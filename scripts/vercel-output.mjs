// The routing the function build writes to .vercel/output/config.json (scripts/vercel-build.mjs).
//
// Vercel still reads vercel.json alongside a prebuilt output and merges the two: its crons are added to these, so
// the daily cron stays in vercel.json only (with it in both, Vercel refused the deploy as "a duplicated cron job").
// The headers vercel.json sets are repeated here as routes, so the web app is served the same way with or without
// the function.

// What the API answers (the same paths middleware.ts forwarded to the VM). Everything else is the web app.
export const API_PATHS = '^/(api(/.*)?|auth/.*|mcp(/.*)?|people/.*|def(/.*|\\.(jsonld|ttl))?|licences/.*|docs/licences/.*|healthz|\\.well-known/.*|authorize|token|register|revoke)$';

export function outputConfig() {
  return {
    version: 3,
    routes: [
      { src: API_PATHS, dest: '/api' },
      { src: '^/assets/(.*)$', headers: { 'Cache-Control': 'public, max-age=31536000, immutable' }, continue: true },
      { src: '^/avatars/(.*)$', headers: { 'Cache-Control': 'public, max-age=86400' }, continue: true },
      { src: '^/sw\\.js$', headers: { 'Cache-Control': 'no-cache' }, continue: true },
      { handle: 'filesystem' },
      { src: '^/.*$', dest: '/index.html' },
    ],
  };
}
