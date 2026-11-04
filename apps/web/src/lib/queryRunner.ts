import type { QueryForm } from './sparql-examples';

/** One query for the worker: the Turtle to run over (the ontology, plus sample data when asked) and the query. */
export interface QueryRun {
  id: number;
  source: string;
  query: string;
  form: QueryForm;
  maxRows: number;
}

/**
 * A result as the page gets it. `total` (rows) and `count` (triples) are exact
 * when `complete`, and otherwise a lower bound: the worker stopped reading.
 * `cut` means at least one value was longer than a cell may be and was shortened.
 */
export type RunResult =
  | { kind: 'rows'; vars: string[]; rows: Record<string, string>[]; total: number; complete: boolean; cut: boolean }
  | { kind: 'ask'; answer: boolean }
  | { kind: 'graph'; text: string; shown: number; count: number; complete: boolean; cut: boolean };

export type QueryRunResult = { id: number; ok: true; result: RunResult; ms: number } | { id: number; ok: false; error: string };

/** Results beyond this many rows are counted but not shown. */
export const MAX_ROWS = 5000;
/**
 * What the worker keeps while results stream in: rows stop being kept past
 * `keptChars` of values (about 16 MB of memory), any value is cut to
 * `cellChars`, and reading stops altogether after `readChars` of results.
 */
export const RESULT_BUDGET = { keptChars: 8 * 1024 * 1024, cellChars: 10_000, readChars: 64 * 1024 * 1024 };
/** A query still running after this long is stopped. */
export const TIME_LIMIT_MS = 20_000;

export class QueryStopped extends Error {
  constructor(readonly reason: 'cancelled' | 'timeout') {
    super(reason === 'timeout' ? 'The query took too long, so it was stopped. Try narrowing it, or add a LIMIT.' : 'The query was cancelled.');
  }
}

/**
 * Runs queries in a worker that can be stopped at any time. One query at a
 * time: starting another, cancelling, or hitting the time limit terminates the
 * worker (the only way to interrupt a synchronous WebAssembly call), and the
 * next run starts a fresh one.
 */
export class QueryRunner {
  private worker?: Worker;
  private pending?: { id: number; resolve: (r: { result: RunResult; ms: number }) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> };
  private nextId = 1;

  // Tests can shorten the limit with window.__concordQueryTimeLimitMs.
  constructor(private readonly timeLimitMs = (globalThis as { __concordQueryTimeLimitMs?: number }).__concordQueryTimeLimitMs ?? TIME_LIMIT_MS) {}

  private ensure(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./queryWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<QueryRunResult>) => {
        const p = this.pending;
        if (!p || p.id !== e.data.id) return;
        clearTimeout(p.timer);
        this.pending = undefined;
        if (e.data.ok) p.resolve({ result: e.data.result, ms: e.data.ms });
        else p.reject(new Error(e.data.error));
      };
      this.worker.onerror = (e) => {
        const p = this.pending;
        this.stop();
        p?.reject(new Error(e.message || 'The query engine stopped unexpectedly.'));
      };
    }
    return this.worker;
  }

  /** Terminates the worker and settles nothing; callers use cancel() to reject the pending run. */
  private stop() {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = undefined;
    this.worker?.terminate();
    this.worker = undefined;
  }

  get running() {
    return !!this.pending;
  }

  run(req: Omit<QueryRun, 'id' | 'maxRows'>): Promise<{ result: RunResult; ms: number }> {
    if (this.pending) this.cancel();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const p = this.pending;
        this.stop();
        p?.reject(new QueryStopped('timeout'));
      }, this.timeLimitMs);
      this.pending = { id, resolve, reject, timer };
      this.ensure().postMessage({ ...req, id, maxRows: MAX_ROWS } satisfies QueryRun);
    });
  }

  cancel() {
    const p = this.pending;
    this.stop();
    p?.reject(new QueryStopped('cancelled'));
  }

  dispose() {
    this.stop();
  }
}
