/**
 * Checking a federation: a set of ontologies, each at a chosen version, that are meant to be used
 * together. Each member is first checked alone with everything it imports; then all of them are
 * reasoned over as one graph. When the whole fails though every member passes alone, members are
 * tried two at a time to find the pairs that conflict. Statements one member makes about another
 * member's terms are reported, since everyone who uses the federation gets them.
 *
 * Everything runs on sparq (the caller passes the reasoner), so the same check works in the server's
 * worker and in a browser.
 */
import { Store, DataFactory } from 'n3';
import { OntologyGraph } from './graph.js';
import { foreignAxioms, unionGraph, type ImportClosure, type ResolvedImport } from './imports.js';
import { NS, RDF_TYPE } from './ns.js';
import type { FederationCheck, ReasonerResult } from './types.js';

export interface FederationMemberInput {
  /** Concord's id for the ontology. */
  id: string;
  title: string;
  version: string;
  graph: OntologyGraph;
  closure: ImportClosure;
}

/** At most this many members are tried two at a time to find conflicting pairs. */
const MAX_PAIRWISE = 8;

/** An empty ontology whose only job is to carry the single owl:Ontology header sparq needs. */
export function federationRoot(iri: string): OntologyGraph {
  const store = new Store();
  store.addQuad(DataFactory.namedNode(iri), DataFactory.namedNode(RDF_TYPE), DataFactory.namedNode(NS.owl + 'Ontology'));
  return new OntologyGraph(store, {});
}

/** Every graph a set of members brings in (members and their imports), each ontology version once. */
function graphsOf(members: FederationMemberInput[]): Pick<ResolvedImport, 'graph'>[] {
  const seen = new Set<string>();
  const out: Pick<ResolvedImport, 'graph'>[] = [];
  const add = (key: string, graph: OntologyGraph) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ graph });
  };
  for (const m of members) {
    add(`${m.id}@${m.version}`, m.graph);
    for (const r of m.closure.imported) add(`${r.ontologyId ?? r.iri}@${r.version}`, r.graph);
  }
  return out;
}

/** All members and everything they import as one graph, under the federation's own header. */
export function federationUnion(iri: string, members: FederationMemberInput[]): OntologyGraph {
  return unionGraph(federationRoot(iri), graphsOf(members));
}

const fails = (r: ReasonerResult) => r.available && (!r.consistent || r.unsatisfiable.length > 0);

export async function checkFederation(
  iri: string,
  members: FederationMemberInput[],
  reason: (g: OntologyGraph) => Promise<ReasonerResult>,
  opts: { now?: () => string } = {},
): Promise<FederationCheck> {
  const root = federationRoot(iri);
  const together = (ms: FederationMemberInput[]) => reason(unionGraph(root, graphsOf(ms)));

  // Each member alone, with its own imports.
  const alone: FederationCheck['members'] = [];
  for (const m of members) {
    const r = await together([m]);
    alone.push({
      ontologyId: m.id,
      title: m.title,
      version: m.version,
      imports: m.closure.imported.length,
      consistent: r.consistent,
      checked: r.available ? (r.checked ?? 'complete') : 'none',
      unsatisfiable: r.unsatisfiable,
      passed: r.available && r.consistent && r.unsatisfiable.length === 0,
    });
  }

  const joint = await together(members);
  const declaredBy = (c: string) => members.find((m) => m.graph.isDeclared(c))?.id ?? null;
  // Classes that are fine in every member alone but not together: the federation's own problem.
  const aloneUnsat = new Set(alone.flatMap((a) => a.unsatisfiable));
  const newUnsat = joint.unsatisfiable.filter((c) => !aloneUnsat.has(c));

  const conflicts: FederationCheck['conflicts'] = [];
  if (fails(joint) && (newUnsat.length > 0 || (!joint.consistent && alone.every((a) => a.consistent)))) {
    const tried = members.slice(0, MAX_PAIRWISE);
    for (let i = 0; i < tried.length; i++)
      for (let j = i + 1; j < tried.length; j++) {
        const r = await together([tried[i], tried[j]]);
        const pairNew = r.unsatisfiable.filter((c) => !aloneUnsat.has(c));
        const pairInconsistent = !r.consistent && alone[i].consistent && alone[j].consistent;
        if (r.available && (pairInconsistent || pairNew.length > 0)) conflicts.push({ a: tried[i].id, b: tried[j].id, inconsistent: pairInconsistent, unsatisfiable: pairNew });
      }
  }

  // Statements a member makes about another member's (or another member's imports') terms.
  const foreign: FederationCheck['foreignAxioms'] = [];
  for (const m of members) {
    const others = members.filter((o) => o !== m).flatMap((o) => [{ graph: o.graph, title: o.title }, ...o.closure.imported.map((r) => ({ graph: r.graph, title: r.title }))]);
    for (const f of foreignAxioms(m.graph, others)) foreign.push({ ...f, member: m.id });
  }

  // One ontology in the federation at two versions (as a member and through someone's imports).
  const versions = new Map<string, { title: string; versions: Set<string> }>();
  const note = (id: string, title: string, v: string) => {
    const e = versions.get(id) ?? { title, versions: new Set<string>() };
    e.versions.add(v);
    versions.set(id, e);
  };
  for (const m of members) {
    note(m.id, m.title, m.version);
    for (const r of m.closure.imported) if (r.ontologyId) note(r.ontologyId, r.title, r.version);
  }
  const versionClashes = [...versions.entries()].filter(([, e]) => e.versions.size > 1).map(([ontologyId, e]) => ({ ontologyId, title: e.title, versions: [...e.versions].sort() }));

  const unresolved = members.flatMap((m) => m.closure.unresolved.map((u) => ({ ...u, member: m.id })));
  return {
    members: alone,
    unresolved,
    joint: {
      consistent: joint.consistent,
      checked: joint.available ? (joint.checked ?? 'complete') : 'none',
      unsatisfiable: joint.unsatisfiable.map((c) => ({ iri: c, member: declaredBy(c), alone: aloneUnsat.has(c) })),
      ...(joint.error ? { error: joint.error } : {}),
    },
    conflicts,
    foreignAxioms: foreign,
    versionClashes,
    // The federation works if its members can be used together: consistent, with no impossible class
    // (whether a member already had it alone or the combination causes it).
    passed: joint.available && joint.consistent && joint.unsatisfiable.length === 0,
    checkedAt: (opts.now ?? (() => new Date().toISOString()))(),
  };
}
