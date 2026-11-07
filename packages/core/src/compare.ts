/**
 * Comparing two federations (or any two ontology graphs) term by term: how far one is a subset of the
 * other, and up to which terms they agree.
 *
 * Each term both define is put in one relation, judged from B's side:
 *   same       everything said about it is identical (equal term hashes);
 *   equivalent the same meaning said differently: other labels or notes, or a restated hierarchy;
 *   tightened  B says everything A says about it, and more (B's meaning is narrower: a safe refinement);
 *   loosened   A says everything B says, and more;
 *   conflict   each says something the other doesn't.
 * Terms only one side defines are `only-a` / `only-b`. Same, equivalent and tightened together are the
 * agreement signature: data written against A's meaning of those terms is still right under B.
 *
 * "Says" is compared at the level of the taxonomy and asserted axioms: entailed named superclasses
 * (from the reasoner, so a restated hierarchy still counts as the same), disjointness, and every other
 * logical axiom about the term in canonical form (restrictions, domains, ranges, characteristics).
 * Exact entailment comparison (conservative extension) is undecidable for OWL 2 DL, so this is the
 * practical approximation the design chose.
 */
import type { Term } from 'n3';
import type { OntologyGraph } from './graph.js';
import { NS } from './ns.js';
import { canonical } from './rdf.js';
import { sha256Hex } from './canon.js';
import type { ReasonerResult } from './types.js';

export type TermRelation = 'same' | 'equivalent' | 'tightened' | 'loosened' | 'conflict' | 'only-a' | 'only-b';
export const AGREEING: TermRelation[] = ['same', 'equivalent', 'tightened'];

export interface TermComparison {
  iri: string;
  kind: string;
  label?: string;
  relation: TermRelation;
  /** Logical statements about the term only B makes, and only A makes (readable, canonical). */
  onlyInB: string[];
  onlyInA: string[];
}

export interface GraphComparison {
  terms: TermComparison[];
  counts: Record<TermRelation, number>;
  /** Terms both define. */
  shared: number;
  /** Shared terms in the agreement signature (same, equivalent or tightened). */
  agreeing: number;
}

/** Predicates that describe a term for people (or record its history) rather than constrain its meaning. */
const ANNOTATION_NS = [NS.skos, NS.dcterms, NS.dc, NS.prov, NS.vann, NS.schema, 'http://www.w3.org/ns/adms#'];
const ANNOTATION_P = new Set([NS.rdfs + 'label', NS.rdfs + 'comment', NS.rdfs + 'seeAlso', NS.rdfs + 'isDefinedBy', NS.owl + 'versionInfo', NS.owl + 'deprecated']);
const isAnnotation = (p: string) => ANNOTATION_P.has(p) || ANNOTATION_NS.some((ns) => p.startsWith(ns));
const SUBCLASS = NS.rdfs + 'subClassOf';

interface TermFacts {
  kind: string;
  label?: string;
  hash: string;
  logical: Set<string>;
}

