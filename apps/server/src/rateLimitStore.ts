import { createHash } from 'node:crypto';
import type { Options, Store } from 'express-rate-limit';
import { get, put, remove, removeWhereAtMost, transaction } from './db.js';

/**
 * An express-rate-limit store in the database, so every server (or Vercel function instance) counts against the
 * same window: with the default memory store each instance had an allowance of its own. Fixed windows, one row per
 * client and window (`kv rate:<name>:<window>:<client hash>`), swept once they are over.
 */
export class DbRateStore implements Store {
  localKeys = false;
  prefix: string;
  private windowMs = 60_000;
  private lastSweep = 0;
  constructor(readonly name: string) {
    this.prefix = `rate:${name}:`;
  }
  init(options: Options) {
    this.windowMs = options.windowMs;
  }
  private row(key: string, now = Date.now()) {
    const window = Math.floor(now / this.windowMs);
    return { id: `${this.prefix}${window}:${createHash('sha256').update(key).digest('base64url')}`, resetTime: new Date((window + 1) * this.windowMs) };
  }
  async increment(key: string) {
    const now = Date.now();
    if (now - this.lastSweep > 60_000) {
      this.lastSweep = now;
      await removeWhereAtMost('kv', 'rateUntil', now);
    }
    const { id, resetTime } = this.row(key, now);
    const totalHits = await transaction(async () => {
      const n = ((await get<{ count?: number }>('kv', id))?.count ?? 0) + 1;
      await put('kv', { id, count: n, rateUntil: resetTime.getTime() }, 'rate-limits');
      return n;
    });
    return { totalHits, resetTime };
  }
  async decrement(key: string) {
    const { id } = this.row(key);
    await transaction(async () => {
      const doc = await get<{ id: string; count?: number; rateUntil: number }>('kv', id);
      if (doc) await put('kv', { ...doc, count: Math.max(0, (doc.count ?? 0) - 1) }, 'rate-limits');
    });
  }
  async resetKey(key: string) {
    await remove('kv', this.row(key).id);
  }
  async get(key: string) {
    const { id, resetTime } = this.row(key);
    const doc = await get<{ count?: number }>('kv', id);
    return doc ? { totalHits: doc.count ?? 0, resetTime } : undefined;
  }
}
