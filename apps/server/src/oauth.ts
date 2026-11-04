import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { InvalidGrantError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { createOAuthMetadata, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthConnection, OAuthRequestInfo, User } from '@concord/shared';
import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from 'express';
import { rateLimit as rateLimiter } from 'express-rate-limit';
import { config } from './config.js';
import { get, HttpError, list, put, remove } from './db.js';
import { newId } from './ids.js';
import { getUser, userForAgentToken } from './services/users.js';

/**
 * OAuth 2.1 for the MCP endpoint, following the MCP authorization spec:
 *
 *  - /mcp answers 401 with a WWW-Authenticate header pointing at its
 *    Protected Resource Metadata (RFC 9728), which names this server as the
 *    authorization server.
 *  - Clients discover the endpoints (RFC 8414), register themselves (dynamic
 *    client registration, RFC 7591, or a Client ID Metadata Document), and
 *    send the person to /authorize with PKCE.
 *  - /authorize hands over to the web app's consent page (/oauth/authorize),
 *    where the person signs in the usual way and clicks Allow. The client gets
 *    a code, swaps it for an access token and a rotating refresh token.
 *
 * So `claude mcp add --transport http concord https://<host>/mcp` is all an
 * agent needs: no token to copy. Personal tokens (Settings → Agent tokens)
 * still work for headless agents such as CI.
 *
 * Every URL is derived from the host the request came in on, so the same
 * server works behind any domain (the Vercel site, a custom domain, the VM's
 * own name) without configuration. Set PUBLIC_ORIGINS to pin the list.
 */

const ACCESS_TTL = 60 * 60; // 1 hour
const REFRESH_TTL = 60 * 24 * 60 * 60; // 60 days
const CODE_TTL = 5 * 60;
const REQUEST_TTL = 15 * 60;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const secret = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`;
const now = () => Math.floor(Date.now() / 1000);

interface ClientDoc {
  id: string;
  info: OAuthClientInformationFull;
  /** Client ID Metadata Documents are cached for a day. */
  fetchedAt?: number;
}
interface PendingRequest {
  id: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource?: string;
  issuer: string;
  expiresAt: number;
}
interface CodeDoc {
  id: string; // sha of the code
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}
interface GrantDoc {
  /** One grant per authorization; refresh tokens rotate within it. */
  id: string;
  clientId: string;
  clientName: string;
  userId: string;
  scopes: string[];
  resource?: string;
  createdAt: string;
  lastUsedAt?: string;
}
interface TokenDoc {
  id: string; // sha of the token
  grantId: string;
  kind: 'access' | 'refresh';
  expiresAt: number;
}

/* ------------------------------------------------------------------------ */
/* Origins                                                                   */
/* ------------------------------------------------------------------------ */

const allowedOrigins = () =>
  (process.env.PUBLIC_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);

const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i;

/**
 * The public origin this request was addressed to: the Vercel site (its
 * middleware sends X-Concord-Origin, which survives the VM's proxy, unlike
 * X-Forwarded-Host), a custom domain, or the backend's own name. When
 * PUBLIC_ORIGINS is set, unknown origins fall back to the first one listed.
 *
 * A forged header only changes the URLs in the forger's own responses: tokens
 * are bound to the origin they were issued for.
 */
export function publicOrigin(req: Request): string {
  const hinted = req.header('x-concord-origin')?.trim();
  const host = req.host;
  const origin = (hinted && ORIGIN_RE.test(hinted) ? hinted : host && /^[a-z0-9.-]+(:\d+)?$/i.test(host) ? `${req.protocol}://${host}` : config.webUrl).toLowerCase();
  const allow = allowedOrigins();
  return allow.length && !allow.includes(origin) ? (allow[0] ?? config.webUrl) : origin;
}

export const mcpUrlFor = (origin: string) => `${origin}/mcp`;
export const resourceMetadataUrlFor = (origin: string) => `${origin}/.well-known/oauth-protected-resource/mcp`;

/* ------------------------------------------------------------------------ */
/* Clients                                                                   */
/* ------------------------------------------------------------------------ */

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
const isPrivate = (ip: string) => (isIP(ip) === 4 ? PRIVATE_V4.some((r) => r.test(ip)) : /^(::1?|f[cd]|fe80|::ffff:(10|127|192\.168|169\.254)\.)/i.test(ip));

