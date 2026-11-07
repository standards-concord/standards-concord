import { lookup as dnsLookupAll } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import * as oauth from 'oauth4webapi';
import { Parser, type Quad } from 'n3';
import { config } from './config.js';
import { insertOnce, removeWhereAtMost, reserveCounters, take } from './db.js';
import { withLease } from './lease.js';
import { sealingAvailable } from './sealed.js';
import { ConnectionPool, FetchError, ipLiteral, isPublicAddress, safeRequest } from './safeFetch.js';
import { refuseWhenReadOnly } from './db.js';

/**
 * Signing in with your own WebID (Solid-OIDC), as a relying party.
 *
 * Concord sends the browser to the person's OpenID provider (the one their
 * WebID profile names), exchanges the code (PKCE, nonce) for a DPoP-bound access
 * token and a signed ID token, and then checks for itself that the WebID's
 * profile lists the token's verified issuer as a `solid:oidcIssuer`. Without
 * that last check any provider could claim any WebID.
 *
 * The provider's metadata is fetched once, when sign-in starts, and that same
 * metadata is used to the end. Every request (discovery, registration, token,
 * JWKS, refresh, profiles) goes through `guardedFetch`: https only, public
 * addresses only (checked on the address actually connected to, IP literals
 * included), no redirects, a byte cap and one deadline over the whole body.
 * Only the operator's own Solid server and SOLID_TRUSTED_ISSUERS are exempt.
 */

const SOLID_OIDC_ISSUER = 'http://www.w3.org/ns/solid/terms#oidcIssuer';
const FOAF_NAME = 'http://xmlns.com/foaf/0.1/name';
const PIM_STORAGE = 'http://www.w3.org/ns/pim/space#storage';
const PIM_STORAGE_TYPE = 'http://www.w3.org/ns/pim/space#Storage';
const VCARD_FN = 'http://www.w3.org/2006/vcard/ns#fn';
const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 8000;

/** Origins the operator configured (their own Solid server, SOLID_TRUSTED_ISSUERS): these may be private or plain http. */
export function trustedOrigins(): string[] {
  const out = new Set<string>();
  for (const u of [config.solid.serverUrl, ...config.solidOidc.trustedIssuers]) {
    try {
      if (u) out.add(new URL(u).origin);
    } catch {
      /* ignore malformed entries */
    }
  }
  return [...out];
}
const isTrusted = (url: URL) => trustedOrigins().includes(url.origin);

export class SolidLoginError extends Error {}

/** Normalise an issuer for comparison: providers differ on the trailing slash. */
export const sameIssuer = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

function parseUrl(raw: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SolidLoginError(`That doesn’t look like a ${what}. It should start with https://`);
  }
  if (url.username || url.password) throw new SolidLoginError(`A ${what} can’t contain a user name or password`);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isTrusted(url))) throw new SolidLoginError(`A ${what} must start with https://`);
  return url;
}

