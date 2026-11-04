import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { get, openDb, put } from '../src/db.js';
import { newId } from '../src/ids.js';
import { setClientMetadataFetcher } from '../src/oauth.js';
import { FetchError, isPublicAddress, readCapped, safeFetchText } from '../src/safeFetch.js';
import { Readable } from 'node:stream';
import { seedDemo } from '../src/services/simulation.js';

const app = createApp();
const REDIRECT = 'http://localhost:33418/callback';

const b64url = (b: Buffer) => b.toString('base64url');
const pkce = () => {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
};

async function signedIn(name = 'OAuth tester') {
  const agent = request.agent(base);
  const res = await agent.post('/api/auth/demo').send({ name, role: 'contributor' });
  expect(res.status).toBe(200);
  return agent;
}

async function register(body: Record<string, unknown> = {}) {
  const res = await request(base)
    .post('/register')
    .send({ client_name: 'Claude Code (concord)', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...body });
  expect(res.status).toBe(201);
  return res.body as { client_id: string; client_secret?: string };
}

/** Runs /authorize, approves on the consent API as `agent`, and returns the code. */
async function authorize(agent: ReturnType<typeof request.agent>, clientId: string, origin: string, opts: { challenge: string; state?: string; resource?: string }) {
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: opts.challenge, code_challenge_method: 'S256', state: opts.state ?? 'xyz' });
  if (opts.resource !== undefined) q.set('resource', opts.resource);
  const res = await request(base).get(`/authorize?${q}`);
  expect(res.status).toBe(302);
  const consent = new URL(res.headers.location);
  expect(consent.origin).toBe(origin);
  expect(consent.pathname).toBe('/oauth/authorize');
  const id = consent.searchParams.get('request')!;
  const info = await agent.get(`/api/oauth/requests/${id}`);
  expect(info.status).toBe(200);
  const approved = await agent.post(`/api/oauth/requests/${id}/approve`).send({});
  expect(approved.status).toBe(200);
  const back = new URL(approved.body.redirect);
  return { back, info: info.body, code: back.searchParams.get('code')! };
}

const token = (body: Record<string, string>) => request(base).post('/token').type('form').send(body);

const mcp = (accessToken: string | undefined, body: object, host?: string) => {
  const r = request(base).post('/mcp').set('Accept', 'application/json, text/event-stream');
  if (host) r.set('X-Forwarded-Host', host);
  if (accessToken) r.set('Authorization', `Bearer ${accessToken}`);
  return r.send(body);
};
const tools = (accessToken: string, host?: string) => mcp(accessToken, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, host);

let origin: string;
let base: string;
let server: Server;

