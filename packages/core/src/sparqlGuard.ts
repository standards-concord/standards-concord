import sparqljs, { type SparqlQuery } from 'sparqljs';

/**
 * Checks on a SPARQL request's syntax tree, shared by the server (which
 * vets what the query assistant hands back) and the browser (which vets every
 * query before its engine runs it). Working on the parsed tree means comments,
 * strings, line endings and Unicode names can't hide anything.
 *
 * Two kinds of check:
 * - policy: read-only forms over the page's own data (no updates, SERVICE or
 *   FROM), applied to what the assistant writes;
 * - resources: queries that would build an enormous table or enormous values
 *   before returning a single row, applied to every query.
 */

export type ParsedSparql = SparqlQuery;

/** The most rows that VALUES lists may combine into (their sizes multiply when they are joined). */
export const MAX_VALUES_ROWS = 10_000;
/** The longest value an expression may be able to build, in characters. */
export const MAX_VALUE_CHARS = 100_000;
/** What a value read from the data is assumed to be at most, for estimating what expressions build from it. */
const DATA_CHARS = 10_000;
/** What GROUP_CONCAT is assumed to build at most (its real size depends on the data). */
const GROUP_CHARS = 50_000;

export function parseSparql(sparql: string): { tree: ParsedSparql } | { error: string } {
  try {
    return { tree: new sparqljs.Parser().parse(sparql) };
  } catch (e) {
    return { error: String((e as Error).message ?? e).split('\n')[0] };
  }
}

type Node = { type?: string; termType?: string; [k: string]: unknown };

/** Every object in the tree, depth first: patterns, expressions, subqueries. */
function* walk(node: unknown): Generator<Node> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (node && typeof node === 'object') {
    yield node as Node;
    for (const v of Object.values(node)) if (v && typeof v === 'object') yield* walk(v);
  }
}

const fmt = (n: number) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-GB') : 'unboundedly many');

/** Results of these are short whatever goes in: numbers, booleans, hashes, language tags. */
const SHORT = new Set([
  '+', '-', '*', '/', '=', '!=', '<', '>', '<=', '>=', '!', '&&', '||', 'in', 'notin', 'exists', 'notexists', 'bound', 'sameterm',
  'isiri', 'isuri', 'isblank', 'isliteral', 'isnumeric', 'regex', 'contains', 'strstarts', 'strends', 'langmatches', 'strlen',
  'abs', 'ceil', 'floor', 'round', 'rand', 'now', 'year', 'month', 'day', 'hours', 'minutes', 'seconds', 'timezone', 'tz',
  'md5', 'sha1', 'sha256', 'sha384', 'sha512', 'lang', 'datatype', 'uuid', 'struuid', 'bnode',
]);

/**
 * An upper bound on how long each variable's values can get, from the BINDs,
 * projections and VALUES that define them: CONCAT adds lengths, REPLACE can
 * multiply them, values from the data are assumed short.
 */
function longestValue(tree: ParsedSparql): { chars: number; variable?: string } {
  const env = new Map<string, number>();
  const est = (e: unknown): number => {
    if (Array.isArray(e)) return Math.max(0, ...e.map(est));
    if (!e || typeof e !== 'object') return 0;
    const n = e as Node;
    if (n.termType === 'Variable') return env.get(n.value as string) ?? DATA_CHARS;
    if (n.termType) return String(n.value ?? '').length;
    const args = (n.args as unknown[] | undefined) ?? [];
    if (n.type === 'operation') {
      const op = String(n.operator).toLowerCase();
      if (SHORT.has(op)) return 64;
      if (op === 'concat') return args.reduce<number>((s, a) => s + est(a), 0);
      // Every match (at most one per character, plus the empty ones) can become the whole replacement, or copies of the match.
      if (op === 'replace') return (est(args[0]) + 1) * (est(args[2]) + 1);
      if (op === 'encode_for_uri') return 3 * est(args[0]);
      if (op === 'if') return Math.max(est(args[1]), est(args[2]));
      return est(args);
    }
    if (n.type === 'functionCall') return est(args);
    if (n.type === 'aggregate') return n.aggregation === 'group_concat' ? GROUP_CHARS : n.aggregation === 'count' || n.aggregation === 'sum' || n.aggregation === 'avg' ? 64 : est(n.expression);
    return 0;
  };
  // Definitions can come before or after their uses in the text (projections before WHERE): settle in a few passes.
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    const define = (name: string, chars: number) => {
      if (chars > (env.get(name) ?? -1)) env.set(name, chars), (changed = true);
    };
    for (const n of walk(tree)) {
      if (n.type === 'bind') define((n.variable as Node).value as string, est(n.expression));
      else if (n.type === 'values') for (const row of n.values as Record<string, unknown>[]) for (const [k, t] of Object.entries(row)) define(k.replace(/^\?/, ''), est(t));
      else if (n.expression && (n.variable as Node | undefined)?.termType === 'Variable' && !n.type) define((n.variable as Node).value as string, est(n.expression));
    }
    if (!changed) break;
  }
  let worst = { chars: 0, variable: undefined as string | undefined };
  for (const [variable, chars] of env) if (chars > worst.chars) worst = { chars, variable };
  // FILTER and ORDER BY expressions build values too, without naming them.
  for (const n of walk(tree)) if (n.type === 'filter' || n.type === 'operation') {
    const chars = est(n.type === 'filter' ? n.expression : n);
    if (chars > worst.chars) worst = { chars, variable: undefined };
  }
  return worst;
}

/** Why running this would need an enormous amount of memory before returning anything, or undefined. */
export function resourceProblem(tree: ParsedSparql): string | undefined {
  let values = 1;
  let blocks = 0;
  for (const n of walk(tree)) {
    const rows = n.type === 'values' ? n.values : n.type === 'query' ? n.values : undefined;
    if (Array.isArray(rows)) (values *= Math.max(1, rows.length)), blocks++;
  }
  // Several VALUES lists multiply: four lists of 200 make 1.6 billion rows before any data is read.
  if (blocks > 1 && values > MAX_VALUES_ROWS) return `Its VALUES lists combine into ${fmt(values)} rows, more than the ${fmt(MAX_VALUES_ROWS)} a query here may start from.`;
  const longest = longestValue(tree);
  if (longest.chars > MAX_VALUE_CHARS)
    return `It could build values of ${fmt(longest.chars)} characters${longest.variable ? ` (?${longest.variable})` : ''}, more than the ${fmt(MAX_VALUE_CHARS)} a query here may build. Repeated CONCAT or REPLACE makes values grow very fast.`;
  return undefined;
}

/** Why the query assistant may not hand this query back, or undefined: read-only forms over the page's own data, within the resource limits. */
export function policyProblem(tree: ParsedSparql): string | undefined {
  if (tree.type !== 'query') return 'Queries here are read-only.';
  for (const n of walk(tree)) {
    if (n.type === 'service') return 'Federated queries (SERVICE) aren’t supported: queries run over the ontology and sample data in your browser.';
    if (n.type === 'query') {
      const from = n.from as { default?: unknown[]; named?: unknown[] } | undefined;
      if (from && ((from.default?.length ?? 0) > 0 || (from.named?.length ?? 0) > 0)) return 'FROM and FROM NAMED aren’t supported: queries run over the ontology and sample data in your browser.';
    }
  }
  return resourceProblem(tree);
}
