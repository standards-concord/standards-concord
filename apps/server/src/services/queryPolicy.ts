import { createRequire } from 'node:module';

/**
 * What the query assistant may hand back to the browser. Queries are checked
 * with sparq, the same engine that runs them in the browser, using its
 * planning-only EXPLAIN: the query is parsed and planned, never executed, so a
 * query that would be expensive to run costs the server nothing. On top of
 * that, a small policy: read-only query forms over the page's own data only.
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

/** Keywords that reach outside the page's data or change it. Updates fail to parse as queries anyway. */
const NOT_ALLOWED: Record<string, string> = {
  SERVICE: 'Federated queries (SERVICE) aren’t supported: queries run over the ontology and sample data in your browser.',
  FROM: 'FROM and FROM NAMED aren’t supported: queries run over the ontology and sample data in your browser.',
  LOAD: 'Queries here are read-only.',
  INSERT: 'Queries here are read-only.',
  DELETE: 'Queries here are read-only.',
  CLEAR: 'Queries here are read-only.',
  DROP: 'Queries here are read-only.',
  CREATE: 'Queries here are read-only.',
};

/** Words of a query outside IRIs, strings and comments, upper-cased. */
function keywords(sparql: string): Set<string> {
  const out = new Set<string>();
  const re = /<[^<>\s]*>|"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|#[^\n]*|([\w:?$@-]+)/g;
  for (const m of sparql.matchAll(re)) if (m[1] && !/[:?$@]/.test(m[1])) out.add(m[1].toUpperCase());
  return out;
}

/** Why this query can't go to the browser, or undefined when it's fine. */
export function queryProblem(sparql: string): string | undefined {
  if (!sparql.trim()) return 'The query is empty.';
  if (sparql.length > MAX_QUERY_LENGTH) return `The query is longer than ${MAX_QUERY_LENGTH.toLocaleString('en-GB')} characters.`;
  const words = keywords(sparql);
  for (const [word, why] of Object.entries(NOT_ALLOWED)) if (words.has(word)) return why;
  try {
    const plan = sparq().explain(sparql);
    if (!/^EXPLAIN \((SELECT|ASK|CONSTRUCT|DESCRIBE)\)/.test(plan)) return 'Only SELECT, ASK, CONSTRUCT and DESCRIBE queries are supported.';
    return undefined;
  } catch (e) {
    return `The query doesn’t parse: ${String((e as Error).message ?? e).replace(/^Error:\s*/, '')}`;
  }
}
