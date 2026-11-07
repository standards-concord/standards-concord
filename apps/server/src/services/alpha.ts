import type { Request, Response } from 'express';
import { APP_RELEASES, APP_VERSION, compareVersions, findRelease, parseVersion, TESTER_ROLE_KEYS, type AlphaMe, type AlphaTesterInfo, type FeedbackSubmission, type TesterRoleKey, type TestedVersion, type User } from '@concord/shared';
import { config } from '../config.js';
import { get, HttpError, put, transaction } from '../db.js';
import { createSession, destroySession, destroyUserSessions, sessionUser } from './users.js';
import { PreconditionFailed, solid } from './solid.js';

/**
 * Alpha testers and the app versions they have tested.
 *
 * In the walkthrough a tester "becomes" a simulated persona, which replaces the
 * session cookie. Their own account (Google, GitHub or a demo tester account)
 * is remembered in a second cookie, so the version they tested and their
 * feedback still go to their own pod rather than the persona's.
 */
export const TESTER_COOKIE = 'concord_tester';

/** Signed in with a provider they can sign in with again from anywhere. */
export const isLasting = (u: User) => u.providers.some((p) => p.provider === 'google' || p.provider === 'github' || p.provider === 'solid');

/** The tester's own account: the one remembered when they switched to a persona or another demo member, else whoever is signed in. */
export async function testerFor(req: Request): Promise<User | undefined> {
  const remembered = await sessionUser(req.cookies?.[TESTER_COOKIE]);
  if (remembered && !remembered.simulated) return remembered;
  return req.user && !req.user.simulated ? req.user : undefined;
}

/**
 * The tester for something that saves to their record (feedback, a visit). A
 * browser still carrying a remembered tester whose session has ended (say, the
 * record moved into another account while the request was on its way) is
 * refused, not quietly treated as having no tester; the stale cookie is cleared
 * so the next attempt starts afresh.
 */
export async function testerForSaving(req: Request, res: Response): Promise<User | undefined> {
  const cookie = req.cookies?.[TESTER_COOKIE];
  if (cookie && !await sessionUser(cookie)) {
    res.clearCookie(TESTER_COOKIE, { path: '/' });
    throw new HttpError(409, 'Your tester session ended (your testing record may have moved into the account you signed in to). Please sign in again and resend.');
  }
  return await testerFor(req);
}

const cookieOpts = () => ({ httpOnly: true, sameSite: 'lax' as const, secure: config.publicUrl.startsWith('https://'), maxAge: 30 * 24 * 60 * 60 * 1000, path: '/' });

export async function clearTesterCookie(req: Request, res: Response) { return transaction(async () => {
  if (req.cookies?.[TESTER_COOKIE]) {
    await destroySession(req.cookies[TESTER_COOKIE]);
    res.clearCookie(TESTER_COOKIE, { path: '/' });
  }
}); }

/**
 * Call after the demo sign-in switches the session to `next`. Whoever was
 * testing before (their own account, not a persona) stays the tester until they
 * sign out, whether they now play a persona or join as a new demo member.
 */
export async function rememberTester(req: Request, res: Response, before: User | undefined, next: User) { return transaction(async () => {
  if (!before || before.id === next.id) return await clearTesterCookie(req, res);
  if ((await sessionUser(req.cookies?.[TESTER_COOKIE]))?.id === before.id) return;
  await clearTesterCookie(req, res);
  res.cookie(TESTER_COOKIE, await createSession(before.id), cookieOpts());
}); }

export function testerInfo(u: User): AlphaTesterInfo {
  return { id: u.id, name: u.name, avatarUrl: u.avatarUrl, lasting: isLasting(u), providers: [...new Set(u.providers.map((p) => p.provider))], podUrl: u.podUrl };
}

/* --------------------------------------------------------- testing record */

/*
 * Each tester's history lives on this server (one document per tester, written
 * synchronously, so it is never lost to a pod that is down) and is mirrored to
 * their pod, so they keep their own copy. The mirror is rewritten from the
 * server's history whenever it changes, and again on later visits until a write
 * succeeds; it is never read back.
 */

