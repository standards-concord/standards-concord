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
 * changes. A term-level contributor is removed only when `generatedContributor`
 * says a merge wrote it (that term, that name), so a credit an editor added
 * stays. Contributors on the ontology itself (its metadata) are always kept.
 * Returns how many triples changed.
 */
export function scrubGeneratedProvenance(g: OntologyGraph, opts: { generatedContributor?: (subject: string, name: string) => boolean } = {}): number {
  const generated = opts.generatedContributor ?? (() => false);
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
    if (q.subject.value === header || !generated(q.subject.value, q.object.value)) continue;
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

/** Predicates that credit people on purpose; rewriteLiterals leaves them alone. */
const CREDITS = new Set([P.contributor, 'http://purl.org/dc/terms/creator', 'http://purl.org/dc/terms/publisher', 'http://purl.org/dc/elements/1.1/creator', 'http://purl.org/dc/elements/1.1/contributor']);

/**
 * Rewrites the literal values of the given subjects (never the ontology's own
 * metadata, nor credits). Returns how many triples changed.
 */
export function rewriteLiterals(g: OntologyGraph, subjects: Iterable<string>, rewrite: (value: string) => string): number {
  const s = g.store;
  let changed = 0;
  for (const iri of new Set(subjects)) {
    if (iri === g.ontologyIRI) continue;
    for (const q of s.getQuads(DataFactory.namedNode(iri), null, null, null)) {
      if (q.object.termType !== 'Literal' || CREDITS.has(q.predicate.value)) continue;
      const lit = q.object as Literal;
      const next = rewrite(lit.value);
      if (next === lit.value) continue;
      s.removeQuad(q);
      s.addQuad(q.subject, q.predicate, DataFactory.literal(next, lit.language || lit.datatype), q.graph);
      changed++;
    }
  }
  return changed;
}

/**
 * The use case titles older versions wrote into generated provenance (see
 * scrubGeneratedProvenance), by term. Read them before scrubbing, so the same
 * titles can be found and redacted elsewhere in those terms' text.
 */
export function generatedProvenanceTitles(g: OntologyGraph): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (subject: string, title: string) => {
    const t = title.trim();
    if (t) out.set(subject, [...new Set([...(out.get(subject) ?? []), t])]);
  };
  const literals = (p: string) => g.store.getQuads(null, DataFactory.namedNode(p), null, null).filter((q) => q.object.termType === 'Literal');
  for (const q of literals(P.source)) {
    const m = /^use cases?:\s*([\s\S]*)$/i.exec(q.object.value);
    if (m) for (const t of m[1].split(';')) add(q.subject.value, t);
  }
  for (const q of literals(P.editorialNote)) {
    const m = /^Needed by the use case “([\s\S]*)”$/.exec(q.object.value);
    if (m) add(q.subject.value, m[1]);
  }
  for (const q of literals(P.definition)) for (const m of q.object.value.matchAll(/, as described in the use case “([^”]*)”\./g)) add(q.subject.value, m[1]);
  return out;
}
