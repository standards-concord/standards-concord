import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { get, openDb, put } from '../src/db.js';
import { solid } from '../src/services/solid.js';
import { clientCredentialsLogin, exportLogin, finishLogin, importLogin, shareLogins, type StoredLogin, guardedFetch, guardedRequests, podReader, podRequester, resolveIssuer, startLogin } from '../src/solidOidc.js';

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
/** The provider rotates refresh tokens: only the latest one works, once. */
let refreshToken = 'rt-1';
let refreshes = 0;
/** Authorization headers the pod documents were requested with. */
let podAuth: string[] = [];
let stored = Buffer.alloc(0);
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
    if (url.pathname === '/pod/big.json') {
      podAuth.push(String(req.headers.authorization));
      return send('application/json', JSON.stringify({ id: 'x' }), behaviour.padPod, behaviour.stallPod);
    }
    // Keeps whatever bytes are PUT, and gives them back.
    if (url.pathname === '/pod/bin') {
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        stored = Buffer.concat(chunks);
        return res.writeHead(201).end();
      }
      return res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(stored);
    }
    // Refuses the first access token (as if it had been revoked early); /pod/locked.json refuses every token.
    if (url.pathname === '/pod/revoked.json' || url.pathname === '/pod/locked.json') {
      podAuth.push(String(req.headers.authorization));
      if (url.pathname === '/pod/locked.json' || req.headers.authorization === 'DPoP at-1') return res.writeHead(401, { 'www-authenticate': 'DPoP error="invalid_token"' }).end();
      return json(200, { id: 'y' });
    }
    // A Community Solid Server's account API, enough to provision a pod.
    if (url.pathname.startsWith('/.account/')) {
      const a = `${base}/.account/`;
      const authed = req.headers.authorization === 'CSS-Account-Token acct-tok';
      if (req.method === 'GET' && url.pathname === '/.account/')
        return json(200, { controls: { account: { create: `${a}account/`, ...(authed ? { pod: `${a}pod/`, clientCredentials: `${a}cc/` } : {}) }, password: { login: `${a}login/`, ...(authed ? { create: `${a}password/` } : {}) } } });
      if (url.pathname === '/.account/account/') return json(200, { authorization: 'acct-tok' });
      if (!authed) return json(401, {});
      if (url.pathname === '/.account/password/') return json(200, {});
      if (url.pathname === '/.account/pod/') return json(200, { pod: `${base}/newpod/`, webId: `${base}/newpod/profile/card#me` });
      if (url.pathname === '/.account/cc/') return json(200, { id: 'cc-id', secret: 'cc-secret' });
    }
    if (url.pathname === '/token') {
      sawDpop = typeof req.headers.dpop === 'string';
      const form = new URLSearchParams(await new Promise<string>((r) => {
        let b = '';
        req.on('data', (c) => (b += c)).on('end', () => r(b));
      }));
      if (form.get('grant_type') === 'client_credentials') {
        // RFC 6749 §2.3.1: each part is form-urlencoded before base64.
        const [id, secret] = Buffer.from(String(req.headers.authorization).replace(/^Basic /, ''), 'base64').toString().split(':').map((x) => decodeURIComponent(x.replace(/\+/g, ' ')));
        const ok = id === 'cc-id' && secret === 'cc-secret';
        return ok ? json(200, { access_token: 'at-cc', token_type: 'DPoP', expires_in: 300 }) : json(401, { error: 'invalid_client' });
      }
      if (form.get('grant_type') === 'refresh_token') {
        refreshes++;
        if (form.get('refresh_token') !== refreshToken) return json(400, { error: 'invalid_grant' });
        refreshToken = `rt-${refreshes + 1}`;
        await new Promise((r) => setTimeout(r, 50));
        return json(200, { access_token: `at-r${refreshes}`, token_type: 'DPoP', expires_in: 300, refresh_token: refreshToken });
      }
      const now = Math.floor(Date.now() / 1000);
      const body = {
        access_token: 'at-1',
        token_type: behaviour.tokenType ?? 'DPoP',
        expires_in: 300,
        refresh_token: refreshToken,
        id_token: await idToken({ iss: behaviour.iss ?? issuer, sub: webId(), webid: webId(), aud: 'concord-test', iat: now, exp: now + 300, nonce: behaviour.nonce ?? expectedNonce }),
      };
      return send('application/json', JSON.stringify(body), behaviour.padToken, behaviour.stallToken);
    }
    if (url.pathname === '/alice/profile/card')
      return res.writeHead(200, { 'content-type': 'text/turtle' }).end(`<#me> <http://www.w3.org/ns/solid/terms#oidcIssuer> <${behaviour.profileIssuer ?? issuer}> ; <http://xmlns.com/foaf/0.1/name> "Alice" ; <http://www.w3.org/ns/pim/space#storage> <${base}/elsewhere/>, <${base}/alice/>, <ftp://x.example/> .`);
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
  podAuth = [];
  refreshToken = 'rt-1';
  refreshes = 0;
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

