/**
 * Prefix declarations in a SPARQL query or Turtle document, read the way a
 * parser would: comments, strings and IRIs (which can contain '#') are
 * skipped, and prefix names are case-sensitive.
 */
export function declaredPrefixes(doc: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /<[^<>\s]*>|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|#[^\n]*|(?:@prefix|\bPREFIX)\s+([A-Za-z][\w.-]*)?:\s*<([^<>\s]*)>/gi;
  for (const m of doc.matchAll(re)) {
    if (m[2] !== undefined) out.set(m[1] ?? '', m[2]);
  }
  return out;
}

/**
 * What to insert for a term picked from autocomplete. Uses the term's prefix
 * when it is declared with the right namespace (or another prefix bound to that
 * namespace), adds the declaration when the prefix is free, and falls back to
 * the full IRI when the prefix is bound to something else.
 */
export function insertTerm(doc: string, lang: 'sparql' | 'turtle', prefix: string, ns: string, iri: string): { declaration?: string; text: string } {
  const local = iri.slice(ns.length);
  const declared = declaredPrefixes(doc);
  const bound = declared.get(prefix);
  if (bound === ns) return { text: `${prefix}:${local}` };
  for (const [p, n] of declared) if (n === ns) return { text: `${p}:${local}` };
  if (bound !== undefined) return { text: `<${iri}>` };
  return {
    declaration: lang === 'sparql' ? `PREFIX ${prefix}: <${ns}>\n` : `@prefix ${prefix}: <${ns}> .\n`,
    text: `${prefix}:${local}`,
  };
}
