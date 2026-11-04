/// <reference lib="webworker" />
/**
 * Runs SPARQL queries with sparq off the main thread, so a slow or explosive
 * query never freezes the page: the page can stop it at any time (Cancel, or
 * the time limit) by terminating this worker. Results are capped before they
 * are sent back, so a huge answer never floods the page either.
 */
import type { SparqStore } from '@sparq-org/sparq';
import type { QueryRun, QueryRunResult, RunResult } from './queryRunner';

let cached: { key: string; store: SparqStore } | undefined;

async function storeFor(source: string): Promise<SparqStore> {
  if (cached?.key === source) return cached.store;
  const { SparqStore } = await import('@sparq-org/sparq');
  const store = await SparqStore.fromString(source, 'turtle');
  cached?.store.free();
  cached = { key: source, store };
  return store;
}

function run(store: SparqStore, req: QueryRun): RunResult {
  if (req.form === 'ask') return { kind: 'ask', answer: store.queryBoolean(req.query) };
  if (req.form === 'construct' || req.form === 'describe') {
    const lines = store.queryQuadsString(req.query).split('\n').filter((l) => l.trim());
    return { kind: 'graph', text: lines.slice(0, req.maxRows).join('\n'), count: lines.length, truncated: lines.length > req.maxRows };
  }
  const json = JSON.parse(store.queryJson(req.query)) as { head: { vars: string[] }; results: { bindings: Record<string, { value: string }>[] } };
  const all = json.results.bindings;
  const rows = all.slice(0, req.maxRows).map((b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.value])));
  return { kind: 'rows', vars: json.head.vars, rows, total: all.length };
}

self.onmessage = async (e: MessageEvent<QueryRun>) => {
  const req = e.data;
  const t0 = performance.now();
  try {
    const store = await storeFor(req.source);
    const result = run(store, req);
    self.postMessage({ id: req.id, ok: true, result, ms: Math.round(performance.now() - t0) } satisfies QueryRunResult);
  } catch (err) {
    // A failed run can leave the engine in a bad state (for example out of memory): start afresh next time.
    cached = undefined;
    self.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies QueryRunResult);
  }
};
