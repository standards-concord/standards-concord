/**
 * Reasoning.
 *
 * `structuralReasoner` is a fast, incomplete, pure-TypeScript check used for
 * instant feedback while editing: it computes the told subclass closure and finds
 * the common sources of incoherence (disjoint ancestors, existential restrictions
 * clashing with domain/range + disjointness) and inconsistency (individuals in
 * disjoint or unsatisfiable classes, functional data properties with two values).
 *
 * `owlReasoner` is the one entry point for complete OWL 2 DL reasoning. It runs
 * sparq's hypertableau reasoner (`checkOwlDl`, compiled to WebAssembly), so the
 * same code runs on the server and in the browser. sparq is fail-closed: when it
 * cannot decide (a construct outside OWL 2 DL, or the work budget ran out), the
 * result falls back to the structural checks and says why, with `available: false`.
 */
import type { OwlProfileNote, ReasonerResult } from './types.js';
import { NS, OWL2_DATATYPES, RDF_TYPE, compactIRI, isBuiltinDatatype } from './ns.js';
import { P, T } from './graph.js';
import type { OntologyGraph } from './graph.js';
import { cloneStore, literal, nn, objects, readList } from './rdf.js';
import type { Store, Term } from 'n3';
import { writeNTriples } from './turtle.js';

