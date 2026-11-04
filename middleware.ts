import { rewrite } from '@vercel/functions/middleware';

/**
 * Vercel routing middleware. The web app is static on Vercel; everything that
 * needs a long-running server (the API, sign-in, the MCP endpoint for agents,
 * WebIDs, dereferenceable ontology documents at /def, live meeting streams, the governance clock) is forwarded to the
 * backend at BACKEND_URL (see deploy/aws). Cookies, bodies and streamed
 * responses pass through unchanged, so the browser only ever talks to one origin.
 */
export const config = { runtime: 'nodejs', matcher: ['/api/:path*', '/auth/:path*', '/mcp', '/mcp/:path*', '/people/:path*', '/def/:path*', '/healthz'] };

export default function middleware(request: Request): Response {
  const backend = process.env.BACKEND_URL?.replace(/\/$/, '');
  if (!backend) {
    return Response.json({ error: 'This deployment has no BACKEND_URL set. Add it in the Vercel project settings and redeploy.' }, { status: 503 });
  }
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.set('x-forwarded-host', url.host);
  headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
  return rewrite(new URL(url.pathname + url.search, backend), { request: { headers } });
}
