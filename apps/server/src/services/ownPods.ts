import type { User } from '@concord/shared';
import { config } from '../config.js';
import { randomBytes } from 'node:crypto';
import { get, HttpError, list, put, remove, transaction } from '../db.js';
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
/** `user:<account>#<generation>`: each sign-in's login refreshes under an id of its own. */
const sharedIdOf = (userId: string, gen: string) => `${USER_LOGIN_PREFIX}${userId}#${gen}`;
const parseSharedId = (sharedId: string) => {
  const m = /^user:([^#]+)#([0-9a-f]+)$/.exec(sharedId);
  return m ? { userId: m[1]!, gen: m[2]! } : undefined;
};

interface OwnPodRow {
  id: string;
  webId: string;
  /** The pod's root (a folder URL), from the person's profile at sign-in. */
  pod: string;
  /** Which sign-in this login is: a new one replaces it, and a refresh only saves into the generation it refreshed. */
  gen: string;
  sealed: string;
}

/** What a sealed login is bound to: its account, WebID, pod and generation (see `seal`'s `boundTo`). */
const boundTo = (userId: string, row: Pick<OwnPodRow, 'webId' | 'pod' | 'gen'>) => JSON.stringify(['own-pod-login', userId, row.webId, row.pod, row.gen]);

/** A Solid account whose private data belongs in its own pod (when this server keeps it there). */
export const usesOwnPod = (user: Pick<User, 'providers'> | undefined) => !!config.solidOwnPods && !!user?.providers.some((p) => p.provider === 'solid');

export class OwnPodUnavailable extends HttpError {
  constructor(message: string) {
    super(409, message);
  }
}

/**
 * Keep a Solid sign-in's login for writing to the person's own pod, as a new generation that replaces any earlier
 * one. Returns its shared id, or why it can't be kept: the person's writes are then refused with that reason until
 * a sign-in that can.
 */
export async function keepOwnPodLogin(userId: string, login: SolidLogin, pod: string | undefined): Promise<{ status: 'kept'; sharedId: string } | { status: 'no-pod' | 'no-key' }> {
  if (!pod) {
    await forgetOwnPodLogin(userId);
    return { status: 'no-pod' };
  }
  if (!sealingAvailable()) {
    console.warn('[solid] a Solid sign-in can’t be kept for writing to the person’s pod: set CONCORD_ENCRYPTION_KEY');
    return { status: 'no-key' };
  }
  const gen = randomBytes(12).toString('hex');
  const sharedId = sharedIdOf(userId, gen);
  const row = { webId: login.webId, pod, gen };
  const sealed = seal('user-login', await exportLogin({ ...login, sharedId }), boundTo(userId, row));
  await transaction(async () => void (await put<OwnPodRow>('kv', { id: rowId(userId), ...row, sealed })));
  return { status: 'kept', sharedId };
}

/**
 * Forget the account's kept login (sign-out, or a sign-in that can't be kept). A refresh under way can't bring it
 * back: it only saves into the generation it refreshed (`saveOwnPodLogin`).
 */
export async function forgetOwnPodLogin(userId: string) {
  await transaction(async () => void (await remove('kv', rowId(userId))));
}

/** The kept login of one generation, opened and checked against its account; undefined once it isn't the current one. */
async function openLogin(userId: string, gen: string): Promise<{ row: OwnPodRow; stored: StoredLogin } | undefined> {
  const row = await get<OwnPodRow>('kv', rowId(userId));
  if (!row || row.gen !== gen) return undefined;
  const stored = unseal<StoredLogin>('user-login', row.sealed, boundTo(userId, row));
  if (!stored || stored.webId !== row.webId || stored.sharedId !== sharedIdOf(userId, gen)) return undefined;
  return { row, stored };
}

/** For `shareLogins`: a kept login, by its shared id (undefined once signed out, or replaced by a newer sign-in). */
export async function loadOwnPodLogin(sharedId: string): Promise<SolidLogin | undefined> {
  const id = parseSharedId(sharedId);
  const open = id && (await openLogin(id.userId, id.gen));
  return open && { ...(await importLogin(open.stored)), sharedId };
}
/** For `shareLogins`: a refresh changes only the tokens, and only of the generation it refreshed. False if that has ended. */
export async function saveOwnPodLogin(sharedId: string, login: SolidLogin): Promise<boolean> {
  const id = parseSharedId(sharedId);
  if (!id) return false;
  return await transaction(async () => {
    const open = await openLogin(id.userId, id.gen);
    if (!open) return false; // signed out, or signed in again, meanwhile
    const stored = { ...open.stored, accessToken: login.accessToken, refreshToken: login.refreshToken, expiresAt: login.expiresAt };
    await put<OwnPodRow>('kv', { ...open.row, sealed: seal('user-login', stored, boundTo(id.userId, open.row)) });
    return true;
  });
}

export interface OwnPod {
  webId: string;
  /** The pod's root. */
  pod: string;
  /** Requests as the person, inside Concord's folder in their pod only. Throws OwnPodUnavailable when their login has ended. */
  request(): Promise<PodRequest>;
}

const AGAIN = 'Sign in with Solid again so Concord can save to your pod.';

/** Concord's folder in a pod: the only place its requests as the person go. */
export const concordFolder = (pod: string) => `${pod}concord/`;

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
  if (!row) throw new OwnPodUnavailable(`Concord has no Solid sign-in to save to your pod with (you signed out, or your WebID profile doesn’t name your pod with pim:storage). ${AGAIN}`);
  return {
    webId: row.webId,
    pod: row.pod,
    async request() {
      // The current sign-in's login, read afresh: another instance may have refreshed its tokens, or a newer sign-in
      // replaced it. Only inside the folder this pod was opened for: a sign-in naming another pod doesn't redirect it.
      const now = await get<OwnPodRow>('kv', rowId(userId));
      const login = now && now.pod === row.pod ? await loadOwnPodLogin(sharedIdOf(userId, now.gen)) : undefined;
      // Before each request it sends: this sign-in is still the kept one (not signed out, nor replaced).
      const stillValid = async () => {
        if ((await get<OwnPodRow>('kv', rowId(userId)))?.gen !== now?.gen) throw new OwnPodUnavailable(`Your Solid sign-in has ended. ${AGAIN}`);
      };
      const req = login && (await podRequester(login, { pods: [concordFolder(row.pod)], stillValid }));
      if (!req) throw new OwnPodUnavailable(`Your Solid sign-in has ended. ${AGAIN}`);
      return req;
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