/** Fetch a Client ID Metadata Document (the client_id is an https URL that serves the client's metadata). */
async function fetchClientMetadata(clientId: string): Promise<OAuthClientInformationFull | undefined> {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return;
  }
  if (url.protocol !== 'https:' || url.hash || url.username || url.pathname === '/') return;
  if (process.env.OAUTH_ALLOW_PRIVATE_CLIENT_URLS !== 'true') {
    const addrs = await lookup(url.hostname, { all: true }).catch(() => []);
    if (!addrs.length || addrs.some((a) => isPrivate(a.address))) return;
  }
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } }).catch(() => undefined);
  if (!res?.ok) return;
  const body = await res.text();
  if (body.length > 64 * 1024) return;
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return;
  }
  if (doc.client_id !== clientId || !Array.isArray(doc.redirect_uris) || !doc.redirect_uris.every((u) => typeof u === 'string' && URL.canParse(u))) return;
  // Metadata documents describe public clients: no secret is ever issued.
  return { ...(doc as OAuthClientInformationFull), client_id: clientId, token_endpoint_auth_method: 'none', client_secret: undefined };
}

const clientsStore: OAuthRegisteredClientsStore = {
  async getClient(clientId) {
    const doc = get<ClientDoc>('oauthClients', clientId);
    if (doc && (!doc.fetchedAt || now() - doc.fetchedAt < 24 * 60 * 60)) return doc.info;
    if (clientId.startsWith('https://')) {
      const info = await fetchClientMetadata(clientId);
      if (info) {
        put<ClientDoc>('oauthClients', { id: clientId, info, fetchedAt: now() });
        return info;
      }
      return doc?.info;
    }
    return undefined;
  },
  registerClient(client) {
    const info = client as OAuthClientInformationFull;
    if (!info.client_id) info.client_id = newId('client');
    put<ClientDoc>('oauthClients', { id: info.client_id, info });
    return info;
  },
};

export const clientName = (c: OAuthClientInformationFull) => c.client_name?.trim() || (c.client_uri ? new URL(c.client_uri).host : 'An MCP client');

/* ------------------------------------------------------------------------ */
/* Tokens                                                                    */
/* ------------------------------------------------------------------------ */

function issueTokens(grant: GrantDoc): OAuthTokens {
  const access = secret('cna');
  const refresh = secret('cnr');
  put<TokenDoc>('oauthTokens', { id: sha(access), grantId: grant.id, kind: 'access', expiresAt: now() + ACCESS_TTL }, grant.id);
  put<TokenDoc>('oauthTokens', { id: sha(refresh), grantId: grant.id, kind: 'refresh', expiresAt: now() + REFRESH_TTL }, grant.id);
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: grant.scopes.join(' ') || undefined };
}

function revokeGrant(grantId: string) {
  for (const t of list<TokenDoc>('oauthTokens', grantId)) remove('oauthTokens', t.id);
  remove('oauthGrants', grantId);
}

