/// <reference lib="webworker" />
/**
 * Runs SPARQL queries with sparq off the main thread, so a slow or explosive
 * query never freezes the page: the page can stop it at any time (Cancel, or
 * the time limit) by terminating this worker. Results are read as a stream and
 * collection stops at a row budget, a byte budget and a cell size, so a huge
 * answer never floods the worker's memory or the page. (sparq builds the result
 * inside WebAssembly before streaming it; the time limit bounds that part.)
 */
import type { SparqStore } from '@sparq-org/sparq';
import { RESULT_BUDGET, type QueryRun, type QueryRunResult, type RunResult } from './queryRunner';

let cached: { key: string; store: SparqStore } | undefined;
let sparq: typeof import('@sparq-org/sparq') | undefined;

async function storeFor(source: string): Promise<SparqStore> {
  sparq ??= await import('@sparq-org/sparq');
  if (cached?.key === source) return cached.store;
  const store = await sparq.SparqStore.fromString(source, 'turtle');
  cached?.store.free();
  cached = { key: source, store };
  return store;
}

/** A value no longer than one cell may be, and whether it was cut. */
function cell(value: string): [string, boolean] {
  return value.length > RESULT_BUDGET.cellChars ? [`${value.slice(0, RESULT_BUDGET.cellChars)}…`, true] : [value, false];
}

function rows(store: SparqStore, req: QueryRun): RunResult {
  const parser = new sparq!.SparqlJsonRowsParser();
  let vars: string[] | undefined;
  let head = '';
  const out: Record<string, string>[] = [];
  let total = 0;
  let kept = 0;
  let read = 0;
  let complete = true;
  let cut = false;
  // Breaking out of the loop frees the engine's cursor.
  for (const chunk of store.queryJsonChunks(req.query)) {
    read += chunk.length;
    if (!vars) {
      head += chunk;
      const m = /"vars"\s*:\s*(\[[^\]]*\])/.exec(head);
      if (m) (vars = JSON.parse(m[1]) as string[]), (head = '');
    }
    for (const b of parser.push(chunk)) {
      total++;
      if (out.length >= req.maxRows || kept >= RESULT_BUDGET.keptChars) continue;
      const row: Record<string, string> = {};
      for (const [k, v] of Object.entries(b)) {
        const [value, wasCut] = cell(v.value);
        cut ||= wasCut;
        kept += k.length + value.length;
        row[k] = value;
      }
      out.push(row);
    }
    // Past this, only counting is left to do: stop, and say the count is a lower bound.
    if (read > RESULT_BUDGET.readChars) {
      complete = false;
      break;
    }
  }
  return { kind: 'rows', vars: vars ?? [], rows: out, total, complete, cut };
}

function graph(store: SparqStore, req: QueryRun): RunResult {
  const lines: string[] = [];
  let count = 0;
  let kept = 0;
  let read = 0;
  let complete = true;
  let cut = false;
  for (const q of store.queryQuadsStream(req.query)) {
    count++;
    const line = `${sparq!.termToNT(q.subject)} ${sparq!.termToNT(q.predicate)} ${sparq!.termToNT(q.object)} .`;
    read += line.length;
    if (lines.length < req.maxRows && kept < RESULT_BUDGET.keptChars) {
      const [text, wasCut] = cell(line);
      cut ||= wasCut;
      kept += text.length;
      lines.push(text);
    }
    if (read > RESULT_BUDGET.readChars) {
      complete = false;
      break;
    }
  }
  return { kind: 'graph', text: lines.join('\n'), shown: lines.length, count, complete, cut };
}

function run(store: SparqStore, req: QueryRun): RunResult {
  if (req.form === 'ask') return { kind: 'ask', answer: store.queryBoolean(req.query) };
  if (req.form === 'construct' || req.form === 'describe') return graph(store, req);
  return rows(store, req);
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
