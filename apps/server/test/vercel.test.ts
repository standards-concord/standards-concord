import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request } from 'express';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { clientIp, publicOrigin } from '../src/oauth.js';
import { createHandler } from '../src/vercel.js';

/**
 * Concord as a Vercel function (step 5d): the entry the build packages (apps/server/vercel-entry.mjs), Vercel's
 * request size limit, and what a function can trust about a request that only Vercel's edge can reach it with.
 */

// The test database, opened first: the handler's own openDb then finds it open, wherever DATABASE_URL points.
beforeAll(async () => {
  await openDb();
});
const env = { ...process.env };
const cfg = { ontologyStore: config.ontologyStore, bodyLimits: config.bodyLimits };
afterEach(() => {
  process.env = { ...env };
  Object.assign(config, cfg);
});

/** The handler on a real port, as Vercel's launcher would call it. */
const serve = async (handler: ReturnType<typeof createHandler>) => {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, r));
  return { url: `http://localhost:${(server.address() as AddressInfo).port}`, close: () => new Promise((r) => server.close(r)) };
};

describe('the Vercel function', () => {
  it('refuses to start without Postgres, saying so, and tries again on the next request', async () => {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    const fn = await serve(createHandler({ waitUntil: () => undefined }));
    try {
      const first = await fetch(`${fn.url}/healthz`);
      expect(first.status).toBe(503);
      expect(first.headers.get('retry-after')).toBe('5');
      expect((await first.json()).error).toMatch(/starting up or its database is unreachable/);
      // Configured since (or the database woke up): the same instance starts on the next request.
      process.env.DATABASE_URL = 'postgres://configured.example/concord';
      (config as { ontologyStore: string }).ontologyStore = 'db';
      const second = await fetch(`${fn.url}/healthz`);
      expect(second.status).toBe(200);
    } finally {
      await fn.close();
    }
  });

  it('refuses the git store, which needs a lasting disk', async () => {
    process.env.DATABASE_URL = 'postgres://configured.example/concord';
    (config as { ontologyStore: string }).ontologyStore = 'git';
    const fn = await serve(createHandler({ waitUntil: () => undefined }));
    try {
      expect((await fetch(`${fn.url}/healthz`)).status).toBe(503);
    } finally {
      await fn.close();
    }
  });

  it('serves the API and runs start-up work after the response, on Vercel’s waitUntil', async () => {
    process.env.DATABASE_URL = 'postgres://configured.example/concord'; // the test database is already open
    (config as { ontologyStore: string }).ontologyStore = 'db';
    const kept: Promise<unknown>[] = [];
    const fn = await serve(createHandler({ waitUntil: (p) => void kept.push(p) }));
    try {
      const res = await fetch(`${fn.url}/api/session`);
      expect(res.status).toBe(200);
      expect(kept.length).toBeGreaterThan(0);
      await Promise.all(kept);
      // Started once per instance: a second request starts nothing more.
      const before = kept.length;
      await fetch(`${fn.url}/healthz`);
      expect(kept.length).toBe(before);
    } finally {
      await fn.close();
    }
  });
});

describe('request size on Vercel', () => {
  // Vercel refuses request bodies over 4.5 MB before Concord sees them. Under that, Concord's own limit (4 MB
  // there) answers with a message a person can act on, not "request entity too large".
  it('refuses a body over the limit with a message that says what the limit is', async () => {
    (config as { bodyLimits: typeof config.bodyLimits }).bodyLimits = { json: '4mb', audio: '4mb' };
    const { createApp } = await import('../src/app.js');
    const app = createApp();
    const big = JSON.stringify({ text: 'x'.repeat(4.2 * 1024 * 1024) });
    const res = await request(app).post('/api/feedback').set('content-type', 'application/json').send(big);
    expect(res.status).toBe(413);
    expect(res.body.error).toBe("That's too large to send (the limit is 4 MB).");
    const clip = await request(app).post('/api/transcribe').set('content-type', 'audio/webm').send(Buffer.alloc(4.2 * 1024 * 1024));
    expect(clip.status).toBe(413);
  });
});

describe('what a Vercel function trusts about a request', () => {
  const req = (headers: Record<string, string>) => ({ headers, header: (n: string) => headers[n.toLowerCase()], ip: '10.0.0.1' }) as unknown as Request;

  it('uses the domain the request was made to (a preview or a new custom domain) and the visitor’s address from Vercel', () => {
    process.env.VERCEL = '1';
    delete process.env.CONCORD_PROXY_SECRET;
    const r = req({ host: 'standards-concord-git-step5-jeswr1.vercel.app', 'x-real-ip': '203.0.113.7' });
    expect(publicOrigin(r)).toBe('https://standards-concord-git-step5-jeswr1.vercel.app');
    expect(clientIp(r)).toBe('203.0.113.7');
  });

  it('on a server reached directly (the VM), still believes neither', () => {
    delete process.env.VERCEL;
    process.env.CONCORD_PROXY_SECRET = 'a-secret-only-the-middleware-knows';
    const r = req({ host: 'anything.example', 'x-real-ip': '203.0.113.7' });
    expect(publicOrigin(r)).toBeUndefined();
    expect(clientIp(r)).toBe('10.0.0.1');
  });
});