/** A quick, friendly refusal before anything is fetched (guardedFetch still checks the address it connects to). */
async function assertPublicHost(url: URL) {
  if (isTrusted(url)) return;
  const literal = ipLiteral(url);
  const addresses = literal ? [literal] : (await dnsLookupAll(url.hostname, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length || !addresses.every(isPublicAddress)) throw new SolidLoginError(`${url.host} isn’t reachable from Concord`);
}

function headerRecord(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(h).forEach((v, k) => (out[k] = v));
  return out;
}

/** Lets tests see every request the guarded transport makes (and so notice any that bypass it). */
export const guardedRequests: { observe?: (method: string, url: string) => void } = {};

/** The pod server's own responses (feedback documents, listings, ACLs) may be larger than an OIDC document, but are still capped. */
export const POD_MAX_BYTES = 1024 * 1024;

function guarded(maxBytes: number, check?: (url: URL) => void, pool?: ConnectionPool | 'held') {
  return async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    check?.(url);
    const trusted = isTrusted(url);
    const method = (init.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST' && method !== 'PUT' && method !== 'HEAD') throw new FetchError('bad-response', `${method} is not allowed`);
    let body: string | Buffer | undefined;
    if (init.body !== undefined && init.body !== null) {
      if (typeof init.body === 'string') body = init.body;
      else if (init.body instanceof URLSearchParams) body = init.body.toString();
      // Bytes are sent exactly as given (a verbatim copy of a pod document).
      else if (init.body instanceof Uint8Array) body = Buffer.from(init.body.buffer, init.body.byteOffset, init.body.byteLength);
      else if (init.body instanceof ArrayBuffer) body = Buffer.from(init.body);
      else throw new FetchError('bad-response', 'Unsupported request body');
    }
    const headers = headerRecord(init.headers);
    guardedRequests.observe?.(method, url.href);
    const r = await safeRequest(url, { method, headers, body, accept: headers.accept ?? '*/*', maxBytes, timeoutMs: TIMEOUT_MS, allowPrivate: trusted, allowHttp: trusted, pool });
    // Response refuses bodies on these statuses; a redirect comes back as itself and is never followed.
    const nullBody = [101, 204, 205, 304].includes(r.status) || method === 'HEAD';
    if (r.status < 200 || r.status > 599) throw new FetchError('bad-response', `HTTP ${r.status}`);
    // The body's own bytes: text() decodes them, arrayBuffer() gives them back unchanged.
    return new Response(nullBody ? null : new Uint8Array(r.bytes), { status: r.status, headers: r.headers });
  };
}

/**
 * The only fetch the Solid sign-in uses, handed to oauth4webapi as its
 * customFetch. See the comment at the top for what it enforces.
 */
export const guardedFetch = guarded(MAX_BYTES);

/** The URL, if it is on the operator's own pod server (the only place Concord reads or writes pods). */
export function podUrl(raw: string | URL): URL {
  const u = new URL(raw);
  if (!config.solid.serverUrl || u.origin !== new URL(config.solid.serverUrl).origin) throw new FetchError('bad-response', `Not on this server’s pod server: ${u.href}`);
  return u;
}

/** The pod server's own connections, apart from the sign-in's (so a request holding one can still refresh its token). */
const podConnections = new ConnectionPool();
const podPool = () => podConnections;

/**
 * The only fetch for the pod server (account API, owners' reads and writes,
 * sharing, admins' reads): the same guarded transport, its origin only, with a
 * larger byte cap.
 */
const podFetchAny = guarded(POD_MAX_BYTES, podUrl, podConnections);
/** While Concord is read-only (CONCORD_READ_ONLY), only reads reach the pod server. */
export const podFetch: typeof podFetchAny = (input, init) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes((init?.method ?? 'GET').toUpperCase())) refuseWhenReadOnly();
  return podFetchAny(input, init);
};
/** podFetch for a request that already holds one of the pod server's connections. */
const podFetchHeld = guarded(POD_MAX_BYTES, podUrl, 'held');

/**
 * A URL inside one of `scope`'s pods (folder URLs ending in /): where a requester for people's own pods may go
 * (step 5e). Anywhere else, including the rest of the same host, is refused before anything is sent. The guarded
 * transport still refuses private addresses on any host that isn't a trusted one.
 */
export function inPods(scope: readonly string[]) {
  return (raw: string | URL): URL => {
    const u = new URL(raw);
    if (u.username || u.password || !scope.some((root) => root.endsWith('/') && u.href.startsWith(root))) throw new FetchError('bad-response', `Not in this person’s pod: ${u.href}`);
    return u;
  };
}

const oauthOptions = (url: URL) => ({
  [oauth.customFetch]: guardedFetch as typeof fetch,
  // Plain http only for the operator's own (trusted) Solid server, in development and tests.
  ...(url.protocol === 'http:' && isTrusted(url) ? { [oauth.allowInsecureRequests]: true } : {}),
});

