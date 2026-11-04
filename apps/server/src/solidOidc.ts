import { lookup as dnsLookup } from 'node:dns';
import { lookup as dnsLookupAll } from 'node:dns/promises';
import { getSessionFromStorage, InMemoryStorage, Session } from '@inrupt/solid-client-authn-node';
import { Parser, type Quad } from 'n3';
import { custom } from 'openid-client';
import { config } from './config.js';
import { FetchError, ipLiteral, isPublicAddress, publicOnlyLookup, safeFetchText } from './safeFetch.js';

/**
 * Signing in with your own WebID (Solid-OIDC), as a relying party.
 *
 * Concord sends the browser to the person's OpenID provider (the one their
 * WebID profile names), receives a DPoP-bound access token and an ID token,
 * and then checks for itself that the WebID's profile really lists that
 * provider as a `solid:oidcIssuer`. Without that last check any provider could
 * claim any WebID.
 *
 * The token exchange, PKCE and DPoP are done by Inrupt's client library. The
 * URLs involved come from strangers (a WebID, its profile, the provider's
 * metadata), so every request made for an untrusted host may only reach
 * public internet addresses.
 */

const SOLID_OIDC_ISSUER = 'http://www.w3.org/ns/solid/terms#oidcIssuer';
const FOAF_NAME = 'http://xmlns.com/foaf/0.1/name';
const VCARD_FN = 'http://www.w3.org/2006/vcard/ns#fn';

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
const trustedHostnames = () => new Set(trustedOrigins().map((o) => new URL(o).hostname));

/**
 * openid-client (inside Inrupt's library) makes the discovery, registration and
 * token requests. Its sockets may only reach public addresses, except the
 * operator's trusted hosts (the pod server Concord itself uses).
 */
custom.setHttpOptionsDefaults({
  timeout: 8000,
  lookup: ((hostname: string, options: never, callback: never) =>
    (trustedHostnames().has(hostname) ? dnsLookup : publicOnlyLookup)(hostname, options, callback)) as never,
});

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

/** Hosts we fetch for strangers must resolve to public addresses only (no Concord-internal services). */
async function assertPublicHost(url: URL) {
  if (isTrusted(url)) return;
  const literal = ipLiteral(url);
  const addresses = literal ? [literal] : (await dnsLookupAll(url.hostname, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length || !addresses.every(isPublicAddress)) throw new SolidLoginError(`${url.host} isn’t reachable from Concord`);
}

const fetchText = (url: URL, accept: string) =>
  safeFetchText(url, { accept, maxBytes: 256 * 1024, timeoutMs: 8000, allowPrivate: isTrusted(url), allowHttp: isTrusted(url) });

export interface WebIdProfile {
  webId: string;
  issuers: string[];
  name?: string;
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
  return { webId, issuers, name: name?.slice(0, 120) };
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

interface ProviderMetadata {
  issuer: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  jwks_uri?: string;
  registration_endpoint?: string;
}

/**
 * Check an OpenID provider before Inrupt's library talks to it: its metadata
 * must name itself, and the endpoints it lists must be https on public hosts.
 * (The JWKS is fetched by a library we can't give our own lookup to, so it is checked here.)
 */
export async function checkProvider(issuer: string): Promise<string> {
  const url = parseUrl(issuer, 'Solid provider address');
  const wellKnown = new URL(`${url.href.replace(/\/+$/, '')}/.well-known/openid-configuration`);
  let meta: ProviderMetadata;
  try {
    meta = JSON.parse(await fetchText(wellKnown, 'application/json')) as ProviderMetadata;
  } catch {
    throw new SolidLoginError(`${url.host} doesn’t look like a Solid provider (no OpenID configuration)`);
  }
  if (typeof meta.issuer !== 'string' || !sameIssuer(meta.issuer, url.href)) throw new SolidLoginError(`${url.host} describes itself as a different provider`);
  for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    if (typeof meta[field] !== 'string') throw new SolidLoginError(`${url.host}’s OpenID configuration has no ${field}`);
  }
  for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'registration_endpoint'] as const) {
    if (meta[field] === undefined) continue;
    const endpoint = parseUrl(String(meta[field]), 'provider endpoint');
    await assertPublicHost(endpoint);
  }
  return meta.issuer;
}

/**
 * Where to send someone who typed `input`: a WebID (we use the provider its
 * profile names), or the address of a Solid provider itself.
 */
export async function resolveIssuer(input: string): Promise<{ issuer: string; webId?: string }> {
  const url = parseUrl(input, 'WebID or Solid provider address');
  await assertPublicHost(url);
  let profile: WebIdProfile | undefined;
  try {
    profile = await fetchProfile(url.href);
  } catch {
    /* not a readable profile: try it as a provider below */
  }
  if (profile?.issuers.length) return { issuer: await checkProvider(profile.issuers[0]!), webId: profile.webId };
  try {
    return { issuer: await checkProvider(url.href) };
  } catch (err) {
    if (profile) throw new SolidLoginError('That WebID’s profile doesn’t name a Solid provider (solid:oidcIssuer) to sign in with');
    throw err;
  }
}

