import type { Request, Response } from 'express';
import { APP_RELEASES, APP_VERSION, compareVersions, findRelease, parseVersion, TESTER_ROLE_KEYS, type AlphaMe, type AlphaTesterInfo, type FeedbackSubmission, type TesterRoleKey, type TestedVersion, type User } from '@concord/shared';
import { config } from '../config.js';
import { get, HttpError, put, transaction } from '../db.js';
import { createSession, destroySession, destroyUserSessions, sessionUser } from './users.js';
import { solid } from './solid.js';

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
export const isLasting = (u: User) => u.providers.some((p) => p.provider === 'google' || p.provider === 'github');

/** The tester's own account: the one remembered when they switched to a persona or another demo member, else whoever is signed in. */
export function testerFor(req: Request): User | undefined {
  const remembered = sessionUser(req.cookies?.[TESTER_COOKIE]);
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
export function testerForSaving(req: Request, res: Response): User | undefined {
  const cookie = req.cookies?.[TESTER_COOKIE];
  if (cookie && !sessionUser(cookie)) {
    res.clearCookie(TESTER_COOKIE, { path: '/' });
    throw new HttpError(409, 'Your tester session ended (your testing record may have moved into the account you signed in to). Please sign in again and resend.');
  }
  return testerFor(req);
}

const cookieOpts = () => ({ httpOnly: true, sameSite: 'lax' as const, secure: config.publicUrl.startsWith('https://'), maxAge: 30 * 24 * 60 * 60 * 1000, path: '/' });

export function clearTesterCookie(req: Request, res: Response) {
  if (req.cookies?.[TESTER_COOKIE]) {
    destroySession(req.cookies[TESTER_COOKIE]);
    res.clearCookie(TESTER_COOKIE, { path: '/' });
  }
}

/**
 * Call after the demo sign-in switches the session to `next`. Whoever was
 * testing before (their own account, not a persona) stays the tester until they
 * sign out, whether they now play a persona or join as a new demo member.
 */
export function rememberTester(req: Request, res: Response, before: User | undefined, next: User) {
  if (!before || before.id === next.id) return clearTesterCookie(req, res);
  if (sessionUser(req.cookies?.[TESTER_COOKIE])?.id === before.id) return;
  clearTesterCookie(req, res);
  res.cookie(TESTER_COOKIE, createSession(before.id), cookieOpts());
}

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
  versions: TestedVersion[];
}

const CONTEXT = {
  '@vocab': 'https://schema.org/',
  concord: 'https://w3id.org/concord/alpha#',
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
function history(userId: string): HistoryDoc {
  const doc = get<HistoryDoc>('kv', historyKey(userId));
  return doc ? { ...doc, versions: normaliseVersions(doc.versions) } : { id: historyKey(userId), versions: [], rev: 0, mirroredRev: 0 };
}
function saveHistory(doc: HistoryDoc) {
  doc.rev += 1;
  put('kv', doc);
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
 * Bring the tester's pod copy up to date (one write at a time per tester, always
 * from the latest history). Failures are logged and retried on a later change or
 * visit; the history itself is already safe on this server.
 */
const mirrors = new Map<string, Promise<void>>();
export function mirrorToPod(user: User): Promise<void> {
  return runSerially(mirrors, user.id, async () => {
    try {
      const h = history(user.id);
      if (h.mirroredRev === h.rev && !h.feedbackToCopy?.length) return;
      // The first time, a document already at the record's path (one this server didn't write) is kept, word for
      // word, beside it rather than written over. If the pod can't say whether there is one, nothing is written.
      if (!h.keptExisting) {
        await solid.keepExisting(user.id, RECORD);
        const marked = history(user.id);
        marked.keptExisting = true;
        put('kv', marked);
      }
      const copied: string[] = [];
      for (const id of h.feedbackToCopy ?? []) {
        const fb = get<FeedbackSubmission>('feedback', id);
        if (fb) await solid.writeExisting(user.id, `feedback/${id}.json`, JSON.stringify(fb, null, 2), 'application/json');
        copied.push(id);
      }
      const doc: RecordDoc = { '@context': CONTEXT, '@id': '', '@type': 'concord:AlphaTestingRecord', versions: h.versions };
      // Straight to the pod or not at all: a fallback copy on this server would just be another stale mirror.
      await solid.writeExisting(user.id, RECORD, JSON.stringify(doc, null, 2), 'application/ld+json');
      const now = history(user.id);
      now.mirroredRev = Math.max(now.mirroredRev, h.rev);
      now.feedbackToCopy = now.feedbackToCopy?.filter((id) => !copied.includes(id));
      put('kv', now);
    } catch (err) {
      console.warn(`[alpha] pod copy of ${user.id}'s testing record is behind: ${(err as Error).message}`);
    }
  });
}

function meFor(user: User): AlphaMe {
  const h = history(user.id);
  return {
    tester: testerInfo(user),
    versions: h.versions,
    storedIn: podKind(user),
    recordUrl: podUrlOf(user, RECORD),
    ...(h.mirroredRev < h.rev || h.feedbackToCopy?.length ? { podBehind: true } : {}),
  };
}

export async function alphaMe(req: Request): Promise<AlphaMe> {
  const t = testerFor(req);
  if (!t) return { versions: [] };
  await mirrorToPod(t);
  return meFor(t);
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
  const h = history(tester.id);
  applyVisit(h, input);
  saveHistory(h);
  await mirrorToPod(tester);
  return meFor(tester);
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
  store: () => void,
): Promise<{ kind: 'solid' | 'local'; url: string }> {
  transaction(() => {
    const h = history(tester.id);
    if (h.movedTo) throw movedError();
    if (visit) applyVisit(h, { ...visit, feedbackId: sub.id });
    h.feedbackToCopy = [...new Set([...(h.feedbackToCopy ?? []), sub.id])];
    store();
    saveHistory(h);
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
  transaction(() => {
    const theirs = history(from.id);
    if (!theirs.movedTo) {
      const mine = history(into.id);
      if (theirs.versions.length) {
        mine.versions = normaliseVersions([...mine.versions, ...theirs.versions]);
        mine.feedbackToCopy = [...new Set([...(mine.feedbackToCopy ?? []), ...theirs.versions.flatMap((v) => v.feedbackIds)])];
        saveHistory(mine);
      }
      theirs.movedTo = into.id;
      saveHistory(theirs);
    }
    destroyUserSessions(from.id);
  });
  await mirrorToPod(into);
}