async function fetchText(url: URL, accept: string): Promise<string> {
  const r = await guardedFetch(url, { headers: { accept } });
  if (!r.ok) throw new FetchError(r.status === 404 || r.status === 410 ? 'not-found' : 'bad-response', `HTTP ${r.status}`, r.status);
  return r.text();
}

export interface WebIdProfile {
  webId: string;
  issuers: string[];
  name?: string;
  /** The pods the profile names (pim:storage). */
  storages: string[];
}

/** Parse a WebID profile document (Turtle) for the WebID's OIDC issuers and name. */
export function parseProfile(webId: string, docUrl: string, turtle: string): WebIdProfile {
  let quads: Quad[];
  try {
    quads = new Parser({ baseIRI: docUrl, format: 'text/turtle' }).parse(turtle);
  } catch {
    throw new SolidLoginError('The WebID profile isn’t valid Turtle');
  }
  const about = quads.filter((q) => q.subject.termType === 'NamedNode' && q.subject.value === webId);
  const issuers = [...new Set(about.filter((q) => q.predicate.value === SOLID_OIDC_ISSUER && q.object.termType === 'NamedNode').map((q) => q.object.value))];
  const name = about.find((q) => (q.predicate.value === FOAF_NAME || q.predicate.value === VCARD_FN) && q.object.termType === 'Literal')?.object.value;
  const storages = [...new Set(about.filter((q) => q.predicate.value === PIM_STORAGE && q.object.termType === 'NamedNode').map((q) => q.object.value))];
  return { webId, issuers, name: name?.slice(0, 120), storages };
}

/** The check that makes a Solid sign-in mean something: the WebID's own profile names the provider that vouched for it. */
export const issuerListed = (profile: WebIdProfile, issuer: string) => profile.issuers.some((i) => sameIssuer(i, issuer));

/** Fetch a WebID's profile. Throws SolidLoginError if it can't be read or isn't a profile. */
export async function fetchProfile(webId: string): Promise<WebIdProfile> {
  const url = parseUrl(webId, 'WebID');
  const doc = new URL(url);
  doc.hash = '';
  let body: string;
  try {
    body = await fetchText(doc, 'text/turtle');
  } catch (err) {
    const status = err instanceof FetchError && err.status ? ` (HTTP ${err.status})` : '';
    throw new SolidLoginError(`Couldn’t read the WebID profile at ${doc.href}${status}`);
  }
  return parseProfile(url.href, doc.href, body);
}

/**
 * Fetch an OpenID provider's metadata, once. It must name itself, and list an
 * authorization endpoint, a token endpoint and a JWKS.
 */
