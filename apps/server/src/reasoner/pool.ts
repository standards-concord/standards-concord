/**
 * The server's OWL reasoner: sparq in one long-lived worker thread, so neither the reasoning
 * nor the hierarchy reduction blocks the event loop. Jobs run one at a time. A job that runs
 * past REASONER_TIMEOUT_MS is stopped (the worker is replaced) and reported as no verdict, so
 * validation fails closed instead of hanging.
 */
import { Worker } from 'node:worker_threads';
import { structuralReasoner, type OntologyGraph } from '@concord/core';
import type { ReasonerResult } from '@concord/core/types';

const TIMEOUT_MS = Number(process.env.REASONER_TIMEOUT_MS ?? 60_000);

type Pending = { resolve: (r: ReasonerResult) => void; graph: OntologyGraph; started: number };
let worker: Worker | undefined;
const pending = new Map<number, Pending>();
let nextId = 1;
let tail: Promise<unknown> = Promise.resolve();

const noVerdict = (graph: OntologyGraph, started: number, error: string): ReasonerResult => ({
  ...structuralReasoner(graph), available: false, checked: 'none', error, durationMs: Math.round(performance.now() - started),
});

function failAll(error: string) {
  for (const [id, p] of pending) { pending.delete(id); p.resolve(noVerdict(p.graph, p.started, error)); }
}

function spawn(): Worker {
  const w = new Worker(new URL('./worker.boot.mjs', import.meta.url));
  w.on('message', ({ id, result, error }: { id: number; result?: ReasonerResult; error?: string }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    p.resolve(result ?? noVerdict(p.graph, p.started, `the OWL reasoner failed: ${error}`));
  });
  w.on('error', (e: Error) => { if (worker === w) worker = undefined; failAll(`the OWL reasoner crashed: ${e.message}`); });
  w.on('exit', (code) => { if (worker === w) worker = undefined; failAll(`the OWL reasoner stopped (exit ${code})`); });
  // Held only while a job is waiting (see run), so an idle reasoner never keeps the server or
  // a test process alive. Unref after the listeners: adding a 'message' listener refs again.
  w.unref();
  return w;
}

async function run(graph: OntologyGraph): Promise<ReasonerResult> {
  const started = performance.now();
  const turtle = await graph.toTurtle();
  const w = (worker ??= spawn());
  const id = nextId++;
  return new Promise<ReasonerResult>((resolve) => {
    const timer = setTimeout(() => {
      if (!pending.delete(id)) return;
      w.unref();
      if (worker === w) worker = undefined;
      void w.terminate();
      resolve(noVerdict(graph, started, `the OWL reasoner took longer than ${Math.round(TIMEOUT_MS / 1000)} s and was stopped`));
    }, TIMEOUT_MS);
    timer.unref();
    pending.set(id, { graph, started, resolve: (r) => { clearTimeout(timer); if (pending.size === 0) w.unref(); resolve(r); } });
    w.ref();
    w.postMessage({ id, turtle });
  });
}

/** OWL 2 DL reasoning (sparq) in the reasoner worker; queued so one job runs at a time. */
export function reasonInWorker(graph: OntologyGraph): Promise<ReasonerResult> {
  const job = tail.then(() => run(graph));
  tail = job.catch(() => undefined);
  return job;
}
