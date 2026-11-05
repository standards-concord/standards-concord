import sparqljs, { type SparqlQuery } from 'sparqljs';

/**
 * The outer LIMIT of a SPARQL query, from the query as a SPARQL parser reads
 * it, so a subquery's LIMIT, or the word in a string, IRI or comment (however
 * its line ends), never counts.
 */

/** The parsed request; a query's `limit` is its outer LIMIT (subqueries keep theirs inside the pattern). */
type Parsed = SparqlQuery & { limit?: number };

function parse(q: string): Parsed | undefined {
  try {
    return new sparqljs.Parser().parse(q) as Parsed;
  } catch {
    return undefined;
  }
}

/** The parsed query without its outer LIMIT, for comparing two queries. */
function withoutLimitTree(tree: Parsed): string {
  const copy = { ...tree } as Record<string, unknown>;
  delete copy.limit;
  return JSON.stringify(copy);
}

export function limitOf(q: string): number | undefined {
  const tree = parse(q);
  return tree?.type === 'query' && typeof tree.limit === 'number' ? tree.limit : undefined;
}

/**
 * The query without its outer LIMIT (any OFFSET stays). The text is edited in
 * place so the rest keeps its layout: each `LIMIT n` in the text is tried, from
 * the end, and the edit kept only if the result parses to the same query with
 * no limit. If none does, the query is written out afresh without it.
 */
export function withoutLimit(q: string): string {
  const tree = parse(q);
  if (tree?.type !== 'query' || tree.limit === undefined) return q;
  const want = withoutLimitTree(tree);
  const candidates = [...q.matchAll(/\blimit\b/gi)].map((m) => m.index!).reverse();
  for (const at of candidates) {
    const m = /limit(?:\s|#[^\n\r]*)*\d+/iy;
    m.lastIndex = at;
    const hit = m.exec(q);
    if (!hit) continue;
    const edited = `${q.slice(0, at)}${q.slice(at + hit[0].length).replace(/^[ \t]+/, '')}`.replace(/[ \t]+(\r?\n)/g, '$1').trimEnd() + '\n';
    const t = parse(edited);
    if (t?.type === 'query' && t.limit === undefined && withoutLimitTree(t) === want) return edited;
  }
  return new sparqljs.Generator().stringify({ ...tree, limit: undefined } as SparqlQuery);
}