export async function discoverProvider(issuer: string): Promise<oauth.AuthorizationServer> {
  const url = parseUrl(issuer, 'Solid provider address');
  await assertPublicHost(url);
  let meta: oauth.AuthorizationServer;
  try {
    const r = await oauth.discoveryRequest(url, { algorithm: 'oidc', ...oauthOptions(url) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    meta = (await r.json()) as oauth.AuthorizationServer;
  } catch {
    throw new SolidLoginError(`${url.host} doesn’t look like a Solid provider (no OpenID configuration)`);
  }
  if (!meta || typeof meta.issuer !== 'string' || !sameIssuer(meta.issuer, url.href)) throw new SolidLoginError(`${url.host} describes itself as a different provider`);
  for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    if (typeof meta[field] !== 'string') throw new SolidLoginError(`${url.host}’s OpenID configuration has no ${field}`);
    parseUrl(meta[field], 'provider endpoint');
  }
  return meta;
}

/**
 * Where to send someone who typed `input`: a WebID (we use the provider its
 * profile names), or the address of a Solid provider itself.
 */
export async function resolveIssuer(input: string): Promise<{ as: oauth.AuthorizationServer; webId?: string }> {
  const url = parseUrl(input, 'WebID or Solid provider address');
  await assertPublicHost(url);
  let profile: WebIdProfile | undefined;
  try {
    profile = await fetchProfile(url.href);
  } catch {
    /* not a readable profile: try it as a provider below */
  }
  if (profile?.issuers.length) return { as: await discoverProvider(profile.issuers[0]!), webId: profile.webId };
  try {
    return { as: await discoverProvider(url.href) };
  } catch (err) {
    if (profile) throw new SolidLoginError('That WebID’s profile doesn’t name a Solid provider (solid:oidcIssuer) to sign in with');
    throw err;
  }
}

/* ------------------------------------------------------------------------ */
/* The login itself                                                          */
/* ------------------------------------------------------------------------ */

export const redirectUrl = () => `${config.publicUrl}/auth/solid/callback`;
/** The Solid-OIDC Client ID Document. Providers fetch it, so it needs a public https address. */
export const clientIdUrl = () => (config.publicUrl.startsWith('https://') ? `${config.publicUrl}/auth/solid/client.jsonld` : undefined);
const SCOPE = 'openid webid offline_access';

export function clientIdDocument() {
  return {
    '@context': ['https://www.w3.org/ns/solid/oidc-context.jsonld'],
    client_id: clientIdUrl() ?? `${config.publicUrl}/auth/solid/client.jsonld`,
    client_name: 'Concord',
    client_uri: config.webUrl,
    logo_uri: `${config.webUrl}/icon-192.png`,
    redirect_uris: [redirectUrl()],
    scope: SCOPE,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    default_max_age: 3600,
    require_auth_time: true,
  };
}

/** Dynamically registered clients, per provider (only for providers that don't take a Client ID Document). */
const registered = new Map<string, oauth.Client>();

async function clientFor(as: oauth.AuthorizationServer): Promise<oauth.Client> {
  const cid = clientIdUrl();
  if (cid && as.scopes_supported?.includes('webid')) return { client_id: cid, token_endpoint_auth_method: 'none' };
  const known = registered.get(as.issuer);
  if (known) return known;
  if (!as.registration_endpoint) throw new SolidLoginError('That Solid provider can’t register Concord as an app');
  const url = parseUrl(as.registration_endpoint, 'provider endpoint');
  const r = await oauth.dynamicClientRegistrationRequest(
    as,
    {
      client_name: 'Concord',
      redirect_uris: [redirectUrl()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'web',
      scope: SCOPE,
    },
    oauthOptions(url),
  );
  const client = await oauth.processDynamicClientRegistrationResponse(r);
  if (registered.size > 200) registered.clear();
  registered.set(as.issuer, client);
  return client;
}

interface Pending {
  as: oauth.AuthorizationServer;
  client: oauth.Client;
  verifier: string;
  state: string;
  nonce: string;
  returnTo: string;
  at: number;
}
/**
 * Sign-ins in progress, in the database: the callback can reach another server (or function instance) than the
 * one that started it. Keyed by a hash of the login cookie, taken once, and gone after PENDING_TTL.
 */
const PENDING_TTL = 10 * 60 * 1000;
const MAX_PENDING = 1000;
const pendingId = (loginId: string) => `solid-login:${createHash('sha256').update(loginId).digest('hex')}`;
interface StoredPending extends Pending {
  id: string;
  /** When it expires (ms): a numeric field of its own, so expired ones are swept in one statement. */
  solidLoginExpires: number;
}
const sweep = async () => void (await removeWhereAtMost('kv', 'solidLoginExpires', Date.now()));

/** Start signing in: returns the login's id (for a cookie) and where to send the browser. */
export async function startLogin(as: oauth.AuthorizationServer, returnTo: string): Promise<{ loginId: string; url: string }> {
  await sweep();
  // At most MAX_PENDING sign-ins started in any ten minutes, across every server.
  if (!(await reserveCounters([{ id: `solid-logins:${Math.floor(Date.now() / PENDING_TTL)}`, max: MAX_PENDING }], 'solid-logins')))
    throw new SolidLoginError('Too many sign-ins in progress. Please try again in a minute.');
  const client = await clientFor(as);
  const verifier = oauth.generateRandomCodeVerifier();
  const state = oauth.generateRandomState();
  const nonce = oauth.generateRandomNonce();
  const url = new URL(as.authorization_endpoint!);
  for (const [k, v] of Object.entries({
    client_id: client.client_id,
    redirect_uri: redirectUrl(),
    response_type: 'code',
    scope: SCOPE,
    state,
    nonce,
    code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    prompt: 'consent',
  }))
    url.searchParams.set(k, v);
  const loginId = oauth.generateRandomState();
  const at = Date.now();
  await insertOnce<StoredPending>('kv', { id: pendingId(loginId), as, client, verifier, state, nonce, returnTo, at, solidLoginExpires: at + PENDING_TTL });
  return { loginId, url: url.href };
}

/** What Concord keeps of an administrator's Solid login: a DPoP-bound token for reading pods as them. */
export interface SolidLogin {
  webId: string;
  as: oauth.AuthorizationServer;
  client: oauth.Client;
  keys: CryptoKeyPair;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  /** For a pod owner Concord acts for (client credentials), instead of a refresh token. */
  clientSecret?: string;
  /** Kept in the database under this id (see `shareLogins`), so every instance refreshes it in turn. */
  sharedId?: string;
}

/** A login as it is stored: its keys as JWKs. */
export interface StoredLogin extends Omit<SolidLogin, 'keys'> {
  jwk: { publicKey: JsonWebKey; privateKey: JsonWebKey };
}
export async function exportLogin(login: SolidLogin): Promise<StoredLogin> {
  const { keys, ...rest } = login;
  return { ...rest, jwk: { publicKey: await crypto.subtle.exportKey('jwk', keys.publicKey), privateKey: await crypto.subtle.exportKey('jwk', keys.privateKey) } };
}
export async function importLogin(stored: StoredLogin): Promise<SolidLogin> {
  const { jwk, ...rest } = stored;
  const alg = { name: 'ECDSA', namedCurve: 'P-256' };
  return { ...rest, keys: { publicKey: await crypto.subtle.importKey('jwk', jwk.publicKey, alg, true, ['verify']), privateKey: await crypto.subtle.importKey('jwk', jwk.privateKey, alg, false, ['sign']) } };
}

/** Where shared logins are kept (auth.ts registers it): each instance loads the latest before refreshing. */
export interface SharedLogins {
  load(id: string): Promise<SolidLogin | undefined>;
  /** Saves the login's new tokens (its keys don't change). */
  save(id: string, login: SolidLogin): Promise<void>;
}
let sharedLogins: SharedLogins | undefined;
export const shareLogins = (s: SharedLogins) => void (sharedLogins = s);

export interface FinishedLogin {
  webId: string;
  issuer: string;
  name: string;
  returnTo: string;
  login: SolidLogin;
  /** The person's own pod, from their profile (see podOf), if it names one Concord can use. */
  storage?: string;
}

/**
 * The pod a profile names that Concord would write to: an https folder (http only on a trusted server), with no user
 * name or password. Of several, the one the WebID itself is in comes first (a pod's own profile), else the first.
 */
export function podOf(profile: WebIdProfile): string | undefined {
  const usable = profile.storages.filter((s) => {
    try {
      const u = new URL(s);
      return !u.username && !u.password && !u.search && !u.hash && u.pathname.endsWith('/') && (u.protocol === 'https:' || (u.protocol === 'http:' && isTrusted(u)));
    } catch {
      return false;
    }
  });
  return usable.find((s) => profile.webId.startsWith(s)) ?? usable[0];
}

/**
 * The pod a WebID lives in when its profile names none (a Community Solid Server profile doesn't, by default): the
 * nearest folder above the profile document that says it is a storage (Link: <pim:Storage>; rel="type"), as the
 * Solid Protocol describes. Read without signing in, through the guarded transport. Undefined if none says so.
 */
export async function storageAbove(webId: string): Promise<string | undefined> {
  let folder: URL;
  try {
    folder = new URL('.', new URL(webId));
  } catch {
    return undefined;
  }
  for (let i = 0; i < 6; i++) {
    try {
      const r = await guardedFetch(folder, { method: 'HEAD' });
      const types = (r.headers.get('link') ?? '').split(',').filter((part) => /;\s*rel="?type"?/i.test(part));
      if (types.some((part) => part.includes(`<${PIM_STORAGE_TYPE}>`))) return podOf({ webId, issuers: [], storages: [folder.href] });
    } catch {
      return undefined;
    }
    if (folder.pathname === '/') return undefined;
    folder = new URL('..', folder);
  }
  return undefined;
}

/** Retry once when the provider asks for a DPoP nonce (the DPoP handle remembers it). */
async function withNonceRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (oauth.isDPoPNonceError(err)) return fn();
    throw err;
  }
}

