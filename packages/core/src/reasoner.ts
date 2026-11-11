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
import type { Literal, Quad, Store, Term } from 'n3';
import { writeNTriples } from './turtle.js';
import { storeRevision } from './storeRevision.js';

/** The ontology-only half of the structural reasoner: its classes, hierarchy, disjointness and unsatisfiable classes. */
interface TBoxAnalysis {
  c: (iri: string) => string;
  classIris: string[];
  classSet: Set<string>;
  domains: Map<string, string[]>;
  ranges: Map<string, string[]>;
  functionalDatatype: string[];
  ancestors: (x: string) => Set<string>;
  clash: (set: Set<string>) => [string, string] | undefined;
  unsat: Map<string, string>;
  /** Notes about the hierarchy (cycles, then why each class is unsatisfiable), in the order the report lists them. */
  tboxNotes: string[];
  inferred: [string, string][];
}

function analyseTBox(graph: OntologyGraph): TBoxAnalysis {
  const s = graph.store;
  const c = (iri: string) => compactIRI(iri, graph.prefixes);
  const v = graph.view();

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

  const ancestorCache = new Map<string, Set<string>>();
  const ancestors = (x: string): Set<string> => {
    const hit = ancestorCache.get(x);
    if (hit) return new Set(hit);
    const out = new Set<string>([x]);
    const stack = [x];
    while (stack.length) for (const p of parents.get(stack.pop()!) ?? []) if (!out.has(p)) { out.add(p); stack.push(p); }
    ancestorCache.set(x, out);
    return new Set(out);
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
    // Sorted, so the pair named doesn't depend on the order the triples were read in.
    const xs = [...set].sort();
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

  const classSet = new Set(v.classes.map((k) => k.iri));
  const tboxNotes: string[] = [];
  // Cycles in the told hierarchy imply equivalence (reported, not inconsistent).
  for (const k of v.classes) {
    for (const sc of k.superClasses) {
      if (sc !== k.iri && toldAncestors(sc).has(k.iri) && k.iri < sc) tboxNotes.push(`subClassOf cycle: ${c(k.iri)} and ${c(sc)} are inferred equivalent`);
    }
  }
  // Inferred subsumptions that are not told (from domains of existential restrictions).
  const inferred: [string, string][] = [];
  for (const k of v.classes) {
    if (unsat.has(k.iri)) continue;
    const told = toldAncestors(k.iri);
    for (const a of ancestors(k.iri)) if (!told.has(a) && a !== T.Thing && classSet.has(a)) inferred.push([k.iri, a]);
  }
  for (const why of unsat.values()) tboxNotes.push(why);

  return {
    c,
    classIris: v.classes.map((k) => k.iri),
    classSet,
    domains,
    ranges,
    functionalDatatype: v.datatypeProperties.filter((x) => x.characteristics.includes('functional')).map((x) => x.iri),
    ancestors,
    clash,
    unsat,
    tboxNotes,
    inferred: inferred.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])),
  };
}

/** Individuals: told types + domain/range typing, checked for disjoint or unsatisfiable types; functional datatype properties with two values. */
function checkIndividuals(t: TBoxAnalysis, quads: Iterable<Quad>): { consistent: boolean; notes: string[] } {
  const { c, classSet, domains, ranges, ancestors, clash, unsat } = t;
  let consistent = true;
  const notes: string[] = [];
  const indTypes = new Map<string, Set<string>>();
  const addType = (i: string, ty: string) => {
    if (!indTypes.has(i)) indTypes.set(i, new Set());
    indTypes.get(i)!.add(ty);
  };
  const functional = new Set(t.functionalDatatype);
  const fnValues = new Map<string, Map<string, Set<string>>>();
  for (const q of quads) {
    if (functional.has(q.predicate.value) && q.object.termType === 'Literal') {
      let bySubject = fnValues.get(q.predicate.value);
      if (!bySubject) fnValues.set(q.predicate.value, (bySubject = new Map()));
      const key = q.subject.value;
      if (!bySubject.has(key)) bySubject.set(key, new Set());
      bySubject.get(key)!.add(`${q.object.value}^^${(q.object as Literal).datatype?.value}`);
    }
    if (q.subject.termType !== 'NamedNode') continue;
    if (q.predicate.value === RDF_TYPE && classSet.has(q.object.value)) addType(q.subject.value, q.object.value);
    for (const d of domains.get(q.predicate.value) ?? []) addType(q.subject.value, d);
    if (q.object.termType === 'NamedNode') for (const r of ranges.get(q.predicate.value) ?? []) if (classSet.has(r)) addType(q.object.value, r);
  }
  for (const [ind, types] of [...indTypes].sort(([a], [b]) => a.localeCompare(b))) {
    const all = new Set([...types].flatMap((ty) => [...ancestors(ty)]));
    const hit = clash(all);
    const badType = [...all].find((ty) => unsat.has(ty));
    if (hit) { consistent = false; notes.push(`individual ${c(ind)} is an instance of disjoint classes ${c(hit[0])} and ${c(hit[1])}`); }
    else if (badType) { consistent = false; notes.push(`individual ${c(ind)} is an instance of unsatisfiable class ${c(badType)}`); }
  }
  for (const p of t.functionalDatatype) {
    for (const [subj, vals] of fnValues.get(p) ?? []) {
      if (vals.size > 1) { consistent = false; notes.push(`${c(subj)} has ${vals.size} values for functional property ${c(p)}`); }
    }
  }
  return { consistent, notes };
}

