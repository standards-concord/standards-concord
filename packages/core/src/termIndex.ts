/**
 * Looking terms up in an ontology's view: find one by IRI, what refers to it,
 * and ranked search. Pure functions over OntologyView, with no RDF store, so
 * the web app can answer these from the view it already holds instead of
 * asking the server on every click. The server's routes use the same code.
 */
import { compactIRI, localName } from './ns.js';
import type { OntologyView, TermView } from './types.js';

/** Every term in the view, in the order OntologyGraph.term() prefers a kind for a punned IRI. */
export function allTerms(v: OntologyView): TermView[] {
  return [...v.classes, ...v.objectProperties, ...v.datatypeProperties, ...v.annotationProperties, ...v.individuals, ...(v.conceptSchemes ?? []), ...(v.concepts ?? [])];
}

/** The term with this IRI, as OntologyGraph.term() would give it (a class before a property before an individual). */
export function findTerm(v: OntologyView, iri: string): TermView | undefined {
  return allTerms(v).find((t) => t.iri === iri);
}

export interface UsedBy {
  iri: string;
  label?: string;
  /** How it refers to the term, e.g. "subclass of" or "restriction vol:hasRole some". */
  via: string;
}

/** Terms that refer to a given IRI (superclass, restriction, domain, range, type). `compact` shortens IRIs in `via`. */
export function usedBy(all: TermView[], iri: string, compact: (i: string) => string = (i) => i): UsedBy[] {
  const out: UsedBy[] = [];
  for (const t of all) {
    if (t.iri === iri) continue;
    if (t.kind === 'class') {
      if (t.superClasses.includes(iri)) out.push({ iri: t.iri, label: t.label, via: 'subclass of' });
      if (t.disjointWith.includes(iri)) out.push({ iri: t.iri, label: t.label, via: 'disjoint with' });
      for (const r of t.restrictions) if (r.property === iri || r.filler === iri) out.push({ iri: t.iri, label: t.label, via: `restriction ${compact(r.property)} ${r.kind}` });
    } else if (t.kind === 'individual') {
      if (t.types.includes(iri)) out.push({ iri: t.iri, label: t.label, via: 'instance of' });
    } else if (t.kind === 'concept') {
      if (t.inScheme.includes(iri) || t.broader.includes(iri) || t.topConceptOf.includes(iri)) out.push({ iri: t.iri, label: t.label, via: t.inScheme.includes(iri) ? 'in code list' : 'broader code' });
    } else if ('domain' in t) {
      if (t.codeList === iri) out.push({ iri: t.iri, label: t.label, via: 'code list' });
      if (t.domain.includes(iri)) out.push({ iri: t.iri, label: t.label, via: 'domain' });
      if (t.range.includes(iri)) out.push({ iri: t.iri, label: t.label, via: 'range' });
      if (t.superProperties.includes(iri)) out.push({ iri: t.iri, label: t.label, via: 'subproperty of' });
    }
  }
  return out;
}

export type TermDetail = TermView & { usedBy: UsedBy[] };

/** A term with what refers to it, as GET /api/ontologies/:id/terms/:iri answers. Undefined when the view has no such term. */
export function termDetail(v: OntologyView, iri: string): TermDetail | undefined {
  const t = findTerm(v, iri);
  return t && { ...t, usedBy: usedBy(allTerms(v), iri, (i) => compactIRI(i, v.prefixes)) };
}

/** True when every character of `needle` appears in `hay` in order (and the needle is longer than 2). */
function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) if (ch === needle[i]) i++;
  return i === needle.length && needle.length > 2;
}

/**
 * Ranked fuzzy search over labels, alt labels, local names and definitions.
 * Each term is listed once (a punned IRI under the kind findTerm gives it).
 */
export function searchTerms(all: TermView[], query: string, limit = 20): TermView[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const tokens = q.split(/\s+/);
  const squashed = q.replace(/\s+/g, '');
  const scored: [number, TermView][] = [];
  const seen = new Set<string>();
  for (const t of all) {
    if (seen.has(t.iri)) continue;
    seen.add(t.iri);
    const label = (t.label ?? '').toLowerCase();
    const ln = localName(t.iri).toLowerCase();
    const notation = t.kind === 'concept' ? t.notation?.toLowerCase() : undefined;
    const alts = (t.altLabels ?? []).map((a) => a.toLowerCase());
    const def = (t.definition ?? '').toLowerCase();
    let score = 0;
    if (label === q || ln === squashed || notation === q) score = 100;
    else if (alts.includes(q)) score = 90;
    else if (label.startsWith(q) || ln.startsWith(squashed) || notation?.startsWith(q)) score = 80;
    else if (label.includes(q) || ln.includes(squashed)) score = 70;
    else if (alts.some((a) => a.includes(q))) score = 60;
    else {
      const hay = [label, ln, notation ?? '', ...alts].join(' ');
      const hits = tokens.filter((tok) => hay.includes(tok)).length;
      const defHits = tokens.filter((tok) => def.includes(tok)).length;
      if (hits === tokens.length) score = 50;
      else if (hits + defHits >= tokens.length) score = 30 + hits;
      else if (hits > 0 || defHits > 0) score = 10 + hits * 2 + defHits;
      else if (isSubsequence(squashed, ln)) score = 5;
    }
    if (score > 0) scored.push([score - (t.deprecated ? 20 : 0), t]);
  }
  return scored.sort((a, b) => b[0] - a[0] || a[1].iri.localeCompare(b[1].iri)).slice(0, limit).map((x) => x[1]);
}
