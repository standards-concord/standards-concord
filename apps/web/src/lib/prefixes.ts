/**
 * Prefix declarations in a SPARQL query or Turtle document, read the way a
 * parser would: comments, strings and IRIs (which can contain '#') are
 * skipped, and prefix names are case-sensitive.
 */
export function declaredPrefixes(doc: string): Map<string, string> {
  const out = new Map<string, string>();
  // In order: IRIs (which may contain '#'); long strings with escapes and up to two inner quotes,
  // possibly unterminated while typing;
  // short strings; comments; a declaration, with whitespace or comments allowed between its
  // tokens; and any other word, so "ex:PREFIX" isn't read as the keyword.
  const re =
    /<[^<>\s]*>|"""(?:(?:"|"")?(?:[^"\\]|\\[\s\S]))*(?:"""|$)|'''(?:(?:'|'')?(?:[^'\\]|\\[\s\S]))*(?:'''|$)|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|#[^\n]*|(?<![\w:?$@-])(?:@prefix|PREFIX)(?:\s|#[^\n]*(?:\n|$))+([A-Za-z][\w.-]*)?:(?:\s|#[^\n]*(?:\n|$))*<([^<>\s]*)>|[\w:?$@-]+/gi;
  for (const m of doc.matchAll(re)) {
    if (m[2] !== undefined) out.set(m[1] ?? '', m[2]);
  }
  return out;
}

/**
 * What to insert for a term picked from autocomplete. Uses the term's prefix
 * when it is declared with the right namespace (or another prefix bound to that
 * namespace), adds the declaration when the prefix is free, and falls back to
 * the full IRI when the prefix is bound to something else. `at` is where the
 * term goes; declarations after it don't count.
 */
export function insertTerm(doc: string, lang: 'sparql' | 'turtle', prefix: string, ns: string, iri: string, at = doc.length): { declaration?: string; text: string } {
  const local = iri.slice(ns.length);
  // Only declarations before the insertion point are in scope there.
  const declared = declaredPrefixes(doc.slice(0, at));
  const bound = declared.get(prefix);
  if (bound === ns) return { text: `${prefix}:${local}` };
  for (const [p, n] of declared) if (n === ns) return { text: `${p}:${local}` };
  if (bound !== undefined) return { text: `<${iri}>` };
  return {
    declaration: lang === 'sparql' ? `PREFIX ${prefix}: <${ns}>\n` : `@prefix ${prefix}: <${ns}> .\n`,
    text: `${prefix}:${local}`,
  };
}
