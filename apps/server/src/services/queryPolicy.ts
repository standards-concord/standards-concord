import { createRequire } from 'node:module';

/**
 * What the query assistant may hand back to the browser. Queries are checked
 * with sparq, the same engine that runs them in the browser, using its
 * planning-only EXPLAIN: the query is parsed and planned, never executed, so a
 * query that would be expensive to run costs the server nothing. On top of
 * that, a small policy: read-only query forms over the page's own data only,
 * and no VALUES lists that multiply into an enormous starting table. Other
 * expensive queries (big cross joins over the data) can't be ruled out from
 * the text, so the browser runs every query in a worker it can stop, with a
 * time limit and a cap on the rows it shows.
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

/** The most rows that VALUES lists may combine into (their sizes multiply when they are joined). */
export const MAX_VALUES_ROWS = 10_000;

/**
 * Rows in each VALUES block, read from the query with strings, IRIs and
 * comments blanked out: one per term for `VALUES ?x { … }`, one per
 * parenthesised tuple for `VALUES (?a ?b) { (…) (…) }`.
 */
function valuesSizes(sparql: string): number[] {
  const text = sparql.replace(/<[^<>\s]*>|"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|#[^\n]*/g, (m) => (m.startsWith('#') ? ' ' : ' X '));
  const sizes: number[] = [];
  for (const m of text.matchAll(/\bVALUES\s*(\([^)]*\)|[?$]\w+)\s*\{([^}]*)\}/gi)) {
    const body = m[2];
    sizes.push(m[1].startsWith('(') ? (body.match(/\(/g) ?? []).length : body.split(/\s+/).filter(Boolean).length);
  }
  return sizes;
}

/** Why this query can't go to the browser, or undefined when it's fine. */
export function queryProblem(sparql: string): string | undefined {
  if (!sparql.trim()) return 'The query is empty.';
  if (sparql.length > MAX_QUERY_LENGTH) return `The query is longer than ${MAX_QUERY_LENGTH.toLocaleString('en-GB')} characters.`;
  const words = keywords(sparql);
  for (const [word, why] of Object.entries(NOT_ALLOWED)) if (words.has(word)) return why;
  // Several VALUES lists multiply: four lists of 200 make 1.6 billion rows before any data is read.
  const sizes = valuesSizes(sparql);
  const combined = sizes.reduce((n, k) => n * Math.max(1, k), 1);
  if (sizes.length > 1 && combined > MAX_VALUES_ROWS)
    return `Its VALUES lists combine into ${combined.toLocaleString('en-GB')} rows, more than the ${MAX_VALUES_ROWS.toLocaleString('en-GB')} a query here may start from.`;
  try {
    const plan = sparq().explain(sparql);
    if (!/^EXPLAIN \((SELECT|ASK|CONSTRUCT|DESCRIBE)\)/.test(plan)) return 'Only SELECT, ASK, CONSTRUCT and DESCRIBE queries are supported.';
    return undefined;
  } catch (e) {
    return `The query doesn’t parse: ${String((e as Error).message ?? e).replace(/^Error:\s*/, '')}`;
  }
}
