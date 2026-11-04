import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { InvalidClientMetadataError, InvalidGrantError, InvalidRequestError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { createOAuthMetadata, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { OAuthClientMetadataSchema, type OAuthClientInformationFull, type OAuthTokenRevocationRequest, type OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthConnection, OAuthRequestInfo, User } from '@concord/shared';
import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from 'express';
import { ipKeyGenerator, rateLimit as rateLimiter } from 'express-rate-limit';
import { config } from './config.js';
import { checkpoint, claim, get, HttpError, list, put, remove, take, transaction } from './db.js';
import { newId } from './ids.js';
import { FetchError, safeFetchText } from './safeFetch.js';
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
 * Every URL is built for the domain the request came in on, as long as that
 * domain is trusted (see publicOrigin): the authenticated Vercel middleware
 * vouches for its own domains, and PUBLIC_URL / PUBLIC_ORIGINS list the rest.
 * Anything else gets PUBLIC_URL. Tokens are bound to the MCP URL they were
 * issued for.
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
  /** Which version of the metadata-document checks admitted it; older cache entries are checked again. */
  checks?: number;
  /** Registered confidential clients: sha256 of the client secret. The secret itself is only ever in the registration response. */
  secretHash?: string;
}
interface PendingRequest {
  id: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource: string;
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
  resource: string;
  expiresAt: number;
}
interface GrantDoc {
  /** One grant per authorization; refresh tokens rotate within it. */
  id: string;
  clientId: string;
  clientName: string;
  userId: string;
  scopes: string[];
  /** The MCP URL these tokens are for (RFC 8707). Always set. */
  resource: string;
  createdAt: string;
  lastUsedAt?: string;
}
interface TokenDoc {
  id: string; // sha of the token
  grantId: string;
  kind: 'access' | 'refresh';
  expiresAt: number;
  /** Set when a refresh token has been rotated. Presenting it again means it leaked: the whole grant is revoked. */
  consumedAt?: number;
}

/* ------------------------------------------------------------------------ */
/* Origins                                                                   */
/* ------------------------------------------------------------------------ */

const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i;
const norm = (o: string) => o.trim().replace(/\/$/, '').toLowerCase();

/** The domains this server answers for: PUBLIC_URL, WEB_URL and any PUBLIC_ORIGINS (comma separated). */
export const trustedOrigins = () => [...new Set([config.publicUrl, config.webUrl, ...(process.env.PUBLIC_ORIGINS ?? '').split(',')].map(norm).filter((o) => ORIGIN_RE.test(o)))];

/**
 * Whether this request came through Concord's own Vercel middleware: it sends
 * CONCORD_PROXY_SECRET, which only it and this server know. Only then are the
 * X-Concord-Origin and X-Concord-Client-IP headers believed.
 */
export function fromTrustedProxy(req: Request): boolean {
  const expected = process.env.CONCORD_PROXY_SECRET;
  const got = req.header('x-concord-proxy-secret');
  if (!expected || !got) return false;
  const a = Buffer.from(sha(expected));
  const b = Buffer.from(sha(got));
  return timingSafeEqual(a, b);
}

/**
 * The public origin this request was addressed to, used for every OAuth URL
 * and for the audience of tokens:
 *  - from the authenticated Vercel middleware, the site's own origin (so a new
 *    Vercel domain works without backend changes);
 *  - otherwise the origin in trustedOrigins() whose host is the request's own
 *    Host header. X-Forwarded-Host and X-Forwarded-Proto are never consulted,
 *    and the scheme comes from configuration, not the request;
 *  - otherwise, when CONCORD_PROXY_SECRET is set, nothing: every legitimate
 *    request then names its origin, so the caller refuses the request (421);
 *  - otherwise PUBLIC_URL. Without the secret, Vercel's forwarded requests
 *    arrive with the backend's own host name, so any unlisted host is defined
 *    as an alias of the canonical resource rather than a resource of its own.
 * Unauthenticated X-Concord-Origin headers are ignored.
 */
export function publicOrigin(req: Request): string | undefined {
  const hinted = req.header('x-concord-origin');
  if (hinted && ORIGIN_RE.test(hinted.trim()) && fromTrustedProxy(req)) return norm(hinted);
  const host = req.headers.host?.trim().toLowerCase();
  const direct = host ? trustedOrigins().find((o) => new URL(o).host === host) : undefined;
  if (direct) return direct;
  if (process.env.CONCORD_PROXY_SECRET) return undefined;
  return norm(config.publicUrl);
}

/** The answer for a request whose origin publicOrigin() refuses. */
export function refuseUnknownOrigin(res: Response) {
  res.status(421).json({ error: 'misdirected_request', error_description: 'This address does not serve Concord. Use the address on the Connect page.' });
}

export const mcpUrlFor = (origin: string) => `${origin}/mcp`;
export const resourceMetadataUrlFor = (origin: string) => `${origin}/.well-known/oauth-protected-resource/mcp`;

/* ------------------------------------------------------------------------ */
/* Clients                                                                   */
/* ------------------------------------------------------------------------ */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const BLOCKED_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'about:', 'ftp:', 'ws:', 'wss:']);

