import * as arctic from 'arctic';
import type { NextFunction, Request, Response, Router } from 'express';
import type { User } from '@concord/shared';
import { config } from './config.js';
import { HttpError } from './db.js';
import { createSession, sessionUser, upsertFederatedUser } from './services/users.js';

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
  req.user = sessionUser(req.cookies?.[SESSION_COOKIE]);
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

const tmpCookie = { httpOnly: true, sameSite: 'lax' as const, maxAge: 10 * 60 * 1000, path: '/' };
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
    res.cookie('oauth_state', state, tmpCookie).cookie('oauth_verifier', verifier, tmpCookie).cookie('oauth_return', safeReturn(req.query.returnTo), tmpCookie);
    res.redirect(url.toString());
  });

  router.get('/auth/google/callback', async (req, res) => {
    const g = google();
    const { code, state } = req.query as Record<string, string>;
    if (!g || !code || state !== req.cookies.oauth_state) throw new HttpError(400, 'Sign-in failed: invalid state. Please try again.');
    const tokens = await g.validateAuthorizationCode(code, req.cookies.oauth_verifier);
    const claims = arctic.decodeIdToken(tokens.idToken()) as { sub: string; name?: string; email?: string; picture?: string };
    const user = await upsertFederatedUser({ provider: 'google', subject: claims.sub, name: claims.name ?? claims.email ?? 'Google user', email: claims.email, avatarUrl: claims.picture });
    setSessionCookie(res, user.id);
    res.redirect(`${config.webUrl}${safeReturn(req.cookies.oauth_return)}`);
  });

  router.get('/auth/github', (req, res) => {
    const g = github();
    if (!g) throw new HttpError(404, 'GitHub sign-in is not configured on this server');
    const state = arctic.generateState();
    const url = g.createAuthorizationURL(state, ['read:user', 'user:email']);
    res.cookie('oauth_state', state, tmpCookie).cookie('oauth_return', safeReturn(req.query.returnTo), tmpCookie);
    res.redirect(url.toString());
  });

  router.get('/auth/github/callback', async (req, res) => {
    const g = github();
    const { code, state } = req.query as Record<string, string>;
    if (!g || !code || state !== req.cookies.oauth_state) throw new HttpError(400, 'Sign-in failed: invalid state. Please try again.');
    const tokens = await g.validateAuthorizationCode(code);
    const headers = { Authorization: `Bearer ${tokens.accessToken()}`, 'User-Agent': 'concord' };
    const gh = (await (await fetch('https://api.github.com/user', { headers })).json()) as { id: number; login: string; name?: string; email?: string; avatar_url?: string };
    let email = gh.email;
    if (!email) {
      const emails = (await (await fetch('https://api.github.com/user/emails', { headers })).json().catch(() => [])) as { email: string; primary: boolean; verified: boolean }[];
      email = Array.isArray(emails) ? emails.find((e) => e.primary && e.verified)?.email : undefined;
    }
    const user = await upsertFederatedUser({ provider: 'github', subject: String(gh.id), name: gh.name ?? gh.login, email, avatarUrl: gh.avatar_url });
    setSessionCookie(res, user.id);
    res.redirect(`${config.webUrl}${safeReturn(req.cookies.oauth_return)}`);
  });
}
