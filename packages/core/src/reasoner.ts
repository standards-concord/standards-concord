/**
 * Reasoning.
 *
 * `structuralReasoner` is a fast, incomplete, pure-TypeScript check used for
 * instant feedback while editing: it computes the told subclass closure and finds
 * the common sources of incoherence (disjoint ancestors, existential restrictions
 * clashing with domain/range + disjointness) and inconsistency (individuals in
 * disjoint or unsatisfiable classes, functional data properties with two values).
 *
 * `owlReasoner` runs a complete OWL 2 DL reasoner (HermiT, or Pellet) via the
 * Python toolkit (owlready2), falling back to the structural reasoner when the
 * toolkit, Python or Java is unavailable.
 */
import type { ReasonerResult } from './types.js';
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
/* OWL DL reasoner via the Python toolkit                                    */
/* ------------------------------------------------------------------------ */

export interface OwlReasonerOptions {
  python?: string;
  timeoutMs?: number;
  engine?: 'hermit' | 'pellet';
}

/** Locates toolkit/ (CONCORD_TOOLKIT_DIR, else <repo>/toolkit relative to this package). */
export async function toolkitDir(): Promise<string> {
  const env = typeof process !== 'undefined' ? process.env.CONCORD_TOOLKIT_DIR : undefined;
  if (env) return env;
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../toolkit');
}

async function findPython(dir: string, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  if (process.env.CONCORD_PYTHON) return process.env.CONCORD_PYTHON;
  const { existsSync } = await import('node:fs');
  const path = await import('node:path');
  const venv = path.join(dir, '.venv', 'bin', 'python');
  return existsSync(venv) ? venv : 'python3';
}

export async function owlReasoner(graph: OntologyGraph, opts: OwlReasonerOptions = {}): Promise<ReasonerResult> {
  const engine = opts.engine ?? 'hermit';
  const t0 = Date.now();
  const fallback = (error: string): ReasonerResult => ({ ...structuralReasoner(graph), available: false, error, durationMs: Date.now() - t0 });
  if (typeof process === 'undefined' || !process.versions?.node) return fallback('OWL reasoner requires Node.js');
  let dir: string;
  let python: string;
  try {
    dir = await toolkitDir();
    python = await findPython(dir, opts.python);
  } catch (e) {
    return fallback(`toolkit not found: ${(e as Error).message}`);
  }
  const { spawn } = await import('node:child_process');
  const path = await import('node:path');
  const script = path.join(dir, 'reason.py');
  const { store: dlStore, replaced } = owl2DatatypesOnly(graph);
  const input = writeNTriples(dlStore);
  const caveat = replaced.length
    ? `Datatypes outside the OWL 2 datatype map were treated as rdfs:Literal for ${engine}: ${replaced.map((d) => compactIRI(d, graph.prefixes)).join(', ')}.`
    : undefined;

  return new Promise<ReasonerResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (r: ReasonerResult) => {
      if (!done) { done = true; resolve(r); }
    };
    const child = spawn(python, [script, '--engine', engine, '--format', 'ntriples', '--iri', graph.ontologyIRI || 'http://example.org/concord-input'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(fallback(`${engine} timed out after ${opts.timeoutMs ?? 120000} ms`));
    }, opts.timeoutMs ?? 120000);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => { clearTimeout(timer); finish(fallback(`could not start ${python}: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let out: any;
      try { out = JSON.parse(stdout); } catch {
        return finish(fallback(`reasoner produced no result (exit ${code}): ${stderr.trim().slice(-2000)}`));
      }
      if (!out.available) return finish(fallback(out.error ?? `reasoner unavailable (exit ${code})`));
      finish({
        engine,
        available: true,
        consistent: !!out.consistent,
        unsatisfiable: out.unsatisfiable ?? [],
        inferredSubClassOf: out.inferredSubClassOf ?? [],
        explanation: [out.explanation, caveat].filter(Boolean).join('\n') || undefined,
        durationMs: Date.now() - t0,
      });
    });
    child.stdin.on('error', () => { /* reported via close */ });
    child.stdin.end(input);
  });
}


/**
 * Copy of the graph in which datatypes outside the OWL 2 datatype map (e.g. xsd:date)
 * are replaced by rdfs:Literal in axioms, and such literals in assertions become
 * plain strings, so that DL reasoners accept the ontology.
 */
function owl2DatatypesOnly(graph: OntologyGraph): { store: Store; replaced: string[] } {
  const store = cloneStore(graph.store);
  const replaced = new Set<string>();
  const annotationProps = new Set(graph.view().annotationProperties.map((p) => p.iri));
  for (const q of store.getQuads(null, null, null, null)) {
    const o = q.object as Term;
    const p = q.predicate.value;
    if (o.termType === 'NamedNode' && isBuiltinDatatype(o.value) && !OWL2_DATATYPES.has(o.value) && p !== RDF_TYPE) {
      store.removeQuad(q);
      store.addQuad(q.subject as any, q.predicate as any, nn(NS.rdfs + 'Literal'));
      replaced.add(o.value);
    } else if (o.termType === 'Literal' && !annotationProps.has(p) && !p.startsWith(NS.dcterms) && !p.startsWith(NS.skos) && !p.startsWith(NS.rdfs)) {
      const dt = (o as any).datatype?.value as string | undefined;
      if (dt && isBuiltinDatatype(dt) && !OWL2_DATATYPES.has(dt)) {
        store.removeQuad(q);
        store.addQuad(q.subject as any, q.predicate as any, literal(o.value));
        replaced.add(dt);
      }
    }
  }
  return { store, replaced: [...replaced].sort() };
}
