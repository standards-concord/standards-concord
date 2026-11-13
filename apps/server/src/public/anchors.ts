import { allTerms, localName } from '@concord/core';
import type { OntologyView, TermView } from '@concord/core/types';

/** A public reference includes only terms this ontology defines. RDF downloads keep every declaration. */
export function ownTerm(t: TermView, namespace: string, ontologyIRI: string): boolean {
  return (!!namespace && t.iri.startsWith(namespace)) || !!t.definedBy?.includes(ontologyIRI);
}

export function ownTermsView(view: OntologyView, namespace: string, ontologyIRI = view.metadata.iri): OntologyView {
  const own = (t: TermView) => ownTerm(t, namespace, ontologyIRI);
  return {
    ...view,
    classes: view.classes.filter(own),
    objectProperties: view.objectProperties.filter(own),
    datatypeProperties: view.datatypeProperties.filter(own),
    annotationProperties: view.annotationProperties.filter(own),
    individuals: view.individuals.filter(own),
    conceptSchemes: view.conceptSchemes?.filter(own),
    concepts: view.concepts?.filter(own),
  };
}

/** Ids the page itself uses. A term from another namespace whose name would clash gets a "term-" prefix. */
const UI_ID = /^(main|(tab|sec|uc|req)-.*)$/;

/**
 * The anchor for every term on the public page, used by the page and the
 * slash-namespace redirect alike.
 *
 * A term in the ontology's own namespace keeps everything after the namespace
 * exactly, so https://…/vocab#part:Child lands on id="part:Child" and
 * https://…/vocab#Café on id="Café". Those fragments are reserved: the page's
 * own ids move out of their way (see pageIds). Terms explicitly defined by this ontology in other namespaces get
 * their local name, prefixed or numbered when it would clash.
 */
export function termAnchors(view: OntologyView, namespace: string, ontologyIRI = view.metadata.iri): Map<string, string> {
  const all = allTerms(ownTermsView(view, namespace, ontologyIRI));
  const own = (t: TermView) => namespace.length > 0 && t.iri.startsWith(namespace) && t.iri.length > namespace.length;
  // Own terms first, so they win their exact fragment. Among them, a name
  // already holding "%" goes last: browsers rewrite #Café as #Caf%C3%A9, so
  // that href must stay with Café rather than a term literally named Caf%C3%A9.
  const pct = (t: TermView) => Number(t.iri.includes('%'));
  const ordered = [...all].sort((a, b) => Number(own(b)) - Number(own(a)) || pct(a) - pct(b) || a.iri.localeCompare(b.iri));
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const t of ordered) {
    if (out.has(t.iri)) continue;
    let base: string;
    if (own(t)) base = t.iri.slice(namespace.length).replace(/\s/g, '_');
    else {
      const name = (localName(t.iri) || 'term').replace(/\s/g, '_');
      base = UI_ID.test(name) ? `term-${name}` : name;
    }
    // Compared as they appear in a link, so #Café and a literal #Caf%C3%A9
    // (the same URI once encoded) can't end up with the same href.
    let anchor = base;
    for (let n = 2; used.has(fragment(anchor)); n++) anchor = `${base}-${n}`;
    used.add(fragment(anchor));
    out.set(t.iri, anchor);
  }
  return out;
}

/**
 * Allocates the page's own ids (tabs, sections, use cases) so they never take
 * a term's anchor: a clashing id becomes "<id>-page" (then "-page-2", …). The
 * same name always gets the same id within one page.
 */
export function pageIds(taken: Iterable<string>): (name: string) => string {
  const used = new Set([...taken].flatMap((id) => [id, fragment(id)]));
  const ids = new Map<string, string>();
  return (name: string) => {
    let id = ids.get(name);
    if (id !== undefined) return id;
    id = name;
    for (let n = 1; used.has(id); n++) id = n === 1 ? `${name}-page` : `${name}-page-${n}`;
    used.add(id);
    ids.set(name, id);
    return id;
  };
}

/**
 * A fragment for an href or Location header: characters a URL fragment can't
 * hold are percent-encoded, and everything else (including "%") is kept, so
 * the browser's raw-then-decoded lookup finds the id exactly.
 */
export function fragment(id: string): string {
  return id.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@/?%]/gu, (c) => encodeURIComponent(c));
}