export function structuralReasoner(graph: OntologyGraph): ReasonerResult {
  const t0 = Date.now();
  const t = analyseTBox(graph);
  const { consistent, notes } = checkIndividuals(t, graph.store.getQuads(null, null, null, null));
  notes.push(...t.tboxNotes);
  return {
    engine: 'structural',
    available: true,
    consistent,
    unsatisfiable: [...t.unsat.keys()].sort(),
    inferredSubClassOf: t.inferred,
    explanation: notes.length ? notes.join('\n') : undefined,
    durationMs: Date.now() - t0,
  };
}

/** Namespaces whose terms in data can change what the ontology says (classes, hierarchy, domains, characteristics, lists). */
const SCHEMA_NAMESPACES = [NS.rdf, NS.rdfs, NS.owl];
/** RDF and RDFS properties that only annotate (labels, comments, links), which data uses all the time. */
const ANNOTATIONS = new Set([NS.rdfs + 'label', NS.rdfs + 'comment', NS.rdfs + 'seeAlso', NS.rdfs + 'isDefinedBy', NS.rdf + 'value']);

/**
 * structuralReasoner over the ontology together with instance data, giving the same verdict as running it
 * on a merged copy. Data that only states facts about individuals can't change the ontology's hierarchy,
 * so that half is worked out once per ontology and kept; data that uses RDF, RDFS or OWL vocabulary
 * (beyond rdf:type to the ontology's own classes) is merged and reasoned over in full.
 */