/** Every declared term of a graph with its hash and logical facts. */
async function factsOf(g: OntologyGraph, reasoner?: ReasonerResult): Promise<Map<string, TermFacts>> {
  const store = g.store;
  const v = g.view();
  // Anonymous axioms (e.g. owl:AllDisjointClasses) in canonical form, found once.
  const referenced = new Set<string>();
  for (const q of store.getQuads(null, null, null, null)) if (q.object.termType === 'BlankNode') referenced.add(q.object.value);
  const anon = store.getQuads(null, null, null, null).filter((q) => q.subject.termType === 'BlankNode' && !referenced.has(q.subject.value)).map((q) => canonical(store, q.subject as Term));
  const anonSet = [...new Set(anon)];

  // Entailed named superclasses: asserted named edges plus the reasoner's, closed transitively.
  const direct = new Map<string, Set<string>>();
  const edge = (a: string, b: string) => (a !== b ? (direct.get(a) ?? direct.set(a, new Set()).get(a)!).add(b) : undefined);
  for (const q of store.getQuads(null, SUBCLASS, null, null)) if (q.subject.termType === 'NamedNode' && q.object.termType === 'NamedNode') edge(q.subject.value, q.object.value);
  for (const [a, b] of reasoner?.inferredSubClassOf ?? []) edge(a, b);
  const supers = (c: string) => {
    const out = new Set<string>();
    for (const todo = [...(direct.get(c) ?? [])]; todo.length; ) {
      const x = todo.pop()!;
      if (x === NS.owl + 'Thing' || out.has(x)) continue;
      out.add(x);
      todo.push(...(direct.get(x) ?? []));
    }
    return out;
  };

  const out = new Map<string, TermFacts>();
  const terms = [...v.classes, ...v.objectProperties, ...v.datatypeProperties, ...v.annotationProperties, ...v.individuals];
  for (const t of terms) {
    if (t.iri === g.ontologyIRI || out.has(t.iri)) continue;
    const all: string[] = [];
    const logical = new Set<string>();
    for (const q of store.getQuads(t.iri, null, null, null)) {
      const line = `<${q.predicate.value}> ${canonical(store, q.object as Term)}`;
      all.push(line);
      if (isAnnotation(q.predicate.value)) continue;
      // Named superclasses are compared through the entailed set below, so a restated hierarchy isn't a difference.
      if (q.predicate.value === SUBCLASS && q.object.termType === 'NamedNode') continue;
      logical.add(line);
    }
    const needle = `<${t.iri}>`;
    for (const a of anonSet) if (a.includes(needle)) (all.push(a), logical.add(a));
    if (t.kind === 'class') for (const s of supers(t.iri)) logical.add(`<${SUBCLASS}> <${s}>`);
    out.set(t.iri, { kind: t.kind, label: t.label, hash: await sha256Hex([...new Set(all)].sort().join('\n')), logical });
  }
  return out;
}

const pretty = (s: string) => s.replace(/<([^>\s]+)>/g, (_, iri: string) => iri.replace(/^.*[#/]/, ''));

/** Compares B against A, term by term (see the module comment). Pass each side's reasoner result to count entailed superclasses. */
export async function compareGraphs(a: OntologyGraph, b: OntologyGraph, opts: { reasonerA?: ReasonerResult; reasonerB?: ReasonerResult } = {}): Promise<GraphComparison> {
  const [fa, fb] = await Promise.all([factsOf(a, opts.reasonerA), factsOf(b, opts.reasonerB)]);
  const terms: TermComparison[] = [];
  for (const [iri, x] of fa) {
    const y = fb.get(iri);
    if (!y) {
      terms.push({ iri, kind: x.kind, label: x.label, relation: 'only-a', onlyInB: [], onlyInA: [] });
      continue;
    }
    const onlyInB = [...y.logical].filter((f) => !x.logical.has(f)).sort();
    const onlyInA = [...x.logical].filter((f) => !y.logical.has(f)).sort();
    const relation: TermRelation =
      x.hash === y.hash ? 'same' : !onlyInA.length && !onlyInB.length ? 'equivalent' : !onlyInA.length ? 'tightened' : !onlyInB.length ? 'loosened' : 'conflict';
    terms.push({ iri, kind: y.kind, label: y.label ?? x.label, relation, onlyInB: onlyInB.map(pretty), onlyInA: onlyInA.map(pretty) });
  }
  for (const [iri, y] of fb) if (!fa.has(iri)) terms.push({ iri, kind: y.kind, label: y.label, relation: 'only-b', onlyInB: [], onlyInA: [] });
  terms.sort((p, q) => p.iri.localeCompare(q.iri));
  const counts = Object.fromEntries((['same', 'equivalent', 'tightened', 'loosened', 'conflict', 'only-a', 'only-b'] as TermRelation[]).map((r) => [r, 0])) as Record<TermRelation, number>;
  for (const t of terms) counts[t.relation]++;
  const shared = terms.length - counts['only-a'] - counts['only-b'];
  return { terms, counts, shared, agreeing: counts.same + counts.equivalent + counts.tightened };
}