export function structuralReasoner(graph: OntologyGraph): ReasonerResult {
  const t0 = Date.now();
  const s = graph.store;
  const c = (iri: string) => compactIRI(iri, graph.prefixes);
  const v = graph.view();
  const notes: string[] = [];

  // Told hierarchy (named superclasses + named equivalences + named conjuncts of definitions).
  const parents = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    if (!parents.has(a)) parents.set(a, new Set());
    parents.get(a)!.add(b);
  };
  for (const k of v.classes) {
    k.superClasses.forEach((sc) => link(k.iri, sc));
    k.equivalentClasses.forEach((e) => { link(k.iri, e); link(e, k.iri); });
    for (const e of objects(s, k.iri, P.equivalentClass)) {
      for (const head of e.termType === 'BlankNode' ? objects(s, e, NS.owl + 'intersectionOf') : []) {
        for (const m of readList(s, head) ?? []) if (m.termType === 'NamedNode') link(k.iri, m.value);
      }
    }
  }
  const asserted = new Map([...parents].map(([k, vs]) => [k, new Set(vs)]));

  // Inference from existential restrictions + domain: C ⊑ ∃p.F and domain(p) = D ⟹ C ⊑ D.
  const domains = new Map<string, string[]>();
  const ranges = new Map<string, string[]>();
  for (const p of [...v.objectProperties, ...v.datatypeProperties]) {
    domains.set(p.iri, p.domain);
    ranges.set(p.iri, p.range);
  }
  const existentials: { cls: string; prop: string; filler?: string }[] = [];
  for (const k of v.classes) {
    for (const r of k.restrictions) {
      const forces = r.kind === 'some' || r.kind === 'value' || ((r.kind === 'min' || r.kind === 'exactly') && (r.cardinality ?? 0) >= 1);
      if (!forces) continue;
      existentials.push({ cls: k.iri, prop: r.property, filler: r.kind === 'value' ? undefined : r.filler });
      for (const d of domains.get(r.property) ?? []) link(k.iri, d);
    }
  }

  const ancestors = (x: string): Set<string> => {
    const out = new Set<string>([x]);
    const stack = [x];
    while (stack.length) for (const p of parents.get(stack.pop()!) ?? []) if (!out.has(p)) { out.add(p); stack.push(p); }
    return out;
  };
  const toldAncestors = (x: string): Set<string> => {
    const out = new Set<string>([x]);
    const stack = [x];
    while (stack.length) for (const p of asserted.get(stack.pop()!) ?? []) if (!out.has(p)) { out.add(p); stack.push(p); }
    return out;
  };

  // Disjointness pairs.
  const disjoint = new Set<string>();
  const pair = (a: string, b: string) => (a < b ? `${a} ${b}` : `${b} ${a}`);
  for (const k of v.classes) for (const d of k.disjointWith) disjoint.add(pair(k.iri, d));
  const isDisjoint = (a: string, b: string) => a !== b && disjoint.has(pair(a, b));
  const clash = (set: Set<string>): [string, string] | undefined => {
    if (set.has(T.Nothing)) return [T.Nothing, T.Nothing];
    const xs = [...set];
    for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) if (isDisjoint(xs[i], xs[j])) return [xs[i], xs[j]];
    return undefined;
  };

  // Unsatisfiable classes: disjoint ancestors, or an existential whose filler clashes with the range.
  const unsat = new Map<string, string>();
  for (const k of v.classes) {
    const anc = ancestors(k.iri);
    const hit = clash(anc);
    if (hit) unsat.set(k.iri, hit[0] === T.Nothing ? `${c(k.iri)} is a subclass of owl:Nothing` : `${c(k.iri)} is a subclass of disjoint classes ${c(hit[0])} and ${c(hit[1])}`);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of existentials) {
      if (unsat.has(e.cls) || !e.filler || isBuiltinDatatype(e.filler)) continue;
      const fillerTypes = ancestors(e.filler);
      for (const r of ranges.get(e.prop) ?? []) fillerTypes.add(r);
      const expanded = new Set([...fillerTypes].flatMap((x) => [...ancestors(x)]));
      const hit = clash(expanded);
      if (unsat.has(e.filler) || hit) {
        unsat.set(e.cls, unsat.has(e.filler)
          ? `${c(e.cls)} requires a ${c(e.prop)} value in unsatisfiable class ${c(e.filler)}`
          : `${c(e.cls)} requires a ${c(e.prop)} value that is both ${c(hit![0])} and ${c(hit![1])} (filler vs range)`);
        changed = true;
      }
    }
    // Subclasses of unsatisfiable classes are unsatisfiable.
    for (const k of v.classes) {
      if (unsat.has(k.iri)) continue;
      const bad = [...ancestors(k.iri)].find((a) => unsat.has(a));
      if (bad) { unsat.set(k.iri, `${c(k.iri)} is a subclass of unsatisfiable ${c(bad)}`); changed = true; }
    }
  }

  // Individuals: told types + domain/range typing; check for disjoint or unsatisfiable types.
  let consistent = true;
  const indTypes = new Map<string, Set<string>>();
  const addType = (i: string, t: string) => {
    if (!indTypes.has(i)) indTypes.set(i, new Set());
    indTypes.get(i)!.add(t);
  };
  const classSet = new Set(v.classes.map((k) => k.iri));
  for (const q of s.getQuads(null, null, null, null)) {
    if (q.subject.termType !== 'NamedNode') continue;
    if (q.predicate.value === RDF_TYPE && classSet.has(q.object.value)) addType(q.subject.value, q.object.value);
    for (const d of domains.get(q.predicate.value) ?? []) addType(q.subject.value, d);
    if (q.object.termType === 'NamedNode') for (const r of ranges.get(q.predicate.value) ?? []) if (classSet.has(r)) addType(q.object.value, r);
  }
  for (const [ind, types] of [...indTypes].sort(([a], [b]) => a.localeCompare(b))) {
    const all = new Set([...types].flatMap((t) => [...ancestors(t)]));
    const hit = clash(all);
    const badType = [...all].find((t) => unsat.has(t));
    if (hit) { consistent = false; notes.push(`individual ${c(ind)} is an instance of disjoint classes ${c(hit[0])} and ${c(hit[1])}`); }
    else if (badType) { consistent = false; notes.push(`individual ${c(ind)} is an instance of unsatisfiable class ${c(badType)}`); }
  }
  // Functional datatype properties with two distinct literal values.
  for (const p of v.datatypeProperties.filter((x) => x.characteristics.includes('functional'))) {
    const bySubject = new Map<string, Set<string>>();
    for (const q of s.getQuads(null, null, null, null)) {
      if (q.predicate.value !== p.iri || q.object.termType !== 'Literal') continue;
      const key = q.subject.value;
      if (!bySubject.has(key)) bySubject.set(key, new Set());
      bySubject.get(key)!.add(`${q.object.value}^^${(q.object as any).datatype?.value}`);
    }
    for (const [subj, vals] of bySubject) {
      if (vals.size > 1) { consistent = false; notes.push(`${c(subj)} has ${vals.size} values for functional property ${c(p.iri)}`); }
    }
  }

  // Cycles in the told hierarchy imply equivalence (reported, not inconsistent).
  for (const k of v.classes) {
    for (const sc of k.superClasses) {
      if (sc !== k.iri && toldAncestors(sc).has(k.iri) && k.iri < sc) notes.push(`subClassOf cycle: ${c(k.iri)} and ${c(sc)} are inferred equivalent`);
    }
  }

  // Inferred subsumptions that are not told (from domains of existential restrictions).
  const inferred: [string, string][] = [];
  for (const k of v.classes) {
    if (unsat.has(k.iri)) continue;
    const told = toldAncestors(k.iri);
    for (const a of ancestors(k.iri)) if (!told.has(a) && a !== T.Thing && classSet.has(a)) inferred.push([k.iri, a]);
  }
  for (const why of unsat.values()) notes.push(why);

  return {
    engine: 'structural',
    available: true,
    consistent,
    unsatisfiable: [...unsat.keys()].sort(),
    inferredSubClassOf: inferred.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])),
    explanation: notes.length ? notes.join('\n') : undefined,
    durationMs: Date.now() - t0,
  };
}

