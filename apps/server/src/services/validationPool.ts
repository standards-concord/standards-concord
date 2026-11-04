import { fork, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DataError, type DataFormat } from '@concord/core';
import type { ValidationJob, ValidationOutcome, WorkerReply } from './validationWorker.js';

/**
 * A few worker processes that run validations (validationWorker.ts). Each job
 * has a deadline and each worker a heap limit: a worker that runs over is
 * stopped and replaced, and the caller gets a 422 or 413, so one input can't
 * hold up or exhaust the server. Workers are processes, not threads: V8 can
 * abort the whole process when a thread's heap runs out at the wrong moment
 * (a large string already live, then an allocation that can't be refused),
 * so only a separate process makes the heap limit safe for the server. Jobs beyond the workers wait in a short
 * queue, for a limited time; past that the caller gets a 503.
 *
 * Callers reserve a place with admit() before they read a request body, so
 * the number of bodies held in memory is bounded too (workers + queue), and
 * one client can hold at most perClient of those places. A place is given
 * back only once its job has stopped: a caller that goes away cancels it.
 *
 * JSON-LD has places and a queue of its own, and only one JSON-LD job runs at
 * a time, so JSON-LD can never hold every worker or every place: with two or
 * more workers, a free worker always takes the next job in another format.
 */

export const POOL_LIMITS = {
  workers: Number(process.env.VALIDATE_WORKERS ?? 2),
  timeoutMs: Number(process.env.VALIDATE_TIMEOUT_MS ?? 10_000),
  heapMb: Number(process.env.VALIDATE_HEAP_MB ?? 192),
  /**
   * The most memory a worker process may use in all (resident set, which counts the SHACL
   * engine's WebAssembly memory and other memory outside the heap). A worker past it is
   * stopped (413); an idle one past `recycleMb` is replaced, to give back what it grew to.
   * At most `workers` processes run, so validation uses at most workers × rssMb.
   */
  rssMb: Number(process.env.VALIDATE_RSS_MB ?? 320),
  recycleMb: Number(process.env.VALIDATE_RECYCLE_MB ?? 224),
  /** Jobs waiting for a worker. Places in all: workers + queue. */
  queue: Number(process.env.VALIDATE_QUEUE ?? 4),
  /** How long a job may wait for a worker before the caller gets a 503. */
  queueWaitMs: Number(process.env.VALIDATE_QUEUE_WAIT_MS ?? 15_000),
  /** Places one client may hold at once (reading, waiting or running). */
  perClient: Number(process.env.VALIDATE_PER_CLIENT ?? 2),
  /** JSON-LD jobs waiting for their turn. JSON-LD places: one running + this many, kept apart from the others. */
  jsonldQueue: Number(process.env.VALIDATE_JSONLD_QUEUE ?? 2),
};

/** JSON-LD jobs that may run at once: converting JSON-LD needs the most memory, so one at a time. */
const JSONLD_AT_ONCE = 1;

/** Each format's share: JSON-LD, or everything else. */
type Lane = 'jsonld' | 'other';
const laneOf = (format: DataFormat | 'sniff' | undefined): Lane => (format === 'jsonld' ? 'jsonld' : 'other');
const places = (lane: Lane) => (lane === 'jsonld' ? JSONLD_AT_ONCE + POOL_LIMITS.jsonldQueue : POOL_LIMITS.workers + POOL_LIMITS.queue);
const queueLimit = (lane: Lane) => (lane === 'jsonld' ? POOL_LIMITS.jsonldQueue : POOL_LIMITS.queue);

const BUSY = 'The validator is busy. Try again in a moment.';
const BUSY_JSONLD = 'The validator is busy with other JSON-LD. Try again in a moment, or send the data as Turtle or N-Triples.';

export type Admission = { ok: true; release: () => void } | { ok: false; status: 429 | 503; message: string };

const held = new Map<string, number>();
const admitted: Record<Lane, number> = { jsonld: 0, other: 0 };

/**
 * Reserves a place for one validation, before its data is read, in the share
 * for its format (JSON-LD or the rest; data whose format isn't known until
 * it is read counts as the rest). Release it when the request ends, however
 * it ends (release is safe to call twice).
 */