beforeAll(async () => {
  openDb();
  await seedDemo();
  // One listening server, so every request sees the same origin (supertest would pick a new port each time).
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The test server's own address is one of the domains this deployment answers for.
  process.env.PUBLIC_ORIGINS = base;
  const md = await request(base).get('/.well-known/oauth-protected-resource/mcp');
  origin = new URL(md.body.resource).origin;
  expect(origin).toBe(base);
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('MCP OAuth discovery', () => {
  it('answers 401 with a pointer to the protected resource metadata', async () => {
    const res = await mcp(undefined, { jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(res.status).toBe(401);
    const header = res.headers['www-authenticate'];
    expect(header).toMatch(/^Bearer resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"$/);
    expect(res.body.error.message).toMatch(/\/connect/);
  });

  it('flags an invalid token so clients know to sign in again', async () => {
    const res = await mcp('cna_nope', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/error="invalid_token"/);
  });

  it('publishes protected resource and authorization server metadata', async () => {
    const prm = await request(base).get('/.well-known/oauth-protected-resource/mcp');
    expect(prm.status).toBe(200);
    expect(prm.body.resource).toBe(`${origin}/mcp`);
    expect(prm.body.authorization_servers).toEqual([`${origin}/`]);
    const root = await request(base).get('/.well-known/oauth-protected-resource');
    expect(root.body.authorization_servers).toEqual([`${origin}/`]);
    const as = await request(base).get('/.well-known/oauth-authorization-server');
    expect(as.status).toBe(200);
    expect(as.body).toMatchObject({
      issuer: `${origin}/`,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      revocation_endpoint: `${origin}/revoke`,
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
    });
    expect(as.headers['access-control-allow-origin']).toBe('*');
  });

  it('builds URLs for trusted domains only, and the canonical address for anything else', async () => {
    const forged = await request(base).get('/.well-known/oauth-authorization-server').set('X-Forwarded-Host', 'attacker.example').set('X-Forwarded-Proto', 'https');
    expect(forged.body.issuer).toBe('http://localhost:8787/');
    process.env.PUBLIC_ORIGINS = `${base},https://concord.example.org`;
    try {
      const alias = await request(base).get('/.well-known/oauth-authorization-server').set('X-Forwarded-Host', 'concord.example.org').set('X-Forwarded-Proto', 'https');
      expect(alias.body.issuer).toBe('https://concord.example.org/');
      expect(alias.body.token_endpoint).toBe('https://concord.example.org/token');
    } finally {
      process.env.PUBLIC_ORIGINS = base;
    }
  });

  it('believes X-Concord-Origin only from the Vercel middleware, which proves itself with the shared secret', async () => {
    const prm = (h: Record<string, string>) => request(base).get('/.well-known/oauth-protected-resource/mcp').set(h);
    // No secret configured: the header is ignored.
    expect((await prm({ 'X-Concord-Origin': 'https://chosen.example' })).body.resource).toBe(`${origin}/mcp`);
    process.env.CONCORD_PROXY_SECRET = 'proxy-secret-for-tests';
    try {
      expect((await prm({ 'X-Concord-Origin': 'https://chosen.example' })).body.resource).toBe(`${origin}/mcp`);
      expect((await prm({ 'X-Concord-Origin': 'https://chosen.example', 'X-Concord-Proxy-Secret': 'wrong' })).body.resource).toBe(`${origin}/mcp`);
      const ok = await prm({ 'X-Concord-Origin': 'https://standards-concord.vercel.app', 'X-Concord-Proxy-Secret': 'proxy-secret-for-tests', 'X-Forwarded-Host': '74.152.52.138.sslip.io' });
      expect(ok.body.resource).toBe('https://standards-concord.vercel.app/mcp');
      expect((await prm({ 'X-Concord-Origin': 'javascript:alert(1)', 'X-Concord-Proxy-Secret': 'proxy-secret-for-tests' })).body.resource).toBe(`${origin}/mcp`);
    } finally {
      delete process.env.CONCORD_PROXY_SECRET;
    }
  });

  it('does not route OAuth paths to the web app', async () => {
    const res = await request(base).get('/token');
    expect(res.headers['content-type']).not.toMatch(/html/);
  });
});

describe('MCP OAuth authorization code flow', () => {
  it('registers, authorizes, issues tokens and serves MCP with them', async () => {
    const client = await register();
    expect(client.client_id).toBeTruthy();
    expect(client.client_secret).toBeUndefined();
    const agent = await signedIn('Ada Agent');
    const { verifier, challenge } = pkce();
    const { back, info, code } = await authorize(agent, client.client_id, origin, { challenge, state: 'st4te', resource: `${origin}/mcp` });
    expect(info).toMatchObject({ clientName: 'Claude Code (concord)', redirectHost: 'localhost:33418', localRedirect: true });
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('st4te');
    expect(back.searchParams.get('iss')).toBe(`${origin}/`);

    const t = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT, resource: `${origin}/mcp` });
    expect(t.status).toBe(200);
    expect(t.body.token_type.toLowerCase()).toBe('bearer');
    expect(t.body.expires_in).toBe(3600);
    expect(t.body.access_token).toMatch(/^cna_/);
    expect(t.body.refresh_token).toMatch(/^cnr_/);

    const list = await tools(t.body.access_token);
    expect(list.status).toBe(200);
    expect(list.text).toContain('report_gap');

    // Codes are single use.
    const again = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('invalid_grant');

    // The connection shows up in Settings, and refresh tokens rotate.
    const conns = await agent.get('/api/oauth/connections');
    expect(conns.body).toEqual([expect.objectContaining({ clientName: 'Claude Code (concord)' })]);
    const r1 = await token({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token, client_id: client.client_id });
    expect(r1.status).toBe(200);
    expect(r1.body.access_token).not.toBe(t.body.access_token);
    expect((await tools(r1.body.access_token)).status).toBe(200);

    // A token issued for one domain is not accepted on another.
    expect((await tools(r1.body.access_token, 'elsewhere.example.org')).status).toBe(401);

    // Disconnecting revokes every token in the grant.
    expect((await agent.delete(`/api/oauth/connections/${conns.body[0].id}`)).status).toBe(204);
    expect((await tools(r1.body.access_token)).status).toBe(401);
    expect((await token({ grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: client.client_id })).status).toBe(400);
  });

  it('revokes the whole connection when a rotated refresh token is replayed', async () => {
    const client = await register();
    const agent = await signedIn();
    const { verifier, challenge } = pkce();
    const { code } = await authorize(agent, client.client_id, origin, { challenge, resource: `${origin}/mcp` });
    const t = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT });
    // The attacker refreshes first with a stolen token...
    const stolen = await token({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token, client_id: client.client_id });
    expect(stolen.status).toBe(200);
    // ...then the real client presents the same (now rotated) token.
    const replay = await token({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token, client_id: client.client_id });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');
    // Everything issued in that connection is dead, including the attacker's fresh tokens.
    expect((await tools(stolen.body.access_token)).status).toBe(401);
    expect((await tools(t.body.access_token)).status).toBe(401);
    expect((await token({ grant_type: 'refresh_token', refresh_token: stolen.body.refresh_token, client_id: client.client_id })).status).toBe(400);
    expect((await agent.get('/api/oauth/connections')).body).toEqual([]);
  });

  it('binds tokens to this MCP URL even when the client sends no resource', async () => {
    const client = await register();
    const agent = await signedIn();
    const { verifier, challenge } = pkce();
    const { code } = await authorize(agent, client.client_id, origin, { challenge });
    // The code can't be exchanged for some other audience...
    const other = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT, resource: 'https://other.example/mcp' });
    expect(other.status).toBe(400);
    expect(other.body.error).toBe('invalid_target');
    // ...and a fresh one without a resource yields a token for this server only.
    const second = await authorize(agent, client.client_id, origin, { challenge });
    const t = await token({ grant_type: 'authorization_code', code: second.code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT });
    expect(t.status).toBe(200);
    expect((await tools(t.body.access_token)).status).toBe(200);
    expect((await tools(t.body.access_token, 'elsewhere.example.org')).status).toBe(401);
    // Fragments are not a loophole.
    const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', resource: `${origin}/mcp#x` });
    expect(new URL((await request(base).get(`/authorize?${q}`)).headers.location).searchParams.get('error')).toBe('invalid_target');
  });

  it('rejects a code issued to another client', async () => {
    const a = await register();
    const b = await register();
    const agent = await signedIn();
    const { verifier, challenge } = pkce();
    const { code } = await authorize(agent, a.client_id, origin, { challenge });
    const t = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: b.client_id, redirect_uri: REDIRECT });
    expect(t.status).toBe(400);
    expect(t.body.error).toBe('invalid_grant');
  });

  it('rejects a wrong PKCE verifier', async () => {
    const client = await register();
    const agent = await signedIn();
    const { challenge } = pkce();
    const { code } = await authorize(agent, client.client_id, origin, { challenge });
    const t = await token({ grant_type: 'authorization_code', code, code_verifier: pkce().verifier, client_id: client.client_id, redirect_uri: REDIRECT });
    expect(t.status).toBe(400);
    expect(t.body.error).toBe('invalid_grant');
  });

  it('rejects tokens for a different resource', async () => {
    const client = await register();
    const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256', resource: 'https://other.example/mcp' });
    const res = await request(base).get(`/authorize?${q}`);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.location).searchParams.get('error')).toBe('invalid_target');
  });

  it('refuses unregistered redirect URIs without redirecting', async () => {
    const client = await register();
    const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://evil.example/cb', code_challenge: pkce().challenge, code_challenge_method: 'S256' });
    const res = await request(base).get(`/authorize?${q}`);
    expect(res.status).toBe(400);
  });

  it('needs a signed-in person to approve, and lets anyone decline', async () => {
    const client = await register();
    const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256', state: 's' });
    const id = new URL((await request(base).get(`/authorize?${q}`)).headers.location).searchParams.get('request')!;
    expect((await request(base).post(`/api/oauth/requests/${id}/approve`).send({})).status).toBe(401);
    const denied = await request(base).post(`/api/oauth/requests/${id}/deny`).send({});
    const back = new URL(denied.body.redirect);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe('s');
    // The request is used up.
    expect((await request(base).get(`/api/oauth/requests/${id}`)).status).toBe(404);
  });

  it('only approves from a JSON request (no cross-site form posts)', async () => {
    const client = await register();
    const agent = await signedIn();
    const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256' });
    const id = new URL((await request(base).get(`/authorize?${q}`)).headers.location).searchParams.get('request')!;
    const res = await agent.post(`/api/oauth/requests/${id}/approve`).type('form').send('x=1');
    expect(res.status).toBe(415);
  });

  it('keeps personal tokens working for headless agents', async () => {
    const agent = await signedIn();
    const tok = await agent.post('/api/agent-tokens').send({ name: 'CI' });
    expect((await tools(tok.body.token)).status).toBe(200);
  });
});

