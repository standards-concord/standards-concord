import type { Literal, Quad } from 'n3';
import { DataFactory } from 'n3';
import type { OntologyGraph } from './graph.js';
import { P } from './graph.js';

/**
 * Removes provenance that earlier versions of Concord wrote into ontologies
 * and that can reveal private use cases or the people behind changes:
 *   - dcterms:contributor "<name>" on terms (added on every merge),
 *   - dcterms:source "use cases: <titles>" (added by synthesis),
 *   - the offline synthesiser's editorial note “Needed by the use case “…””
 *     and definition suffix “, as described in the use case “…”.”
 * Only these generated forms are touched, so nothing an editor wrote by hand
 * changes. Contributors on the ontology itself (its metadata) are kept.
 * Returns how many triples changed.
 */
export function scrubGeneratedProvenance(g: OntologyGraph): number {
  const s = g.store;
  const header = g.ontologyIRI;
  let changed = 0;
  const literalQuads = (p: string) => s.getQuads(null, DataFactory.namedNode(p), null, null).filter((q) => q.object.termType === 'Literal') as (Quad & { object: Literal })[];
  const replace = (q: Quad & { object: Literal }, value: string) => {
    s.removeQuad(q);
    s.addQuad(q.subject, q.predicate, DataFactory.literal(value, q.object.language || q.object.datatype), q.graph);
    changed++;
  };
  for (const q of literalQuads(P.contributor)) {
    if (q.subject.value === header) continue;
    s.removeQuad(q);
    changed++;
  }
  for (const q of literalQuads(P.source)) {
    if (!/^use cases?:/i.test(q.object.value)) continue;
    s.removeQuad(q);
    changed++;
  }
  for (const q of literalQuads(P.editorialNote)) if (/^Needed by the use case “[\s\S]*”$/.test(q.object.value)) replace(q, 'Needed by a use case (see source).');
  for (const q of literalQuads(P.definition)) {
    const next = q.object.value.replace(/, as described in the use case “[^”]*”\./g, '.');
    if (next !== q.object.value) replace(q, next);
  }
  return changed;
}
