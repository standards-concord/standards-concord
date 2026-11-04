import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { finishLogin, guardedFetch, resolveIssuer, startLogin } from '../src/solidOidc.js';

/**
 * The Solid-OIDC flow against a scripted OpenID provider on 127.0.0.1, which
 * the test marks as trusted (so plain http and a private address are allowed
 * for it, and only for it).
 */

interface Behaviour {
  /** iss claim in the ID token (default: the provider's own issuer). */
  iss?: string;
  /** Issuer the WebID profile lists (default: the provider). */
  profileIssuer?: string;
  tokenType?: string;
  /** Override the nonce the ID token carries. */
  nonce?: string;
  /** Token endpoint the metadata advertises. */
  tokenEndpoint?: string;
  /** Sign with a key the JWKS doesn't have. */
  wrongKey?: boolean;
  /** Pad the discovery document to this many bytes. */
  padDiscovery?: number;
  /** Stall the discovery body this long (ms) after the headers. */
  stallDiscovery?: number;
}

let server: http.Server;
let base: string;
let issuer: string;
let behaviour: Behaviour = {};
let expectedNonce = '';
let sawDpop = false;
const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const otherKeys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
const b64 = (b: ArrayBuffer | string) => Buffer.from(typeof b === 'string' ? Buffer.from(b) : new Uint8Array(b)).toString('base64url');

async function idToken(claims: Record<string, unknown>) {
  const head = b64(JSON.stringify({ alg: 'ES256', kid: 'k1', typ: 'JWT' }));
  const body = b64(JSON.stringify(claims));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, (behaviour.wrongKey ? otherKeys : keys).privateKey, Buffer.from(`${head}.${body}`));
  return `${head}.${body}.${b64(sig)}`;
}

const webId = () => `${base}/alice/profile/card#me`;
const savedTrusted = [...config.solidOidc.trustedIssuers];

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, base);
    const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (url.pathname === '/.well-known/openid-configuration') {
      const meta = {
        issuer,
        authorization_endpoint: `${base}/auth`,
        token_endpoint: behaviour.tokenEndpoint ?? `${base}/token`,
        jwks_uri: `${base}/jwks`,
        registration_endpoint: `${base}/register`,
        scopes_supported: ['openid', 'webid', 'offline_access'],
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['ES256'],
        dpop_signing_alg_values_supported: ['ES256'],
        ...(behaviour.padDiscovery ? { padding: 'x'.repeat(behaviour.padDiscovery) } : {}),
      };
      if (behaviour.stallDiscovery) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(JSON.stringify(meta).slice(0, 10));
        setTimeout(() => res.end(JSON.stringify(meta).slice(10)), behaviour.stallDiscovery);
        return;
      }
      return json(200, meta);
    }
    if (url.pathname === '/register') return json(201, { client_id: 'concord-test', redirect_uris: [`${config.publicUrl}/auth/solid/callback`], token_endpoint_auth_method: 'none' });
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/token') {
      sawDpop = typeof req.headers.dpop === 'string';
      const now = Math.floor(Date.now() / 1000);
      return json(200, {
        access_token: 'at-1',
        token_type: behaviour.tokenType ?? 'DPoP',
        expires_in: 300,
        id_token: await idToken({ iss: behaviour.iss ?? issuer, sub: webId(), webid: webId(), aud: 'concord-test', iat: now, exp: now + 300, nonce: behaviour.nonce ?? expectedNonce }),
      });
    }
    if (url.pathname === '/alice/profile/card')
      return res.writeHead(200, { 'content-type': 'text/turtle' }).end(`<#me> <http://www.w3.org/ns/solid/terms#oidcIssuer> <${behaviour.profileIssuer ?? issuer}> ; <http://xmlns.com/foaf/0.1/name> "Alice" .`);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  issuer = `${base}/`;
  config.solidOidc.trustedIssuers.push(issuer);
});
afterAll(() => {
  config.solidOidc.trustedIssuers.splice(0, config.solidOidc.trustedIssuers.length, ...savedTrusted);
  server.close();
});
beforeEach(() => {
  behaviour = {};
  sawDpop = false;
});