const sameResource = (a: string | undefined, b: URL | string | undefined) => !a || !b || a.replace(/\/$/, '') === String(b).replace(/#.*$/, '').replace(/\/$/, '');

export const provider: OAuthServerProvider = {
  get clientsStore() {
    return clientsStore;
  },

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    const origin = publicOrigin(res.req);
    if (params.resource && !sameResource(mcpUrlFor(origin), params.resource)) throw new InvalidTargetError(`This server only issues tokens for ${mcpUrlFor(origin)}`);
    const pending: PendingRequest = {
      id: newId('authz'),
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes ?? [],
      resource: params.resource?.href,
      issuer: `${origin}/`,
      expiresAt: now() + REQUEST_TTL,
    };
    put('oauthRequests', pending);
    // The consent page is part of the web app, so it shares the person's session and sign-in options.
    res.redirect(302, `${origin}/oauth/authorize?request=${encodeURIComponent(pending.id)}`);
  },

  async challengeForAuthorizationCode(client, code) {
    const c = get<CodeDoc>('oauthCodes', sha(code));
    if (!c || c.clientId !== client.client_id || c.expiresAt < now()) throw new InvalidGrantError('Invalid or expired authorization code');
    return c.codeChallenge;
  },

  async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
    const c = get<CodeDoc>('oauthCodes', sha(code));
    // Codes are single use, whatever happens next.
    if (c) remove('oauthCodes', c.id);
    if (!c || c.clientId !== client.client_id || c.expiresAt < now()) throw new InvalidGrantError('Invalid or expired authorization code');
    if (redirectUri && redirectUri !== c.redirectUri) throw new InvalidGrantError('redirect_uri does not match the authorization request');
    if (resource && !sameResource(c.resource, resource)) throw new InvalidTargetError('resource does not match the authorization request');
    const grant: GrantDoc = {
      id: newId('grant'),
      clientId: client.client_id,
      clientName: clientName(client),
      userId: c.userId,
      scopes: c.scopes,
      resource: c.resource ?? resource?.href,
      createdAt: new Date().toISOString(),
    };
    put('oauthGrants', grant, c.userId);
    return issueTokens(grant);
  },

  async exchangeRefreshToken(client, refreshToken, _scopes, resource) {
    const t = get<TokenDoc>('oauthTokens', sha(refreshToken));
    const grant = t ? get<GrantDoc>('oauthGrants', t.grantId) : undefined;
    if (!t || t.kind !== 'refresh' || !grant || grant.clientId !== client.client_id || t.expiresAt < now()) throw new InvalidGrantError('Invalid or expired refresh token');
    if (resource && !sameResource(grant.resource, resource)) throw new InvalidTargetError('resource does not match the original grant');
    // Rotate: the old refresh token stops working (OAuth 2.1 for public clients).
    remove('oauthTokens', t.id);
    return issueTokens(grant);
  },

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const t = get<TokenDoc>('oauthTokens', sha(token));
    if (t?.kind === 'access') {
      const grant = get<GrantDoc>('oauthGrants', t.grantId);
      if (!grant || t.expiresAt < now()) throw new InvalidTokenError('The access token has expired');
      return {
        token,
        clientId: grant.clientId,
        scopes: grant.scopes,
        expiresAt: t.expiresAt,
        resource: grant.resource ? new URL(grant.resource) : undefined,
        extra: { userId: grant.userId, agentName: grant.clientName, grantId: grant.id },
      };
    }
    // Personal tokens from Settings, for agents that can't do a browser sign-in.
    const personal = userForAgentToken(token);
    if (personal) return { token, clientId: 'personal-token', scopes: [], extra: { userId: personal.user.id, agentName: personal.tokenName } };
    throw new InvalidTokenError('Invalid access token');
  },

  async revokeToken(client, request: OAuthTokenRevocationRequest) {
    const t = get<TokenDoc>('oauthTokens', sha(request.token));
    const grant = t ? get<GrantDoc>('oauthGrants', t.grantId) : undefined;
    if (t && grant?.clientId === client.client_id) remove('oauthTokens', t.id);
  },
};

/* ------------------------------------------------------------------------ */
/* Consent (called by the web app's /oauth/authorize page)                   */
/* ------------------------------------------------------------------------ */

function pendingRequest(id: string): PendingRequest {
  const p = get<PendingRequest>('oauthRequests', id);
  if (!p || p.expiresAt < now()) throw new HttpError(404, 'This sign-in link has expired. Go back to your agent and try connecting again.');
  return p;
}

export async function describeRequest(id: string): Promise<OAuthRequestInfo> {
  const p = pendingRequest(id);
  const client = await clientsStore.getClient(p.clientId);
  if (!client) throw new HttpError(404, 'The app asking for access is no longer registered. Try connecting again.');
  const redirect = new URL(p.redirectUri);
  return {
    id: p.id,
    clientName: clientName(client),
    clientUri: client.client_uri,
    logoUri: client.logo_uri,
    redirectHost: redirect.host,
    localRedirect: ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname),
    resource: p.resource,
  };
}

function finish(p: PendingRequest, params: Record<string, string>) {
  remove('oauthRequests', p.id);
  const url = new URL(p.redirectUri);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (p.state) url.searchParams.set('state', p.state);
  url.searchParams.set('iss', p.issuer);
  return url.href;
}

export function approveRequest(id: string, user: User): { redirect: string } {
  const p = pendingRequest(id);
  const code = secret('cnc');
  put<CodeDoc>('oauthCodes', {
    id: sha(code),
    clientId: p.clientId,
    userId: user.id,
    redirectUri: p.redirectUri,
    codeChallenge: p.codeChallenge,
    scopes: p.scopes,
    resource: p.resource,
    expiresAt: now() + CODE_TTL,
  });
  return { redirect: finish(p, { code }) };
}

export function denyRequest(id: string): { redirect: string } {
  return { redirect: finish(pendingRequest(id), { error: 'access_denied', error_description: 'The person declined to connect this app' }) };
}