export function admit(client: string, format?: DataFormat | 'sniff'): Admission {
  const lane = laneOf(format);
  const mine = held.get(client) ?? 0;
  if (mine >= POOL_LIMITS.perClient) {
    return { ok: false, status: 429, message: `You already have ${mine} validation${mine === 1 ? '' : 's'} in progress. Wait for ${mine === 1 ? 'it' : 'them'} to finish.` };
  }
  if (admitted[lane] >= places(lane)) return { ok: false, status: 503, message: lane === 'jsonld' ? BUSY_JSONLD : BUSY };
  held.set(client, mine + 1);
  admitted[lane]++;
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      admitted[lane]--;
      const left = (held.get(client) ?? 1) - 1;
      if (left > 0) held.set(client, left);
      else held.delete(client);
    },
  };
}

type Pending = { job: Omit<ValidationJob, 'deadlineMs'>; resolve: (o: ValidationOutcome) => void; reject: (e: unknown) => void; wait?: NodeJS.Timeout };
interface Slot {
  worker: ChildProcess;
  current?: Pending & { timer: NodeJS.Timeout };
}

// A plain-JavaScript entry that registers tsx itself, then loads validationWorker.ts.
const WORKER_PATH = fileURLToPath(new URL('./validationWorker.boot.mjs', import.meta.url));

const slots: Slot[] = [];
const queue: Pending[] = [];
let nextId = 1;