/* ------------------------------------------------------------------------ */
/* The login itself                                                          */
/* ------------------------------------------------------------------------ */

/** Inrupt's sessions (tokens and DPoP keys) live in this process only and are lost on restart. */
const storage = new InMemoryStorage();

interface Pending {
  issuer: string;
  returnTo: string;
  at: number;
}
const pending = new Map<string, Pending>();
const PENDING_TTL = 10 * 60 * 1000;

const sweep = () => {
  const now = Date.now();
  for (const [id, p] of pending) if (now - p.at > PENDING_TTL) pending.delete(id);
};

export const redirectUrl = () => `${config.publicUrl}/auth/solid/callback`;
/** The Solid-OIDC Client ID Document. Providers fetch it, so it needs a public https address. */
export const clientIdUrl = () => (config.publicUrl.startsWith('https://') ? `${config.publicUrl}/auth/solid/client.jsonld` : undefined);

export function clientIdDocument() {
  return {
    '@context': ['https://www.w3.org/ns/solid/oidc-context.jsonld'],
    client_id: clientIdUrl() ?? `${config.publicUrl}/auth/solid/client.jsonld`,
    client_name: 'Concord',
    client_uri: config.webUrl,
    logo_uri: `${config.webUrl}/favicon.svg`,
    redirect_uris: [redirectUrl()],
    scope: 'openid webid offline_access',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    default_max_age: 3600,
    require_auth_time: true,
  };
}

/** Start signing in: returns the login session's id (for a cookie) and where to send the browser. */
export async function startLogin(issuer: string, returnTo: string): Promise<{ loginId: string; url: string }> {
  sweep();
  const session = new Session({ storage, keepAlive: true });
  let url: string | undefined;
  await session.login({
    oidcIssuer: issuer,
    redirectUrl: redirectUrl(),
    clientName: 'Concord',
    clientId: clientIdUrl(),
    tokenType: 'DPoP',
    handleRedirect: (u: string) => {
      url = u;
    },
  });
  if (!url) throw new SolidLoginError('The Solid provider didn’t start a sign-in');
  pending.set(session.info.sessionId, { issuer, returnTo, at: Date.now() });
  return { loginId: session.info.sessionId, url };
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

export interface FinishedLogin {
  webId: string;
  issuer: string;
  name: string;
  returnTo: string;
  /** Inrupt's session id: keep it to act as this person in their pods (DPoP-bound), or end it. */
  loginId: string;
}

/**
 * Finish signing in. `loginId` is the cookie this browser got when it started;
 * the provider's state must belong to the same login. Then the WebID's profile
 * must list the provider we sent them to.
 */
export async function finishLogin(loginId: string | undefined, callbackUrl: string): Promise<FinishedLogin> {
  sweep();
  const p = loginId ? pending.get(loginId) : undefined;
  if (!loginId || !p) throw new SolidLoginError('Sign-in failed: it expired or was started in another browser. Please try again.');
  pending.delete(loginId);
  const session = await getSessionFromStorage(loginId, { storage, refreshSession: false });
  if (!session) throw new SolidLoginError('Sign-in failed: it expired. Please try again.');
  let info;
  try {
    info = await session.handleIncomingRedirect(callbackUrl);
  } catch (err) {
    await endLogin(loginId);
    throw new SolidLoginError(`Sign-in failed: ${(err as Error).message.split('\n')[0]?.slice(0, 200)}`);
  }
  if (!info?.isLoggedIn || info.sessionId !== loginId || !info.webId) {
    await endLogin(loginId);
    throw new SolidLoginError('Sign-in failed: the provider didn’t confirm a WebID. Please try again.');
  }
  let profile: WebIdProfile;
  try {
    profile = await fetchProfile(info.webId);
  } catch (err) {
    await endLogin(loginId);
    throw err;
  }
  if (!issuerListed(profile, p.issuer)) {
    await endLogin(loginId);
    throw new SolidLoginError(`Sign-in refused: ${info.webId} doesn’t list ${p.issuer} as its Solid provider`);
  }
  return { webId: info.webId, issuer: p.issuer, name: profile.name ?? nameFromWebId(info.webId), returnTo: p.returnTo, loginId };
}

/** Forget a login's tokens and keys. */
export async function endLogin(loginId: string | undefined) {
  if (!loginId) return;
  pending.delete(loginId);
  const s = await getSessionFromStorage(loginId, { storage, refreshSession: false }).catch(() => undefined);
  await s?.logout({ logoutType: 'app' }).catch(() => undefined);
  for (const key of await storageKeys(loginId)) await storage.delete(key).catch(() => undefined);
}
// Inrupt keeps a session's data under one key per session.
const storageKeys = async (id: string) => [`solidClientAuthenticationUser:${id}`];

/** A fetch that acts as the signed-in WebID (DPoP-bound access token), or undefined if that login has ended. */
export async function fetchAs(loginId: string): Promise<{ fetch: typeof fetch; webId: string } | undefined> {
  const s = await getSessionFromStorage(loginId, { storage }).catch(() => undefined);
  if (!s?.info.isLoggedIn || !s.info.webId) return undefined;
  return { fetch: s.fetch.bind(s) as typeof fetch, webId: s.info.webId };
}
