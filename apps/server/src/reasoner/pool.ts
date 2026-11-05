/**
 * The server's OWL reasoner: sparq in one long-lived worker thread, so neither the reasoning
 * nor the hierarchy reduction blocks the event loop. Jobs run one at a time.
 *
 * A job that fails, or runs past REASONER_TIMEOUT_MS (the worker is then replaced), falls back
 * to the structural checks, also in the worker and with their own limit
 * (REASONER_STRUCTURAL_TIMEOUT_MS), as the HermiT path did. Either way it is no verdict
 * (available: false), so validation fails closed. If the structural checks can't finish
 * either, the result says nothing was checked (engine 'none') and is not consistent.
 */
import { Worker } from 'node:worker_threads';
import type { OntologyGraph } from '@concord/core';
import type { ReasonerResult } from '@concord/core/types';

const TIMEOUT_MS = Number(process.env.REASONER_TIMEOUT_MS ?? 60_000);
const STRUCTURAL_TIMEOUT_MS = Number(process.env.REASONER_STRUCTURAL_TIMEOUT_MS ?? 20_000);

type Outcome = { result: ReasonerResult } | { error: string };
type Pending = { resolve: (o: Outcome) => void; worker: Worker };
let worker: Worker | undefined;
const pending = new Map<number, Pending>();
let nextId = 1;
let tail: Promise<unknown> = Promise.resolve();

/** Fails the jobs running on worker w (only that worker's: a replaced worker exits after its successor has started). */
function failJobsOn(w: Worker, error: string) {
  for (const [id, p] of pending) if (p.worker === w) { pending.delete(id); p.resolve({ error }); }
}

function spawn(): Worker {
  const w = new Worker(new URL('./worker.boot.mjs', import.meta.url));
  w.on('message', ({ id, result, error }: { id: number; result?: ReasonerResult; error?: string }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    p.resolve(result ? { result } : { error: `failed: ${error}` });
  });
  w.on('error', (e: Error) => { if (worker === w) worker = undefined; failJobsOn(w, `crashed: ${e.message}`); });
  w.on('exit', (code) => { if (worker === w) worker = undefined; failJobsOn(w, `stopped (exit ${code})`); });
  // Held only while a job is waiting (see runIn), so an idle reasoner never keeps the server or
  // a test process alive. Unref after the listeners: adding a 'message' listener refs again.
  w.unref();
  return w;
}

const duration = (ms: number) => (ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`);

/** Runs one job in the worker; on timeout the worker is stopped and replaced. */
function runIn(turtle: string, mode: 'owl' | 'structural' | 'hang', timeoutMs: number): Promise<Outcome> {
  const w = (worker ??= spawn());
  const id = nextId++;
  return new Promise<Outcome>((resolve) => {
    const timer = setTimeout(() => {
      if (!pending.delete(id)) return;
      w.unref();
      if (worker === w) worker = undefined;
      void w.terminate();
      resolve({ error: `took longer than ${duration(timeoutMs)} and was stopped` });
    }, timeoutMs);
    timer.unref();
    pending.set(id, { worker: w, resolve: (o) => { clearTimeout(timer); if (pending.size === 0) w.unref(); resolve(o); } });
    w.ref();
    w.postMessage({ id, turtle, mode });
  });
}

async function run(graph: OntologyGraph, timeoutMs: number, structuralTimeoutMs: number, owlMode: 'owl' | 'hang'): Promise<ReasonerResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const turtle = await graph.toTurtle();
  const owl = await runIn(turtle, owlMode, timeoutMs);
  if ('result' in owl) return owl.result;
  const error = `the OWL reasoner ${owl.error}`;
  const structural = await runIn(turtle, 'structural', structuralTimeoutMs);
  if ('result' in structural) return { ...structural.result, available: false, checked: 'none', error, durationMs: elapsed() };
  return {
    engine: 'none',
    available: false,
    checked: 'none',
    consistent: false,
    unsatisfiable: [],
    inferredSubClassOf: [],
    explanation: 'Neither the OWL reasoner nor the structural checks could finish, so nothing is known about whether the ontology is consistent.',
    error: `${error}; the structural checks ${structural.error}`,
    durationMs: elapsed(),
  };
}

/** OWL 2 DL reasoning (sparq) in the reasoner worker, with the structural fallback; queued so one job runs at a time. */
export function reasonInWorker(
  graph: OntologyGraph,
  opts: {
    timeoutMs?: number;
    structuralTimeoutMs?: number;
    /** Tests only: 'hang' makes the OWL job never answer, so a timeout is certain rather than a race. */
    owlMode?: 'owl' | 'hang';
  } = {},
): Promise<ReasonerResult> {
  const job = tail.then(() => run(graph, opts.timeoutMs ?? TIMEOUT_MS, opts.structuralTimeoutMs ?? STRUCTURAL_TIMEOUT_MS, opts.owlMode ?? 'owl'));
  tail = job.catch(() => undefined);
  return job;
}