const RECORD = 'alpha/testing.jsonld';

interface RecordDoc {
  '@context': unknown;
  '@id': string;
  '@type': string;
  /** The record's revision here (HistoryDoc.rev), so a writer can tell whether the copy is already newer. */
  revision?: number;
  versions: TestedVersion[];
}

const CONTEXT = {
  '@vocab': 'https://schema.org/',
  concord: 'https://w3id.org/concord/alpha#',
  revision: { '@id': 'concord:revision', '@type': 'http://www.w3.org/2001/XMLSchema#integer' },
  versions: { '@id': 'concord:testedVersion', '@container': '@set' },
  version: 'softwareVersion',
  commit: 'concord:commit',
  firstAt: { '@id': 'concord:firstUsed', '@type': 'http://www.w3.org/2001/XMLSchema#dateTime' },
  lastAt: { '@id': 'concord:lastUsed', '@type': 'http://www.w3.org/2001/XMLSchema#dateTime' },
  feedbackIds: { '@id': 'concord:feedback', '@container': '@set' },
  roles: { '@id': 'concord:testedAsRole', '@container': '@set' },
};

interface HistoryDoc {
  id: string;
  versions: TestedVersion[];
  /** Bumped on every change, so a mirror write only marks the copy it wrote as current. */
  rev: number;
  /** The rev the pod copy has. */
  mirroredRev: number;
  /** Feedback documents still to copy into this tester's pod (after a record moved in). */
  feedbackToCopy?: string[];
  /** Set once this (demo) tester's record has moved into another account: it takes no more changes. */
  movedTo?: string;
  /** Set once anything that was already at the mirror's path (not written by this server) has been kept aside. */
  keptExisting?: boolean;
}

/** Limits on what a visit or a feedback submission can add. Merging records never drops anything. */
export const MAX_VERSIONS = 200;
export const MAX_FEEDBACK_PER_VERSION = 500;
const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : undefined);
const isoOr = (v: unknown, fallback: string) => {
  const s = str(v, 40);
  return s && !Number.isNaN(Date.parse(s)) ? s : fallback;
};

/**
 * Tidy a list of tested versions: only well-formed entries, one per version
 * (duplicates are merged, never dropped), newest first.
 */
export function normaliseVersions(raw: unknown): TestedVersion[] {
  if (!Array.isArray(raw)) return [];
  const byVersion = new Map<string, TestedVersion>();
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue;
    const e = v as Record<string, unknown>;
    const version = str(e.version, 20);
    const parsed = version && parseVersion(version);
    if (!parsed) continue;
    const key = parsed.join('.');
    const firstAt = isoOr(e.firstAt, new Date(0).toISOString());
    const entry: TestedVersion = {
      version: key,
      firstAt,
      lastAt: isoOr(e.lastAt, firstAt),
      feedbackIds: Array.isArray(e.feedbackIds) ? [...new Set(e.feedbackIds.filter((f): f is string => typeof f === 'string' && /^[\w-]{1,64}$/.test(f)))] : [],
    };
    const commit = str(e.commit, 40);
    if (commit && /^[0-9a-f]{7,40}$/i.test(commit)) entry.commit = commit;
    if (Array.isArray(e.roles)) {
      const roles = [...new Set(e.roles.filter((r): r is TesterRoleKey => TESTER_ROLE_KEYS.includes(r as TesterRoleKey)))];
      if (roles.length) entry.roles = roles;
    }
    const prev = byVersion.get(key);
    byVersion.set(key, prev ? mergeEntry(prev, entry) : entry);
  }
  return [...byVersion.values()].sort((a, b) => compareVersions(b.version, a.version));
}

function mergeEntry(a: TestedVersion, b: TestedVersion): TestedVersion {
  const roles = [...new Set([...(a.roles ?? []), ...(b.roles ?? [])])];
  return {
    version: a.version,
    commit: a.commit ?? b.commit,
    firstAt: a.firstAt < b.firstAt ? a.firstAt : b.firstAt,
    lastAt: a.lastAt > b.lastAt ? a.lastAt : b.lastAt,
    feedbackIds: [...new Set([...a.feedbackIds, ...b.feedbackIds])],
    ...(roles.length ? { roles } : {}),
  };
}

