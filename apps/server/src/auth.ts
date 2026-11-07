import { createHash } from 'node:crypto';
import * as arctic from 'arctic';
import type { NextFunction, Request, Response, Router } from 'express';
import type { User } from '@concord/shared';
import { config } from './config.js';
import { get, HttpError, put, remove, removeWhereAtMost, transaction } from './db.js';
import { seal, sealingAvailable, unseal } from './sealed.js';
import type { AuthProvider } from '@concord/shared';
import { allUsers, setPodUrl, createSession, createUser, destroySession, findByProvider, linkFederatedIdentity, sessionOf, type FederatedIdentity } from './services/users.js';
import { clientIdDocument, exportLogin, finishLogin, importLogin, resolveIssuer, sessionKey, shareLogins, SolidLoginError, startLogin, type SolidLogin, type StoredLogin } from './solidOidc.js';
import { keepOwnPodLogin, loadOwnPodLogin, saveOwnPodLogin, USER_LOGIN_PREFIX, usesOwnPod } from './services/ownPods.js';
import { clearTesterCookie, mergeTesterRecords, mirrorToPod, moveTesterRecord, testerFor, testerRecordMovedTo } from './services/alpha.js';

export const SESSION_COOKIE = 'concord_session';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

/** Identities people can sign in with again from anywhere (not demo accounts). */
export const LASTING_PROVIDERS = ['google', 'github', 'solid'] as const;
const FEDERATED: readonly AuthProvider[] = LASTING_PROVIDERS;

/**
 * Deployment administrators: an account whose WebID is in ADMIN_WEBIDS (or, the
 * older way, whose verified email is in ADMIN_EMAILS). This session must itself
 * have been signed in with Google, GitHub or their own WebID (Solid): demo
 * accounts, simulated personas, and sessions a demo account had before it was
 * linked to a provider never count.
 */
export function isAdmin(user: User, method: AuthProvider | undefined): boolean {
  if (!method || !FEDERATED.includes(method) || !user.providers.some((p) => p.provider === method) || user.simulated) return false;
  if (user.webId && config.adminWebIds.includes(user.webId)) return true;
  return !!user.email && config.adminEmails.includes(user.email.toLowerCase());
}

export async function sessionMiddleware(req: Request, _res: Response, next: NextFunction) {
  const s = await sessionOf(req.cookies?.[SESSION_COOKIE]);
  req.user = s && isAdmin(s.user, s.method) ? { ...s.user, isPlatformAdmin: true } : s?.user;
  next();
}

/**
 * A name for one browser session that the browser may know (the session token itself stays in its
 * httpOnly cookie, and can't be worked out from this). A sign-out made with no connection sends it
 * later, so the server ends that session and no other: not a newer one, nor another account's.
 */
export function sessionHandle(token: unknown): string | undefined {
  return typeof token === 'string' && token ? createHash('sha256').update('concord-session-handle:').update(token).digest('base64url').slice(0, 22) : undefined;
}

export function requireUser(req: Request): User {
  if (!req.user) throw new HttpError(401, 'Sign in first');
  return req.user;
}

/** Start a session for `userId` (signed in with `method`) and give the browser its cookie. Returns the session token. */
export async function setSessionCookie(res: Response, userId: string, method: AuthProvider): Promise<string> { return transaction(async () => {
  const token = await createSession(userId, method);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.publicUrl.startsWith('https://'),
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  });
  return token;
}); }

const google = () =>
  config.google.clientId && config.google.clientSecret ? new arctic.Google(config.google.clientId, config.google.clientSecret, `${config.publicUrl}/auth/google/callback`) : undefined;
const github = () =>
  config.github.clientId && config.github.clientSecret ? new arctic.GitHub(config.github.clientId, config.github.clientSecret, `${config.publicUrl}/auth/github/callback`) : undefined;

export const providers = () => ({ google: !!google(), github: !!github(), solid: config.solidOidc.enabled, demo: config.demoMode });

/**
 * Administrators who signed in with Solid keep their login (a DPoP-bound token
 * and its key) so Concord can read testers' pods as their WebID. It belongs to
 * the browser session that signed in, not the account: another session of the
 * same account can't use it. Everyone else's Solid tokens are dropped straight
 * after sign-in: we only needed to know who they are.
 *
 * With CONCORD_ENCRYPTION_KEY (sealed.ts) the login is also kept in the database, sealed, so any instance can
 * use and refresh it (Vercel); without it, in this process's memory only (the VM).
 */