/* ------------------------------------------------------------------------ */
/* OWL 2 DL reasoner: sparq (WebAssembly)                                     */
/* ------------------------------------------------------------------------ */

export interface OwlReasonerOptions {
  /** sparq's deterministic work budget. Omitted members keep sparq's defaults. */
  budget?: { maxSteps?: number; maxNodes?: number };
}

/** The parts of `@sparq-org/sparq`'s `checkOwlDl` result that Concord reads. */
interface SparqOwlDlResult {
  consistent: boolean | 'unknown';
  reason: null | { kind: string; construct?: string; detail?: string; triples?: string[]; violations?: { kind: string; detail: string }[]; imports?: string[] };
  profile: { dl: boolean | 'unknown'; violations: { kind: string; detail: string; triples: string[] }[]; unchecked: { rule: string }[] };
  unsatisfiable: string[];
  inferredSubClassOf: [string, string][];
  classification: 'complete' | { unknown: string } | null;
}
type CheckOwlDl = (tbox: string, abox?: string, options?: { format?: 'ntriples'; budget?: OwlReasonerOptions['budget'] }) => Promise<SparqOwlDlResult>;

let sparqLoad: Promise<CheckOwlDl> | undefined;
/** Loads sparq's reasoner once. Its WebAssembly bundle is only fetched on first use. */
function loadSparq(): Promise<CheckOwlDl> {
  sparqLoad ??= import('@sparq-org/sparq').then((m) => {
    const fn = (m as unknown as { checkOwlDl?: CheckOwlDl }).checkOwlDl;
    if (typeof fn !== 'function') throw new Error('this @sparq-org/sparq has no checkOwlDl (it needs 0.1.7 or later)');
    return fn;
  });
  sparqLoad.catch(() => { sparqLoad = undefined; });
  return sparqLoad;
}

/** Why sparq gave no verdict, in a sentence, naming the first offending triple. */
function undecidedReason(r: SparqOwlDlResult, g: OntologyGraph): string {
  const why = r.reason;
  const c = (nt: string) => nt.replace(/<([^>]+)>/g, (_, iri: string) => compactIRI(iri, g.prefixes)).replace(/ \.$/, '');
  const first = why?.triples?.[0] ? ` (for example: ${c(why.triples[0])})` : '';
  switch (why?.kind) {
    case 'OutOfFragment': return `sparq does not decide ${why.construct ?? 'one of the constructs used'}${first}`;
    case 'NotInDl': return `the ontology is outside OWL 2 DL: ${(why.violations ?? []).map((v) => v.detail).join('; ')}`;
    case 'ResourceBudget': return 'sparq ran out of its work budget before reaching a verdict';
    case 'DatatypeUnknown': return `sparq could not decide a datatype question${first}`;
    case 'Unconfirmed': return 'sparq found a candidate model with nominals that it could not confirm';
    case 'ImportsNotLoaded': return `owl:imports targets were not loaded: ${(why.imports ?? []).join(', ')}`;
    default: return `sparq could not read the graph as an OWL 2 ontology (${why?.kind ?? 'unknown'}${why?.detail ? `: ${why.detail}` : ''})`;
  }
}

