import type { User } from '@concord/shared';
import { config } from '../config.js';
import { get, HttpError, list, put, remove } from '../db.js';
import { seal, sealingAvailable, unseal } from '../sealed.js';
import { exportLogin, importLogin, podRequester, type PodRequest, type SolidLogin, type StoredLogin } from '../solidOidc.js';

/**
 * People who sign in with Solid keep their private data (use cases, interview transcripts, their testing record and
 * feedback) in their own pod, written as them (step 5e; Jesse's decision of 4 November). Google and GitHub accounts
 * keep theirs in this server's private store.
 *
 * Their Solid login is kept sealed in the database (CONCORD_ENCRYPTION_KEY), one per account, replaced at each Solid
 * sign-in, so any instance can write as them, including work that runs after their request (synthesis, sharing the
 * feedback folder). Its requests go only inside the pod their profile names (solidOidc.ts `inPods`). When the pod
 * can't be written, the write fails and the person is told: nothing is quietly kept here instead.
 */

const rowId = (userId: string) => `solid-user:${userId}`;
/** The id a kept login refreshes under (solidOidc.ts `shareLogins`), apart from administrators' per-session ones. */
export const USER_LOGIN_PREFIX = 'user:';
const sharedIdOf = (userId: string) => `${USER_LOGIN_PREFIX}${userId}`;

interface OwnPodRow {
  id: string;
  webId: string;
  /** The pod's root (a folder URL), from the person's profile at sign-in. */
  pod: string;
  sealed: string;
  /** When Concord's folder in the pod was made private to its owner (see `solid.ts` makePrivate). */
  privateAt?: string;
}

/** A Solid account whose private data belongs in its own pod (when this server keeps it there). */
export const usesOwnPod = (user: Pick<User, 'providers'> | undefined) => !!config.solidOwnPods && !!user?.providers.some((p) => p.provider === 'solid');

export class OwnPodUnavailable extends HttpError {
  constructor(message: string) {
    super(409, message);
  }
}

/**
 * Keep a Solid sign-in's login for writing to the person's own pod. Returns why it can't be kept, if it can't: the
 * person's writes are then refused with that reason until a sign-in that can.
 */
export async function keepOwnPodLogin(userId: string, login: SolidLogin, pod: string | undefined): Promise<'kept' | 'no-pod' | 'no-key'> {
  if (!pod) {
    await remove('kv', rowId(userId));
    return 'no-pod';
  }
  if (!sealingAvailable()) {
    console.warn('[solid] a Solid sign-in can’t be kept for writing to the person’s pod: set CONCORD_ENCRYPTION_KEY');
    return 'no-key';
  }
  const prev = await get<OwnPodRow>('kv', rowId(userId));
  const sealed = seal('user-login', await exportLogin({ ...login, sharedId: sharedIdOf(userId) }));
  // The same pod stays private; a different one is made private again before its first write.
  await put<OwnPodRow>('kv', { id: rowId(userId), webId: login.webId, pod, sealed, ...(prev?.pod === pod && prev.privateAt ? { privateAt: prev.privateAt } : {}) });
  return 'kept';
}

/** For `shareLogins`: a kept login, by its shared id. */
export async function loadOwnPodLogin(sharedId: string): Promise<SolidLogin | undefined> {
  const row = await get<OwnPodRow>('kv', rowId(sharedId.slice(USER_LOGIN_PREFIX.length)));
  const stored = row && unseal<StoredLogin>('user-login', row.sealed);
  return stored && { ...(await importLogin(stored)), sharedId };
}
/** For `shareLogins`: a refresh changes only the tokens. */
export async function saveOwnPodLogin(sharedId: string, login: SolidLogin) {
  const row = await get<OwnPodRow>('kv', rowId(sharedId.slice(USER_LOGIN_PREFIX.length)));
  const stored = row && unseal<StoredLogin>('user-login', row.sealed);
  if (row && stored) await put<OwnPodRow>('kv', { ...row, sealed: seal('user-login', { ...stored, accessToken: login.accessToken, refreshToken: login.refreshToken, expiresAt: login.expiresAt }) });
}

export interface OwnPod {
  webId: string;
  /** The pod's root. */
  pod: string;
  privateAt?: string;
  /** Requests as the person, inside their pod only. Throws OwnPodUnavailable when their login has ended. */
  request(): Promise<PodRequest>;
  markPrivate(): Promise<void>;
}

const AGAIN = 'Sign in with Solid again so Concord can save to your pod.';

/**
 * Where a Solid account's private data goes: its own pod. Undefined for other accounts (and when this server doesn't
 * use own pods). Throws OwnPodUnavailable when it should go to a pod Concord can't write to now.
 */
export async function ownPodOf(userId: string): Promise<OwnPod | undefined> {
  if (!config.solidOwnPods) return undefined;
  const user = await get<User>('users', userId);
  if (!usesOwnPod(user)) return undefined;
  if (!sealingAvailable()) throw new OwnPodUnavailable('Saving to your pod is off on this server: it needs CONCORD_ENCRYPTION_KEY.');
  const row = await get<OwnPodRow>('kv', rowId(userId));
  if (!row) throw new OwnPodUnavailable(`Concord doesn’t know which pod is yours. Check that your WebID profile names your pod (pim:storage), then sign in with Solid again.`);
  return {
    webId: row.webId,
    pod: row.pod,
    privateAt: row.privateAt,
    async request() {
      // Read afresh each time: another instance may have refreshed the tokens, or a new sign-in replaced the login.
      const login = await loadOwnPodLogin(sharedIdOf(userId));
      const req = login && (await podRequester(login, { pods: [row.pod] }));
      if (!req) throw new OwnPodUnavailable(`Your Solid sign-in has ended. ${AGAIN}`);
      return req;
    },
    async markPrivate() {
      const now = await get<OwnPodRow>('kv', rowId(userId));
      if (now && now.pod === row.pod) await put<OwnPodRow>('kv', { ...now, privateAt: new Date().toISOString() });
    },
  };
}

/** Every account with a kept pod (for sharing the feedback folders and the administrators' reads). */
export async function ownPods(): Promise<{ userId: string; podUrl: string; webId: string }[]> {
  if (!config.solidOwnPods) return [];
  return (await list<OwnPodRow>('kv'))
    .filter((r) => typeof r.id === 'string' && r.id.startsWith('solid-user:') && typeof r.pod === 'string')
    .map((r) => ({ userId: r.id.slice('solid-user:'.length), podUrl: r.pod, webId: r.webId }));
}
