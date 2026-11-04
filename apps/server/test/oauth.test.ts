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
import { claim, get, openDb, put } from '../src/db.js';
import { newId } from '../src/ids.js';
import { migrateClientSecrets, setClientMetadataFetcher } from '../src/oauth.js';
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
  if (host) r.set('Host', host);
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

  it('builds URLs from the Host header for configured domains only, never from X-Forwarded-*', async () => {
    const asMeta = (h: Record<string, string>) => request(base).get('/.well-known/oauth-authorization-server').set(h);
    // Forwarded headers can't pick the origin, even a configured one.
    process.env.PUBLIC_ORIGINS = `${base},https://concord.example.org`;
    try {
      const forged = await asMeta({ 'X-Forwarded-Host': 'concord.example.org', 'X-Forwarded-Proto': 'https' });
      expect(forged.body.issuer).toBe(`${base}/`);
      // A configured domain in the Host header gets its own URLs, with the scheme from configuration.
      const alias = await asMeta({ Host: 'concord.example.org', 'X-Forwarded-Proto': 'http' });
      expect(alias.body.issuer).toBe('https://concord.example.org/');
      expect(alias.body.token_endpoint).toBe('https://concord.example.org/token');
    } finally {
      process.env.PUBLIC_ORIGINS = base;
    }
    // Without the proxy secret, an unlisted host (such as the backend's own name, which Vercel uses) is an alias of PUBLIC_URL.
    expect((await asMeta({ Host: 'attacker.example' })).body.issuer).toBe('http://localhost:8787/');
  });

  it('refuses unlisted hosts once the proxy secret is set, for OAuth and MCP alike', async () => {
    process.env.CONCORD_PROXY_SECRET = 'proxy-secret-for-tests';
    try {
      for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp', '/authorize', '/register']) {
        const res = await request(base).get(path).set('Host', '74.152.52.138.sslip.io');
        expect(res.status, path).toBe(421);
      }
      const direct = await mcp(undefined, { jsonrpc: '2.0', id: 1, method: 'initialize' }, 'attacker.example');
      expect(direct.status).toBe(421);
      expect(direct.headers['www-authenticate']).toBeUndefined();
      // Configured hosts and the authenticated proxy still work.
      expect((await request(base).get('/.well-known/oauth-authorization-server')).status).toBe(200);
      const viaProxy = await request(base)
        .get('/.well-known/oauth-protected-resource/mcp')
        .set({ Host: '74.152.52.138.sslip.io', 'X-Concord-Origin': 'https://standards-concord.vercel.app', 'X-Concord-Proxy-Secret': 'proxy-secret-for-tests' });
      expect(viaProxy.body.resource).toBe('https://standards-concord.vercel.app/mcp');
    } finally {
      delete process.env.CONCORD_PROXY_SECRET;
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

  it('when the same refresh token is sent twice at once, one wins and the whole connection is then revoked', async () => {
    const client = await register();
    const agent = await signedIn();
    const { verifier, challenge } = pkce();
    const { code } = await authorize(agent, client.client_id, origin, { challenge, resource: `${origin}/mcp` });
    const t = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT });
    const refresh = () => token({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token, client_id: client.client_id });
    const results = await Promise.all([refresh(), refresh(), refresh()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400, 400]);
    const winner = results.find((r) => r.status === 200)!;
    // The replays revoked the family, so even the winner's new tokens are dead.
    expect((await tools(winner.body.access_token)).status).toBe(401);
    expect((await token({ grant_type: 'refresh_token', refresh_token: winner.body.refresh_token, client_id: client.client_id })).status).toBe(400);
  });

  it('two authorization-code exchanges at once produce one connection', async () => {
    const client = await register();
    const agent = await signedIn();
    const { verifier, challenge } = pkce();
    const { code } = await authorize(agent, client.client_id, origin, { challenge, resource: `${origin}/mcp` });
    const exchange = () => token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT });
    const results = await Promise.all([exchange(), exchange()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  });

  it('lets only one of two racing refreshes win, and treats the loser as a replay', async () => {
    const client = await register();
    const agent = await signedIn();
    const { verifier, challenge } = pkce();
    const { code } = await authorize(agent, client.client_id, origin, { challenge, resource: `${origin}/mcp` });
    const t = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT });
    // Simulate another writer that read the same unconsumed token and consumed it first, between our read and our write:
    // the conditional consume in exchangeRefreshToken must then lose, not mint a second successor.
    const hash = createHash('sha256').update(t.body.refresh_token).digest('hex');
    const before = get<{ id: string; grantId: string }>('oauthTokens', hash)!;
    expect(claim('oauthTokens', hash, 'consumedAt', Math.floor(Date.now() / 1000))).toBeDefined();
    expect(claim('oauthTokens', hash, 'consumedAt', Math.floor(Date.now() / 1000))).toBeUndefined();
    const loser = await token({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token, client_id: client.client_id });
    expect(loser.status).toBe(400);
    expect(get('oauthGrants', before.grantId)).toBeUndefined();
    expect((await tools(t.body.access_token)).status).toBe(401);
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

  /**
   * Runs a whole sign-in the way ChatGPT's connector does: resource on the authorization and token requests,
   * OIDC scopes on the authorization request, PKCE, then a refresh. Returns the client's tokens.
   */
  async function chatgptFlow(clientId: string, redirect: string, tokenAuth: Record<string, string> = {}, consent: Record<string, unknown> = {}) {
    const { verifier, challenge } = pkce();
    const resource = `${origin}/mcp`;
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'cgpt', resource, scope: 'openid email profile' });
    const start = await request(base).get(`/authorize?${q}`);
    expect(start.status, JSON.stringify(start.body)).toBe(302);
    const id = new URL(start.headers.location).searchParams.get('request')!;
    const agent = await signedIn('ChatGPT user');
    expect((await agent.get(`/api/oauth/requests/${id}`)).body).toMatchObject({ clientName: 'ChatGPT', redirectHost: 'chatgpt.com', ...consent });
    const back = new URL((await agent.post(`/api/oauth/requests/${id}/approve`).send({})).body.redirect);
    expect(back.origin + back.pathname).toBe(redirect);
    expect(back.searchParams.get('iss')).toBe(`${origin}/`);
    expect(back.searchParams.get('state')).toBe('cgpt');
    const code = back.searchParams.get('code')!;
    const t = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: redirect, resource, ...tokenAuth });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    expect((await tools(t.body.access_token)).status).toBe(200);
    const r = await token({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token, client_id: clientId, resource, ...tokenAuth });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await tools(r.body.access_token)).status).toBe(200);
    return r.body as OAuthTokens;
  }

  /**
   * ChatGPT's metadata documents, as OpenAI describes them: every method it can use, in no order, plus a
   * preferred one. The stable document only lists the stable callback; a callback-specific document is used
   * with authorization servers that don't advertise issuer identification in responses.
   */
  const CGPT_STABLE = 'https://chatgpt.com/oauth/client.json';
  const CGPT_CALLBACK = 'https://chatgpt.com/oauth/cb_123abc/client.json';
  const CGPT_AUTH = { methods: ['none', 'private_key_jwt'], preferred: 'private_key_jwt' };
  const cgptDoc = (clientId: string, redirect: string, { methods, preferred }: { methods?: unknown; preferred?: unknown } = CGPT_AUTH) => ({
    client_id: clientId,
    client_name: 'ChatGPT',
    client_uri: 'https://chatgpt.com',
    redirect_uris: [redirect],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    ...(methods === undefined ? {} : { token_endpoint_auth_methods_supported: methods }),
    ...(preferred === undefined ? {} : { token_endpoint_auth_method: preferred }),
    jwks_uri: 'https://chatgpt.com/oauth/jwks.json',
    scope: 'openid email profile',
  });
  const assertion = { client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: 'eyJhbGciOiJSUzI1NiJ9.e30.sig' };

  it('leads ChatGPT to its callback-specific client and to public-client authentication', async () => {
    const meta = (await request(base).get('/.well-known/oauth-authorization-server')).body;
    // No issuer identification in responses, so ChatGPT uses its callback-specific client ID and callback.
    expect(meta.authorization_response_iss_parameter_supported).toBeUndefined();
    expect(meta.client_id_metadata_document_supported).toBe(true);
    expect(meta.code_challenge_methods_supported).toContain('S256');
    // ChatGPT picks from the intersection with what it can do: that leaves only none.
    expect(meta.token_endpoint_auth_methods_supported.filter((m: string) => ['none', 'private_key_jwt'].includes(m))).toEqual(['none']);
  });

  it('works with ChatGPT through its callback-specific metadata document', async () => {
    docs.set(CGPT_CALLBACK, cgptDoc(CGPT_CALLBACK, 'https://chatgpt.com/connector/oauth/cb_123abc'));
    await chatgptFlow(CGPT_CALLBACK, 'https://chatgpt.com/connector/oauth/cb_123abc', {}, { publisher: 'chatgpt.com' });
  });

  it('works with ChatGPT through its stable metadata document too', async () => {
    docs.set(CGPT_STABLE, cgptDoc(CGPT_STABLE, 'https://chatgpt.com/connector_platform_oauth_redirect'));
    await chatgptFlow(CGPT_STABLE, 'https://chatgpt.com/connector_platform_oauth_redirect', {}, { publisher: 'chatgpt.com' });
  });

  it('refuses a callback the metadata document does not list', async () => {
    docs.set(CGPT_CALLBACK, cgptDoc(CGPT_CALLBACK, 'https://chatgpt.com/connector/oauth/cb_123abc'));
    for (const wrong of ['https://chatgpt.com/connector_platform_oauth_redirect', 'https://chatgpt.com/connector/oauth/cb_other', 'https://chatgpt.com.evil.example/connector/oauth/cb_123abc']) {
      expect((await request(base).get(authorizeUrl(CGPT_CALLBACK, wrong))).status, wrong).toBe(400);
    }
  });

  it('refuses a code redeemed by a different client', async () => {
    docs.set(CGPT_CALLBACK, cgptDoc(CGPT_CALLBACK, 'https://chatgpt.com/connector/oauth/cb_123abc'));
    docs.set(CGPT_STABLE, cgptDoc(CGPT_STABLE, 'https://chatgpt.com/connector_platform_oauth_redirect'));
    const { verifier, challenge } = pkce();
    const redirect = 'https://chatgpt.com/connector/oauth/cb_123abc';
    const q = new URLSearchParams({ response_type: 'code', client_id: CGPT_CALLBACK, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', resource: `${origin}/mcp` });
    const id = new URL((await request(base).get(`/authorize?${q}`)).headers.location).searchParams.get('request')!;
    const back = new URL((await (await signedIn()).post(`/api/oauth/requests/${id}/approve`).send({})).body.redirect);
    const res = await token({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, code_verifier: verifier, client_id: CGPT_STABLE, redirect_uri: redirect, resource: `${origin}/mcp` });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('refuses a metadata document that does not allow public-client authentication', async () => {
    const cases: [string, unknown, unknown][] = [
      ['private-key-only', ['private_key_jwt'], 'private_key_jwt'],
      ['preference-only', undefined, 'private_key_jwt'],
      ['secret-only', ['client_secret_basic'], undefined],
      ['not-a-list', 'none', undefined],
      // Malformed or contradictory, even though none is listed.
      ['preference-not-listed', ['none'], 'private_key_jwt'],
      ['non-string-method', ['none', 7], undefined],
      ['object-preference', ['none'], { m: 'none' }],
      ['shared-secret-listed', ['none', 'client_secret_basic'], undefined],
      ['empty-list', [], undefined],
    ];
    for (const [label, methods, preferred] of cases) {
      const cid = `https://chatgpt.com/oauth/${label}/client.json`;
      const redirect = `https://chatgpt.com/connector/oauth/${label}`;
      docs.set(cid, cgptDoc(cid, redirect, { methods, preferred }));
      const res = await request(base).get(authorizeUrl(cid, redirect));
      expect(res.status, label).toBe(400);
      expect(res.body.error, label).toBe('invalid_client');
    }
    // A document that names no method at all is a public client (it can't carry a secret).
    const bare = 'https://chatgpt.com/oauth/bare/client.json';
    docs.set(bare, cgptDoc(bare, 'https://chatgpt.com/connector/oauth/bare', {}));
    expect((await request(base).get(authorizeUrl(bare, 'https://chatgpt.com/connector/oauth/bare'))).status).toBe(302);
  });

  it('checks a document cached by the old rules again, and drops it if it now fails', async () => {
    const cid = 'https://chatgpt.com/oauth/cached-old/client.json';
    const redirect = 'https://chatgpt.com/connector/oauth/cached-old';
    docs.set(cid, cgptDoc(cid, redirect, { methods: ['private_key_jwt'], preferred: 'private_key_jwt' }));
    // As the earlier code stored it: rewritten to none, with no record of which checks admitted it.
    put('oauthClients', { id: cid, info: { client_id: cid, client_name: 'ChatGPT', redirect_uris: [redirect], token_endpoint_auth_method: 'none' }, fetchedAt: Math.floor(Date.now() / 1000) });
    expect((await request(base).get(authorizeUrl(cid, redirect))).status).toBe(400);
    expect(get('oauthClients', cid)).toBeUndefined();
  });

  it('refuses client assertions instead of ignoring them', async () => {
    docs.set(CGPT_CALLBACK, cgptDoc(CGPT_CALLBACK, 'https://chatgpt.com/connector/oauth/cb_123abc'));
    const tokens = await chatgptFlow(CGPT_CALLBACK, 'https://chatgpt.com/connector/oauth/cb_123abc');
    for (const extra of [assertion, { client_assertion: 'not-a-jwt' }, { client_assertion_type: assertion.client_assertion_type }] as Record<string, string>[]) {
      const res = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token!, client_id: CGPT_CALLBACK, resource: `${origin}/mcp`, ...extra });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_client');
    }
    const revoke = await request(base).post('/revoke').type('form').send({ token: tokens.refresh_token!, client_id: CGPT_CALLBACK, ...assertion });
    expect(revoke.status).toBe(401);
    // Refused requests did not use up or revoke the refresh token.
    expect((await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token!, client_id: CGPT_CALLBACK, resource: `${origin}/mcp` })).status).toBe(200);
  });

  it('works with ChatGPT registering itself, public or with a secret, and checks the secret', async () => {
    const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
    const reg = (method?: string) =>
      request(base)
        .post('/register')
        .send({ client_name: 'ChatGPT', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'openid email profile', ...(method ? { token_endpoint_auth_method: method } : {}) });
    const pub = await reg('none');
    expect(pub.status).toBe(201);
    expect(pub.body.client_secret).toBeUndefined();
    await chatgptFlow(pub.body.client_id, redirect);
    const conf = await reg('client_secret_post');
    expect(conf.status).toBe(201);
    const tokens = await chatgptFlow(conf.body.client_id, redirect, { client_secret: conf.body.client_secret });
    for (const auth of [{}, { client_secret: 'wrong' }, { client_secret: '' }] as Record<string, string>[]) {
      const res = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token!, client_id: conf.body.client_id, resource: `${origin}/mcp`, ...auth });
      expect(res.status, JSON.stringify(auth)).toBe(401);
      expect(res.body.error).toBe('invalid_client');
    }
    // The secret is stored only as a hash.
    const stored = get<{ info: Record<string, unknown>; secretHash?: string }>('oauthClients', conf.body.client_id)!;
    expect(stored.info.client_secret).toBeUndefined();
    expect(stored.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(conf.body.client_secret);
    // Leaving the method out gets client_secret_post (RFC 7591's client_secret_basic default isn't supported), and says so.
    const omitted = await reg();
    expect(omitted.status).toBe(201);
    expect(omitted.body.token_endpoint_auth_method).toBe('client_secret_post');
    expect(omitted.body.client_secret).toBeTruthy();
    for (const method of ['private_key_jwt', 'client_secret_basic', 'tls_client_auth']) {
      const res = await reg(method);
      expect(res.status, method).toBe(400);
      expect(res.body.error).toBe('invalid_client_metadata');
    }
  });

  it('refuses credentials a public client sends, and HTTP Basic from anyone', async () => {
    docs.set(CGPT_CALLBACK, cgptDoc(CGPT_CALLBACK, 'https://chatgpt.com/connector/oauth/cb_123abc'));
    const tokens = await chatgptFlow(CGPT_CALLBACK, 'https://chatgpt.com/connector/oauth/cb_123abc');
    const basic = `Basic ${Buffer.from(`${encodeURIComponent(CGPT_CALLBACK)}:x`).toString('base64')}`;
    const refresh = { grant_type: 'refresh_token', refresh_token: tokens.refresh_token!, client_id: CGPT_CALLBACK, resource: `${origin}/mcp` };
    expect((await token({ ...refresh, client_secret: 'bogus' })).status).toBe(401);
    expect((await request(base).post('/token').type('form').set('Authorization', basic).send(refresh)).status).toBe(401);
    expect((await request(base).post('/revoke').type('form').set('Authorization', basic).send({ token: tokens.refresh_token!, client_id: CGPT_CALLBACK })).status).toBe(401);
    expect((await request(base).post('/revoke').type('form').send({ token: tokens.refresh_token!, client_id: CGPT_CALLBACK, client_secret: 'bogus' })).status).toBe(401);
    // A registered public client too.
    const pub = await register();
    const { verifier, challenge } = pkce();
    const { code } = await authorize(await signedIn(), pub.client_id, origin, { challenge, resource: `${origin}/mcp` });
    const exchange = { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: pub.client_id, redirect_uri: REDIRECT, resource: `${origin}/mcp` };
    expect((await token({ ...exchange, client_secret: 'bogus' })).status).toBe(401);
    // None of that used up the code or the refresh token.
    expect((await token(exchange)).status).toBe(200);
    expect((await token(refresh)).status).toBe(200);
  });

  /** A confidential registered client with a live refresh token and a fresh code, for the checks below. */
  async function confidentialClient() {
    // Stored the way registration stores it (registering over HTTP here would hit its hourly limit).
    const client_id = newId('client');
    const client_secret = randomBytes(32).toString('hex');
    put('oauthClients', {
      id: client_id,
      info: { client_id, client_name: 'Confidential', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'client_secret_post', client_secret_expires_at: 0 },
      secretHash: createHash('sha256').update(client_secret).digest('hex'),
    });
    const newCode = async () => {
      const { verifier, challenge } = pkce();
      const { code } = await authorize(await signedIn(), client_id, origin, { challenge, resource: `${origin}/mcp` });
      return { grant_type: 'authorization_code', code, code_verifier: verifier, client_id, redirect_uri: REDIRECT, resource: `${origin}/mcp` };
    };
    const first = await token({ ...(await newCode()), client_secret });
    expect(first.status).toBe(200);
    return { client_id, client_secret, newCode, refresh: { grant_type: 'refresh_token', refresh_token: first.body.refresh_token as string, client_id, resource: `${origin}/mcp` } };
  }

  it('checks the secret on every path the token and revocation endpoints answer', async () => {
    const c = await confidentialClient();
    const exchange = await c.newCode();
    for (const path of ['/token', '/token/', '/token//', '/TOKEN', '/token///x']) {
      for (const body of [exchange, c.refresh]) {
        const res = await request(base).post(path).type('form').send(body);
        expect([401, 404], `${path} ${body.grant_type}`).toContain(res.status);
      }
    }
    for (const path of ['/revoke', '/revoke/', '/revoke//']) {
      expect([401, 404], path).toContain((await request(base).post(path).type('form').send({ token: c.refresh.refresh_token, client_id: c.client_id })).status);
    }
    // Off the canonical paths, the endpoints aren't there at all.
    expect((await request(base).post('/token//').type('form').send({ ...c.refresh, client_secret: c.client_secret })).status).toBe(404);
    // And nothing above used up the code or the refresh token.
    expect((await token({ ...exchange, client_secret: c.client_secret })).status).toBe(200);
    expect((await token({ ...c.refresh, client_secret: c.client_secret })).status).toBe(200);
  });

  it('refuses an expired secret, and a malformed stored hash, without a server error', async () => {
    const c = await confidentialClient();
    const doc = get<{ id: string; info: Record<string, unknown>; secretHash: string }>('oauthClients', c.client_id)!;
    put('oauthClients', { ...doc, info: { ...doc.info, client_secret_expires_at: Math.floor(Date.now() / 1000) - 60 } });
    const exchange = await c.newCode();
    for (const body of [exchange, c.refresh]) {
      const res = await token({ ...body, client_secret: c.client_secret });
      expect(res.status, body.grant_type).toBe(401);
      expect(res.body.error_description).toContain('expired');
    }
    expect((await request(base).post('/revoke').type('form').send({ token: c.refresh.refresh_token, client_id: c.client_id, client_secret: c.client_secret })).status).toBe(401);
    put('oauthClients', { ...doc, secretHash: 'ab' });
    expect((await token({ ...exchange, client_secret: c.client_secret })).status).toBe(401);
    put('oauthClients', doc);
    expect((await token({ ...exchange, client_secret: c.client_secret })).status).toBe(200);
  });

  it('hashes every plain-text secret at startup, including clients nobody has used since', () => {
    const ids = [newId('client'), newId('client')];
    for (const id of ids) put('oauthClients', { id, info: { client_id: id, client_name: 'Untouched', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_post', client_secret: `plain-${id}` } });
    expect(migrateClientSecrets()).toBeGreaterThanOrEqual(2);
    for (const id of ids) {
      const d = get<{ info: Record<string, unknown>; secretHash?: string }>('oauthClients', id)!;
      expect(d.info.client_secret).toBeUndefined();
      expect(d.secretHash).toBe(createHash('sha256').update(`plain-${id}`).digest('hex'));
    }
    expect(migrateClientSecrets()).toBe(0);
  });

  it('moves a secret stored in plain text by older code into a hash, and still accepts it', async () => {
    const id = newId('client');
    const secret = randomBytes(32).toString('hex');
    put('oauthClients', { id, info: { client_id: id, client_name: 'Old client', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_post', client_secret: secret, client_secret_expires_at: 0 } });
    const { verifier, challenge } = pkce();
    const { code } = await authorize(await signedIn(), id, origin, { challenge, resource: `${origin}/mcp` });
    const stored = get<{ info: Record<string, unknown>; secretHash?: string }>('oauthClients', id)!;
    expect(stored.info.client_secret).toBeUndefined();
    expect(stored.secretHash).toBe(createHash('sha256').update(secret).digest('hex'));
    const exchange = { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: id, redirect_uri: REDIRECT, resource: `${origin}/mcp` };
    expect((await token(exchange)).status).toBe(401);
    expect((await token({ ...exchange, client_secret: secret })).status).toBe(200);
  });

  it('says plainly when access goes to a native app, whatever its link claims after the scheme', async () => {
    for (const [uri, scheme] of [
      ['com.attacker.agent://chatgpt.com/cb', 'com.attacker.agent:'],
      ['com.attacker.agent:/cb', 'com.attacker.agent:'],
    ]) {
      const reg = await request(base).post('/register').send({ client_name: 'ChatGPT', redirect_uris: [uri], token_endpoint_auth_method: 'none' });
      expect(reg.status).toBe(201);
      const res = await request(base).get(authorizeUrl(reg.body.client_id, uri));
      const id = new URL(res.headers.location).searchParams.get('request')!;
      const info = (await (await signedIn()).get(`/api/oauth/requests/${id}`)).body;
      expect(info, uri).toMatchObject({ redirectKind: 'native', redirectHost: scheme, localRedirect: false });
    }
  });

  it('does not vouch for a registered app that borrows another app’s name and website', async () => {
    const reg = await request(base)
      .post('/register')
      .send({ client_name: 'ChatGPT', client_uri: 'https://chatgpt.com', redirect_uris: ['https://chatgpt.com.evil.example/connector/oauth/x'], token_endpoint_auth_method: 'none' });
    expect(reg.status).toBe(201);
    const res = await request(base).get(authorizeUrl(reg.body.client_id, 'https://chatgpt.com.evil.example/connector/oauth/x'));
    const id = new URL(res.headers.location).searchParams.get('request')!;
    const info = (await (await signedIn()).get(`/api/oauth/requests/${id}`)).body;
    expect(info).toMatchObject({ clientName: 'ChatGPT', clientUri: 'https://chatgpt.com', redirectHost: 'chatgpt.com.evil.example', redirectKind: 'web' });
    expect(info.publisher).toBeUndefined();
  });

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