/** A readable name for a WebID whose profile gives none: its first path segment ("jesse" in /jesse/profile/card#me), else its host. */
export function nameFromWebId(webId: string): string {
  try {
    const u = new URL(webId);
    const first = u.pathname.split('/').filter(Boolean)[0];
    return first && first !== 'profile' ? decodeURIComponent(first).slice(0, 60) : u.hostname;
  } catch {
    return webId.slice(0, 60);
  }
}

/**
 * Finish signing in. `loginId` is the cookie this browser got when it started;
 * the callback must carry that login's state. The ID token must be signed by
 * the provider we started with (its JWKS), for us, with our nonce; then the
 * WebID's profile must list the token's issuer.
 */
export async function finishLogin(loginId: string | undefined, callbackUrl: string): Promise<FinishedLogin> {
  // Taken once: a second callback with the same cookie finds nothing.
  const p = loginId ? await take<StoredPending>('kv', pendingId(loginId)) : undefined;
  if (!loginId || !p || p.solidLoginExpires <= Date.now()) throw new SolidLoginError('Sign-in failed: it expired or was started in another browser. Please try again.');
  const { as, client } = p;
  const tokenUrl = new URL(as.token_endpoint!);
  const opts = oauthOptions(tokenUrl);
  let claims: oauth.IDToken;
  let tokens: oauth.TokenEndpointResponse;
  // Extractable only where a login can be kept, sealed, in the database for other instances (an administrator's).
  const keys = await oauth.generateKeyPair('ES256', { extractable: sealingAvailable() });
  const DPoP = oauth.DPoP(client, keys);
  try {
    const params = oauth.validateAuthResponse(as, client, new URL(callbackUrl), p.state);
    let response: Response | undefined;
    tokens = await withNonceRetry(async () => {
      response = await oauth.authorizationCodeGrantRequest(as, client, oauth.None(), params, redirectUrl(), p.verifier, { DPoP, ...opts });
      return oauth.processAuthorizationCodeResponse(as, client, response, { expectedNonce: p.nonce, requireIdToken: true });
    });
    // The ID token's signature, against the JWKS of the provider we started with.
    await oauth.validateApplicationLevelSignature(as, response!, oauthOptions(new URL(as.jwks_uri!)));
    claims = oauth.getValidatedIdTokenClaims(tokens)!;
  } catch (err) {
    const msg = err instanceof Error ? err.message.split('\n')[0]!.slice(0, 200) : 'unknown error';
    throw new SolidLoginError(`Sign-in failed: ${msg}`);
  }
  if (tokens.token_type?.toLowerCase() !== 'dpop') throw new SolidLoginError('Sign-in failed: the provider didn’t issue a DPoP-bound token');
  // oauth4webapi has checked iss === as.issuer, aud, exp and the nonce.
  const webId = typeof claims.webid === 'string' ? claims.webid : claims.sub;
  try {
    new URL(webId);
  } catch {
    throw new SolidLoginError('Sign-in failed: the provider didn’t confirm a WebID');
  }
  const profile = await fetchProfile(webId);
  if (!issuerListed(profile, claims.iss)) throw new SolidLoginError(`Sign-in refused: ${webId} doesn’t list ${claims.iss} as its Solid provider`);
  return {
    webId,
    issuer: claims.iss,
    name: profile.name ?? nameFromWebId(webId),
    returnTo: p.returnTo,
    storage: podOf(profile) ?? (await storageAbove(webId)),
    login: { webId, as, client, keys, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + (tokens.expires_in ?? 300) * 1000 },
  };
}

