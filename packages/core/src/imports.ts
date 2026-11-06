/**
 * Checking an ontology together with the ontologies it imports (owl:imports).
 *
 * On its own, an ontology that imports another can't be checked by the OWL reasoner: sparq
 * refuses a graph whose imports were not loaded, and a change that contradicts an imported
 * ontology looks fine in isolation. Here the import closure is resolved (by the caller, who
 * knows where ontologies live), merged under the importing ontology's single header (sparq
 * accepts only one owl:Ontology per graph), and reasoned over as one graph. When the union
 * fails, each direct import is tried alone with the importing ontology to say which one the
 * problem comes from.
 */
import { DataFactory, Store } from 'n3';
import type { Term } from 'n3';
import { OntologyGraph } from './graph.js';
import { NS, RDF_TYPE } from './ns.js';
import type { ImportCheck, ImportedOntologyRef, ReasonerResult } from './types.js';

/** An ontology an owl:imports IRI resolved to. */
export interface ResolvedImport {
  /** The IRI as written in owl:imports. */
  iri: string;
  graph: OntologyGraph;
  /** Who it is, for people: the ontology's title. */
  title: string;
  /** A release version, or 'draft' when the import resolved to a working draft. */
  version: string;
  /** Concord's id for the ontology, when Concord hosts it. */
  ontologyId?: string;
  /** Identifies the exact content (a revision or a content hash), for caching. */
  revision: string;
}

/** Why an import could not be loaded. */
export type UnresolvedReason = 'not-hosted' | 'held' | 'limit';

export type ImportResolver = (iri: string) => Promise<ResolvedImport | { unresolved: UnresolvedReason } | null>;

export interface ImportClosure {
  /** Every ontology in the closure, root excluded, in the order they were reached. */
  imported: (ResolvedImport & { via: string })[];
  unresolved: { iri: string; via: string; reason: UnresolvedReason }[];
  /** owl:imports IRIs the root itself names, in order. */
  direct: string[];
}

/** At most this many ontologies are loaded into one closure. */
export const MAX_IMPORTS = 25;

const OWL_IMPORTS = NS.owl + 'imports';
const OWL_ONTOLOGY = NS.owl + 'Ontology';

const importsOf = (g: OntologyGraph): string[] => g.metadata().imports;

/**
 * Follows owl:imports from `root`, breadth first, loading each IRI once. An IRI that resolves to
 * the root itself, or to an ontology already loaded under another IRI, is not loaded twice.
 */
export async function resolveImportClosure(root: OntologyGraph, resolve: ImportResolver, opts: { max?: number } = {}): Promise<ImportClosure> {
  const max = opts.max ?? MAX_IMPORTS;
  const direct = importsOf(root);
  const closure: ImportClosure = { imported: [], unresolved: [], direct };
  const seen = new Set<string>([root.ontologyIRI]);
  const loadedOntologies = new Set<string>();
  const queue = direct.map((iri) => ({ iri, via: root.ontologyIRI }));
  while (queue.length) {
    const { iri, via } = queue.shift()!;
    if (seen.has(iri)) continue;
    seen.add(iri);
    if (closure.imported.length >= max) {
      closure.unresolved.push({ iri, via, reason: 'limit' });
      continue;
    }
    const r = await resolve(iri);
    if (!r) {
      closure.unresolved.push({ iri, via, reason: 'not-hosted' });
      continue;
    }
    if ('unresolved' in r) {
      closure.unresolved.push({ iri, via, reason: r.unresolved });
      continue;
    }
    const key = r.graph.ontologyIRI || iri;
    if (key === root.ontologyIRI || loadedOntologies.has(`${key}@${r.version}`)) continue;
    loadedOntologies.add(`${key}@${r.version}`);
    closure.imported.push({ ...r, via });
    for (const next of importsOf(r.graph)) queue.push({ iri: next, via: iri });
  }
  return closure;
}

/**
 * The root and the given imports as one graph: one owl:Ontology header (the root's), no
 * owl:imports (everything they name is loaded), and each import's blank nodes kept apart.
 */
export function unionGraph(root: OntologyGraph, imported: Pick<ResolvedImport, 'graph'>[]): OntologyGraph {
  const store = new Store();
  const rootIRI = root.ontologyIRI;
  const headers = new Set<string>();
  const add = (g: OntologyGraph, tag: string | undefined) => {
    for (const h of g.store.getSubjects(DataFactory.namedNode(RDF_TYPE), DataFactory.namedNode(OWL_ONTOLOGY), null)) headers.add(h.value);
    const rename = (t: Term): Term => (tag && t.termType === 'BlankNode' ? DataFactory.blankNode(`${tag}_${t.value}`) : t);
    for (const q of g.store.getQuads(null, null, null, null)) {
      if (q.predicate.value === OWL_IMPORTS) continue;
      store.addQuad(DataFactory.quad(rename(q.subject) as any, q.predicate, rename(q.object) as any));
    }
  };
  add(root, undefined);
  imported.forEach((r, i) => add(r.graph, `imp${i}`));
  // Only the root keeps its header. An imported ontology's header and its annotations go:
  // sparq rejects a graph with more than one owl:Ontology.
  for (const h of headers) {
    if (h === rootIRI) continue;
    store.removeQuads(store.getQuads(DataFactory.namedNode(h), null, null, null));
  }
  return new OntologyGraph(store, { ...Object.assign({}, ...imported.map((r) => r.graph.prefixes)), ...root.prefixes });
}

