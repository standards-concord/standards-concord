import type { DataCheckOutcome } from '@concord/core/data-check';
import type { DataFormat } from '@concord/core/data-formats';
import { onAccountChange } from './session';

export interface DataCheckJob {
  /** Names the ontology version (and its exact text), so the worker can reuse what it parsed. */
  key: string;
  ontology: string;
  shapes: string;
  text: string;
  format: DataFormat;
  baseIRI: string;
  maxTriples: number;
  turtle?: boolean;
}

/** A failed check: `status` is 400 for data that doesn't parse, 413 for data over the limits. */
export class DataCheckError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'DataCheckError';
  }
}

let worker: Worker | undefined;
let nextId = 0;
/** An outcome, with how long the check itself took in the worker (parsing and checking, not the ontology download). */
export type TimedOutcome = DataCheckOutcome & { ms: number };
type Pending = { job: DataCheckJob & { id: number }; timeoutMs: number; timer?: ReturnType<typeof setTimeout>; resolve: (o: TimedOutcome) => void; reject: (e: Error) => void };
const pending = new Map<number, Pending>();

/** Stops the worker (and what it has parsed) and fails every check still waiting. */
function stop(reason: Error) {
  worker?.terminate();
  worker = undefined;
  for (const p of pending.values()) p.reject(reason);
  pending.clear();
}

/**
 * Ends one check. A worker can't be interrupted part way through a job, so if it is still busy the
 * worker is replaced and the other checks waiting on it are sent to the new one; they never fail
 * because of another check's time limit or cancellation.
 */
function cancel(id: number, reason: Error) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  p.reject(reason);
  worker?.terminate();
  worker = undefined;
  if (!pending.size) return;
  worker = start();
  for (const other of pending.values()) post(other);
}

/** Sends a check to the worker, with its full time limit from now (so one moved to a new worker gets its time again). */
function post(p: Pending) {
  clearTimeout(p.timer);
  p.timer = setTimeout(() => cancel(p.job.id, new DataCheckError(`Checking took longer than ${Math.round(p.timeoutMs / 1000)} s and was stopped. Try smaller data.`, 422)), p.timeoutMs);
  worker!.postMessage(p.job);
}

/** Forgets every parsed ontology and fails the checks under way: on any change of account, so nothing one account could read stays in memory for the next. */
export function resetDataCheck() {
  stop(new DOMException('Cancelled', 'AbortError') as unknown as Error);
}
onAccountChange(resetDataCheck);

function start(): Worker {
  const w = new Worker(new URL('./dataCheckWorker.ts', import.meta.url), { type: 'module', name: 'sparq-data-check' });
  w.onmessage = (ev: MessageEvent<{ id: number; outcome?: DataCheckOutcome; ms?: number; error?: string; status?: number }>) => {
    const p = pending.get(ev.data.id);
    if (!p) return;
    pending.delete(ev.data.id);
    if (ev.data.outcome) p.resolve({ ...ev.data.outcome, ms: ev.data.ms ?? 0 });
    else p.reject(new DataCheckError(ev.data.error ?? 'The check failed.', ev.data.status));
  };
  w.onerror = (ev) => stop(new DataCheckError(ev.message || 'The checker could not start in this browser.'));
  return w;
}

/**
 * Checks data on this device, in a Web Worker kept between checks (so a version's ontology is
 * parsed once). Aborting, or running past `timeoutMs`, ends this check alone (see cancel).
 */
export function checkDataInBrowser(job: DataCheckJob, { signal, timeoutMs = 60_000 }: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<TimedOutcome> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
    worker ??= start();
    const id = ++nextId;
    const onAbort = () => cancel(id, new DOMException('Cancelled', 'AbortError') as unknown as Error);
    signal?.addEventListener('abort', onAbort, { once: true });
    const entry: Pending = {
      job: { ...job, id },
      timeoutMs,
      resolve: (o) => (settle(), resolve(o)),
      reject: (e) => (settle(), reject(e)),
    };
    const settle = () => {
      clearTimeout(entry.timer);
      signal?.removeEventListener('abort', onAbort);
    };
    pending.set(id, entry);
    post(entry);
  });
}

/**
 * Parses a version's ontology and shapes in the worker and runs one tiny check, so the first real
 * check doesn't pay for starting WebAssembly and parsing the ontology (about 100 ms, against a few ms after).
 */
export function warmDataCheck(job: Omit<DataCheckJob, 'text' | 'format'>): void {
  checkDataInBrowser({ ...job, text: '<urn:x-concord:warm-up> <urn:x-concord:warm-up> "" .', format: 'ntriples' }).catch(() => {
    /* a real check reports any problem */
  });
}