const adminLogins = new Map<string, SolidLogin>();
const MAX_ADMIN_LOGINS = 100;
const ADMIN_LOGIN_DAYS = 7;
const adminLoginRow = (key: string) => `admin-login:${key}`;
interface AdminLoginRow {
  id: string;
  sealed: string;
  adminLoginExpires: number;
}
const loadShared = async (key: string): Promise<SolidLogin | undefined> => {
  const row = await get<AdminLoginRow>('kv', adminLoginRow(key));
  const stored = row && row.adminLoginExpires > Date.now() ? unseal<StoredLogin>('admin-login', row.sealed) : undefined;
  return stored && { ...(await importLogin(stored)), sharedId: key };
};
const saveShared = async (key: string, login: SolidLogin) =>
  void (await put<AdminLoginRow>('kv', { id: adminLoginRow(key), sealed: seal('admin-login', await exportLogin({ ...login, sharedId: key })), adminLoginExpires: Date.now() + ADMIN_LOGIN_DAYS * 86_400_000 }));
shareLogins({
  // People's own-pod logins (one per account) refresh under ids of their own; the rest are administrators' sessions.
  load: (key) => (key.startsWith(USER_LOGIN_PREFIX) ? loadOwnPodLogin(key) : loadShared(key)),
  // A refresh changes only the tokens (the keys were sealed at sign-in), and keeps the row's expiry.
  save: async (key, login) => {
    if (key.startsWith(USER_LOGIN_PREFIX)) return await saveOwnPodLogin(key, login);
    const row = await get<AdminLoginRow>('kv', adminLoginRow(key));
    const stored = row && unseal<StoredLogin>('admin-login', row.sealed);
    if (row && stored)
      await put<AdminLoginRow>('kv', { ...row, sealed: seal('admin-login', { ...stored, accessToken: login.accessToken, refreshToken: login.refreshToken, expiresAt: login.expiresAt }) });
  },
});
const remember = (key: string, login: SolidLogin) => {
  if (adminLogins.size >= MAX_ADMIN_LOGINS) adminLogins.delete(adminLogins.keys().next().value!);
  adminLogins.set(key, login);
};
/** Whether administrators' Solid logins can be kept here: sealed in the database, or in memory on a single server. */
export const adminLoginsKept = () => sealingAvailable() || config.adminLoginsInMemory;
/**
 * Keep an administrator's Solid login for their browser session. Returns false when it can't be kept (several
 * instances and no CONCORD_ENCRYPTION_KEY): reading testers' pods is then off, rather than working on one instance only.
 */
export async function keepAdminLogin(sessionToken: string, login: SolidLogin): Promise<boolean> {
  const key = sessionKey(sessionToken);
  if (sealingAvailable()) {
    await removeWhereAtMost('kv', 'adminLoginExpires', Date.now());
    await saveShared(key, login);
    remember(key, { ...login, sharedId: key });
    return true;
  }
  if (!config.adminLoginsInMemory) {
    console.warn('[auth] an administrator signed in with Solid, but reading pods is off: set CONCORD_ENCRYPTION_KEY to keep their login');
    return false;
  }
  remember(key, login);
  return true;
}
export const adminLoginFor = async (req: Request): Promise<SolidLogin | undefined> => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token !== 'string' || !token) return undefined;
  const key = sessionKey(token);
  if (!adminLoginsKept()) return undefined;
  const here = adminLogins.get(key);
  if (here || !sealingAvailable()) return here;
  // Signed in through another instance.
  const shared = await loadShared(key);
  if (shared) remember(key, shared);
  return shared;
};
/** Forget the Solid login held for this session token (sign-out, or a new sign-in in the same browser). */
export async function endAdminLogin(sessionToken: unknown) {
  if (typeof sessionToken !== 'string' || !sessionToken) return;
  const key = sessionKey(sessionToken);
  adminLogins.delete(key);
  await remove('kv', adminLoginRow(key));
}

/**
 * WebIDs Concord provisioned (each person's pod here) or serves itself can't be
 * used to sign in with Solid: they belong to accounts that sign in another way.
 */
async function managedWebId(webId: string) {
  if (webId.startsWith(`${config.publicUrl}/people/`)) return true;
  return (await allUsers()).some((u) => u.webId === webId && !u.providers.some((p) => p.provider === 'solid' && p.subject === webId));
}

const tmpCookie = () => ({ httpOnly: true, sameSite: 'lax' as const, secure: config.publicUrl.startsWith('https://'), maxAge: 10 * 60 * 1000, path: '/' });
const OAUTH_COOKIES = ['oauth_state', 'oauth_verifier', 'oauth_return'];
const SOLID_COOKIE = 'solid_login';

/**
 * The callback must carry the state this browser was given when it started
 * signing in. Both must be present: a missing query state and a missing cookie
 * would otherwise compare equal. The state is single-use.
 */
