import { Worker } from 'node:worker_threads';
import { DataError } from '@concord/core';
import type { ValidationJob, ValidationOutcome, WorkerReply } from './validationWorker.js';

/**
 * A few worker threads that run validations (validationWorker.ts). Each job
 * has a deadline and each worker a heap limit: a worker that runs over is
 * stopped and replaced, and the caller gets a 422 or 413, so one input can't
 * hold up or exhaust the server. Jobs beyond the workers wait in a short
 * queue; past that the caller gets a 503.
 */

export const POOL_LIMITS = {
  workers: Number(process.env.VALIDATE_WORKERS ?? 2),
  timeoutMs: Number(process.env.VALIDATE_TIMEOUT_MS ?? 10_000),
  heapMb: Number(process.env.VALIDATE_HEAP_MB ?? 192),
  queue: Number(process.env.VALIDATE_QUEUE ?? 16),
};

type Pending = { job: ValidationJob; resolve: (o: ValidationOutcome) => void; reject: (e: unknown) => void };
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
    queue.push({ job: { ...job, id: nextId++ }, resolve, reject });
    pump();
  });
}
