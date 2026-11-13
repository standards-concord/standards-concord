import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain script, no types
import { outputConfig } from '../../../scripts/vercel-output.mjs';

/**
 * The routing the function build writes to .vercel/output/config.json (scripts/vercel-build.mjs). Vercel also
 * reads vercel.json next to a prebuilt output and merges the two.
 */

const vercelJson = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../../vercel.json'), 'utf8')) as {
  crons: { path: string; schedule: string }[];
  headers: { source: string; headers: { key: string; value: string }[] }[];
  rewrites: { source: string; destination: string }[];
};
type Route = { src?: string; dest?: string; headers?: Record<string, string>; handle?: string };
const routes = (outputConfig() as { routes: Route[] }).routes;

describe('the function build’s routing', () => {
  // The first deploy of the function (a preview, 2026-11-11) was refused: the build wrote the daily cron into
  // config.json and vercel.json declared it too, and Vercel merged them into "a duplicated cron job".
  it('leaves the daily cron to vercel.json, so a function deploy isn’t refused as a duplicate', () => {
    expect(vercelJson.crons).toEqual([{ path: '/api/cron/daily', schedule: '17 4 * * *' }]);
    expect(outputConfig()).not.toHaveProperty('crons');
  });

  // The build's routes once left out vercel.json's no-cache header for the service worker.
  it('sets every header vercel.json sets, on the same paths', () => {
    for (const rule of vercelJson.headers) {
      const sample = rule.source.replace('(.*)', 'x');
      const route = routes.find((r) => r.headers && r.src && new RegExp(r.src).test(sample));
      expect(route, rule.source).toBeDefined();
      for (const h of rule.headers) expect(route!.headers![h.key], `${rule.source} ${h.key}`).toBe(h.value);
    }
  });

  it('sends the API’s paths to the function and everything else to the web app', () => {
    const to = (p: string) => routes.find((r) => r.src && r.dest && new RegExp(r.src).test(p))?.dest;
    for (const p of ['/api/cron/daily', '/auth/google/callback', '/mcp', '/healthz', '/.well-known/oauth-authorization-server', '/token', '/def', '/def/', '/def.jsonld', '/def.ttl', '/def/volunteering', '/licences/W3C-20150513', '/docs/licences/CC-BY-1.0.md']) expect(to(p), p).toBe('/api');
    for (const p of ['/', '/o/x/terms', '/welcome', '/apiary']) expect(to(p), p).toBe('/index.html');
  });

  it('keeps the catalogue, its representations and licence notices out of Vercel’s app rewrite', () => {
    // The rewrite used to exclude only /def/, sending the catalogue to index.html.
    for (const rule of vercelJson.rewrites.filter((r) => r.destination === '/index.html')) {
      const pattern = new RegExp(`^${rule.source}$`);
      for (const url of ['/def', '/def/', '/def.jsonld', '/def.ttl', '/def/volunteering', '/licences/W3C-20150513', '/docs/licences/CC-BY-1.0.md']) expect(pattern.test(url), url).toBe(false);
      for (const url of ['/', '/definitions', '/o/example']) expect(pattern.test(url), url).toBe(true);
    }
  });
});