function spawn(): Slot {
  const worker = fork(WORKER_PATH, [], {
    // Only these flags, not the server's own: the boot file loads TypeScript itself.
    execArgv: [`--max-old-space-size=${POOL_LIMITS.heapMb}`, '--max-semi-space-size=16'],
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  // An idle worker never keeps the server (or a test run) from exiting.
  worker.unref();
  worker.channel?.unref();
  const slot: Slot = { worker };
  worker.on('message', (reply: WorkerReply) => {
    const cur = slot.current;
    if (!cur || cur.job.id !== reply.id) return;
    clearTimeout(cur.timer);
    slot.current = undefined;
    worker.channel?.unref();
    if (reply.ok) cur.resolve(reply.outcome);
    else cur.reject(reply.status ? new DataError(reply.status as 400, reply.message) : new Error(reply.message));
    // A worker that grew large on that job is replaced rather than kept.
    if ((residentMb(worker) ?? 0) > POOL_LIMITS.recycleMb) retire(slot, undefined);
    pump();
  });
  worker.on('error', (err) => retire(slot, err));
  // A heap that runs out aborts the worker (SIGABRT): that is the data asking for too much memory.
  worker.on('exit', (_code, signal) =>
    retire(slot, signal === 'SIGABRT' ? new DataError(413, OUT_OF_MEMORY) : new Error('The validator stopped unexpectedly')),
  );
  slots.push(slot);
  return slot;
}

const OUT_OF_MEMORY = 'Checking the data needed more memory than the validator allows. Try smaller data.';

/** A process's resident memory in MB (Linux), or undefined where that can't be read. */
function residentMb(worker: ChildProcess): number | undefined {
  if (!worker.pid) return undefined;
  try {
    return (Number(readFileSync(`/proc/${worker.pid}/statm`, 'utf8').split(' ')[1]) * 4096) / 1024 / 1024;
  } catch {
    return undefined;
  }
}

let memoryWatch: NodeJS.Timeout | undefined;

/** While jobs run, checks the workers' memory often, and stops one that uses too much. */
function watchMemory() {
  if (memoryWatch) return;
  const check = () => {
    const busy = slots.filter((s) => s.current);
    if (!busy.length) {
      clearInterval(memoryWatch);
      memoryWatch = undefined;
      return;
    }
    for (const slot of busy) if ((residentMb(slot.worker) ?? 0) > POOL_LIMITS.rssMb) retire(slot, new DataError(413, OUT_OF_MEMORY));
  };
  memoryWatch = setInterval(check, 20);
  memoryWatch.unref();
  check();
}

// Workers don't outlive the server: on exit they are killed (and each also watches for the server going away).
process.on('exit', () => {
  for (const slot of slots) slot.worker.kill('SIGKILL');
});

/** Workers being stopped. They still count against the limit until they have exited, as JSON-LD ones do against JSONLD_AT_ONCE. */
let stopping = 0;
let stoppingJsonld = 0;

/**
 * Stops a worker, then fails its job and lets the queue go on. Its job's
 * caller (and so its place) is only let go once the process has exited, so
 * a stopped worker and its replacement never run side by side.
 */
function retire(slot: Slot, err: unknown) {
  const i = slots.indexOf(slot);
  if (i < 0) return;
  slots.splice(i, 1);
  const cur = slot.current;
  slot.current = undefined;
  if (cur) clearTimeout(cur.timer);
  const jsonld = cur?.job.format === 'jsonld';
  stopping++;
  if (jsonld) stoppingJsonld++;
  const done = () => {
    stopping--;
    if (jsonld) stoppingJsonld--;
    if (cur) cur.reject(err);
    pump();
  };
  const { worker } = slot;
  if (worker.pid === undefined || worker.exitCode !== null || worker.signalCode !== null) return done();
  worker.once('exit', done);
  worker.kill('SIGKILL');
}

function pump() {
  while (queue.length) {
    // The first waiting job that may start: any job, unless it is JSON-LD and JSON-LD is already running.
    const jsonldRunning = slots.filter((s) => s.current?.job.format === 'jsonld').length + stoppingJsonld;
    const i = queue.findIndex((p) => p.job.format !== 'jsonld' || jsonldRunning < JSONLD_AT_ONCE);
    if (i < 0) return;
    let slot = slots.find((s) => !s.current);
    if (!slot && slots.length + stopping < POOL_LIMITS.workers) slot = spawn();
    if (!slot) return;
    const next = queue.splice(i, 1)[0];
    clearTimeout(next.wait);
    const timer = setTimeout(() => {
      const seconds = POOL_LIMITS.timeoutMs / 1000;
      retire(
        slot!,
        // JSON-LD is converted whole before its triples can be counted, so running out of time is its size limit.
        next.job.format === 'jsonld'
          ? new DataError(413, `The JSON-LD took longer than ${seconds} s to convert to triples, so it is too large or complex to check. Send less, or send it as Turtle or N-Triples.`)
          : new DataError(422, `Checking the data took longer than ${seconds} s, so it was stopped. Try smaller or simpler data.`),
      );
    }, POOL_LIMITS.timeoutMs);
    slot.current = { ...next, timer };
    // While it has a job, the worker's channel keeps the server waiting for the answer.
    slot.worker.channel?.ref();
    // The worker also stops itself a little after the deadline, in case this process is gone by then.
    slot.worker.send({ ...next.job, deadlineMs: POOL_LIMITS.timeoutMs + 5000 } satisfies ValidationJob);
    watchMemory();
  }
}

/**
 * Runs a validation in a worker. Aborting `signal` (the caller went away)
 * takes a waiting job out of the queue, or stops the worker running it, so
 * cancelled work never holds a place.
 */
export function runValidation(job: Omit<ValidationJob, 'id' | 'deadlineMs'>, signal?: AbortSignal): Promise<ValidationOutcome> {
  if (signal?.aborted) return Promise.reject(new Error('The validation was cancelled'));
  const lane = laneOf(job.format);
  const busy = () => new DataError(503, lane === 'jsonld' ? BUSY_JSONLD : BUSY);
  return new Promise<ValidationOutcome>((resolve, reject) => {
    const pending: Pending = { job: { ...job, id: nextId++ }, resolve, reject };
    queue.push(pending);
    pump();
    // It didn't start at once and its format's queue is full: turn it away (a free worker always takes it first).
    if (queue.includes(pending) && queue.filter((p) => laneOf(p.job.format) === lane).length > queueLimit(lane)) {
      queue.splice(queue.indexOf(pending), 1);
      return reject(busy());
    }
    if (!queue.includes(pending)) {
      signal?.addEventListener('abort', () => cancel(pending), { once: true });
      return;
    }
    // Waiting counts towards the caller's time too: a job that can't start soon is turned away.
    pending.wait = setTimeout(() => {
      const i = queue.indexOf(pending);
      if (i < 0) return;
      queue.splice(i, 1);
      reject(busy());
    }, POOL_LIMITS.queueWaitMs);
    pending.wait.unref();
    signal?.addEventListener('abort', () => cancel(pending), { once: true });
  });
}

/** Takes a job out of the queue, or stops the worker running it. */
function cancel(pending: Pending) {
  const cancelled = new Error('The validation was cancelled');
  const i = queue.indexOf(pending);
  if (i >= 0) {
    queue.splice(i, 1);
    clearTimeout(pending.wait);
    return pending.reject(cancelled);
  }
  const slot = slots.find((s) => s.current?.job.id === pending.job.id);
  if (slot) retire(slot, cancelled);
}

/** Places taken and jobs waiting or running, for tests and health checks. */
export const poolState = () => ({ admitted: admitted.jsonld + admitted.other, admittedJsonld: admitted.jsonld, queued: queue.length, running: slots.filter((s) => s.current).length, stopping, threads: slots.length + stopping, jsonld: slots.filter((s) => s.current?.job.format === 'jsonld').length + stoppingJsonld });