function checkState(req: Request, res: Response) {
  const { code, state } = req.query as Record<string, unknown>;
  const expected = req.cookies?.oauth_state;
  const ok = typeof code === 'string' && code && typeof state === 'string' && state && typeof expected === 'string' && expected && state === expected;
  const returnTo = safeReturn(req.cookies?.oauth_return);
  const verifier = req.cookies?.oauth_verifier as string | undefined;
  for (const c of OAUTH_COOKIES) res.clearCookie(c, { path: '/' });
  if (!ok) throw new HttpError(400, 'Sign-in failed: invalid state. Please try again.');
  return { code: code as string, returnTo, verifier };
}

/** Start a fresh session on sign-in, and end the one the browser had (no session fixation). */
async function signInAs(req: Request, res: Response, userId: string, method: AuthProvider): Promise<string> { return transaction(async () => {
  await endAdminLogin(req.cookies?.[SESSION_COOKIE]);
  await destroySession(req.cookies?.[SESSION_COOKIE]);
  return await setSessionCookie(res, userId, method);
}); }

/**
 * Sign in with a provider identity. An alpha tester using a demo account in
 * this browser keeps their testing record: a new identity is attached to the
 * demo account, and an existing account takes over the demo account's record.
 */
async function federatedSignIn(req: Request, res: Response, identity: FederatedIdentity) {
  const tester = await testerFor(req);
  const demoTester = tester && tester.providers.every((p) => p.provider === 'demo') ? tester : undefined;
  const user = await accountForIdentity(identity, demoTester);
  await clearTesterCookie(req, res);
  const sessionToken = await signInAs(req, res, user.id, identity.provider);
  return { user, sessionToken };
}
/**
 * The account an identity signs in to, given the demo account this browser was using (if any): the identity is
 * attached to the demo account when new, and an existing account takes over the demo account's testing record.
 */
export async function accountForIdentity(identity: FederatedIdentity, demoTester?: User) {
  // The checks, the attachment (or the existing account's update) and the record move commit together, so a sign-in
  // refused part-way changes nothing.
  const found = await transaction(async () => {
    if (demoTester) {
      // Another sign-in from this browser already moved the demo account's record into its account. Only a retry by
      // that same identity goes on; attaching anyone else to the demo account would sign them in to a closed record.
      const movedTo = await testerRecordMovedTo(demoTester.id);
      if (movedTo && (await findByProvider(identity.provider, identity.subject))?.id !== movedTo)
        throw new HttpError(409, 'This browser’s demo account was just linked to another sign-in. Please sign in again.');
    }
    const user = await linkFederatedIdentity(identity, demoTester);
    if (user && demoTester && user.id !== demoTester.id) await moveTesterRecord(demoTester, user);
    return user;
  });
  if (found) {
    if (demoTester && found.id !== demoTester.id) await mirrorToPod(found);
    return found;
  }
  // A new account is made outside the transaction: making one provisions a pod over the network.
  const user = await createUser({ ...identity });
  if (demoTester) await mergeTesterRecords(demoTester, user);
  return user;
}
const safeReturn = (r: unknown) => (typeof r === 'string' && r.startsWith('/') && !r.startsWith('//') && !r.startsWith('/\\') ? r : '/');

/** Back to the login page with a message, rather than a bare error page. */
const loginError = (res: Response, returnTo: string, message: string) =>
  res.redirect(`${config.webUrl}/login?${new URLSearchParams({ next: returnTo, solidError: message.slice(0, 300) })}`);

/**
 * Sign in with Google or GitHub. A WebID and Solid pod are provisioned on first
 * sign-in; people never have to know about them.
 */
