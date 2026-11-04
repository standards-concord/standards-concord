import { Worker } from 'node:worker_threads';
import { DataError } from '@concord/core';
import type { ValidationJob, ValidationOutcome, WorkerReply } from './validationWorker.js';

/**
 * A few worker threads that run validations (validationWorker.ts). Each job
 * has a deadline and each worker a heap limit: a worker that runs over is
 * stopped and replaced, and the caller gets a 422 or 413, so one input can't
 * hold up or exhaust the server. Jobs beyond the workers wait in a short
 * queue, for a limited time; past that the caller gets a 503.
 *
 * Callers reserve a place with admit() before they read a request body, so
 * the number of bodies held in memory is bounded too (workers + queue), and
 * one client can hold at most perClient of those places.
 */

export const POOL_LIMITS = {
  workers: Number(process.env.VALIDATE_WORKERS ?? 2),
  timeoutMs: Number(process.env.VALIDATE_TIMEOUT_MS ?? 10_000),
  heapMb: Number(process.env.VALIDATE_HEAP_MB ?? 192),
  /** Jobs waiting for a worker. Places in all: workers + queue. */
  queue: Number(process.env.VALIDATE_QUEUE ?? 4),
  /** How long a job may wait for a worker before the caller gets a 503. */
  queueWaitMs: Number(process.env.VALIDATE_QUEUE_WAIT_MS ?? 15_000),
  /** Places one client may hold at once (reading, waiting or running). */
  perClient: Number(process.env.VALIDATE_PER_CLIENT ?? 2),
};

export type Admission = { ok: true; release: () => void } | { ok: false; status: 429 | 503; message: string };

const held = new Map<string, number>();
let admitted = 0;

/**
 * Reserves a place for one validation, before its data is read. Release it
 * when the request ends, however it ends (release is safe to call twice).
 */
export function admit(client: string): Admission {
  const mine = held.get(client) ?? 0;
  if (mine >= POOL_LIMITS.perClient) {
    return { ok: false, status: 429, message: `You already have ${mine} validation${mine === 1 ? '' : 's'} in progress. Wait for ${mine === 1 ? 'it' : 'them'} to finish.` };
  }
  if (admitted >= POOL_LIMITS.workers + POOL_LIMITS.queue) return { ok: false, status: 503, message: 'The validator is busy. Try again in a moment.' };
  held.set(client, mine + 1);
  admitted++;
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      admitted--;
      const left = (held.get(client) ?? 1) - 1;
      if (left > 0) held.set(client, left);
      else held.delete(client);
    },
  };
}

type Pending = { job: ValidationJob; resolve: (o: ValidationOutcome) => void; reject: (e: unknown) => void; wait?: NodeJS.Timeout };
interface Slot {
  worker: Worker;
  current?: Pending & { timer: NodeJS.Timeout };
}

const WORKER_URL = new URL('./validationWorker.ts', import.meta.url);
// The worker is TypeScript: load it through tsx unless this process already does (node --import tsx, or the tsx CLI).
const execArgv = process.execArgv.some((a) => a === 'tsx' || /[\\/]tsx[\\/]dist[\\/]/.test(a)) ? process.execArgv : [...process.execArgv, '--import', 'tsx'];

const slots: Slot[] = [];
const queue: Pending[] = [];
let nextId = 1;

function spawn(): Slot {
  const worker = new Worker(WORKER_URL, { execArgv, resourceLimits: { maxOldGenerationSizeMb: POOL_LIMITS.heapMb, maxYoungGenerationSizeMb: 32 } });
  worker.unref();
  const slot: Slot = { worker };
  worker.on('message', (reply: WorkerReply) => {
    const cur = slot.current;
    if (!cur || cur.job.id !== reply.id) return;
    clearTimeout(cur.timer);
    slot.current = undefined;
    if (reply.ok) cur.resolve(reply.outcome);
    else cur.reject(reply.status ? new DataError(reply.status as 400, reply.message) : new Error(reply.message));
    pump();
  });
  worker.on('error', (err: Error & { code?: string }) => {
    const oom = err.code === 'ERR_WORKER_OUT_OF_MEMORY';
    retire(slot, oom ? new DataError(413, 'Checking the data needed more memory than the validator allows. Try smaller data.') : err);
  });
  worker.on('exit', () => retire(slot, new Error('The validator stopped unexpectedly')));
  slots.push(slot);
  return slot;
}

/** Removes a worker, failing its job, and starts a fresh one for the queue. */
function retire(slot: Slot, err: unknown) {
  const i = slots.indexOf(slot);
  if (i < 0) return;
  slots.splice(i, 1);
  const cur = slot.current;
  slot.current = undefined;
  if (cur) {
    clearTimeout(cur.timer);
    cur.reject(err);
  }
  void slot.worker.terminate();
  pump();
}

function pump() {
  while (queue.length) {
    let slot = slots.find((s) => !s.current);
    if (!slot && slots.length < POOL_LIMITS.workers) slot = spawn();
    if (!slot) return;
    const next = queue.shift()!;
    clearTimeout(next.wait);
    const timer = setTimeout(() => {
      retire(slot!, new DataError(422, `Checking the data took longer than ${POOL_LIMITS.timeoutMs / 1000} s, so it was stopped. Try smaller or simpler data.`));
    }, POOL_LIMITS.timeoutMs);
    slot.current = { ...next, timer };
    slot.worker.postMessage(next.job);
  }
}

export function runValidation(job: Omit<ValidationJob, 'id'>): Promise<ValidationOutcome> {
  if (queue.length >= POOL_LIMITS.queue) return Promise.reject(new DataError(503, 'The validator is busy. Try again in a moment.'));
  return new Promise((resolve, reject) => {
    const pending: Pending = { job: { ...job, id: nextId++ }, resolve, reject };
    // Waiting counts towards the caller's time too: a job that can't start soon is turned away.
    pending.wait = setTimeout(() => {
      const i = queue.indexOf(pending);
      if (i < 0) return;
      queue.splice(i, 1);
      reject(new DataError(503, 'The validator is busy. Try again in a moment.'));
    }, POOL_LIMITS.queueWaitMs);
    pending.wait.unref();
    queue.push(pending);
    pump();
  });
}