/** Start a login and come back from the provider with a code. */
async function signIn(input = webId()) {
  const { as } = await resolveIssuer(input);
  const { loginId, url } = await startLogin(as, '/somewhere');
  const auth = new URL(url);
  expectedNonce = auth.searchParams.get('nonce')!;
  expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
  const callback = `${config.publicUrl}/auth/solid/callback?code=abc&state=${auth.searchParams.get('state')}`;
  return finishLogin(loginId, callback);
}

describe('Solid-OIDC against a scripted provider', () => {
  it('signs in with a DPoP-bound token, a verified ID token and our nonce', async () => {
    const done = await signIn();
    expect(done).toMatchObject({ webId: webId(), issuer, name: 'Alice', returnTo: '/somewhere' });
    expect(sawDpop).toBe(true);
    expect(done.login.accessToken).toBe('at-1');
  });

  it('refuses an ID token from another issuer than the provider we started with', async () => {
    behaviour.iss = 'https://not-listed.example/';
    await expect(signIn()).rejects.toThrow(/Sign-in failed/);
  });

  it('refuses when the WebID’s profile doesn’t list the provider', async () => {
    behaviour.profileIssuer = 'https://someone-else.example/';
    // Started from the provider's address (the profile is only read after the provider vouches for the WebID).
    await expect(signIn(issuer)).rejects.toThrow(/doesn’t list/);
  });

  it('refuses a wrong nonce, a bad signature and a plain bearer token', async () => {
    behaviour.nonce = 'not-ours';
    await expect(signIn()).rejects.toThrow(/Sign-in failed/);
    behaviour = { wrongKey: true };
    await expect(signIn()).rejects.toThrow(/Sign-in failed/);
    behaviour = { tokenType: 'Bearer' };
    await expect(signIn()).rejects.toThrow(/DPoP/);
  });

  it('never sends the token request to an address that isn’t public', async () => {
    // Metadata from a trusted provider pointing its token endpoint at an untrusted private address.
    behaviour.tokenEndpoint = 'https://127.0.0.2:1/token';
    await expect(signIn()).rejects.toThrow(/provider endpoint|Sign-in failed/);
  });

  it('caps the size of what providers send, and the time it takes', async () => {
    behaviour.padDiscovery = 400 * 1024;
    await expect(resolveIssuer(issuer)).rejects.toThrow(/doesn’t look like a Solid provider/);
    behaviour = { stallDiscovery: 9000 };
    const t = Date.now();
    await expect(resolveIssuer(issuer)).rejects.toThrow(/doesn’t look like a Solid provider/);
    expect(Date.now() - t).toBeLessThan(8900);
  }, 20_000);
});

describe('guardedFetch', () => {
  it('refuses private and literal addresses, plain http and redirects for untrusted hosts', async () => {
    await expect(guardedFetch('https://127.0.0.1/token', { method: 'POST', body: 'a=b' })).rejects.toThrow(/not a public address/);
    await expect(guardedFetch('https://[::1]/')).rejects.toThrow(/not a public address/);
    await expect(guardedFetch('https://2130706433/')).rejects.toThrow(/not a public address/);
    await expect(guardedFetch('http://example.org/')).rejects.toThrow(/Only https/);
    await expect(guardedFetch('https://localhost:1/')).rejects.toThrow(/not a public address/);
  });

  it('returns a redirect as itself instead of following it', async () => {
    const s = http.createServer((_req, res) => res.writeHead(302, { location: 'http://169.254.169.254/' }).end());
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    config.solidOidc.trustedIssuers.push(`${origin}/`);
    try {
      const r = await guardedFetch(`${origin}/x`);
      expect(r.status).toBe(302);
    } finally {
      config.solidOidc.trustedIssuers.pop();
      s.close();
    }
  });
});
