import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { closeDb, get, openDb, put, remove } from '../src/db.js';
import { kickScheduled, LEASE_MS, resetKick, runDue, scheduledIdle, useJobs, type ScheduledJob } from '../src/services/scheduler.js';

/**
 * Scheduled work without per-minute timers (issue #112): due work runs after requests, from a daily cron call, or
 * from a long-running server's timer, one runner at a time across instances.
 *
 * With TEST_DATABASE_URL the lease is taken on a real Postgres pool, so racing runners use separate connections,
 * as two function instances would.
 */

const pgUrl = process.env.TEST_DATABASE_URL;
beforeAll(async () => {
  if (pgUrl) await openDb({ kind: 'postgres', url: pgUrl, max: 4 });
});
afterAll(async () => {
  if (pgUrl) await closeDb();
});

const counting = (name: string, every: number, run: () => Promise<unknown> = async () => undefined) => {
  const job = { name, every, runs: 0, run: async () => (job.runs++, await run()) };
  return job satisfies ScheduledJob;
};
let restore: (() => void) | undefined;
afterEach(async () => {
  await scheduledIdle();
  restore?.();
  restore = undefined;
  resetKick();
  await remove('kv', 'scheduler');
});

describe('scheduled work', () => {
  it('runs a job when it is due, not again until it is next due, and every job when forced', async () => {
    const minute = counting('minute', 60_000);
    const daily = counting('daily', 86_400_000);
    restore = useJobs([minute, daily]);
    let t = 1_900_000_000_000;
    const now = () => t;
    expect(await runDue({ now })).toEqual({ ran: ['minute', 'daily'], failed: [] });
    t += 30_000;
    expect(await runDue({ now })).toEqual({ ran: [], failed: [] });
    t += 30_000;
    expect(await runDue({ now })).toEqual({ ran: ['minute'], failed: [] });
    expect(await runDue({ now, force: true })).toEqual({ ran: ['minute', 'daily'], failed: [] });
    expect([minute.runs, daily.runs]).toEqual([3, 2]);
  });

  // Review r1 of #118: while Concord is read-only, a job could still call Recall.ai, GitHub or a pod before the
  // database refused its write.
  it('runs nothing while Concord is read-only, not even when forced', async () => {
    const job = counting('read-only', 60_000);
    restore = useJobs([job]);
    (config as { readOnly: boolean }).readOnly = true;
    try {
      expect(await runDue({ force: true })).toEqual({ ran: [], failed: [] });
      expect(job.runs).toBe(0);
    } finally {
      (config as { readOnly: boolean }).readOnly = false;
    }
  });

  it('lets one runner at a time run the work, however many instances look at once', async () => {
    let release!: () => void;
    const slow = counting('slow', 60_000, () => new Promise<void>((r) => (release = r)));
    restore = useJobs([slow]);
    const first = runDue();
    await expect.poll(() => slow.runs).toBe(1);
    const others = await Promise.all([runDue(), runDue({ force: true }), runDue()]);
    expect(others.every((r) => r.ran.length === 0)).toBe(true);
    expect(others.some((r) => r.busy)).toBe(true);
    release();
    expect((await first).ran).toEqual(['slow']);
    expect(slow.runs).toBe(1);
  });

  // Review r1 of step 4: the race above only started its rivals once the first run had begun. Here every runner
  // starts at the same moment, before any of them has the lease.
  it('lets exactly one of several runners starting at the same moment run the work', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = counting('slow', 60_000, () => gate);
    restore = useJobs([slow]);
    const all = Promise.all([runDue(), runDue(), runDue(), runDue(), runDue()]);
    await expect.poll(() => slow.runs).toBe(1);
    release();
    const results = await all;
    expect(results.filter((r) => r.ran.length).length).toBe(1);
    expect(slow.runs).toBe(1);
  });

  it('takes over from a runner that died holding the lease, once the lease has run out', async () => {
    const job = counting('job', 60_000);
    restore = useJobs([job]);
    let t = 1_900_000_000_000;
    const now = () => t;
    // A runner on an instance that has gone: its lease is left behind, never renewed.
    await put('kv', { id: 'scheduler', lease: { token: 'gone', until: t + LEASE_MS }, lastRun: {} });
    t += 60_000;
    expect(await runDue({ now })).toMatchObject({ ran: [], busy: true });
    t += LEASE_MS;
    expect(await runDue({ now })).toEqual({ ran: ['job'], failed: [] });
  });

  // Review r1 of step 4: the lease wasn't renewed, so a run that was merely slow lost it after five minutes and a
  // second run started beside it.
  it('keeps the lease of a slow run that is still going, so no other run starts beside it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = counting('slow', 60_000, () => gate);
    restore = useJobs([slow]);
    let t = 1_900_000_000_000;
    const now = () => t;
    const first = runDue({ now, renewEvery: 10 });
    await expect.poll(() => slow.runs).toBe(1);
    t += 2 * LEASE_MS;
    // A renewal after the clock moved on carries the lease past it.
    await expect.poll(async () => (await get<{ lease?: { until: number } }>('kv', 'scheduler'))?.lease?.until ?? 0).toBeGreaterThan(t);
    expect(await runDue({ now })).toMatchObject({ ran: [], busy: true });
    release();
    expect(await first).toEqual({ ran: ['slow'], failed: [] });
    expect(slow.runs).toBe(1);
  });

  // The accepted limit: a runner that stalls past the lease (no renewals) and then resumes finishes beside the run
  // that took over. It says so, and leaves the new run's lease alone.
  it('lets a run that stalled past its lease finish, reporting the lost lease and leaving the new lease alone', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const stalled = counting('stalled', 60_000, () => gate);
    restore = useJobs([stalled]);
    let t = 1_900_000_000_000;
    const now = () => t;
    const first = runDue({ now, renewEvery: 3_600_000 });
    await expect.poll(() => stalled.runs).toBe(1);
    t += LEASE_MS + 1;
    let releaseNext!: () => void;
    const nextGate = new Promise<void>((r) => (releaseNext = r));
    const next = counting('stalled', 60_000, () => nextGate);
    restore = useJobs([next]);
    const second = runDue({ now, renewEvery: 3_600_000 });
    await expect.poll(() => next.runs).toBe(1);
    // It finishes before any renewal noticed: the lost lease is still logged (review r2 of step 4).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    release();
    expect(await first).toEqual({ ran: ['stalled'], failed: [], lostLease: true });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/lease ran out/));
    warn.mockRestore();
    // The second run's lease is still in place.
    expect(await runDue({ now, force: true })).toMatchObject({ ran: [], busy: true });
    releaseNext();
    expect(await second).toEqual({ ran: ['stalled'], failed: [] });
  });

  it('keeps going when a job fails, and tries it again when it is next due', async () => {
    let fail = true;
    const flaky = counting('flaky', 60_000, async () => {
      if (fail) throw new Error('GitHub is down');
    });
    const steady = counting('steady', 60_000);
    restore = useJobs([flaky, steady]);
    let t = 1_900_000_000_000;
    const now = () => t;
    expect(await runDue({ now })).toEqual({ ran: ['flaky', 'steady'], failed: [{ name: 'flaky', error: 'GitHub is down' }] });
    fail = false;
    t += 60_000;
    expect(await runDue({ now })).toEqual({ ran: ['flaky', 'steady'], failed: [] });
  });

  it('looks for due work after a request, at most every half minute per instance', async () => {
    const job = counting('job', 0);
    restore = useJobs([job]);
    kickScheduled(1_000_000);
    kickScheduled(1_010_000);
    await scheduledIdle();
    expect(job.runs).toBe(1);
    kickScheduled(1_031_000);
    await scheduledIdle();
    expect(job.runs).toBe(2);
  });

  it('runs due work after requests when Concord schedules that way (Vercel), and not otherwise', async () => {
    const job = counting('job', 60_000);
    restore = useJobs([job]);
    const { createApp } = await import('../src/app.js');
    // A long-running server has its own timer: requests start nothing.
    expect((await request(createApp()).get('/healthz')).status).toBe(200);
    await scheduledIdle();
    expect(job.runs).toBe(0);
    (config as { schedule: string }).schedule = 'requests';
    try {
      expect((await request(createApp()).get('/healthz')).status).toBe(200);
      await scheduledIdle();
      expect(job.runs).toBe(1);
    } finally {
      (config as { schedule: string }).schedule = 'timer';
    }
  });

  it('runs every job from the daily cron call, only with the cron secret', async () => {
    const minute = counting('minute', 60_000);
    const daily = counting('daily', 86_400_000);
    restore = useJobs([minute, daily]);
    const { createApp } = await import('../src/app.js');
    const app = createApp();
    // No secret configured: nobody may call it.
    expect((await request(app).get('/api/cron/daily')).status).toBe(401);
    (config as { cronSecret?: string }).cronSecret = 'cron-secret-for-tests';
    try {
      expect((await request(app).get('/api/cron/daily')).status).toBe(401);
      expect((await request(app).get('/api/cron/daily').set('Authorization', 'Bearer wrong-secret-for-tests')).status).toBe(401);
      expect([minute.runs, daily.runs]).toEqual([0, 0]);
      await runDue(); // both just ran
      const res = await request(app).get('/api/cron/daily').set('Authorization', 'Bearer cron-secret-for-tests');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ran: ['minute', 'daily'], failed: [] });
      expect([minute.runs, daily.runs]).toEqual([2, 2]);
    } finally {
      (config as { cronSecret?: string }).cronSecret = undefined;
    }
  });
});