/** Get a token with client credentials (DPoP-bound) for a login that has them. */
async function grantClientCredentials(login: SolidLogin) {
  const DPoP = oauth.DPoP(login.client, login.keys);
  const opts = oauthOptions(new URL(login.as.token_endpoint!));
  const t = await withNonceRetry(async () =>
    oauth.processClientCredentialsResponse(
      login.as,
      login.client,
      await oauth.clientCredentialsGrantRequest(login.as, login.client, oauth.ClientSecretBasic(login.clientSecret!), new URLSearchParams({ scope: 'webid' }), { DPoP, ...opts }),
    ),
  );
  if (t.token_type?.toLowerCase() !== 'dpop') throw new SolidLoginError('The pod server didn’t issue a DPoP-bound token');
  login.accessToken = t.access_token;
  login.expiresAt = Date.now() + (t.expires_in ?? 300) * 1000;
}

let ownServer: Promise<oauth.AuthorizationServer> | undefined;

/**
 * Act as a pod owner on the operator's own Solid server, with the client
 * credentials Concord minted for their WebID when it provisioned the pod.
 */
export async function clientCredentialsLogin(webId: string, clientId: string, clientSecret: string): Promise<SolidLogin> {
  if (!config.solid.serverUrl) throw new SolidLoginError('No Solid server is configured');
  ownServer ??= discoverProvider(`${config.solid.serverUrl.replace(/\/+$/, '')}/`).catch((err) => {
    ownServer = undefined;
    throw err;
  });
  const login: SolidLogin = { webId, as: await ownServer, client: { client_id: clientId }, keys: await oauth.generateKeyPair('ES256'), accessToken: '', expiresAt: 0, clientSecret };
  await grantClientCredentials(login);
  return login;
}