export function mountAuth(router: Router) {
  router.get('/auth/google', (req, res) => {
    const g = google();
    if (!g) throw new HttpError(404, 'Google sign-in is not configured on this server');
    const state = arctic.generateState();
    const verifier = arctic.generateCodeVerifier();
    const url = g.createAuthorizationURL(state, verifier, ['openid', 'profile', 'email']);
    res.cookie('oauth_state', state, tmpCookie()).cookie('oauth_verifier', verifier, tmpCookie()).cookie('oauth_return', safeReturn(req.query.returnTo), tmpCookie());
    res.redirect(url.toString());
  });

  router.get('/auth/google/callback', async (req, res) => {
    const g = google();
    if (!g) throw new HttpError(404, 'Google sign-in is not configured on this server');
    const { code, returnTo, verifier } = checkState(req, res);
    if (!verifier) throw new HttpError(400, 'Sign-in failed: invalid state. Please try again.');
    const tokens = await g.validateAuthorizationCode(code, verifier);
    const claims = arctic.decodeIdToken(tokens.idToken()) as { sub: string; name?: string; email?: string; email_verified?: boolean; picture?: string };
    // Only a verified address counts (ADMIN_EMAILS matches on it).
    const email = claims.email_verified === true ? claims.email : undefined;
    await federatedSignIn(req, res, { provider: 'google', subject: claims.sub, name: claims.name ?? email ?? 'Google user', email, avatarUrl: claims.picture });
    res.redirect(`${config.webUrl}${returnTo}`);
  });

  router.get('/auth/github', (req, res) => {
    const g = github();
    if (!g) throw new HttpError(404, 'GitHub sign-in is not configured on this server');
    const state = arctic.generateState();
    const url = g.createAuthorizationURL(state, ['read:user', 'user:email']);
    res.cookie('oauth_state', state, tmpCookie()).cookie('oauth_return', safeReturn(req.query.returnTo), tmpCookie());
    res.redirect(url.toString());
  });

  router.get('/auth/github/callback', async (req, res) => {
    const g = github();
    if (!g) throw new HttpError(404, 'GitHub sign-in is not configured on this server');
    const { code, returnTo } = checkState(req, res);
    const tokens = await g.validateAuthorizationCode(code);
    const headers = { Authorization: `Bearer ${tokens.accessToken()}`, 'User-Agent': 'concord' };
    const gh = (await (await fetch('https://api.github.com/user', { headers })).json()) as { id: number; login: string; name?: string; avatar_url?: string };
    // The primary, verified address (the public profile email is not checked here).
    const emails = (await (await fetch('https://api.github.com/user/emails', { headers })).json().catch(() => [])) as { email: string; primary: boolean; verified: boolean }[];
    const email = Array.isArray(emails) ? emails.find((e) => e.primary && e.verified)?.email : undefined;
    await federatedSignIn(req, res, { provider: 'github', subject: String(gh.id), name: gh.name ?? gh.login, email, avatarUrl: gh.avatar_url });
    res.redirect(`${config.webUrl}${returnTo}`);
  });

  /*
   * Sign in with your own WebID (Solid-OIDC with DPoP). The WebID becomes the
   * account's WebID, so ADMIN_WEBIDS can name it directly.
   */
  router.get('/auth/solid/client.jsonld', (_req, res) => {
    res.type('application/ld+json').set('Cache-Control', 'public, max-age=300').send(JSON.stringify(clientIdDocument(), null, 2));
  });

  router.get('/auth/solid', async (req, res) => {
    if (!config.solidOidc.enabled) throw new HttpError(404, 'Signing in with Solid is turned off on this server');
    const returnTo = safeReturn(req.query.returnTo);
    // Only from Concord's own login page (or a typed address): otherwise a link elsewhere could
    // use this route to send people to any site that calls itself a Solid provider.
    if (req.get('sec-fetch-site') === 'cross-site' || req.get('sec-fetch-site') === 'same-site')
      return loginError(res, returnTo, 'Start signing in with your WebID from this page.');
    const input = typeof req.query.webId === 'string' ? req.query.webId.trim().slice(0, 2000) : '';
    if (!input) return loginError(res, returnTo, 'Enter your WebID, or the address of your Solid provider.');
    try {
      const { as } = await resolveIssuer(input);
      const { loginId, url } = await startLogin(as, returnTo);
      res.cookie(SOLID_COOKIE, loginId, tmpCookie());
      res.redirect(url);
    } catch (err) {
      if (!(err instanceof SolidLoginError)) console.warn(`[solid-oidc] could not start sign-in: ${(err as Error).message}`);
      loginError(res, returnTo, err instanceof SolidLoginError ? err.message : 'Couldn’t reach that Solid provider. Check the address and try again.');
    }
  });

  router.get('/auth/solid/callback', async (req, res) => {
    if (!config.solidOidc.enabled) throw new HttpError(404, 'Signing in with Solid is turned off on this server');
    const loginId = req.cookies?.[SOLID_COOKIE] as string | undefined;
    res.clearCookie(SOLID_COOKIE, { path: '/' });
    let done;
    try {
      done = await finishLogin(loginId, `${config.publicUrl}${req.originalUrl}`);
    } catch (err) {
      if (!(err instanceof SolidLoginError)) console.warn(`[solid-oidc] sign-in failed: ${(err as Error).message}`);
      return loginError(res, '/', err instanceof SolidLoginError ? err.message : 'Sign-in with Solid failed. Please try again.');
    }
    if (await managedWebId(done.webId)) return loginError(res, done.returnTo, 'That WebID was made for you by Concord: sign in the way you created your account.');
    const { user, sessionToken } = await federatedSignIn(req, res, { provider: 'solid', subject: done.webId, webId: done.webId, name: done.name });
    // Keep an administrator's login for this browser session (to read testers' pods as them); drop everyone else's.
    if (isAdmin(user, 'solid')) await keepAdminLogin(sessionToken, done.login);
    // Their private data goes to their own pod, written as them (step 5e).
    if (usesOwnPod(user)) {
      const kept = await keepOwnPodLogin(user.id, done.login, done.storage);
      if (kept === 'kept' && user.podUrl !== done.storage) await setPodUrl(user.id, done.storage!);
    }
    res.redirect(`${config.webUrl}${done.returnTo}`);
  });
}
