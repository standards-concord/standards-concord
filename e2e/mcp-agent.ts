import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

/**
 * A stand-in for Claude Code or Codex: the official MCP SDK client with a
 * loopback redirect, exactly as CLI agents do it. `authorizationUrl` resolves
 * when the client wants the person's browser to open the sign-in page, and
 * `callback` resolves with the query string the browser is sent back with.
 */
export async function fakeAgent(baseURL: string, name = 'Playwright Agent') {
  let resolveCallback!: (q: URLSearchParams) => void;
  const callback = new Promise<URLSearchParams>((r) => (resolveCallback = r));
  const server: Server = createServer((req, res) => {
    const q = new URL(req.url ?? '/', 'http://localhost').searchParams;
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h1 id="done">Agent connected. You can close this tab.</h1>');
    resolveCallback(q);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const redirectUrl = `http://localhost:${(server.address() as AddressInfo).port}/callback`;

  let resolveAuthUrl!: (u: URL) => void;
  const authorizationUrl = new Promise<URL>((r) => (resolveAuthUrl = r));
  const store: { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string } = {};
  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return redirectUrl;
    },
    get clientMetadata(): OAuthClientMetadata {
      return { client_name: name, redirect_uris: [redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
    },
    clientInformation: () => store.client,
    saveClientInformation: (c) => void (store.client = c),
    tokens: () => store.tokens,
    saveTokens: (t) => void (store.tokens = t),
    saveCodeVerifier: (v) => void (store.verifier = v),
    codeVerifier: () => store.verifier!,
    redirectToAuthorization: (url) => resolveAuthUrl(url),
  };
  const mcpUrl = new URL('/mcp', baseURL);
  const transport = new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider });
  // The first connect fails with 401 and kicks off discovery, registration and the browser hand-off.
  const first = new Client({ name: 'playwright', version: '1.0.0' }).connect(transport).catch((e: unknown) => e);

  return {
    store,
    authorizationUrl,
    callback,
    first,
    async finish(code: string) {
      await transport.finishAuth(code);
    },
    async connect() {
      const client = new Client({ name: 'playwright', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider }));
      return client;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
