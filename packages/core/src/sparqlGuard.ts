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
 * - resources: queries whose own text makes them build an enormous table
 *   (multiplying VALUES lists) or enormous values (repeated CONCAT or
 *   REPLACE), applied to every query. This is not a memory bound: what a
 *   query builds from the data (GROUP_CONCAT over many rows, a big join)
 *   can't be known from the text. The browser bounds that with a cap on the
 *   engine's memory and a limit on the size of a result row.
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

type Env = Map<string, number>;

/**
 * An upper bound on the longest value a query can build from its own
 * expressions, worked out the way the query is evaluated: each query level
 * (the outer query and every subquery) has its own variables, a subquery
 * passes out only what it projects, patterns are read in order so a BIND
 * sees what came before it, and projections come after WHERE. CONCAT adds
 * lengths and REPLACE can multiply them; values from the data are assumed
 * to be at most DATA_CHARS. GROUP_CONCAT depends on how many rows it joins,
 * which can't be known from the text: it counts as GROUP_CHARS here, and the
 * browser's memory cap and row-size limit bound what it really builds.
 */
function longestValue(tree: ParsedSparql): { chars: number; variable?: string } {
  let worst: { chars: number; variable?: string } = { chars: 0 };
  const note = (chars: number, variable?: string) => {
    if (chars > worst.chars || (chars === worst.chars && variable && !worst.variable)) worst = { chars, variable };
  };

  const est = (e: unknown, env: Env): number => {
    if (Array.isArray(e)) return Math.max(0, ...e.map((x) => est(x, env)));
    if (!e || typeof e !== 'object') return 0;
    const n = e as Node;
    if (n.termType === 'Variable') return env.get(n.value as string) ?? DATA_CHARS;
    if (n.termType) return String(n.value ?? '').length;
    const args = (n.args as unknown[] | undefined) ?? [];
    let out: number;
    if (n.type === 'operation') {
      const op = String(n.operator).toLowerCase();
      if (op === 'exists' || op === 'notexists') {
        // The pattern inside is evaluated too (with the outer variables in scope), but yields only a boolean.
        patterns(args, new Map(env));
        return 64;
      }
      const sizes = args.map((a) => est(a, env));
      if (SHORT.has(op)) out = 64;
      else if (op === 'concat') out = sizes.reduce((x, y) => x + y, 0);
      // Every match (at most one per character, plus the empty ones) can become the whole replacement, or copies of the match.
      else if (op === 'replace') out = ((sizes[0] ?? 0) + 1) * ((sizes[2] ?? 0) + 1);
      else if (op === 'encode_for_uri') out = 3 * (sizes[0] ?? 0);
      else if (op === 'if') out = Math.max(sizes[1] ?? 0, sizes[2] ?? 0);
      else out = Math.max(0, ...sizes);
    } else if (n.type === 'functionCall') out = Math.max(0, ...args.map((a) => est(a, env)));
    else if (n.type === 'aggregate') {
      const inner = est(n.expression, env);
      out = n.aggregation === 'group_concat' ? Math.max(GROUP_CHARS, inner) : n.aggregation === 'count' || n.aggregation === 'sum' || n.aggregation === 'avg' ? 64 : inner;
    } else out = 0;
    note(out);
    return out;
  };

  /**
   * Binds a variable. One already bound keeps the longer estimate: a join would make the values equal, but a
   * variable can be unbound on some rows (VALUES … UNDEF, OPTIONAL, one branch of a UNION), where the new value
   * goes through unchanged, so the shorter estimate is not a bound.
   */
  const bind = (env: Env, name: string, chars: number) => env.set(name, Math.max(env.get(name) ?? 0, chars));
  const fromData = (env: Env, t: unknown) => {
    const n = t as Node | undefined;
    if (n?.termType === 'Variable') bind(env, n.value as string, DATA_CHARS);
  };

  /** Evaluates patterns in order into env, the variables of this query level. */
  function patterns(list: unknown[], env: Env) {
    // A FILTER applies to its whole group, wherever it is written: judge it with all of the group's bindings.
    const filters: unknown[] = [];
    for (const item of list) {
      const p = item as Node;
      switch (p.type) {
        case 'bgp':
          for (const t of p.triples as Node[]) for (const k of ['subject', 'predicate', 'object']) fromData(env, t[k]);
          break;
        case 'bind': {
          const chars = est(p.expression, env);
          bind(env, (p.variable as Node).value as string, chars);
          note(chars, (p.variable as Node).value as string);
          break;
        }
        case 'values':
          for (const row of p.values as Record<string, unknown>[]) for (const [k, t] of Object.entries(row)) if (t) note(est(t, env));
          for (const k of new Set((p.values as Record<string, unknown>[]).flatMap((r) => Object.keys(r))))
            bind(env, k.replace(/^\?/, ''), Math.max(0, ...(p.values as Record<string, unknown>[]).map((r) => est(r[k], env))));
          break;
        case 'filter':
          filters.push(p.expression);
          break;
        case 'query':
          // A subquery has its own variables and passes out only its projections.
          for (const [k, v] of query(p)) bind(env, k, v);
          break;
        case 'union': {
          // Each branch sees the variables so far; afterwards a variable may come from either.
          const branches = (p.patterns as unknown[]).map((b) => {
            const copy = new Map(env);
            patterns([b], copy);
            return copy;
          });
          for (const k of new Set(branches.flatMap((b) => [...b.keys()]))) env.set(k, Math.max(...branches.filter((b) => b.has(k)).map((b) => b.get(k)!)));
          break;
        }
        case 'optional':
        case 'minus':
        case 'group':
        case 'graph':
        case 'service': {
          if (p.type === 'graph' || p.type === 'service') fromData(env, p.name);
          const inner = new Map(env);
          patterns(p.patterns as unknown[], inner);
          if (p.type !== 'minus') for (const [k, v] of inner) bind(env, k, v);
          break;
        }
        default:
          break;
      }
    }
    for (const f of filters) est(f, env);
  }

  /** One query level: WHERE in order, then GROUP BY and projections in order. Returns what it projects. */
  function query(q: Node): Env {
    const env: Env = new Map();
    if (q.values) patterns([{ type: 'values', values: q.values }], env);
    patterns((q.where as unknown[] | undefined) ?? [], env);
    for (const g of (q.group as Node[] | undefined) ?? []) {
      const chars = est(g.expression, env);
      if ((g.variable as Node | undefined)?.termType === 'Variable') bind(env, (g.variable as Node).value as string, chars);
    }
    for (const h of (q.having as unknown[] | undefined) ?? []) est(h, env);
    const projected: Env = new Map();
    for (const v of (q.variables as Node[] | undefined) ?? []) {
      if (v.termType === 'Variable') projected.set(v.value as string, env.get(v.value as string) ?? DATA_CHARS);
      else if (v.termType === 'Wildcard') for (const [k, c] of env) projected.set(k, c);
      else if (v.expression && (v.variable as Node | undefined)?.termType === 'Variable') {
        const name = (v.variable as Node).value as string;
        const chars = est(v.expression, env);
        env.set(name, chars);
        projected.set(name, chars);
        note(chars, name);
      }
    }
    for (const o of (q.order as Node[] | undefined) ?? []) est(o.expression, env);
    // CONSTRUCT templates and DESCRIBE only use what is bound.
    return projected;
  }

  if (tree.type === 'query') query(tree as unknown as Node);
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