const historyKey = (userId: string) => `alpha-history:${userId}`;
async function history(userId: string): Promise<HistoryDoc> {
  const doc = await get<HistoryDoc>('kv', historyKey(userId));
  return doc ? { ...doc, versions: normaliseVersions(doc.versions) } : { id: historyKey(userId), versions: [], rev: 0, mirroredRev: 0 };
}
async function saveHistory(doc: HistoryDoc) {
  doc.rev += 1;
  await put('kv', doc);
}

/**
 * Run jobs for one key one at a time. A job that fails doesn't stop the ones
 * after it, and never surfaces as an unhandled rejection.
 */
export function runSerially(queues: Map<string, Promise<void>>, key: string, job: () => Promise<void>): Promise<void> {
  const prev = queues.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(job);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

const podKind = (u: User): 'solid' | 'local' => (config.solid.serverUrl && u.podUrl?.startsWith(config.solid.serverUrl) ? 'solid' : 'local');
const podUrlOf = (u: User, rel: string) => (podKind(u) === 'solid' && u.podUrl ? `${u.podUrl}concord/${rel}` : `${config.publicUrl}/people/${u.id}/private/${rel}`);

/**
 * Bring the tester's pod copy up to date (one write at a time per tester on this instance, always from the latest
 * history). Failures are logged and retried on a later change or visit; the history itself is already safe here.
 *
 * Instances writing at once are ordered by the copy itself: every write after the first replaces exactly the
 * version it read (If-Match), and the copy says which revision it holds. A writer whose condition fails reads the
 * copy again: if it already holds this revision or a newer one, there is nothing to do; otherwise it tries again
 * on what is there now. So the copy never goes back to an older revision, and `mirroredRev` only records a revision
 * the copy has.
 */
const mirrors = new Map<string, Promise<void>>();
export function mirrorToPod(user: User): Promise<void> {
  // Read-only (the cutover): nothing is copied, and the next visit after it catches up.
  if (config.readOnly) return Promise.resolve();
  return runSerially(mirrors, user.id, () => mirrorNow(user));
}

/** Tries at replacing the copy before leaving it to the next change or visit. */
const MIRROR_TRIES = 4;
const revisionOf = (bytes: Buffer): number => {
  try {
    const r = (JSON.parse(bytes.toString('utf8')) as Partial<RecordDoc>).revision;
    return typeof r === 'number' && Number.isFinite(r) ? r : 0;
  } catch {
    return 0;
  }
};

async function mirrorNow(user: User): Promise<void> {
  try {
    const h = await history(user.id);
    if (h.mirroredRev === h.rev && !h.feedbackToCopy?.length) return;
    const copied: string[] = [];
    for (const id of h.feedbackToCopy ?? []) {
      const fb = await get<FeedbackSubmission>('feedback', id);
      if (fb) await solid.writeExisting(user.id, `feedback/${id}.json`, JSON.stringify(fb, null, 2), 'application/json');
      copied.push(id);
    }
    const doc: RecordDoc = { '@context': CONTEXT, '@id': '', '@type': 'concord:AlphaTestingRecord', revision: h.rev, versions: h.versions };
    const body = JSON.stringify(doc, null, 2);
    let has: number | undefined;
    if (!h.keptExisting) {
      // The first time, a document already at the record's path (one this server didn't write) is kept, byte for
      // byte, beside it, and the record only replaces exactly that version (or only creates, if nothing was there).
      // If the pod can't say, or the document changes in between, nothing is written and it's tried again later.
      // A record another instance already copied there (it names its revision) isn't kept aside, and is only
      // replaced by a newer revision: this instance may have read its history before that copy was made.
      const when = await solid.keepExisting(user.id, RECORD, { ours: (b) => revisionOf(b) > 0 });
      const there = when.existing ? revisionOf(when.existing) : 0;
      if (there >= h.rev) has = there;
      else {
        await solid.writeExisting(user.id, RECORD, body, 'application/ld+json', { ifMatch: when.ifMatch, ifNoneMatch: when.ifNoneMatch });
        has = h.rev;
      }
    } else {
      for (let n = 0; n < MIRROR_TRIES && has === undefined; n++) {
        const now = await solid.readTagged(user.id, RECORD);
        const there = now.bytes ? revisionOf(now.bytes) : 0;
        if (now.bytes && there >= h.rev) {
          has = there; // another writer got there first, with this revision or a newer one
          break;
        }
        try {
          // Straight to the pod or not at all: a fallback copy on this server would just be another stale mirror.
          await solid.writeExisting(user.id, RECORD, body, 'application/ld+json', now.tag ? { ifMatch: now.tag } : { ifNoneMatch: '*' });
          has = h.rev;
        } catch (err) {
          if (!(err instanceof PreconditionFailed)) throw err;
        }
      }
      if (has === undefined) throw new Error(`the copy kept changing while it was being written (${MIRROR_TRIES} tries)`);
    }
    const written = has;
    // Re-read and saved in one transaction: a visit saved while the pod was being written must not be lost.
    await transaction(async () => {
      const now = await history(user.id);
      now.keptExisting = true;
      now.mirroredRev = Math.max(now.mirroredRev, Math.min(written, now.rev));
      now.feedbackToCopy = now.feedbackToCopy?.filter((id) => !copied.includes(id));
      await put('kv', now);
    });
  } catch (err) {
    console.warn(`[alpha] pod copy of ${user.id}'s testing record is behind: ${(err as Error).message}`);
  }
}

async function meFor(user: User): Promise<AlphaMe> {
  const h = await history(user.id);
  return {
    tester: testerInfo(user),
    versions: h.versions,
    storedIn: podKind(user),
    recordUrl: podUrlOf(user, RECORD),
    ...(h.mirroredRev < h.rev || h.feedbackToCopy?.length ? { podBehind: true } : {}),
  };
}

export async function alphaMe(req: Request): Promise<AlphaMe> {
  const t = await testerFor(req);
  if (!t) return { versions: [] };
  await mirrorToPod(t);
  return await meFor(t);
}

/**
 * A version this server knows, or a well-formed newer one: the web app (on
 * Vercel) can be deployed a little before this server, so it may be ahead.
 */
export function acceptVersion(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const known = findRelease(v);
  if (known) return known.version;
  const p = parseVersion(v);
  return p && compareVersions(v, APP_VERSION) > 0 ? p.join('.') : undefined;
}

const knownVersion = (v: unknown) => {
  const ok = acceptVersion(v);
  if (!ok) throw new HttpError(400, `Unknown app version. Known versions: ${APP_RELEASES.map((r) => r.version).join(', ')}`);
  return ok;
};

const movedError = () => new HttpError(409, 'This tester account’s record has moved into the account you signed in to. Sign in again to keep testing.');

interface VisitInput {
  version: unknown;
  commit?: unknown;
  role?: unknown;
  feedbackId?: string;
}

/** Apply a visit (and optional feedback) to a history, or throw (409) without changing it if it can't take it. */
function applyVisit(h: HistoryDoc, input: VisitInput) {
  if (h.movedTo) throw movedError();
  const version = knownVersion(input.version);
  // Real time, not the demo's fast-forwardable governance clock.
  const now = new Date().toISOString();
  let entry = h.versions.find((v) => v.version === version);
  if (!entry && h.versions.length >= MAX_VERSIONS) throw new HttpError(409, `This testing record already has ${MAX_VERSIONS} versions.`);
  if (input.feedbackId && entry && !entry.feedbackIds.includes(input.feedbackId) && entry.feedbackIds.length >= MAX_FEEDBACK_PER_VERSION)
    throw new HttpError(409, `This testing record already has ${MAX_FEEDBACK_PER_VERSION} pieces of feedback for ${version}.`);
  if (!entry) {
    entry = { version, firstAt: now, lastAt: now, feedbackIds: [] };
    h.versions.push(entry);
  }
  entry.lastAt = now;
  if (typeof input.commit === 'string' && /^[0-9a-f]{7,40}$/i.test(input.commit)) entry.commit = input.commit;
  if (typeof input.role === 'string' && TESTER_ROLE_KEYS.includes(input.role as TesterRoleKey) && !entry.roles?.includes(input.role as TesterRoleKey))
    entry.roles = [...(entry.roles ?? []), input.role as TesterRoleKey];
  if (input.feedbackId && !entry.feedbackIds.includes(input.feedbackId)) entry.feedbackIds.push(input.feedbackId);
  h.versions = normaliseVersions(h.versions);
}

/** Record that the tester used `version`. Saved here first, then mirrored to their pod. */
export async function recordVersion(tester: User, input: VisitInput): Promise<AlphaMe> {
  // Read and saved in one transaction, so visits arriving at once (several tabs) can't overwrite each other.
  await transaction(async () => {
    const h = await history(tester.id);
    applyVisit(h, input);
    await saveHistory(h);
  });
  await mirrorToPod(tester);
  return await meFor(tester);
}

/**
 * Store a tester's feedback and link it to their testing record in one step:
 * if the record can't take it (it has moved into another account, or is full),
 * nothing is stored and the 409 goes back to them. `store` saves the feedback
 * itself, inside the same transaction. Their pod gets a copy afterwards.
 */
export async function recordFeedback(
  tester: User,
  sub: FeedbackSubmission,
  visit: Omit<VisitInput, 'feedbackId'> | undefined,
  store: () => Promise<unknown>,
): Promise<{ kind: 'solid' | 'local'; url: string }> {
  await transaction(async () => {
    const h = await history(tester.id);
    if (h.movedTo) throw movedError();
    if (visit) applyVisit(h, { ...visit, feedbackId: sub.id });
    h.feedbackToCopy = [...new Set([...(h.feedbackToCopy ?? []), sub.id])];
    await store();
    await saveHistory(h);
  });
  await mirrorToPod(tester);
  return { kind: podKind(tester), url: podUrlOf(tester, `feedback/${sub.id}.json`) };
}

/**
 * Move a demo tester's record into the account they have just signed in to
 * (they proved control of both: the demo account's cookie and the provider
 * identity). In one database transaction: everything is merged into the
 * account's history (nothing dropped), the demo record is closed (it takes no
 * more changes) and the demo account's sessions end, so no browser keeps adding
 * to a record nobody will see again. Their feedback documents are then copied
 * into the account's pod with the record. Running it again finishes the job.
 */
export async function mergeTesterRecords(from: User, into: User) {
  await moveTesterRecord(from, into);
  await mirrorToPod(into);
}

/** Where a demo account's testing record moved to, if it has. */
export const testerRecordMovedTo = async (userId: string) => (await history(userId)).movedTo;

/** The stored part of mergeTesterRecords, in one transaction (or the caller's, so it commits with the caller's writes). */
export async function moveTesterRecord(from: User, into: User) {
  await transaction(async () => {
    // Only a demo account's record moves. If an identity was attached to it after the caller read it, the record
    // belongs to that identity now, and moving it would close it and end that identity's sessions.
    const stored = await get<User>('users', from.id);
    if (stored && !stored.simulated && !stored.providers.every((p) => p.provider === 'demo'))
      throw new HttpError(409, 'This browser’s demo account was just linked to another sign-in. Please sign in again.');
    const theirs = await history(from.id);
    if (!theirs.movedTo) {
      const mine = await history(into.id);
      if (theirs.versions.length) {
        mine.versions = normaliseVersions([...mine.versions, ...theirs.versions]);
        mine.feedbackToCopy = [...new Set([...(mine.feedbackToCopy ?? []), ...theirs.versions.flatMap((v) => v.feedbackIds)])];
        await saveHistory(mine);
      }
      theirs.movedTo = into.id;
      await saveHistory(theirs);
    }
    await destroyUserSessions(from.id);
  });
}