/**
 * Where we will send a browser back to after consent: https, http only on
 * this computer (CLI agents' loopback callbacks), or a reverse-domain
 * private-use scheme for native apps (RFC 8252, e.g. com.example.app:/cb).
 * Never javascript:, data: and the like. No fragments or credentials.
 */
export function isSafeRedirectUri(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (BLOCKED_SCHEMES.has(u.protocol)) return false;
  if (u.protocol === 'https:') return !!u.hostname;
  if (u.protocol === 'http:') return LOOPBACK.has(u.hostname);
  return /^[a-z][a-z0-9+-]*(\.[a-z0-9+-]+)+:$/.test(u.protocol);
}

const httpsUrl = (v: unknown) => typeof v === 'string' && URL.canParse(v) && new URL(v).protocol === 'https:';

/** Checks a client's metadata (from registration or a metadata document) before we trust any of it. */
export function validateClientMetadata(doc: unknown): { ok: true; info: OAuthClientInformationFull } | { ok: false; reason: string } {
  const parsed = OAuthClientMetadataSchema.safeParse(doc);
  if (!parsed.success) return { ok: false, reason: parsed.error.message };
  const m = parsed.data;
  if (!m.redirect_uris.length) return { ok: false, reason: 'redirect_uris is empty' };
  const bad = m.redirect_uris.find((u) => !isSafeRedirectUri(u));
  if (bad) return { ok: false, reason: `redirect URI not allowed: ${bad}` };
  for (const field of ['client_uri', 'logo_uri', 'policy_uri', 'tos_uri'] as const) {
    if (m[field] !== undefined && !httpsUrl(m[field])) return { ok: false, reason: `${field} must be an https URL` };
  }
  if (m.client_name !== undefined && (m.client_name.length > 100 || /[\u0000-\u001f]/.test(m.client_name))) return { ok: false, reason: 'client_name is too long or has control characters' };
  return { ok: true, info: { ...(doc as object), ...m } as OAuthClientInformationFull };
}

const SHARED_SECRET_METHODS = new Set(['client_secret_basic', 'client_secret_post', 'client_secret_jwt']);

/**
 * Why a client metadata document's authentication fields rule it out, if they do (CIMD draft -03, §4.1 and §5).
 * ChatGPT lists every method it can use in token_endpoint_auth_methods_supported (no order) and a preference
 * in the singular field, which must be one of them. Shared-secret methods are meaningless in a public
 * document. Concord only supports `none` for these clients, so the document must allow it; a document that
 * names no method at all is a public client, as the draft says.
 */