describe('the official MCP SDK client', () => {
  it('connects with only the server URL, signing in through the consent page', async () => {
    const agent = await signedIn('SDK person');
    const store: { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string; code?: string } = {};
    const provider: OAuthClientProvider = {
      get redirectUrl() {
        return REDIRECT;
      },
      get clientMetadata(): OAuthClientMetadata {
        return { client_name: 'SDK test client', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
      },
      clientInformation: () => store.client,
      saveClientInformation: (c) => void (store.client = c),
      tokens: () => store.tokens,
      saveTokens: (t) => void (store.tokens = t),
      saveCodeVerifier: (v) => void (store.verifier = v),
      codeVerifier: () => store.verifier!,
      async redirectToAuthorization(url) {
        // What the person's browser does: follow /authorize to the consent page and click Allow.
        const res = await fetch(url, { redirect: 'manual' });
        const id = new URL(res.headers.get('location')!).searchParams.get('request')!;
        const approved = await agent.post(`/api/oauth/requests/${id}/approve`).send({});
        store.code = new URL(approved.body.redirect).searchParams.get('code')!;
      },
    };
    const connect = async () => {
      const client = new Client({ name: 'sdk-test', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider }));
      return client;
    };
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider });
    await expect(new Client({ name: 'sdk-test', version: '1.0.0' }).connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(store.code).toBeTruthy();
    await transport.finishAuth(store.code!);
    expect(store.tokens?.access_token).toMatch(/^cna_/);

    const client = await connect();
    const { tools: list } = await client.listTools();
    expect(list.map((t) => t.name)).toContain('search_terms');
    // Connector directories (Anthropic's, OpenAI's) require a title and a read-only or destructive hint on every tool.
    for (const t of list) {
      expect(t.title, t.name).toBeTruthy();
      expect(typeof t.annotations?.readOnlyHint === 'boolean' || typeof t.annotations?.destructiveHint === 'boolean', t.name).toBe(true);
    }
    const found = await client.callTool({ name: 'search_terms', arguments: { ontology: 'volunteering', query: 'skill' } });
    expect(JSON.stringify(found.content)).toContain('vol:Skill');
    await client.close();
  });
});

