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

async function readVersions(userId: string): Promise<TestedVersion[]> {
  const raw = await solid.read(userId, RECORD).catch(() => undefined);
  if (!raw) return [];
  try {
    const doc = JSON.parse(raw) as Partial<RecordDoc>;
    return Array.isArray(doc.versions) ? doc.versions.filter((v) => v && typeof v.version === 'string') : [];
  } catch {
    return [];
  }
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
  const versions = await readVersions(tester.id);
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
  const saved = await writeVersions(tester, versions);
  return { tester: testerInfo(tester), versions, storedIn: saved.kind, recordUrl: saved.url };
}