/** Start a login and come back from the provider with a code (`between` runs while the browser is at the provider). */
async function signIn(input = webId(), between?: () => void) {
  const { as } = await resolveIssuer(input);
  const { loginId, url } = await startLogin(as, '/somewhere');
  between?.();
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
    // Step 5e: the pod the profile names, preferring the one the WebID is in, never one Concord can't use.
    expect(done.storage).toBe(`${base}/alice/`);
    expect(sawDpop).toBe(true);
    expect(done.login.accessToken).toBe('at-1');
    // Discovery, the profile, registration, token, JWKS and the profile again: all guarded (checked after each test).
    expect(seen.map((r) => new URL(r.split(' ')[1]!).pathname)).toEqual(expect.arrayContaining(['/.well-known/openid-configuration', '/register', '/token', '/jwks', '/alice/profile/card']));
  });

  it('keeps a sign-in in progress in the database, so any server can finish it, and only once', async () => {
    // Step 5 (Vercel): the sign-in in progress was in this process's memory, so a callback reaching another
    // function instance failed with "it expired or was started in another browser".
    const { as } = await resolveIssuer(webId());
    const { loginId, url } = await startLogin(as, '/somewhere');
    const row = `solid-login:${createHash('sha256').update(loginId).digest('hex')}`;
    expect(await get('kv', row)).toMatchObject({ returnTo: '/somewhere', solidLoginExpires: expect.any(Number) });
    const auth = new URL(url);
    expectedNonce = auth.searchParams.get('nonce')!;
    const callback = `${config.publicUrl}/auth/solid/callback?code=abc&state=${auth.searchParams.get('state')}`;
    expect((await finishLogin(loginId, callback)).webId).toBe(webId());
    expect(await get('kv', row)).toBeUndefined();
    await expect(finishLogin(loginId, callback)).rejects.toThrow(/expired or was started in another browser/);
  });

  it('refuses a sign-in that has expired', async () => {
    const { as } = await resolveIssuer(webId());
    const { loginId, url } = await startLogin(as, '/somewhere');
    const row = `solid-login:${createHash('sha256').update(loginId).digest('hex')}`;
    await put('kv', { ...(await get<object>('kv', row))!, id: row, solidLoginExpires: Date.now() - 1 });
    const callback = `${config.publicUrl}/auth/solid/callback?code=abc&state=${new URL(url).searchParams.get('state')}`;
    await expect(finishLogin(loginId, callback)).rejects.toThrow(/expired/);
  });

  it('finishes with the provider metadata it started with, never fetching it again', async () => {
    // While the browser is away, the provider's metadata changes to point the token endpoint elsewhere.
    const done = await signIn(webId(), () => (behaviour.tokenEndpoint = `${base}/elsewhere/token`));
    expect(done.webId).toBe(webId());
    const paths = seen.map((r) => new URL(r.split(' ')[1]!).pathname);
    expect(paths.filter((p) => p === '/.well-known/openid-configuration')).toHaveLength(1);
    expect(paths).toContain('/token');
    expect(paths).not.toContain('/elsewhere/token');
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
    // A real listener on a port that isn't trusted (only the provider's own origin is): it must never be connected to.
    let connections = 0;
    const inside = http.createServer((_req, res) => res.writeHead(200).end('{}'));
    inside.on('connection', () => connections++);
    await new Promise<void>((resolve, reject) => inside.once('error', reject).listen(0, '127.0.0.1', resolve));
    try {
      // Metadata from a trusted provider pointing its token endpoint there.
      behaviour.tokenEndpoint = `https://127.0.0.1:${(inside.address() as AddressInfo).port}/token`;
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

  it('refreshes a login kept in the database once across instances, and each instance takes up the new token', async () => {
    // Step 5 (Vercel): an administrator's login was in one process's memory, so another instance answered "your
    // Solid sign-in has ended", and two instances refreshing it at once would spend a rotating refresh token twice.
    process.env.CONCORD_ENCRYPTION_KEY = 'ab'.repeat(32);
    try {
      const { login } = await signIn();
      const rows = new Map<string, StoredLogin>([['s1', await exportLogin(login)]]);
      shareLogins({
        load: async (id) => (rows.has(id) ? { ...(await importLogin(rows.get(id)!)), sharedId: id } : undefined),
        save: async (id, l) => void rows.set(id, { ...rows.get(id)!, accessToken: l.accessToken, refreshToken: l.refreshToken, expiresAt: l.expiresAt }),
      });
      // The same login on two instances, both finding it expired.
      const [a, b] = await Promise.all([1, 2].map(async () => ({ ...(await importLogin(rows.get('s1')!)), sharedId: 's1', expiresAt: 0 })));
      const readers = await Promise.all([podReader(a), podReader(b)]);
      expect(readers.every(Boolean)).toBe(true);
      expect(refreshes).toBe(1);
      expect(a.accessToken).toBe('at-r1');
      expect(b.accessToken).toBe('at-r1');
      expect(rows.get('s1')).toMatchObject({ accessToken: 'at-r1', refreshToken: 'rt-2' });
      expect((await readers[1]!(`${base}/pod/big.json`, 'application/json')).status).toBe(200);
    } finally {
      delete process.env.CONCORD_ENCRYPTION_KEY;
    }
  });

  it('refreshes an expiring login once, however many requests need it at the same moment', async () => {
    const { login } = await signIn();
    const get = (await podReader(login))!;
    // The token expires while the reader is in use.
    login.expiresAt = 0;
    const results = await Promise.all([1, 2, 3, 4].map(() => get(`${base}/pod/big.json`, 'application/json')));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(refreshes).toBe(1);
    expect(new Set(podAuth)).toEqual(new Set(['DPoP at-r1']));
  });

  it('waits for a connection before checking the token, so a token that went stale in the queue is refreshed first', async () => {
    const { login } = await signIn();
    const get = (await podReader(login))!;
    // Four slow reads take every connection to the pod server; the token has half a second of freshness left.
    behaviour = { stallPod: 1500 };
    login.expiresAt = Date.now() + 30_500;
    const busy = [1, 2, 3, 4].map(() => get(`${base}/pod/big.json`, 'application/json'));
    await new Promise((r) => setTimeout(r, 100));
    const queued = get(`${base}/pod/big.json`, 'application/json');
    expect((await Promise.all([...busy, queued])).map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    // The queued read went out after a refresh, with the new token; the first four used the old one.
    expect(refreshes).toBe(1);
    expect(podAuth).toEqual(['DPoP at-1', 'DPoP at-1', 'DPoP at-1', 'DPoP at-1', 'DPoP at-r1']);
  }, 20_000);

  it('sends and reads bytes exactly, not as text', async () => {
    const { login } = await signIn();
    const req = (await podRequester(login))!;
    // Not valid UTF-8: decoding it as text would change it.
    const bytes = new Uint8Array([0, 255, 128, 10, 13, 0xc3, 0x28]);
    expect((await req('PUT', `${base}/pod/bin`, { headers: { 'content-type': 'application/octet-stream' }, body: bytes })).status).toBe(201);
    expect([...stored]).toEqual([...bytes]);
    expect([...new Uint8Array(await (await req('GET', `${base}/pod/bin`)).arrayBuffer())]).toEqual([...bytes]);
    await req('PUT', `${base}/pod/bin`, { body: bytes.buffer });
    expect([...stored]).toEqual([...bytes]);
  });

  it('refreshes once and retries when the pod answers 401, and gives the 401 back if it persists', async () => {
    const { login } = await signIn();
    const get = (await podReader(login))!;
    expect((await get(`${base}/pod/revoked.json`, 'application/json')).status).toBe(200);
    expect(refreshes).toBe(1);
    expect(podAuth).toEqual(['DPoP at-1', 'DPoP at-r1']);
    podAuth = [];
    expect((await get(`${base}/pod/locked.json`, 'application/json')).status).toBe(401);
    expect(podAuth).toHaveLength(2);
    expect(refreshes).toBe(2);
  });

  it('provisions a pod through the guarded transport (the account API, then client credentials)', async () => {
    await openDb();
    const made = await solid.provision({ id: 'u-provision1', name: 'New Tester' });
    expect(made).toEqual({ webId: `${base}/newpod/profile/card#me`, podUrl: `${base}/newpod/` });
    expect(seen.filter((r) => r.includes('/.account/')).length).toBeGreaterThanOrEqual(5);
    // Every request it made went through the guarded transport (checked after each test), and none used the plain fetch (stubbed to fail).
  });

  it('acts as a pod owner with client credentials, through the guarded transport', async () => {
    const login = await clientCredentialsLogin(webId(), 'cc-id', 'cc-secret');
    expect(login.accessToken).toBe('at-cc');
    const req = (await podRequester(login))!;
    expect((await req('GET', `${base}/pod/big.json`)).status).toBe(200);
    expect(podAuth).toEqual(['DPoP at-cc']);
    expect(seen.some((r) => r.startsWith('POST ') && r.endsWith('/token'))).toBe(true);
    // Every request (discovery, token, pod) was guarded: checked after each test.
    await expect(clientCredentialsLogin(webId(), 'cc-id', 'wrong')).rejects.toThrow();
  });
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
