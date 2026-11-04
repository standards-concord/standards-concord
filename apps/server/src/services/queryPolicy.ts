import { createRequire } from 'node:module';
import sparqljs, { type SparqlQuery } from 'sparqljs';

const { Parser } = sparqljs;

/**
 * What the query assistant may hand back to the browser. Queries are checked
 * with sparq, the same engine that runs them in the browser, using its
 * planning-only EXPLAIN: the query is parsed and planned, never executed, so a
 * query that would be expensive to run costs the server nothing. On top of
 * that, a policy applied to the parsed query: read-only forms over the page's
 * own data only, and no VALUES lists that multiply into an enormous starting
 * table. Other expensive queries (big cross joins, long strings) can't be ruled
 * out statically, so the browser runs every query in a worker with row, byte
 * and time budgets, stopped the moment one is exceeded.
 */

const require = createRequire(import.meta.url);
let planner: { explain(sparql: string): string } | undefined;
function sparq() {
  if (!planner) {
    const { Store } = require('@sparq-org/sparq/wasm-node') as { Store: new () => { explain(sparql: string): string } };
    planner = new Store();
  }
  return planner;
}

export const MAX_QUERY_LENGTH = 8000;

/** The most rows that VALUES lists may combine into (their sizes multiply when they are joined). */
export const MAX_VALUES_ROWS = 10_000;

type Node = { type?: string; [k: string]: unknown };

/** Every object in the parsed query, depth first: patterns, expressions, subqueries. */
function* walk(node: unknown): Generator<Node> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (node && typeof node === 'object') {
    yield node as Node;
    for (const v of Object.values(node)) if (v && typeof v === 'object') yield* walk(v);
  }
}

/**
 * Why this query can't go to the browser, or undefined when it's fine. It is
 * parsed with sparqljs and the policy applied to the syntax tree (so comments,
 * strings, line endings and Unicode names can't hide anything), then planned
 * by sparq, the engine the browser runs, to be sure it will run there.
 */
export function queryProblem(sparql: string): string | undefined {
  if (!sparql.trim()) return 'The query is empty.';
  if (sparql.length > MAX_QUERY_LENGTH) return `The query is longer than ${MAX_QUERY_LENGTH.toLocaleString('en-GB')} characters.`;
  let parsed: SparqlQuery;
  try {
    parsed = new Parser().parse(sparql);
  } catch (e) {
    return `The query doesn’t parse: ${String((e as Error).message ?? e).split('\n')[0]}`;
  }
  if (parsed.type !== 'query') return 'Queries here are read-only.';
  let values = 1;
  let valuesBlocks = 0;
  for (const n of walk(parsed)) {
    if (n.type === 'service') return 'Federated queries (SERVICE) aren’t supported: queries run over the ontology and sample data in your browser.';
    if (n.type === 'query') {
      const from = n.from as { default?: unknown[]; named?: unknown[] } | undefined;
      if (from && ((from.default?.length ?? 0) > 0 || (from.named?.length ?? 0) > 0)) return 'FROM and FROM NAMED aren’t supported: queries run over the ontology and sample data in your browser.';
      if (Array.isArray(n.values)) (values *= Math.max(1, n.values.length)), valuesBlocks++;
    }
    if (n.type === 'values' && Array.isArray(n.values)) (values *= Math.max(1, n.values.length)), valuesBlocks++;
  }
  // Several VALUES lists multiply: four lists of 200 make 1.6 billion rows before any data is read.
  if (valuesBlocks > 1 && values > MAX_VALUES_ROWS)
    return `Its VALUES lists combine into ${values.toLocaleString('en-GB')} rows, more than the ${MAX_VALUES_ROWS.toLocaleString('en-GB')} a query here may start from.`;
  try {
    const plan = sparq().explain(sparql);
    if (!/^EXPLAIN \((SELECT|ASK|CONSTRUCT|DESCRIBE)\)/.test(plan)) return 'Only SELECT, ASK, CONSTRUCT and DESCRIBE queries are supported.';
    return undefined;
  } catch (e) {
    return `The query doesn’t parse: ${String((e as Error).message ?? e).replace(/^Error:\s*/, '')}`;
  }
}