export function listConnections(userId: string): OAuthConnection[] {
  return list<GrantDoc>('oauthGrants', userId)
    .map((g) => ({ id: g.id, clientName: g.clientName, createdAt: g.createdAt, lastUsedAt: g.lastUsedAt }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function disconnect(userId: string, grantId: string) {
  const g = get<GrantDoc>('oauthGrants', grantId);
  if (!g || g.userId !== userId) throw new HttpError(404, 'Connection not found');
  revokeGrant(grantId);
}

/** Who an MCP request is acting for. Undefined means "send a 401 with the metadata link". */
export async function authenticateMcp(req: Request): Promise<{ user: User; agentName: string; error?: undefined } | { error: 'missing' | 'invalid' }> {
  const header = req.header('authorization');
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return { error: 'missing' };
  try {
    const info = await provider.verifyAccessToken(token);
    if (info.resource && !sameResource(mcpUrlFor(publicOrigin(req)), info.resource)) return { error: 'invalid' };
    const user = getUser(String(info.extra?.userId));
    if (!user) return { error: 'invalid' };
    const grantId = info.extra?.grantId as string | undefined;
    if (grantId) {
      const g = get<GrantDoc>('oauthGrants', grantId);
      // Record use at most once a minute.
      if (g && (!g.lastUsedAt || Date.now() - Date.parse(g.lastUsedAt) > 60_000)) put('oauthGrants', { ...g, lastUsedAt: new Date().toISOString() }, g.userId);
    }
    return { user, agentName: String(info.extra?.agentName ?? 'Agent') };
  } catch {
    return { error: 'invalid' };
  }
}

/* ------------------------------------------------------------------------ */
/* Routes                                                                    */
/* ------------------------------------------------------------------------ */

// One set of limits for every domain (built once, not per origin). The client IP comes from X-Forwarded-For.
const limiter = (windowMs: number, limit: number) =>
  rateLimiter({ windowMs, limit, standardHeaders: true, legacyHeaders: false, validate: { trustProxy: false, xForwardedForHeader: false }, message: { error: 'too_many_requests', error_description: 'Too many requests. Try again later.' } });
const limits: [RegExp, RequestHandler][] = [
  [/^\/register/, limiter(60 * 60 * 1000, 30)],
  [/^\/(authorize|token|revoke)/, limiter(15 * 60 * 1000, 300)],
];
const rateLimit = false as const;

function metadataFor(origin: string) {
  const issuerUrl = new URL(`${origin}/`);
  return {
    ...createOAuthMetadata({ provider, issuerUrl, serviceDocumentationUrl: new URL(`${origin}/connect`) }),
    client_id_metadata_document_supported: true,
    revocation_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
  };
}

const routers = new Map<string, Router>();
function routerFor(origin: string): Router {
  let r = routers.get(origin);
  if (r) return r;
  r = express.Router();
  const cors = (_req: Request, res: Response, next: NextFunction) => {
    res.set('Access-Control-Allow-Origin', '*');
    next();
  };
  // Advertise Client ID Metadata Document support on top of the SDK's metadata.
  r.get('/.well-known/oauth-authorization-server', cors, (_req, res) => res.json(metadataFor(origin)));
  // Some clients look for the resource metadata at the root rather than under /mcp.
  r.get('/.well-known/oauth-protected-resource', cors, (_req, res) =>
    res.json({ resource: mcpUrlFor(origin), authorization_servers: [`${origin}/`], resource_name: 'Concord', resource_documentation: `${origin}/connect`, bearer_methods_supported: ['header'] }),
  );
  r.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(`${origin}/`),
      resourceServerUrl: new URL(mcpUrlFor(origin)),
      resourceName: 'Concord',
      serviceDocumentationUrl: new URL(`${origin}/connect`),
      authorizationOptions: { rateLimit },
      tokenOptions: { rateLimit },
      revocationOptions: { rateLimit },
      clientRegistrationOptions: { rateLimit, clientSecretExpirySeconds: 0 },
    }),
  );
  if (routers.size > 50) routers.clear();
  routers.set(origin, r);
  return r;
}

const OAUTH_PATHS = /^\/(\.well-known\/(oauth-authorization-server|oauth-protected-resource)|authorize|token|register|revoke)(\/|$)/;

/** Mount at the app root. Builds one router per public origin, so every domain gets matching metadata. */
export function oauthRoutes(req: Request, res: Response, next: NextFunction) {
  if (!OAUTH_PATHS.test(req.path)) return next();
  const origin = publicOrigin(req);
  const limit = limits.find(([re]) => re.test(req.path))?.[1];
  try {
    if (limit) return void limit(req, res, () => routerFor(origin)(req, res, next));
    routerFor(origin)(req, res, next);
  } catch (err) {
    next(err);
  }
}

