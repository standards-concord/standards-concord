import * as arctic from 'arctic';
import type { NextFunction, Request, Response, Router } from 'express';
import type { User } from '@concord/shared';
import { config } from './config.js';
import { HttpError } from './db.js';
import { createSession, destroySession, sessionUser, upsertFederatedUser } from './services/users.js';

export const SESSION_COOKIE = 'concord_session';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export function sessionMiddleware(req: Request, _res: Response, next: NextFunction) {
  const user = sessionUser(req.cookies?.[SESSION_COOKIE]);
  // ADMIN_EMAILS makes people who sign in with Google or GitHub administrators of the deployment.
  const federated = user?.providers.some((p) => p.provider === 'google' || p.provider === 'github');
  req.user = user && federated && !user.simulated && user.email && config.adminEmails.includes(user.email.toLowerCase()) ? { ...user, isPlatformAdmin: true } : user;
  next();
}

export function requireUser(req: Request): User {
  if (!req.user) throw new HttpError(401, 'Sign in first');
  return req.user;
}

export function setSessionCookie(res: Response, userId: string) {
  res.cookie(SESSION_COOKIE, createSession(userId), {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.publicUrl.startsWith('https://'),
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

const google = () =>
  config.google.clientId && config.google.clientSecret ? new arctic.Google(config.google.clientId, config.google.clientSecret, `${config.publicUrl}/auth/google/callback`) : undefined;
const github = () =>
  config.github.clientId && config.github.clientSecret ? new arctic.GitHub(config.github.clientId, config.github.clientSecret, `${config.publicUrl}/auth/github/callback`) : undefined;

export const providers = () => ({ google: !!google(), github: !!github(), demo: config.demoMode });

const tmpCookie = () => ({ httpOnly: true, sameSite: 'lax' as const, secure: config.publicUrl.startsWith('https://'), maxAge: 10 * 60 * 1000, path: '/' });
const OAUTH_COOKIES = ['oauth_state', 'oauth_verifier', 'oauth_return'];

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
function signInAs(req: Request, res: Response, userId: string) {
  destroySession(req.cookies?.[SESSION_COOKIE]);
  setSessionCookie(res, userId);
}
const safeReturn = (r: unknown) => (typeof r === 'string' && r.startsWith('/') && !r.startsWith('//') ? r : '/');

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
    const user = await upsertFederatedUser({ provider: 'google', subject: claims.sub, name: claims.name ?? email ?? 'Google user', email, avatarUrl: claims.picture });
    signInAs(req, res, user.id);
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
    const user = await upsertFederatedUser({ provider: 'github', subject: String(gh.id), name: gh.name ?? gh.login, email, avatarUrl: gh.avatar_url });
    signInAs(req, res, user.id);
    res.redirect(`${config.webUrl}${returnTo}`);
  });
}
