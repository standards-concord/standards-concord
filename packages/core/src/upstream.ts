/**
 * Handing terms upstream: a sub-federation (say, UK financial services, extending UK government) has
 * terms of its own that have settled, and proposes them to an ontology of the federation it extends.
 * This turns the chosen terms into change operations on the target ontology: each term is re-created in
 * the target's namespace with its label, definition and notes, linked back to the original with
 * skos:exactMatch, and its superclasses, domains and ranges kept where the target can say them (a term
 * the target already has, another term being handed up, or a well-known vocabulary term).
 */
import type { OntologyGraph } from './graph.js';
import { isBuiltinDatatype, isWellKnown, NS } from './ns.js';
import type { ChangeOp, ClassView, PropertyView, TermView } from './types.js';

export interface UpstreamPlan {
  ops: ChangeOp[];
  /** Original IRI → the IRI it gets in the target. */
  mapping: Record<string, string>;
  /** Things that couldn't be carried over, in plain words. */
  warnings: string[];
}

const localOf = (iri: string) => iri.replace(/^.*[#/]/, '');

export function upstreamOps(source: OntologyGraph, terms: string[], target: OntologyGraph): UpstreamPlan {
  const v = source.view();
  const byIri = new Map<string, TermView>([...v.classes, ...v.objectProperties, ...v.datatypeProperties].map((t) => [t.iri, t]));
  const ns = target.namespace;
  const warnings: string[] = [];
  const mapping: Record<string, string> = {};
  const chosen = terms.filter((t) => {
    if (byIri.has(t)) return true;
    warnings.push(`${t} isn't a class or property of this federation, so it was left out.`);
    return false;
  });
  for (const t of chosen) {
    const iri = ns + localOf(t);
    if (target.isDeclared(iri)) warnings.push(`${target.metadata().title ?? 'The target'} already has ${localOf(t)}; the proposal will say so when it is checked.`);
    mapping[t] = iri;
  }
  // A reference the target can make: one of its own terms, a term being handed up with this one, or a well-known term.
  const carry = (ref: string, what: string, from: string) => {
    if (mapping[ref]) return mapping[ref];
    if (target.isDeclared(ref) || isWellKnown(ref) || isBuiltinDatatype(ref)) return ref;
    warnings.push(`${localOf(from)}: its ${what} ${localOf(ref)} isn't in the target, so it was left out (hand it up too, or add it there first).`);
    return undefined;
  };
  const kept = (refs: string[], what: string, from: string) => refs.map((r) => carry(r, what, from)).filter((r): r is string => !!r);

  // Classes first, each after the chosen classes it builds on (the target checks references in order).
  const classes = chosen.filter((t) => byIri.get(t)!.kind === 'class');
  const ordered: string[] = [];
  const visit = (c: string, stack = new Set<string>()) => {
    if (ordered.includes(c) || stack.has(c)) return;
    stack.add(c);
    for (const s of (byIri.get(c) as ClassView).superClasses) if (classes.includes(s)) visit(s, stack);
    ordered.push(c);
  };
  classes.forEach((c) => visit(c));

  const ops: ChangeOp[] = [];
  const annotations = (t: TermView) => ({
    label: t.label ?? localOf(t.iri),
    definition: t.definition ?? '',
    ...(t.comment ? { comment: t.comment } : {}),
    ...(t.altLabels?.length ? { altLabels: t.altLabels } : {}),
    ...(t.examples?.length ? { examples: t.examples } : {}),
    mappings: { [NS.skos + 'exactMatch']: [t.iri] },
  });
  for (const c of ordered) {
    const t = byIri.get(c) as ClassView;
    ops.push({ op: 'addClass', localName: localOf(c), ...annotations(t), subClassOf: kept(t.superClasses, 'superclass', c), disjointWith: kept(t.disjointWith, 'disjoint class', c) });
  }
  for (const p of chosen.filter((t) => byIri.get(t)!.kind !== 'class')) {
    const t = byIri.get(p) as PropertyView;
    const common = { localName: localOf(p), ...annotations(t), domain: kept(t.domain, 'domain', p), range: kept(t.range, 'range', p) };
    ops.push(t.kind === 'objectProperty' ? { op: 'addObjectProperty', ...common } : { op: 'addDatatypeProperty', ...common });
  }
  return { ops, mapping, warnings };
}