/** Axiom predicates that change the meaning of the term they are said about. */
const MEANING = new Set([
  NS.rdfs + 'subClassOf',
  NS.owl + 'equivalentClass',
  NS.owl + 'disjointWith',
  NS.rdfs + 'domain',
  NS.rdfs + 'range',
  NS.rdfs + 'subPropertyOf',
  NS.owl + 'equivalentProperty',
  NS.owl + 'inverseOf',
  NS.owl + 'propertyDisjointWith',
]);
const CHARACTERISTICS = new Set(['FunctionalProperty', 'InverseFunctionalProperty', 'TransitiveProperty', 'SymmetricProperty', 'AsymmetricProperty', 'ReflexiveProperty', 'IrreflexiveProperty'].map((c) => NS.owl + c));

/**
 * Axioms the root says about terms that belong to an imported ontology: it re-axiomatises
 * someone else's term ("constrain, never fork"). A term belongs to the import whose namespace
 * it is in, unless it is also in the root's own namespace.
 */
export function foreignAxioms(root: OntologyGraph, imported: Pick<ResolvedImport, 'graph' | 'title'>[]): ImportCheck['foreignAxioms'] {
  const own = root.namespace;
  const owners = imported.map((r) => ({ ns: r.graph.namespace, title: r.title })).filter((o) => o.ns && o.ns !== own);
  const ownerOf = (iri: string) => (own && iri.startsWith(own) ? undefined : owners.find((o) => iri.startsWith(o.ns)));
  const out: ImportCheck['foreignAxioms'] = [];
  for (const q of root.store.getQuads(null, null, null, null)) {
    if (q.subject.termType !== 'NamedNode') continue;
    const meaning = MEANING.has(q.predicate.value) || (q.predicate.value === RDF_TYPE && CHARACTERISTICS.has(q.object.value));
    if (!meaning) continue;
    const owner = ownerOf(q.subject.value);
    if (!owner) continue;
    out.push({ subject: q.subject.value, predicate: q.predicate.value, object: q.object.termType === 'NamedNode' ? q.object.value : '(class expression)', owner: owner.title });
  }
  return out;
}

const refOf = (r: ResolvedImport & { via: string }): ImportedOntologyRef => ({ iri: r.iri, title: r.title, version: r.version, via: r.via, ...(r.ontologyId ? { ontologyId: r.ontologyId } : {}) });

/** How many direct imports are tried one at a time to find the one a failure comes from. */
const MAX_BLAME = 8;

/**
 * Reasons over the root with its whole import closure. The verdict is on the root's own classes:
 * a class the root declares that becomes unsatisfiable fails it, while a class that is only in an
 * import (and unsatisfiable there) is reported but left to that ontology's own checks.
 */
export async function checkImports(root: OntologyGraph, closure: ImportClosure, reason: (g: OntologyGraph) => Promise<ReasonerResult>): Promise<{ check: ImportCheck; reasoner: ReasonerResult }> {
  const union = unionGraph(root, closure.imported);
  const joint = await reason(union);
  const own = joint.unsatisfiable.filter((c) => root.isDeclared(c));
  const inherited = joint.unsatisfiable.filter((c) => !root.isDeclared(c));
  const failed = joint.available && (!joint.consistent || own.length > 0);

  // Several versions of one Concord ontology in the closure: both sets of axioms are in the union.
  const byOntology = new Map<string, Set<string>>();
  for (const r of closure.imported) if (r.ontologyId) byOntology.set(r.ontologyId, (byOntology.get(r.ontologyId) ?? new Set()).add(r.version));
  const versionClashes = [...byOntology.entries()].filter(([, v]) => v.size > 1).map(([id, v]) => ({ ontologyId: id, title: closure.imported.find((r) => r.ontologyId === id)!.title, versions: [...v].sort() }));

  const blame: ImportCheck['blame'] = [];
  if (failed) {
    // The root alone first: if it already fails without its imports, they are not to blame.
    const alone = await reason(unionGraph(root, []));
    if (alone.available && (!alone.consistent || alone.unsatisfiable.some((c) => own.includes(c)))) {
      blame.push({ import: null, title: root.metadata().title ?? 'This ontology', inconsistent: !alone.consistent, unsatisfiable: alone.unsatisfiable.filter((c) => own.includes(c)) });
    } else {
      const directs = closure.imported.filter((r) => r.via === root.ontologyIRI).slice(0, MAX_BLAME);
      for (const d of directs) {
        // The direct import with everything it brings in itself.
        const sub = subClosure(closure, d);
        const r = directs.length === 1 ? joint : await reason(unionGraph(root, sub));
        if (r.available && (!r.consistent || r.unsatisfiable.some((c) => own.includes(c))))
          blame.push({ import: d.iri, title: d.title, inconsistent: !r.consistent, unsatisfiable: r.unsatisfiable.filter((c) => own.includes(c)) });
      }
    }
  }

  const check: ImportCheck = {
    imports: closure.imported.map(refOf),
    unresolved: closure.unresolved,
    consistent: joint.consistent,
    checked: joint.available ? (joint.checked ?? 'complete') : 'none',
    unsatisfiable: own,
    inheritedUnsatisfiable: inherited,
    blame,
    foreignAxioms: foreignAxioms(root, closure.imported),
    versionClashes,
    passed: joint.available && joint.consistent && own.length === 0,
    ...(joint.error ? { error: joint.error } : {}),
  };
  // The reasoner verdict the rest of validation uses: the union's, with only the root's own classes counted.
  return { check, reasoner: { ...joint, unsatisfiable: own } };
}

/** `d` and everything reached through it. */
function subClosure(closure: ImportClosure, d: ResolvedImport & { via: string }): (ResolvedImport & { via: string })[] {
  const out = [d];
  const reached = new Set([d.iri]);
  for (const r of closure.imported) {
    if (reached.has(r.via) && !reached.has(r.iri)) {
      reached.add(r.iri);
      out.push(r);
    }
  }
  return out;
}
