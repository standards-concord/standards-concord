import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { OntologyProject } from '@concord/shared';
import { detached, get, HttpError, put, remove, transaction } from '../db.js';

/**
 * Mutual exclusion for changes to an ontology's working draft and its change
 * requests: within this process (a promise queue) and across processes sharing
 * the database (a lease row, taken and renewed in database transactions).
 *
 * - Re-entrant: code already holding an ontology's lock runs straight away.
 * - The holder renews its lease every HEARTBEAT_MS, so only a holder that has
 *   stopped (crashed or hung) for LEASE_MS loses it to someone waiting.
 * - Every lease has a token: a holder only renews or releases its own, and
 *   `assertStillHeld` (called before each irreversible write) renews it and
 *   fails if someone else has taken it over, so a holder that stalled past its
 *   lease cannot then write over its successor's work.
 */
export const lockTiming = { heartbeatMs: 5_000, leaseMs: 60_000, waitMs: 30_000 };

interface Lease {
  id: string;
  token: string;
  pid: number;
  expiresAt: number;
}

const queues = new Map<string, Promise<unknown>>();
const held = new AsyncLocalStorage<Map<string, string>>();
const key = (projectId: string) => `working-draft-lock:${projectId}`;

/** Take the lease if it is free or expired, or renew it if it is ours. */
async function claimLease(k: string, token: string, takeFree: boolean): Promise<boolean> {
  return await transaction(async () => {
    const cur = await get<Lease>('kv', k);
    const ours = cur?.token === token;
    if (!ours && (!takeFree || (cur && cur.expiresAt > Date.now()))) return false;
    await put('kv', { id: k, token, pid: process.pid, expiresAt: Date.now() + lockTiming.leaseMs } satisfies Lease);
    return true;
  });
}

async function releaseLease(k: string, token: string) {
  await transaction(async () => {
    if ((await get<Lease>('kv', k))?.token === token) await remove('kv', k);
  });
}

async function acquire(k: string, token: string) {
  const deadline = Date.now() + lockTiming.waitMs;
  while (!await claimLease(k, token, true)) {
    if (Date.now() > deadline) throw new HttpError(503, 'The working draft is busy with another change. Try again shortly.');
    await sleep(25);
  }
}

export function withWorkingDraftLock<T>(project: Pick<OntologyProject, 'id'>, fn: () => Promise<T>): Promise<T> {
  const mine = held.getStore();
  if (mine?.has(project.id)) return fn();
  const k = key(project.id);
  const locked = async () => {
    const token = randomUUID();
    await acquire(k, token);
    // Detached: a beat is never part of whatever transaction the holder happens to be in when it fires.
    const beat = setInterval(() => {
      void detached(() => claimLease(k, token, false)).catch(() => {
        /* the next beat or assertStillHeld will notice */
      });
    }, lockTiming.heartbeatMs);
    beat.unref();
    try {
      return await held.run(new Map([...(mine ?? []), [project.id, token]]), fn);
    } finally {
      clearInterval(beat);
      await releaseLease(k, token);
    }
  };
  const run = (queues.get(project.id) ?? Promise.resolve()).then(locked, locked);
  queues.set(project.id, run.catch(() => undefined));
  return run;
}

/** True if this code is running inside the ontology's lock. */
export const holdsWorkingDraftLock = (project: Pick<OntologyProject, 'id'>) => !!held.getStore()?.has(project.id);

/**
 * Renews this code's lease on the ontology and throws if it doesn't hold it, or
 * someone else has taken it over. Call just before an irreversible write: the
 * lease is then good for another LEASE_MS.
 */
export async function assertStillHeld(project: Pick<OntologyProject, 'id'>) {
  const token = held.getStore()?.get(project.id);
  if (!token || !await claimLease(key(project.id), token, false)) throw new HttpError(503, 'Lost the lock on the working draft, so nothing was changed. Try again.');
}
