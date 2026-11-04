import { rewrite } from '@vercel/functions/middleware';

/**
 * Vercel routing middleware. The web app is static on Vercel; everything that
 * needs a long-running server (the API, sign-in, the MCP endpoint for agents,
 * WebIDs, OAuth for MCP clients, live meeting streams, the governance clock) is forwarded to the
 * backend at BACKEND_URL (see deploy/aws). Cookies, bodies and streamed
 * responses pass through unchanged, so the browser only ever talks to one origin.
 */
export const config = {
  runtime: 'nodejs',
  matcher: [
    '/api/:path*',
    '/auth/:path*',
    '/mcp',
    '/mcp/:path*',
    '/people/:path*',
    '/healthz',
    // OAuth for MCP clients (discovery, client registration, sign-in, tokens).
    '/.well-known/:path*',
    '/authorize',
    '/token',
    '/register',
    '/revoke',
  ],
};

export default function middleware(request: Request): Response {
  const backend = process.env.BACKEND_URL?.replace(/\/$/, '');
  if (!backend) {
    return Response.json({ error: 'This deployment has no BACKEND_URL set. Add it in the Vercel project settings and redeploy.' }, { status: 503 });
  }
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  // Never pass on a visitor's own x-concord-* headers.
  for (const name of [...headers.keys()]) if (name.startsWith('x-concord-')) headers.delete(name);
  headers.set('x-forwarded-host', url.host);
  headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
  // The backend's own proxy (Caddy) rewrites X-Forwarded-*, so say which site this came through and
  // who the visitor is, signed with a secret only this middleware and the backend know. The backend
  // builds OAuth URLs for that site and rate-limits by that IP; without the secret it ignores both.
  const secret = process.env.CONCORD_PROXY_SECRET;
  if (secret) {
    headers.set('x-concord-proxy-secret', secret);
    headers.set('x-concord-origin', url.origin);
    const ip = request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    if (ip) headers.set('x-concord-client-ip', ip);
  }
  return rewrite(new URL(url.pathname + url.search, backend), { request: { headers } });
}