export function cimdAuthProblem(doc: Record<string, unknown>): string | undefined {
  const list = doc.token_endpoint_auth_methods_supported;
  const one = doc.token_endpoint_auth_method;
  if (list !== undefined && (!Array.isArray(list) || !list.length || !list.every((m) => typeof m === 'string'))) return 'token_endpoint_auth_methods_supported must be a non-empty list of strings';
  if (one !== undefined && typeof one !== 'string') return 'token_endpoint_auth_method must be a string';
  const methods = [...((list as string[] | undefined) ?? []), ...(one === undefined ? [] : [one as string])];
  if (methods.some((m) => SHARED_SECRET_METHODS.has(m))) return 'a metadata document cannot use shared-secret authentication';
  if (list !== undefined && one !== undefined && !(list as string[]).includes(one as string)) return 'token_endpoint_auth_method is not in token_endpoint_auth_methods_supported';
  const allowsNone = list !== undefined ? (list as string[]).includes('none') : one === undefined || one === 'none';
  return allowsNone ? undefined : 'the client requires authentication Concord does not support (only none)';
}

/** Token endpoint authentication Concord supports; also what the authorization server metadata advertises. */
const AUTH_METHODS = ['none', 'client_secret_post'];

const CIMD_FRESH = 24 * 60 * 60;
/** Bump when fetchClientMetadata starts refusing something it used to accept. */
const CIMD_CHECKS = 3;
/** After a failed refresh (network error, timeout, 5xx), a cached document may be used this much longer, then never. */
const CIMD_STALE_GRACE = 60 * 60;

type MetadataFetcher = (url: URL) => Promise<string>;
let fetchMetadata: MetadataFetcher = (url) => safeFetchText(url, { maxBytes: 64 * 1024, timeoutMs: 5000 });
/** Tests only. */
export const setClientMetadataFetcher = (f: MetadataFetcher) => void (fetchMetadata = f);

type CimdResult = { kind: 'ok'; info: OAuthClientInformationFull } | { kind: 'invalid' } | { kind: 'unavailable' };

/** Fetch and validate a Client ID Metadata Document (the client_id is an https URL serving the client's metadata). */
async function fetchClientMetadata(clientId: string): Promise<CimdResult> {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return { kind: 'invalid' };
  }
  if (url.protocol !== 'https:' || url.hash || url.username || url.password || url.pathname === '/') return { kind: 'invalid' };
  let body: string;
  try {
    body = await fetchMetadata(url);
  } catch (err) {
    const kind = err instanceof FetchError ? err.kind : 'unavailable';
    return kind === 'unavailable' || kind === 'busy' ? { kind: 'unavailable' } : { kind: 'invalid' };
  }
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return { kind: 'invalid' };
  }
  if (!doc || typeof doc !== 'object' || doc.client_id !== clientId) return { kind: 'invalid' };
  // Concord only takes metadata-document clients as public clients (PKCE, no client authentication). That is
  // only safe when the document says the client may work that way: a client that insists on private_key_jwt
  // is refused rather than quietly downgraded, so a leaked refresh token can't be used without its key.
  if (cimdAuthProblem(doc)) return { kind: 'invalid' };
  const checked = validateClientMetadata({ ...doc, token_endpoint_auth_method: 'none' });
  if (!checked.ok) return { kind: 'invalid' };
  return { kind: 'ok', info: { ...checked.info, client_id: clientId, client_secret: undefined } };
}

/**
 * A registered (not metadata-document) client. Moves a secret stored by older code into a hash, so the
 * stored client never carries a usable secret; registeredClientAuth checks it instead of the SDK.
 */
function registeredClient(clientId: string): ClientDoc | undefined {
  const doc = get<ClientDoc>('oauthClients', clientId);
  return doc?.info.client_secret ? hashSecret(doc) : doc;
}
function hashSecret(doc: ClientDoc): ClientDoc {
  const { client_secret, ...info } = doc.info;
  const migrated = { ...doc, info: info as OAuthClientInformationFull, secretHash: sha(client_secret!) };
  put<ClientDoc>('oauthClients', migrated);
  return migrated;
}

