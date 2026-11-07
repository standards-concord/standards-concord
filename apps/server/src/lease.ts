import { randomUUID } from 'node:crypto';
import { get, put, remove, transaction } from './db.js';

/**
 * A short lease in the database (`kv lease:<id>`), for work only one instance at a time may do and that is never
 * part of a transaction (it calls out over the network). Waits up to `ttlMs` for another holder, then throws. A
 * holder that dies leaves a lease that lapses after `ttlMs`. Not a fence: work under it must still be safe if it
 * overruns the lease (here, refreshing a token one extra time).
 */
export async function withLease<T>(id: string, ttlMs: number, fn: () => Promise<T>): Promise<T>;
/** With `wait: false`: undefined at once, without running `fn`, if another instance holds it. */
export async function withLease<T>(id: string, ttlMs: number, fn: () => Promise<T>, opts: { wait: false }): Promise<T | undefined>;
export async function withLease<T>(id: string, ttlMs: number, fn: () => Promise<T>, opts: { wait?: boolean } = {}): Promise<T | undefined> {
  const key = `lease:${id}`;
  const token = randomUUID();
  const deadline = Date.now() + ttlMs;
  for (let wait = 25; ; wait = Math.min(wait * 2, 500)) {
    const took = await transaction(async () => {
      const held = await get<{ until: number }>('kv', key);
      if (held && held.until > Date.now()) return false;
      await put('kv', { id: key, token, until: Date.now() + ttlMs });
      return true;
    });
    if (took) break;
    if (opts.wait === false) return undefined;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${id}`);
    await new Promise((r) => setTimeout(r, wait));
  }
  try {
    return await fn();
  } finally {
    await transaction(async () => {
      if ((await get<{ token: string }>('kv', key))?.token === token) await remove('kv', key);
    }).catch(() => undefined);
  }
}