/** A refresh in progress, per login: requests that find the token expiring wait for the same one (refresh tokens may rotate, so only one use counts). */
const refreshing = new WeakMap<SolidLogin, Promise<boolean>>();

/** Refresh the access token if it is (nearly) expired. Returns false when the login can't continue. */
function fresh(login: SolidLogin, force = false): Promise<boolean> {
  if (!force && Date.now() < login.expiresAt - 30_000) return Promise.resolve(true);
  let p = refreshing.get(login);
  if (!p) {
    p = renew(login).finally(() => refreshing.delete(login));
    refreshing.set(login, p);
  }
  return p;
}

/**
 * A shared login is refreshed by one instance at a time (refresh tokens may rotate, so only one use counts): under
 * a lease, it first takes up a token another instance already got, and otherwise refreshes and saves it.
 */
async function renew(login: SolidLogin): Promise<boolean> {
  const id = login.sharedId;
  if (!id || !sharedLogins) return await renewHere(login);
  const store = sharedLogins;
  return await withLease(`solid-refresh:${id}`, 30_000, async () => {
    const latest = await store.load(id);
    if (!latest) return false; // signed out, or (an own-pod login, step 5e) replaced by a newer sign-in, meanwhile
    if (latest.accessToken !== login.accessToken && Date.now() < latest.expiresAt - 30_000) {
      Object.assign(login, { accessToken: latest.accessToken, refreshToken: latest.refreshToken, expiresAt: latest.expiresAt });
      return true;
    }
    Object.assign(login, { refreshToken: latest.refreshToken });
    const ok = await renewHere(login);
    if (ok) await store.save(id, login);
    return ok;
  });
}