export function dataConsistency(graph: OntologyGraph, data: Quad[]): Pick<ReasonerResult, 'consistent' | 'explanation'> {
  const schemaLike = data.some(
    (q) =>
      (q.predicate.value !== RDF_TYPE && !ANNOTATIONS.has(q.predicate.value) && SCHEMA_NAMESPACES.some((ns) => q.predicate.value.startsWith(ns))) ||
      (q.predicate.value === RDF_TYPE && SCHEMA_NAMESPACES.some((ns) => q.object.value.startsWith(ns))),
  );
  if (schemaLike) {
    const merged = graph.clone();
    merged.store.addQuads(data);
    return structuralReasoner(merged);
  }
  // Worked out again whenever the ontology changes at all (a replaced triple keeps the size the same).
  const revision = storeRevision(graph.store);
  let hit = tboxes.get(graph);
  if (!hit || hit.revision !== revision) tboxes.set(graph, (hit = { revision, analysis: analyseTBox(graph) }));
  const t = hit.analysis;
  // A triple in both counts as one either way: types and functional values are collected into sets.
  const all = [...graph.store.getQuads(null, null, null, null), ...data];
  const { consistent, notes } = checkIndividuals(t, all);
  notes.push(...t.tboxNotes);
  return { consistent, explanation: notes.length ? notes.join('\n') : undefined };
}
const tboxes = new WeakMap<OntologyGraph, { revision: number; analysis: TBoxAnalysis }>();

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
  const fallback = (error: string, extra: Partial<ReasonerResult> = {}): ReasonerResult => ({ ...structural(), available: false, checked: 'none', error, ...extra, durationMs: Math.round(now() - t0) });
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
      engine: 'sparq', available: true, checked: 'complete', consistent: false, unsatisfiable: [], inferredSubClassOf: [],
      explanation: ['The ontology is inconsistent: no interpretation satisfies all its axioms (typically an individual in disjoint classes or in an unsatisfiable class, or a value that breaks a range, cardinality or key).', !s.consistent && s.explanation ? `Likely cause: ${s.explanation}` : undefined, caveat].filter(Boolean).join('\n'),
      profile, durationMs: Math.round(now() - t0), checkMs,
    };
  }
  if (r.classification !== 'complete') {
    const kind = r.classification && typeof r.classification === 'object' ? r.classification.unknown : 'unknown';
    // Consistency is decided; only the class-by-class tests are missing. Report nothing about
    // classes rather than the structural guesses, which would sit oddly next to "consistent".
    return fallback(`sparq showed the ontology is consistent but could not finish checking every class (${kind === 'ResourceBudget' ? 'it ran out of its work budget' : kind})`, {
      consistent: true,
      checked: 'consistency',
      unsatisfiable: [],
      inferredSubClassOf: [],
      explanation: undefined,
      profile,
    });
  }
  const unsat = [...r.unsatisfiable].filter((c) => c !== T.Nothing).sort();
  const s = unsat.length ? structural() : undefined;
  return {
    engine: 'sparq', available: true, checked: 'complete', consistent: true,
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
 * Reduces sparq's entailed subsumptions to the ones an editor wants to see: direct
 * superclasses of each class that don't already follow from the asserted named hierarchy.
 *
 * sparq returns every entailed pair that isn't asserted, so together with the asserted edges
 * `sup` is the whole (transitively closed) subsumption relation and needs no closure here.
 * A pair implied through an asserted parent is dropped in O(parents); only the remaining,
 * genuinely new pairs get the O(|sup(a)|) directness test. Linear in sparq's output for
 * ordinary hierarchies, where nearly every entailed pair follows from an asserted parent.
 * @param work Accumulates one step per entailed pair, told edge examined and candidate intermediate examined.
 */
export function directInferred(graph: OntologyGraph, entailed: [string, string][], unsat: Set<string>, work?: { steps: number }): [string, string][] {
  let steps = 0;
  // Classes become small integers, so the hot loop hashes numbers rather than long IRIs.
  const ids = new Map<string, number>();
  const iris: string[] = [];
  const id = (iri: string) => {
    let n = ids.get(iri);
    if (n === undefined) { n = iris.length; ids.set(iri, n); iris.push(iri); }
    return n;
  };
  const sup: Set<number>[] = [];
  const told: number[][] = [];
  const link = (a: number, b: number, asserted: boolean) => {
    if (a === b) return;
    (sup[a] ??= new Set()).add(b);
    if (asserted) (told[a] ??= []).push(b);
  };
  const s = graph.store;
  for (const q of s.getQuads(null, P.subClassOf, null, null)) {
    if (q.subject.termType === 'NamedNode' && q.object.termType === 'NamedNode') link(id(q.subject.value), id(q.object.value), true);
  }
  for (const q of s.getQuads(null, P.equivalentClass, null, null)) {
    if (q.subject.termType !== 'NamedNode' || q.object.termType !== 'NamedNode') continue;
    const [a, b] = [id(q.subject.value), id(q.object.value)];
    link(a, b, true);
    link(b, a, true);
  }
  const pairs = new Int32Array(entailed.length * 2);
  entailed.forEach(([a, b], k) => { const x = id(a), y = id(b); pairs[2 * k] = x; pairs[2 * k + 1] = y; link(x, y, false); });
  const has = (a: number, b: number) => sup[a]?.has(b) ?? false;
  const equiv = (a: number, b: number) => has(a, b) && has(b, a);
  const thing = id(T.Thing);
  /** a ⊑ b follows from an asserted edge out of a (or out of a class asserted equivalent to a). */
  const toldImplied = (a: number, b: number) => {
    let stack: number[] | undefined;
    let seen: Set<number> | undefined;
    let x: number | undefined = a;
    while (x !== undefined) {
      for (const p of told[x] ?? []) {
        steps++;
        // Back at a through an equivalence: that's a's own (inferred) parent, not a told one.
        if (p === a) continue;
        if (p === b) return true;
        if (has(p, b)) {
          if (!equiv(p, a)) return true;
          if (!(seen ??= new Set([a])).has(p)) { seen.add(p); (stack ??= []).push(p); }
        }
      }
      x = stack?.pop();
    }
    return false;
  };
  const out: [string, string][] = [];
  for (let k = 0; k < entailed.length; k++) {
    steps++;
    const a = pairs[2 * k], b = pairs[2 * k + 1];
    if (a === b || b === thing || toldImplied(a, b) || equiv(a, b) || unsat.has(iris[a])) continue;
    // Direct: no strict intermediate between a and b.
    let direct = true;
    for (const m of sup[a]!) {
      steps++;
      if (m !== b && has(m, b) && !equiv(m, a) && !equiv(m, b)) { direct = false; break; }
    }
    if (direct) out.push([iris[a], iris[b]]);
  }
  if (work) work.steps += steps;
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
  const view = graph.view();
  const annotationProps = new Set(view.annotationProperties.map((p) => p.iri));
  // A property declared as a data or object property is logical even in a vocabulary namespace.
  const logicalProps = new Set([...view.datatypeProperties, ...view.objectProperties].map((p) => p.iri));
  const isAnnotation = (p: string) => !logicalProps.has(p) && (annotationProps.has(p) || p.startsWith(NS.dcterms) || p.startsWith(NS.skos) || p.startsWith(NS.rdfs));
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
