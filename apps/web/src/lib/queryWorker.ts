/// <reference lib="webworker" />
/**
 * Runs SPARQL queries with sparq off the main thread, so a slow or explosive
 * query never freezes the page: the page can stop it at any time (Cancel, or
 * the time limit) by terminating this worker. Memory is bounded three ways:
 * - before running, queries that would build enormous values or VALUES tables
 *   are refused (the same check the server applies to the assistant's queries);
 * - the engine's WebAssembly memory is capped, so a query that needs more fails
 *   with an error instead of growing towards the 4 GB WebAssembly allows;
 * - results are read as a stream, and collection stops at a row budget, a byte
 *   budget and a cell size, so a huge answer never floods the page.
 */
import type { SparqStore } from '@sparq-org/sparq';
import initWasm from '@sparq-org/sparq/wasm/sparq_wasm.js';
import wasmUrl from '@sparq-org/sparq/wasm/sparq_wasm_bg.wasm?url';
import { parseSparql, resourceProblem } from '@concord/core/sparql-guard';
import { RESULT_BUDGET, type QueryRun, type QueryRunResult, type RunResult } from './queryRunner';
import { withMemoryLimit } from './wasmMemory';

let cached: { key: string; store: SparqStore } | undefined;
let sparq: typeof import('@sparq-org/sparq') | undefined;
let engine: { memory: WebAssembly.Memory; limitBytes: number } | undefined;

/** Loads sparq's engine with its memory capped (sparq's own loader then finds it already loaded). */
async function load(memoryMiB: number) {
  if (!engine) {
    const bytes = new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer());
    const exports = (await initWasm({ module_or_path: withMemoryLimit(bytes, memoryMiB) })) as unknown as { memory: WebAssembly.Memory };
    engine = { memory: exports.memory, limitBytes: memoryMiB * 1024 * 1024 };
  }
  sparq ??= await import('@sparq-org/sparq');
}

async function storeFor(source: string): Promise<SparqStore> {
  if (cached?.key === source) return cached.store;
  const store = await sparq!.SparqStore.fromString(source, 'turtle');
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
  const out: (string | null)[][] = [];
  let total = 0;
  let kept = 0;
  let read = 0;
  let complete = true;
  let cut = false;
  // Breaking out of the loop frees the engine's cursor.
  for (const chunk of store.queryJsonChunks(req.query)) {
    // The engine splits between rows, so one huge chunk is one huge row: don't decode it.
    if (chunk.length > RESULT_BUDGET.chunkChars) throw new Error(`A row of the results is over ${Math.round(RESULT_BUDGET.chunkChars / 1024 / 1024)} MB, too large to show. Try selecting fewer or shorter values.`);
    read += chunk.length;
    if (!vars) {
      head += chunk;
      const m = /"vars"\s*:\s*(\[[^\]]*\])/.exec(head);
      if (m) (vars = JSON.parse(m[1]) as string[]), (head = '');
    }
    for (const b of parser.push(chunk)) {
      total++;
      if (out.length >= req.maxRows || kept >= RESULT_BUDGET.keptChars || !vars) continue;
      // By position in vars, never by name: a variable may be called __proto__.
      const row = vars.map((v) => {
        const term = Object.hasOwn(b, v) ? b[v] : undefined;
        if (!term) return null;
        const [value, wasCut] = cell(term.value);
        cut ||= wasCut;
        kept += value.length;
        return value;
      });
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
  // Refused before the engine starts building anything. (A query sparqljs can't parse is left to sparq,
  // which reports its own error or runs it, still within the memory cap.)
  const parsed = parseSparql(req.query);
  const problem = 'tree' in parsed ? resourceProblem(parsed.tree) : undefined;
  if (problem) throw new Refused(problem);
  if (req.form === 'ask') return { kind: 'ask', answer: store.queryBoolean(req.query) };
  if (req.form === 'construct' || req.form === 'describe') return graph(store, req);
  return rows(store, req);
}

class Refused extends Error {}

self.onmessage = async (e: MessageEvent<QueryRun>) => {
  const req = e.data;
  const t0 = performance.now();
  try {
    await load(req.memoryMiB);
    const store = await storeFor(req.source);
    const result = run(store, req);
    self.postMessage({ id: req.id, ok: true, result, ms: Math.round(performance.now() - t0) } satisfies QueryRunResult);
  } catch (err) {
    if (err instanceof Refused) return void self.postMessage({ id: req.id, ok: false, error: err.message } satisfies QueryRunResult);
    // A trap (running out of the capped memory ends in one) leaves the engine unusable: the page replaces this worker.
    const message = err instanceof Error ? err.message : String(err);
    const trapped = err instanceof WebAssembly.RuntimeError || err instanceof RangeError || /^(unreachable|RuntimeError)|out of memory|memory access out of bounds/i.test(message);
    // A failed allocation can be a large one (a growing table doubles), so the memory is often far from full when it fails.
    const full = !!engine && engine.memory.buffer.byteLength >= engine.limitBytes * 0.25;
    cached = undefined;
    const error =
      trapped && full
        ? `The query needed more memory than a query here may use (${req.memoryMiB} MB), so it was stopped. Try narrowing it, or add a LIMIT.`
        : trapped
          ? `The query engine stopped unexpectedly (${message}). Try the query again, or narrow it.`
          : message;
    self.postMessage({ id: req.id, ok: false, error, fatal: trapped } satisfies QueryRunResult);
  }
};
