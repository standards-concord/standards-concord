import type { Request, Response } from 'express';
import { APP_RELEASES, APP_VERSION, compareVersions, findRelease, parseVersion, TESTER_ROLE_KEYS, type AlphaMe, type AlphaTesterInfo, type TesterRoleKey, type TestedVersion, type User } from '@concord/shared';
import { config } from '../config.js';
import { HttpError } from '../db.js';
import { createSession, destroySession, sessionUser } from './users.js';
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

/* ------------------------------------------------------------ pod record */

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

const MAX_VERSIONS = 200;
const MAX_FEEDBACK = 500;
const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : undefined);
const isoOr = (v: unknown, fallback: string) => {
  const s = str(v, 40);
  return s && !Number.isNaN(Date.parse(s)) ? s : fallback;
};

/**
 * Read a pod record defensively: it is the tester's own document, so anything in
 * it may be malformed. Keeps only well-formed entries, one per version, with
 * bounded strings and arrays.
 */
export function normaliseVersions(raw: unknown): TestedVersion[] {
  if (!Array.isArray(raw)) return [];
  const byVersion = new Map<string, TestedVersion>();
  for (const v of raw.slice(0, MAX_VERSIONS * 2)) {
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
      feedbackIds: Array.isArray(e.feedbackIds) ? [...new Set(e.feedbackIds.filter((f): f is string => typeof f === 'string' && /^[\w-]{1,64}$/.test(f)))].slice(0, MAX_FEEDBACK) : [],
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
  return [...byVersion.values()].sort((a, b) => compareVersions(b.version, a.version)).slice(0, MAX_VERSIONS);
}

function mergeEntry(a: TestedVersion, b: TestedVersion): TestedVersion {
  const roles = [...new Set([...(a.roles ?? []), ...(b.roles ?? [])])];
  return {
    version: a.version,
    commit: a.commit ?? b.commit,
    firstAt: a.firstAt < b.firstAt ? a.firstAt : b.firstAt,
    lastAt: a.lastAt > b.lastAt ? a.lastAt : b.lastAt,
    feedbackIds: [...new Set([...a.feedbackIds, ...b.feedbackIds])].slice(0, MAX_FEEDBACK),
    ...(roles.length ? { roles } : {}),
  };
}

async function readVersions(userId: string): Promise<TestedVersion[]> {
  const raw = await solid.read(userId, RECORD).catch(() => undefined);
  if (!raw) return [];
  try {
    return normaliseVersions((JSON.parse(raw) as Partial<RecordDoc> | null)?.versions);
  } catch {
    return [];
  }
}

/**
 * Read-modify-write of one tester's record, one at a time per tester. Only this
 * server writes the record, and it runs as a single process, so a per-tester
 * queue is enough to stop two tabs (or a visit and a feedback submission)
 * overwriting each other.
 */
const queues = new Map<string, Promise<unknown>>();
function updateRecord<T>(userId: string, fn: (versions: TestedVersion[]) => Promise<T>): Promise<T> {
  const prev = queues.get(userId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(async () => fn(await readVersions(userId)));
  const tail = run.catch(() => undefined);
  queues.set(userId, tail);
  void tail.then(() => {
    if (queues.get(userId) === tail) queues.delete(userId);
  });
  return run;
}

async function writeVersions(user: User, versions: TestedVersion[]) {
  const doc: RecordDoc = {
    '@context': CONTEXT,
    '@id': '',
    '@type': 'concord:AlphaTestingRecord',
    versions: [...versions].sort((a, b) => compareVersions(b.version, a.version)),
  };
  return solid.write(user.id, RECORD, JSON.stringify(doc, null, 2), 'application/ld+json');
}

const podKind = (u: User): 'solid' | 'local' => (config.solid.serverUrl && u.podUrl?.startsWith(config.solid.serverUrl) ? 'solid' : 'local');

export async function alphaMe(req: Request): Promise<AlphaMe> {
  const t = testerFor(req);
  if (!t) return { versions: [] };
  return { tester: testerInfo(t), versions: await readVersions(t.id), storedIn: podKind(t) };
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

/** Record that the tester used `version` (and, optionally, sent feedback on it). */
export async function recordVersion(tester: User, input: { version: unknown; commit?: unknown; role?: unknown; feedbackId?: string }): Promise<AlphaMe> {
  const version = knownVersion(input.version);
  return updateRecord(tester.id, async (versions) => {
    // Real time, not the demo's fast-forwardable governance clock.
    const now = new Date().toISOString();
    let entry = versions.find((v) => v.version === version);
    if (!entry) {
      entry = { version, firstAt: now, lastAt: now, feedbackIds: [] };
      versions.push(entry);
    }
    entry.lastAt = now;
    if (typeof input.commit === 'string' && /^[0-9a-f]{7,40}$/i.test(input.commit)) entry.commit = input.commit;
    if (typeof input.role === 'string' && TESTER_ROLE_KEYS.includes(input.role as TesterRoleKey) && !entry.roles?.includes(input.role as TesterRoleKey))
      entry.roles = [...(entry.roles ?? []), input.role as TesterRoleKey];
    if (input.feedbackId && !entry.feedbackIds.includes(input.feedbackId)) entry.feedbackIds.push(input.feedbackId);
    const kept = normaliseVersions(versions);
    const saved = await writeVersions(tester, kept);
    return { tester: testerInfo(tester), versions: kept, storedIn: saved.kind, recordUrl: saved.url };
  });
}

/**
 * Move a demo tester's record into the account they have just signed in to
 * (they proved control of both: the demo account's cookie and the provider
 * identity). Copies their feedback documents too; the demo account keeps its own copy.
 */
export async function mergeTesterRecords(from: User, into: User) {
  const theirs = await updateRecord(from.id, async (v) => v);
  if (!theirs.length) return;
  await updateRecord(into.id, async (mine) => {
    const merged = normaliseVersions([...mine, ...theirs]);
    await writeVersions(into, merged);
    return merged;
  });
  for (const id of new Set(theirs.flatMap((v) => v.feedbackIds))) {
    const doc = await solid.read(from.id, `feedback/${id}.json`).catch(() => undefined);
    if (doc && !(await solid.read(into.id, `feedback/${id}.json`).catch(() => undefined))) await solid.write(into.id, `feedback/${id}.json`, doc, 'application/json').catch(() => undefined);
  }
}
