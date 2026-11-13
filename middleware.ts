import { next, rewrite } from '@vercel/functions/middleware';

/**
 * Vercel routing middleware. The web app is static on Vercel; everything that
 * needs a long-running server (the API, sign-in, the MCP endpoint for agents,
 * WebIDs, public ontology pages and fork documents at /def, OAuth for MCP clients, live meeting streams, the governance clock) is forwarded to the
 * backend at BACKEND_URL (see deploy/aws). Cookies, bodies and streamed
 * responses pass through unchanged, so the browser only ever talks to one origin.
 *
 * Since step 5 the API can be a Vercel function in the same deployment (scripts/vercel-build.mjs). Vercel
 * runs this middleware before the function's routes, so when the function serves the API it must let the
 * request through. It decides as the build does: the function unless BACKEND_URL is set, and CONCORD_API
 * (`function` or `backend`) overrides that. A preview of the function while BACKEND_URL is set for
 * Preview needs CONCORD_API=function at build time and at run time.
 */
export const config = {
  runtime: 'nodejs',
  matcher: [
    '/api/:path*',
    '/auth/:path*',
    '/mcp',
    '/mcp/:path*',
    '/people/:path*',
    '/def/:path*',
    '/def.jsonld',
    '/def.ttl',
    '/licences/:path*',
    '/docs/licences/:path*',
    '/healthz',
    // OAuth for MCP clients (discovery, client registration, sign-in, tokens).
    '/.well-known/:path*',
    '/authorize',
    '/token',
    '/register',
    '/revoke',
  ],
};

/** Whether this deployment's own function serves the API, decided as scripts/vercel-build.mjs decides it. */
const functionServesApi = () => (process.env.CONCORD_API ?? (process.env.BACKEND_URL ? 'backend' : 'function')) === 'function';

export default function middleware(request: Request): Response {
  if (functionServesApi()) {
    // On to the function, without a visitor's own x-concord-* headers (only this middleware may set them).
    const headers = new Headers(request.headers);
    for (const name of [...headers.keys()]) if (name.startsWith('x-concord-')) headers.delete(name);
    return next({ request: { headers } });
  }
  const backend = process.env.BACKEND_URL?.replace(/\/$/, '');
  if (!backend) {
    return Response.json({ error: 'This deployment has CONCORD_API=backend but no BACKEND_URL. Add BACKEND_URL in the Vercel project settings, or remove CONCORD_API, and redeploy.' }, { status: 503 });
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
