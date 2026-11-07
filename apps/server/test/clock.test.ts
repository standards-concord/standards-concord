import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { clock, DAY_MS, saveClock, syncClock } from '../src/clock.js';
import { put, remove } from '../src/db.js';

/**
 * The demo's governance clock, shared by every instance (step 5): the offset was in one process's memory, so on
 * Vercel advancing time moved it for one function instance only, and the next request could land on another.
 */
afterEach(async () => {
  clock.reset();
  await remove('kv', 'governance-clock');
});

describe('the governance clock across instances', () => {
  it('answers each request on the clock as another instance last moved it', async () => {
    const { createApp } = await import('../src/app.js');
    await put('kv', { id: 'governance-clock', offsetMs: 3 * DAY_MS }); // moved elsewhere
    const res = await request(createApp()).get('/api/session');
    expect(res.body.clockOffsetMs).toBe(3 * DAY_MS);
    expect(new Date(res.body.now).getTime()).toBeGreaterThan(Date.now() + 3 * DAY_MS - 60_000);
  });

  it('saves the clock when it is moved, for the other instances', async () => {
    clock.advance(2 * DAY_MS);
    await saveClock();
    clock.reset(); // another instance, started fresh
    await syncClock();
    expect(clock.offsetMs).toBe(2 * DAY_MS);
  });

  it('seeds on a clock of its own, which nothing else sees', async () => {
    const outside: number[] = [];
    const inside = await clock.withShift(-21 * DAY_MS, async () => {
      const start = clock.now().getTime();
      clock.advance(2 * DAY_MS);
      // A request meanwhile, outside the seed, keeps the shared clock.
      await new Promise<void>((resolve) => setImmediate(() => resolve(void outside.push(clock.offsetMs))));
      return clock.now().getTime() - start;
    });
    expect(Math.round(inside / DAY_MS)).toBe(2);
    expect(clock.offsetMs).toBe(0);
    expect(outside).toEqual([0]);
  });
});
