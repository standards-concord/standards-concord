import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { finishLogin, guardedFetch, guardedRequests, podReader, resolveIssuer, startLogin } from '../src/solidOidc.js';

/**
 * The Solid-OIDC flow against a scripted OpenID provider on 127.0.0.1, which
 * the test marks as trusted (so plain http and a private address are allowed
 * for it, and only for it).
 *
 * The global fetch is replaced by one that fails the test, and every request the
 * provider receives must have gone through the guarded transport first.
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
  /** The same for the token endpoint, the JWKS and a pod document. */
  padToken?: number;
  stallToken?: number;
  padJwks?: number;
  stallJwks?: number;
  padPod?: number;
  stallPod?: number;
}

let server: http.Server;
let base: string;
let issuer: string;
let behaviour: Behaviour = {};
let expectedNonce = '';
let sawDpop = false;
/** Requests the provider received, and requests the guarded transport made. */
let seen: string[] = [];
let guarded: string[] = [];
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
    seen.push(`${req.method} ${url.href}`);
    const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    /** Send `body`, padded to `pad` bytes, or with its end held back `stall` ms. */
    const send = (type: string, body: string, pad?: number, stall?: number) => {
      if (pad) body = body.replace(/}\s*$/, `, "padding": "${'x'.repeat(pad)}"}`);
      if (!stall) return res.writeHead(200, { 'content-type': type }).end(body);
      res.writeHead(200, { 'content-type': type });
      res.write(body.slice(0, 10));
      setTimeout(() => res.end(body.slice(10)), stall);
    };
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
    if (url.pathname === '/jwks') return send('application/json', JSON.stringify({ keys: [jwk] }), behaviour.padJwks, behaviour.stallJwks);
    if (url.pathname === '/pod/big.json') return send('application/json', JSON.stringify({ id: 'x' }), behaviour.padPod, behaviour.stallPod);
    if (url.pathname === '/token') {
      sawDpop = typeof req.headers.dpop === 'string';
      const now = Math.floor(Date.now() / 1000);
      const body = {
        access_token: 'at-1',
        token_type: behaviour.tokenType ?? 'DPoP',
        expires_in: 300,
        id_token: await idToken({ iss: behaviour.iss ?? issuer, sub: webId(), webid: webId(), aud: 'concord-test', iat: now, exp: now + 300, nonce: behaviour.nonce ?? expectedNonce }),
      };
      return send('application/json', JSON.stringify(body), behaviour.padToken, behaviour.stallToken);
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
  seen = [];
  guarded = [];
  guardedRequests.observe = (method, url) => guarded.push(`${method} ${url}`);
  vi.stubGlobal('fetch', () => {
    throw new Error('The plain fetch was used');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  guardedRequests.observe = undefined;
  // Everything the provider received went through the guarded transport.
  for (const r of seen) expect(guarded, `${r} bypassed guardedFetch`).toContain(r);
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
    // Discovery, the profile, registration, token, JWKS and the profile again: all guarded (checked after each test).
    expect(seen.map((r) => new URL(r.split(' ')[1]!).pathname)).toEqual(expect.arrayContaining(['/.well-known/openid-configuration', '/register', '/token', '/jwks', '/alice/profile/card']));
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
    // A real listener on another private address, which isn't trusted: it must never be connected to.
    let connections = 0;
    const inside = http.createServer((_req, res) => res.writeHead(200).end('{}'));
    inside.on('connection', () => connections++);
    await new Promise<void>((r) => inside.listen(0, '127.0.0.2', r));
    try {
      // Metadata from a trusted provider pointing its token endpoint there.
      behaviour.tokenEndpoint = `https://127.0.0.2:${(inside.address() as AddressInfo).port}/token`;
      await expect(signIn()).rejects.toThrow(/Sign-in failed: .*not a public address/);
      expect(connections).toBe(0);
    } finally {
      inside.close();
    }
  });

  it('caps the size of the token response and the JWKS, and the time they take', async () => {
    for (const b of [{ padToken: 400 * 1024 }, { padJwks: 400 * 1024 }]) {
      behaviour = b;
      await expect(signIn()).rejects.toThrow(/Sign-in failed: .*bytes/);
    }
    for (const b of [{ stallToken: 9000 }, { stallJwks: 9000 }]) {
      behaviour = b;
      const t = Date.now();
      await expect(signIn()).rejects.toThrow(/Sign-in failed: .*Timed out/);
      expect(Date.now() - t).toBeLessThan(8900);
    }
  }, 40_000);

  it('caps the size of discovery, and the time it takes', async () => {
    behaviour.padDiscovery = 400 * 1024;
    await expect(resolveIssuer(issuer)).rejects.toThrow(/doesn’t look like a Solid provider/);
    behaviour = { stallDiscovery: 9000 };
    const t = Date.now();
    await expect(resolveIssuer(issuer)).rejects.toThrow(/doesn’t look like a Solid provider/);
    expect(Date.now() - t).toBeLessThan(8900);
  }, 20_000);
});

describe('reading a pod as the signed-in WebID', () => {
  const savedServer = config.solid.serverUrl;
  beforeAll(() => {
    config.solid.serverUrl = base;
  });
  afterAll(() => {
    config.solid.serverUrl = savedServer;
  });

  it('goes only to the pod server, through the guarded transport, with a byte cap and a deadline', async () => {
    const { login } = await signIn();
    const get = (await podReader(login))!;
    expect((await get(`${base}/pod/big.json`, 'application/json')).status).toBe(200);
    await expect(get('https://elsewhere.example/pod/big.json', 'application/json')).rejects.toThrow(/Not on this server’s pod server/);

    behaviour = { padPod: 2 * 1024 * 1024 };
    await expect(get(`${base}/pod/big.json`, 'application/json')).rejects.toThrow(/bytes/);
    behaviour = { stallPod: 9000 };
    const t = Date.now();
    await expect(get(`${base}/pod/big.json`, 'application/json')).rejects.toThrow(/Timed out/);
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