/** Run at startup: hash every client secret older code stored in plain text, and leave no copy in the WAL. */
export function migrateClientSecrets(): number {
  const n = transaction(() => {
    const plain = list<ClientDoc>('oauthClients').filter((d) => d.info.client_secret);
    for (const d of plain) hashSecret(d);
    return plain.length;
  });
  if (n) checkpoint();
  return n;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
/** Constant-time check of a presented secret against its stored hash. A malformed stored hash never matches. */
const sameSecret = (given: string, hash: string) => SHA256_HEX.test(hash) && timingSafeEqual(Buffer.from(sha(given), 'hex'), Buffer.from(hash, 'hex'));

const clientsStore: OAuthRegisteredClientsStore = {
  async getClient(clientId) {
    if (!clientId.startsWith('https://')) return registeredClient(clientId)?.info;
    const doc = get<ClientDoc>('oauthClients', clientId);
    const age = doc?.fetchedAt && doc.checks === CIMD_CHECKS ? now() - doc.fetchedAt : Infinity;
    if (doc && age < CIMD_FRESH) return doc.info;
    const r = await fetchClientMetadata(clientId);
    if (r.kind === 'ok') {
      put<ClientDoc>('oauthClients', { id: clientId, info: r.info, fetchedAt: now(), checks: CIMD_CHECKS });
      return r.info;
    }
    if (r.kind === 'invalid') {
      // Removed or replaced with something we won't accept: forget the old one at once.
      if (doc) remove('oauthClients', clientId);
      return undefined;
    }
    return doc && age < CIMD_FRESH + CIMD_STALE_GRACE ? doc.info : undefined;
  },
  registerClient(client) {
    const method = client.token_endpoint_auth_method;
    if (method !== undefined && !AUTH_METHODS.includes(method))
      throw new InvalidClientMetadataError(`token_endpoint_auth_method ${method} is not supported; use none (with PKCE) or client_secret_post`);
    const checked = validateClientMetadata(client);
    if (!checked.ok) throw new InvalidClientMetadataError(checked.reason);
    const info = { ...checked.info, ...client } as OAuthClientInformationFull;
    if (!info.client_id) info.client_id = newId('client');
    // RFC 7591's default (client_secret_basic) isn't supported; the SDK has issued a secret, so say how to send it.
    if (method === undefined) info.token_endpoint_auth_method = 'client_secret_post';
    if (info.token_endpoint_auth_method !== 'none' && !info.client_secret) throw new InvalidClientMetadataError('a confidential client needs a secret');
    const { client_secret, ...stored } = info;
    put<ClientDoc>('oauthClients', { id: info.client_id, info: stored as OAuthClientInformationFull, secretHash: client_secret ? sha(client_secret) : undefined });
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

/** Revoke a connection and every token in its family, all at once. Not for use inside another transaction. */
function revokeGrant(grantId: string) {
  transaction(() => revokeGrantNow(grantId));
}
function revokeGrantNow(grantId: string) {
  for (const t of list<TokenDoc>('oauthTokens', grantId)) remove('oauthTokens', t.id);
  remove('oauthGrants', grantId);
}

/** Resource indicators must name exactly this server's MCP URL (a trailing slash is tolerated, fragments are not). */
const sameResource = (expected: string, given: URL | string) => {
  const g = String(given);
  return !g.includes('#') && g.replace(/\/$/, '') === expected.replace(/\/$/, '');
};

export const provider: OAuthServerProvider = {
  get clientsStore() {
    return clientsStore;
  },

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    const origin = publicOrigin(res.req);
    if (!origin) throw new InvalidRequestError('This address does not serve Concord');
    const resource = mcpUrlFor(origin);
    // Clients that don't send a resource indicator get tokens for this server's MCP URL anyway: tokens are never audience-free.
    if (params.resource && !sameResource(resource, params.resource)) throw new InvalidTargetError(`This server only issues tokens for ${resource}`);
    // The SDK has matched this against the client's registered URIs, which we validated; check again before sending a browser there.
    if (!isSafeRedirectUri(params.redirectUri)) throw new InvalidRequestError('redirect_uri is not allowed');
    const pending: PendingRequest = {
      id: newId('authz'),
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes ?? [],
      resource,
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
    // Codes are single use, whatever happens next: taking it deletes it, and only one caller can take it.
    const c = take<CodeDoc>('oauthCodes', sha(code));
    if (!c || c.clientId !== client.client_id || c.expiresAt < now()) throw new InvalidGrantError('Invalid or expired authorization code');
    if (redirectUri && redirectUri !== c.redirectUri) throw new InvalidGrantError('redirect_uri does not match the authorization request');
    if (resource && !sameResource(c.resource, resource)) throw new InvalidTargetError('resource does not match the authorization request');
    if (!c.resource) throw new InvalidGrantError('Invalid authorization code');
    const grant: GrantDoc = {
      id: newId('grant'),
      clientId: client.client_id,
      clientName: clientName(client),
      userId: c.userId,
      scopes: c.scopes,
      resource: c.resource,
      createdAt: new Date().toISOString(),
    };
    return transaction(() => {
      put('oauthGrants', grant, c.userId);
      return issueTokens(grant);
    });
  },

  async exchangeRefreshToken(client, refreshToken, _scopes, resource) {
    // One transaction (write lock taken before reading) covers checking, consuming, rotating and
    // revoking. Consuming is also a single conditional UPDATE, so of two refreshes racing with the
    // same token exactly one wins; the other is treated as a replay.
    const outcome = transaction((): { tokens: OAuthTokens } | { error: Error } => {
      const t = get<TokenDoc>('oauthTokens', sha(refreshToken));
      const grant = t ? get<GrantDoc>('oauthGrants', t.grantId) : undefined;
      if (!t || t.kind !== 'refresh' || !grant || grant.clientId !== client.client_id) return { error: new InvalidGrantError('Invalid or expired refresh token') };
      const replay = () => {
        // A rotated refresh token came back: someone has a copy. Revoke the whole family (RFC 9700 §4.14.2).
        revokeGrantNow(grant.id);
        return { error: new InvalidGrantError('This refresh token was already used. The connection has been revoked; sign in again.') };
      };
      if (t.consumedAt) return replay();
      if (t.expiresAt < now()) return { error: new InvalidGrantError('Invalid or expired refresh token') };
      if (!grant.resource) {
        revokeGrantNow(grant.id);
        return { error: new InvalidGrantError('This connection predates audience-bound tokens; sign in again.') };
      }
      if (resource && !sameResource(grant.resource, resource)) return { error: new InvalidTargetError('resource does not match the original grant') };
      // Rotate, keeping the old token's hash (marked consumed) so a replay is recognised.
      if (!claim<TokenDoc>('oauthTokens', t.id, 'consumedAt', now())) return replay();
      return { tokens: issueTokens(grant) };
    });
    if ('error' in outcome) throw outcome.error;
    return outcome.tokens;
  },

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const t = get<TokenDoc>('oauthTokens', sha(token));
    if (t?.kind === 'access') {
      const grant = get<GrantDoc>('oauthGrants', t.grantId);
      if (!grant || !grant.resource || t.expiresAt < now()) throw new InvalidTokenError('The access token has expired');
      return {
        token,
        clientId: grant.clientId,
        scopes: grant.scopes,
        expiresAt: t.expiresAt,
        resource: new URL(grant.resource),
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
    // Revoking either token ends the whole connection, as a person disconnecting would.
    if (t && grant?.clientId === client.client_id) revokeGrant(grant.id);
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
  if (!isSafeRedirectUri(p.redirectUri)) throw new HttpError(400, 'This app’s return address is not allowed.');
  const redirect = new URL(p.redirectUri);
  return {
    id: p.id,
    clientName: clientName(client),
    clientUri: client.client_uri,
    logoUri: client.logo_uri,
    publisher: client.client_id.startsWith('https://') ? new URL(client.client_id).host : undefined,
    ...(redirect.protocol === 'https:' || redirect.protocol === 'http:'
      ? { redirectHost: redirect.host, redirectKind: LOOPBACK.has(redirect.hostname) ? ('local' as const) : ('web' as const) }
      : // A native app's link: anything after the scheme is up to the app, so it says nothing about who receives access.
        { redirectHost: redirect.protocol, redirectKind: 'native' as const }),
    localRedirect: (redirect.protocol === 'https:' || redirect.protocol === 'http:') && LOOPBACK.has(redirect.hostname),
    resource: p.resource,
  };
}

function finish(p: PendingRequest, params: Record<string, string>) {
  remove('oauthRequests', p.id);
  if (!isSafeRedirectUri(p.redirectUri)) throw new HttpError(400, 'This app’s return address is not allowed.');
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
    // OAuth tokens are only good for the MCP URL they were issued for. Personal tokens are not audience-bound.
    const origin = publicOrigin(req);
    if (info.clientId !== 'personal-token' && (!origin || !info.resource || !sameResource(mcpUrlFor(origin), info.resource))) return { error: 'invalid' };
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
/**
 * Rate-limit by the person's IP. Behind Vercel and Caddy, req.ip is Vercel's
 * egress address, so use the client IP the authenticated middleware passes on.
 */
export function clientIp(req: Request): string {
  const passed = req.header('x-concord-client-ip')?.trim();
  if (passed && isIP(passed) && fromTrustedProxy(req)) return passed;
  return req.ip ?? 'unknown';
}
const limiter = (windowMs: number, limit: number) =>
  rateLimiter({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(clientIp(req as Request)),
    validate: { trustProxy: false, xForwardedForHeader: false },
    message: { error: 'too_many_requests', error_description: 'Too many requests. Try again later.' },
  });
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
  // Client authentication for /token and /revoke, before the SDK sees the request. Concord supports none
  // (public clients, PKCE) and client_secret_post. Anything else a client sends expects to be checked, so it
  // is refused rather than ignored: client assertions, HTTP Basic, or a secret from a public client.
  // Registered clients' secrets are stored hashed and compared in constant time here; the stored client has
  // no client_secret, so the SDK's own check (plain string comparison) never runs.
  const clientAuth = (req: Request, res: Response, next: NextFunction) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const refuse = (why: string) => res.status(401).json({ error: 'invalid_client', error_description: why });
    if (body.client_assertion !== undefined || body.client_assertion_type !== undefined)
      return refuse('Client assertions (private_key_jwt) are not supported. Authenticate with none (PKCE) or client_secret_post.');
    if (req.headers.authorization !== undefined) return refuse('HTTP Basic client authentication is not supported. Send client_secret in the request body, or nothing for a public client.');
    if (typeof body.client_id !== 'string') return next(); // the SDK answers invalid_request
    const doc = body.client_id.startsWith('https://') ? undefined : registeredClient(body.client_id);
    const given = body.client_secret;
    if (doc?.secretHash) {
      if (typeof given !== 'string' || !sameSecret(given, doc.secretHash)) return refuse('The client secret is missing or wrong.');
      const expires = doc.info.client_secret_expires_at;
      if (expires && expires < now()) return refuse('The client secret has expired. Register the client again.');
    } else if (given !== undefined) {
      return refuse('This is a public client (none): send no client_secret.');
    }
    delete body.client_secret;
    next();
  };
  // Mounted with use() so it covers every path the SDK's /token and /revoke routers answer (they match
  // prefixes, so /token/ and /token// reach them too), not just the exact paths.
  const postOnly = (h: RequestHandler): RequestHandler => (req, res, next) => (req.method === 'POST' ? h(req, res, next) : next());
  for (const path of ['/token', '/revoke']) r.use(path, postOnly(cors), postOnly(express.urlencoded({ extended: false })), postOnly(clientAuth));
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
/** The only paths the OAuth endpoints answer on; anything else that looks like one (/token/, /token//) is not found. */
const CANONICAL_OAUTH_PATHS = new Set(['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/authorize', '/token', '/register', '/revoke']);

export function oauthRoutes(req: Request, res: Response, next: NextFunction) {
  if (!OAUTH_PATHS.test(req.path)) return next();
  if (!CANONICAL_OAUTH_PATHS.has(req.path)) return void res.status(404).json({ error: 'not_found' });
  const origin = publicOrigin(req);
  if (!origin) return refuseUnknownOrigin(res);
  const limit = limits.find(([re]) => re.test(req.path))?.[1];
  try {
    if (limit) return void limit(req, res, () => routerFor(origin)(req, res, next));
    routerFor(origin)(req, res, next);
  } catch (err) {
    next(err);
  }
}