/**
 * Complete OWL 2 DL reasoning with sparq: consistency, unsatisfiable classes and the
 * inferred (direct, not asserted) subclass relations. Works in Node and in the browser.
 */
export async function owlReasoner(graph: OntologyGraph, opts: OwlReasonerOptions = {}): Promise<ReasonerResult> {
  const t0 = now();
  const structural = () => structuralReasoner(graph);
  const fallback = (error: string, extra: Partial<ReasonerResult> = {}): ReasonerResult => ({ ...structural(), available: false, error, ...extra, durationMs: Math.round(now() - t0) });
  let checkOwlDl: CheckOwlDl;
  try {
    checkOwlDl = await loadSparq();
  } catch (e) {
    return fallback(`the sparq reasoner could not load: ${(e as Error).message}`);
  }
  const { store: dlStore, replaced } = owl2DatatypesOnly(graph);
  const caveat = replaced.length
    ? `Datatypes outside the OWL 2 datatype map were treated as rdfs:Literal: ${replaced.map((d) => compactIRI(d, graph.prefixes)).join(', ')}.`
    : undefined;
  let r: SparqOwlDlResult;
  const tCheck = now();
  try {
    r = await checkOwlDl(writeNTriples(dlStore), undefined, { format: 'ntriples', ...(opts.budget ? { budget: opts.budget } : {}) });
  } catch (e) {
    return fallback(`sparq failed: ${(e as Error).message}`);
  }
  const checkMs = Math.round((now() - tCheck) * 10) / 10;
  const profile = profileNotes(r, graph);

  if (r.consistent === 'unknown') return fallback(undecidedReason(r, graph), { profile });
  if (r.consistent === false) {
    // sparq gives the verdict; the structural checks often name the clash.
    const s = structural();
    return {
      engine: 'sparq', available: true, consistent: false, unsatisfiable: [], inferredSubClassOf: [],
      explanation: ['The ontology is inconsistent: no interpretation satisfies all its axioms (typically an individual in disjoint classes or in an unsatisfiable class, or a value that breaks a range, cardinality or key).', !s.consistent && s.explanation ? `Likely cause: ${s.explanation}` : undefined, caveat].filter(Boolean).join('\n'),
      profile, durationMs: Math.round(now() - t0), checkMs,
    };
  }
  if (r.classification !== 'complete') {
    const kind = r.classification && typeof r.classification === 'object' ? r.classification.unknown : 'unknown';
    // Consistency is decided; only the class-by-class tests are missing.
    return fallback(`sparq showed the ontology is consistent but could not finish classifying it (${kind === 'ResourceBudget' ? 'it ran out of its work budget' : kind})`, { consistent: true, profile });
  }
  const unsat = [...r.unsatisfiable].filter((c) => c !== T.Nothing).sort();
  const s = unsat.length ? structural() : undefined;
  return {
    engine: 'sparq', available: true, consistent: true,
    unsatisfiable: unsat,
    inferredSubClassOf: directInferred(graph, r.inferredSubClassOf, new Set(unsat)),
    explanation: [
      unsat.length ? `${unsat.length} class(es) are unsatisfiable (equivalent to owl:Nothing), typically because they are subclasses of disjoint classes or carry contradictory restrictions.` : undefined,
      ...(s?.explanation?.split('\n').filter((l) => unsat.some((u) => l.startsWith(compactIRI(u, graph.prefixes) + ' '))) ?? []),
      caveat,
    ].filter(Boolean).join('\n') || undefined,
    profile, durationMs: Math.round(now() - t0), checkMs,
  };
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** OWL 2 DL profile violations sparq reported, other than ones caused by our datatype rewrite. */
function profileNotes(r: SparqOwlDlResult, g: OntologyGraph): OwlProfileNote[] | undefined {
  const c = (iri: string) => compactIRI(iri, g.prefixes);
  const notes = r.profile.violations.map((v) => ({ kind: v.kind, detail: v.detail.replace(/https?:\/\/[^\s,;)]+/g, (iri) => c(iri)) }));
  const seen = new Set<string>();
  return notes.length ? notes.filter((n) => !seen.has(n.detail) && !!seen.add(n.detail)) : undefined;
}

