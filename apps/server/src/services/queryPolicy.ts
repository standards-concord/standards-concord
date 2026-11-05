import { createRequire } from 'node:module';
import { MAX_VALUES_ROWS, parseSparql, policyProblem } from '@concord/core/sparql-guard';

/**
 * What the query assistant may hand back to the browser. The query is parsed
 * with sparqljs and the shared policy applied to the syntax tree (read-only
 * forms over the page's own data, no VALUES lists that multiply into an
 * enormous table, no expressions that can build enormous values), then
 * planned by sparq, the engine the browser runs, with its planning-only
 * EXPLAIN: never executed, so a query that would be expensive to run costs the
 * server nothing. The browser applies the resource checks again to every query
 * and runs it in a worker with a memory cap, a time limit and result budgets.
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
export { MAX_VALUES_ROWS };

/** Why this query can't go to the browser, or undefined when it's fine. */
export function queryProblem(sparql: string): string | undefined {
  if (!sparql.trim()) return 'The query is empty.';
  if (sparql.length > MAX_QUERY_LENGTH) return `The query is longer than ${MAX_QUERY_LENGTH.toLocaleString('en-GB')} characters.`;
  const parsed = parseSparql(sparql);
  if ('error' in parsed) return `The query doesn’t parse: ${parsed.error}`;
  const problem = policyProblem(parsed.tree);
  if (problem) return problem;
  try {
    const plan = sparq().explain(sparql);
    if (!/^EXPLAIN \((SELECT|ASK|CONSTRUCT|DESCRIBE)\)/.test(plan)) return 'Only SELECT, ASK, CONSTRUCT and DESCRIBE queries are supported.';
    return undefined;
  } catch (e) {
    return `The query doesn’t parse: ${String((e as Error).message ?? e).replace(/^Error:\s*/, '')}`;
  }
}
