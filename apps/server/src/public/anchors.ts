import { localName } from '@concord/core';
import type { OntologyView, TermView } from '@concord/core/types';

/** Ids the page itself uses. A term whose fragment would clash gets a "term-" prefix instead. */
const UI_ID = /^(main|term-filter|(tab|sec|uc|req)-.*)$/;

/**
 * The anchor for every term on the public page. A term in the ontology's own
 * namespace keeps its IRI fragment exactly (so https://…/vocab#Café lands on
 * id="Café"); terms from other namespaces, and the rare fragment that clashes
 * with the page's own ids, get a prefixed or numbered anchor. The page and the
 * slash-namespace redirect both use this mapping.
 */
export function termAnchors(view: OntologyView, namespace: string): Map<string, string> {
  const all: TermView[] = [...view.classes, ...view.objectProperties, ...view.datatypeProperties, ...view.annotationProperties, ...view.individuals];
  const own = (t: TermView) => t.iri.startsWith(namespace);
  // Own terms first, so they win their exact fragment; then a stable order.
  const ordered = [...all].sort((a, b) => Number(own(b)) - Number(own(a)) || a.iri.localeCompare(b.iri));
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const t of ordered) {
    if (out.has(t.iri)) continue;
    const fragment = (localName(t.iri) || 'term').replace(/\s/g, '_');
    let anchor = UI_ID.test(fragment) ? `term-${fragment}` : fragment;
    const base = anchor;
    for (let n = 2; used.has(anchor); n++) anchor = `${base}-${n}`;
    used.add(anchor);
    out.set(t.iri, anchor);
  }
  return out;
}