/**
 * Reduces sparq's entailed subsumptions (every entailed pair that is not asserted) to the
 * ones an editor wants to see: direct superclasses of each class, minus those that already
 * follow from the asserted named hierarchy.
 */
function directInferred(graph: OntologyGraph, entailed: [string, string][], unsat: Set<string>): [string, string][] {
  const s = graph.store;
  const told = new Map<string, Set<string>>();
  const link = (m: Map<string, Set<string>>, a: string, b: string) => {
    if (a === b) return;
    if (!m.has(a)) m.set(a, new Set());
    m.get(a)!.add(b);
  };
  for (const q of s.getQuads(null, P.subClassOf, null, null)) if (q.subject.termType === 'NamedNode' && q.object.termType === 'NamedNode') link(told, q.subject.value, q.object.value);
  for (const q of s.getQuads(null, P.equivalentClass, null, null)) {
    if (q.subject.termType === 'NamedNode' && q.object.termType === 'NamedNode') { link(told, q.subject.value, q.object.value); link(told, q.object.value, q.subject.value); }
  }
  const closure = (m: Map<string, Set<string>>, x: string) => {
    const out = new Set<string>();
    const stack = [x];
    while (stack.length) for (const p of m.get(stack.pop()!) ?? []) if (!out.has(p)) { out.add(p); stack.push(p); }
    out.delete(x);
    return out;
  };
  const all = new Map<string, Set<string>>();
  for (const [a, set] of told) for (const b of set) link(all, a, b);
  for (const [a, b] of entailed) link(all, a, b);
  const sup = new Map<string, Set<string>>();
  const supOf = (x: string) => { let v = sup.get(x); if (!v) { v = closure(all, x); sup.set(x, v); } return v; };
  const equiv = (a: string, b: string) => supOf(a).has(b) && supOf(b).has(a);
  const out: [string, string][] = [];
  for (const a of new Set(entailed.map(([x]) => x))) {
    if (unsat.has(a)) continue;
    const ups = [...supOf(a)].filter((b) => b !== T.Thing && !equiv(a, b));
    const toldUp = closure(told, a);
    for (const b of ups) {
      if (toldUp.has(b)) continue;
      const indirect = ups.some((m) => m !== b && !equiv(m, b) && supOf(m).has(b));
      if (!indirect) out.push([a, b]);
    }
  }
  return out.sort((x, y) => x[0].localeCompare(y[0]) || x[1].localeCompare(y[1]));
}

/**
 * Copy of the graph in which datatypes outside the OWL 2 datatype map (e.g. xsd:date)
 * are replaced by rdfs:Literal in axioms, and such literals in assertions become
 * plain strings, so that the DL reasoner decides the ontology instead of abstaining.
 * Annotation values are rewritten too (they never affect reasoning), but are not
 * reported, so that a dated ontology header doesn't add a caveat.
 */
function owl2DatatypesOnly(graph: OntologyGraph): { store: Store; replaced: string[] } {
  const store = cloneStore(graph.store);
  const replaced = new Set<string>();
  const annotationProps = new Set(graph.view().annotationProperties.map((p) => p.iri));
  const isAnnotation = (p: string) => annotationProps.has(p) || p.startsWith(NS.dcterms) || p.startsWith(NS.skos) || p.startsWith(NS.rdfs);
  for (const q of store.getQuads(null, null, null, null)) {
    const o = q.object as Term;
    const p = q.predicate.value;
    if (o.termType === 'NamedNode' && isBuiltinDatatype(o.value) && !OWL2_DATATYPES.has(o.value) && p !== RDF_TYPE) {
      store.removeQuad(q);
      store.addQuad(q.subject as any, q.predicate as any, nn(NS.rdfs + 'Literal'));
      replaced.add(o.value);
    } else if (o.termType === 'Literal') {
      const dt = (o as any).datatype?.value as string | undefined;
      if (dt && isBuiltinDatatype(dt) && !OWL2_DATATYPES.has(dt)) {
        store.removeQuad(q);
        store.addQuad(q.subject as any, q.predicate as any, literal(o.value));
        if (!isAnnotation(p)) replaced.add(dt);
      }
    }
  }
  return { store, replaced: [...replaced].sort() };
}
