import type { DataCheckOutcome } from '@concord/core/data-check';
import type { DataFormat } from '@concord/core/data-formats';

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
const pending = new Map<number, { resolve: (o: TimedOutcome) => void; reject: (e: Error) => void }>();

function stop(reason: Error) {
  worker?.terminate();
  worker = undefined;
  for (const p of pending.values()) p.reject(reason);
  pending.clear();
}

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
 * parsed once). Aborting, or running past `timeoutMs`, stops the worker; the next check starts a new one.
 */
export function checkDataInBrowser(job: DataCheckJob, { signal, timeoutMs = 60_000 }: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<TimedOutcome> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
    worker ??= start();
    const id = ++nextId;
    const timer = setTimeout(() => stop(new DataCheckError(`Checking took longer than ${Math.round(timeoutMs / 1000)} s and was stopped. Try smaller data.`, 422)), timeoutMs);
    const onAbort = () => stop(new DOMException('Cancelled', 'AbortError') as unknown as Error);
    signal?.addEventListener('abort', onAbort, { once: true });
    const settle = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    pending.set(id, {
      resolve: (o) => (settle(), resolve(o)),
      reject: (e) => (settle(), reject(e)),
    });
    worker.postMessage({ ...job, id });
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
