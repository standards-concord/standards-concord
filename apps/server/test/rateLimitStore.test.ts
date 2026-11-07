import express from 'express';
import { rateLimit } from 'express-rate-limit';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { closeDb, openDb } from '../src/db.js';
import { DbRateStore } from '../src/rateLimitStore.js';
import { withTriageBudget } from '../src/services/budget.js';

/**
 * Abuse limits shared by every instance (step 5): with express-rate-limit's memory store, or a Map, each Vercel
 * function instance had a full allowance of its own, so N instances let N times the limit through.
 *
 * With TEST_DATABASE_URL the counters are on a real Postgres pool, so the two "servers" below race on separate
 * connections.
 */

const pgUrl = process.env.TEST_DATABASE_URL;
beforeAll(async () => {
  if (pgUrl) await openDb({ kind: 'postgres', url: pgUrl, max: 4 });
});
afterAll(async () => {
  if (pgUrl) await closeDb();
});

/** One server: its own app, its own limiter and store object, the same database. */
const server = (name: string) => {
  const app = express();
  app.use(rateLimit({ windowMs: 60_000, limit: 3, store: new DbRateStore(name), keyGenerator: () => 'client-1', validate: false }));
  app.get('/', (_req, res) => res.json({ ok: true }));
  return app;
};

describe('rate limits counted in the database', () => {
  it('lets one client through only as often as the limit, however many servers it reaches', async () => {
    const name = `test-${Date.now()}`;
    const [a, b] = [server(name), server(name)];
    const statuses = [];
    for (const app of [a, b, a, b, a]) statuses.push((await request(app).get('/')).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it('counts racing requests to two servers exactly', async () => {
    const name = `race-${Date.now()}`;
    const [a, b] = [server(name), server(name)];
    const statuses = await Promise.all([a, b, a, b, a, b].map((app) => request(app).get('/').then((r) => r.status)));
    expect(statuses.filter((s) => s === 200)).toHaveLength(3);
  });

  it('caps a person’s change checks across servers, not per server', async () => {
    const before = config.sharedLimits;
    (config as { sharedLimits: boolean }).sharedLimits = true;
    try {
      const user = { id: `budget-${Date.now()}` };
      // Another server already ran this person's 20 checks in this window: this one, with a fresh count of its
      // own, still refuses the next.
      const { reserveCounters } = await import('../src/db.js');
      const window = Math.floor(Date.now() / (10 * 60 * 1000));
      for (let i = 0; i < 20; i++) await reserveCounters([{ id: `triage-budget:${user.id}:${window}`, max: 20 }], 'rate-limits');
      await expect(withTriageBudget(user, async () => undefined)).rejects.toMatchObject({ status: 429 });
    } finally {
      (config as { sharedLimits: boolean }).sharedLimits = before;
    }
  });
});