describe('client metadata documents and redirect safety', () => {
  const CID = 'https://client.example/oauth/metadata.json';
  const docs = new Map<string, unknown>();
  let failWith: FetchError | undefined;
  beforeAll(() => {
    setClientMetadataFetcher(async (url) => {
      if (failWith) throw failWith;
      const d = docs.get(url.href);
      if (d === undefined) throw new FetchError('not-found', 'HTTP 404', 404);
      return JSON.stringify(d);
    });
  });
  const meta = (extra: Record<string, unknown> = {}) => ({ client_id: CID, client_name: 'Example Agent', redirect_uris: ['https://client.example/callback'], ...extra });
  const authorizeUrl = (clientId: string, redirect: string) =>
    `/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: pkce().challenge, code_challenge_method: 'S256', state: 's' })}`;

  it('accepts a valid metadata document and shows its name on the consent page', async () => {
    docs.set(CID, meta({ logo_uri: 'https://client.example/logo.png' }));
    const res = await request(base).get(authorizeUrl(CID, 'https://client.example/callback'));
    expect(res.status).toBe(302);
    const id = new URL(res.headers.location).searchParams.get('request')!;
    const info = await (await signedIn()).get(`/api/oauth/requests/${id}`);
    expect(info.body).toMatchObject({ clientName: 'Example Agent', redirectHost: 'client.example', localRedirect: false });
  });

  for (const [label, uri] of [
    ['javascript:', 'javascript:void(fetch("/api/agent-tokens"))//'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['plain http off this computer', 'http://client.example/callback'],
    ['a fragment', 'https://client.example/callback#x'],
  ] as const) {
    it(`refuses a metadata document whose redirect URI is ${label}`, async () => {
      const id = `https://client.example/bad-${label.replace(/\W/g, '')}.json`;
      docs.set(id, meta({ client_id: id, redirect_uris: [uri] }));
      const res = await request(base).get(authorizeUrl(id, uri));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_client');
    });
  }

  it('refuses metadata with unsafe links or a mismatched client_id', async () => {
    const logo = 'https://client.example/logo-http.json';
    docs.set(logo, meta({ client_id: logo, logo_uri: 'http://client.example/logo.png' }));
    expect((await request(base).get(authorizeUrl(logo, 'https://client.example/callback'))).status).toBe(400);
    const other = 'https://client.example/mismatch.json';
    docs.set(other, meta({ client_id: 'https://someone-else.example/meta.json' }));
    expect((await request(base).get(authorizeUrl(other, 'https://client.example/callback'))).status).toBe(400);
  });

  it('refuses the same unsafe redirect URIs at dynamic registration', async () => {
    for (const uri of ['javascript:alert(1)', 'http://client.example/cb', 'https://client.example/cb#frag']) {
      const res = await request(base).post('/register').send({ client_name: 'Bad', redirect_uris: [uri], token_endpoint_auth_method: 'none' });
      expect(res.status, uri).toBe(400);
    }
    // Native apps' reverse-domain schemes and loopback http are fine.
    for (const uri of ['com.example.agent:/oauth/callback', 'http://127.0.0.1:9999/callback']) {
      expect((await request(base).post('/register').send({ client_name: 'Native', redirect_uris: [uri], token_endpoint_auth_method: 'none' })).status, uri).toBe(201);
    }
  });

  it('never sends a browser to an unsafe address, even from a stored request', async () => {
    const agent = await signedIn();
    for (const action of ['approve', 'deny']) {
      const id = newId('authz');
      put('oauthRequests', { id, clientId: CID, redirectUri: 'javascript:alert(document.cookie)//', codeChallenge: 'x', scopes: [], resource: `${origin}/mcp`, issuer: `${origin}/`, expiresAt: Math.floor(Date.now() / 1000) + 600 });
      const res = await agent.post(`/api/oauth/requests/${id}/${action}`).send({});
      expect(res.status, action).toBe(400);
      expect(res.body.redirect).toBeUndefined();
    }
  });

  it('forgets a document that disappears or turns invalid, and stops trusting a stale one', async () => {
    const id = 'https://client.example/cache.json';
    docs.set(id, meta({ client_id: id }));
    expect((await request(base).get(authorizeUrl(id, 'https://client.example/callback'))).status).toBe(302);
    const age = (seconds: number) => {
      const doc = get<{ id: string; fetchedAt: number }>('oauthClients', id)!;
      put('oauthClients', { ...doc, fetchedAt: Math.floor(Date.now() / 1000) - seconds });
    };
    // Past a day old and the host is down: a short grace period, then no more.
    failWith = new FetchError('unavailable', 'timeout');
    try {
      age(24 * 3600 + 60);
      expect((await request(base).get(authorizeUrl(id, 'https://client.example/callback'))).status).toBe(302);
      age(26 * 3600);
      expect((await request(base).get(authorizeUrl(id, 'https://client.example/callback'))).status).toBe(400);
    } finally {
      failWith = undefined;
    }
    // Refetched fine, then removed by its owner: forgotten at once.
    expect((await request(base).get(authorizeUrl(id, 'https://client.example/callback'))).status).toBe(302);
    docs.delete(id);
    age(24 * 3600 + 60);
    expect((await request(base).get(authorizeUrl(id, 'https://client.example/callback'))).status).toBe(400);
    expect(get('oauthClients', id)).toBeUndefined();
  });
});

describe('fetching untrusted URLs', () => {
  it('only allows public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(isPublicAddress(ip), ip).toBe(true);
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fe90::1', 'febf::1', 'fc00::1', 'fd12::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '2001:db8::1', '2002:7f00:1::1', '64:ff9b::7f00:1', 'not-an-ip'])
      expect(isPublicAddress(ip), ip).toBe(false);
  });

  it('refuses to connect when the name resolves to a private address', async () => {
    await expect(safeFetchText(new URL('https://localhost/meta.json'))).rejects.toThrow(/not a public address/);
  });

  it('stops reading as soon as a response passes the size limit', async () => {
    let pushed = 0;
    const stream = new Readable({
      read() {
        pushed += 16 * 1024;
        this.push(Buffer.alloc(16 * 1024, 'a'));
      },
    });
    await expect(readCapped(stream, 64 * 1024)).rejects.toMatchObject({ kind: 'too-large' });
    expect(pushed).toBeLessThan(200 * 1024);
  });
});
