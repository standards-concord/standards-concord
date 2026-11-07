import { randomUUID } from 'node:crypto';
import { get, put, remove, transaction } from './db.js';

export interface LeaseOptions {
  /** false: undefined at once, without running `fn`, if another instance holds it. */
  wait?: boolean;
  /**
   * Keep the lease while `fn` runs (it is extended every third of `ttlMs`), for work that may outlast `ttlMs`.
   * Then only an instance that stops running (frozen or killed) lets it lapse early.
   */
  renew?: boolean;
}

/**
 * A short lease in the database (`kv lease:<id>`), for work only one instance at a time may do and that is never
 * part of a transaction (it calls out over the network). Waits up to `ttlMs` for another holder, then throws. A
 * holder that dies leaves a lease that lapses after `ttlMs`. Not a fence: work under it must still be safe if it
 * overruns the lease (here, refreshing a token one extra time).
 */
export async function withLease<T>(id: string, ttlMs: number, fn: () => Promise<T>, opts?: LeaseOptions & { wait?: true }): Promise<T>;
export async function withLease<T>(id: string, ttlMs: number, fn: () => Promise<T>, opts: LeaseOptions & { wait: false }): Promise<T | undefined>;
export async function withLease<T>(id: string, ttlMs: number, fn: () => Promise<T>, opts: LeaseOptions = {}): Promise<T | undefined> {
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
  const renewal = opts.renew
    ? setInterval(() => {
        void transaction(async () => {
          if ((await get<{ token: string }>('kv', key))?.token === token) await put('kv', { id: key, token, until: Date.now() + ttlMs });
        }).catch(() => undefined);
      }, Math.max(1000, Math.floor(ttlMs / 3)))
    : undefined;
  renewal?.unref?.();
  try {
    return await fn();
  } finally {
    if (renewal) clearInterval(renewal);
    await transaction(async () => {
      if ((await get<{ token: string }>('kv', key))?.token === token) await remove('kv', key);
    }).catch(() => undefined);
  }
}