async function renewHere(login: SolidLogin): Promise<boolean> {
  try {
    if (login.clientSecret) {
      await grantClientCredentials(login);
      return true;
    }
    if (!login.refreshToken) return false;
    const DPoP = oauth.DPoP(login.client, login.keys);
    const opts = oauthOptions(new URL(login.as.token_endpoint!));
    const t = await withNonceRetry(async () =>
      oauth.processRefreshTokenResponse(login.as, login.client, await oauth.refreshTokenGrantRequest(login.as, login.client, oauth.None(), login.refreshToken!, { DPoP, ...opts })),
    );
    login.accessToken = t.access_token;
    login.refreshToken = t.refresh_token ?? login.refreshToken;
    login.expiresAt = Date.now() + (t.expires_in ?? 300) * 1000;
    return true;
  } catch {
    return false;
  }
}

export type PodRequest = (method: 'GET' | 'HEAD' | 'PUT', url: string, init?: { headers?: Record<string, string>; body?: string | Uint8Array | ArrayBuffer }) => Promise<Response>;

/**
 * Requests that act as the login's WebID (a DPoP proof per request), on the
 * operator's own pod server only, through the pod server's connections.
 * Undefined if the login can no longer be used. Each request waits for its
 * connection first, and only then checks the token is fresh (refreshing it if
 * not) and signs its proof, so time spent queueing can't leave it stale. A 401
 * gets one refresh and retry; any other answer comes back as the response.
 */
export async function podRequester(login: SolidLogin, opts: { pods?: readonly string[] } = {}): Promise<PodRequest | undefined> {
  if (!(await fresh(login))) return undefined;
  // People's own pods (step 5e): only inside the pods named, on any public host. Otherwise the operator's pod server.
  const check = opts.pods ? inPods(opts.pods) : podUrl;
  const held = opts.pods ? guarded(POD_MAX_BYTES, check, 'held') : podFetchHeld;
  return async (method, url, init = {}) => {
    const u = check(url);
    return podPool().run(async () => {
      const send = async () => {
        if (!(await fresh(login))) throw new SolidLoginError('The Solid login has ended');
        const token = login.accessToken;
        const DPoP = oauth.DPoP(login.client, login.keys);
        const opts = { DPoP, [oauth.customFetch]: held as never, ...(u.protocol === 'http:' ? { [oauth.allowInsecureRequests]: true } : {}) };
        try {
          return { token, res: await withNonceRetry(() => oauth.protectedResourceRequest(token, method, u, new Headers({ accept: '*/*', ...init.headers }), init.body ?? null, opts)) };
        } catch (err) {
          // oauth4webapi raises a 401 challenge as an error; hand it back as the response it was.
          if (err instanceof oauth.WWWAuthenticateChallengeError) return { token, res: err.response };
          throw err;
        }
      };
      const first = await send();
      if (first.res.status !== 401) return first.res;
      // The token may have been revoked or expired early: refresh (unless another request just did) and try once more.
      if (login.accessToken === first.token && !(await fresh(login, true))) return first.res;
      return (await send()).res;
    });
  };
}

/** A GET as the signed-in WebID (see podRequester). Undefined if the login can no longer be used. */
export async function podReader(login: SolidLogin, opts: { pods?: readonly string[] } = {}): Promise<((url: string, accept: string) => Promise<Response>) | undefined> {
  const req = await podRequester(login, opts);
  return req && ((url, accept) => req('GET', url, { headers: { accept } }));
}

/** Logins are kept per browser session: the key is a hash of the session cookie, never the account. */
export const sessionKey = (sessionToken: string) => createHash('sha256').update(`solid-login:${sessionToken}`).digest('hex');
