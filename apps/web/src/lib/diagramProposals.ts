import type { ChangeOp, OntologyView } from '@concord/core/types';
import { allTerms, type Labeler } from './ontology';
import { DATATYPE_NAMES, datatypeName, localName } from './format';
import { buildModel, XSD, type OntologyModel } from './ontologyModel';

export type HowMany = 'any' | 'min' | 'exactly' | 'max';
export const HOW_MANY: Record<HowMany, string> = { any: 'Any number', min: 'At least one', exactly: 'Exactly one', max: 'At most one' };
const basicTypes: Record<string, string> = { string: 'text', integer: 'whole number', decimal: 'decimal number', boolean: 'true/false', date: 'date', dateTime: 'date and time', anyURI: 'web address' };
export const PROPOSAL_DATATYPES: [string, string][] = [
  ...Object.entries(basicTypes).map(([type, name]): [string, string] => [XSD + type, name]),
  ...Object.entries(DATATYPE_NAMES).filter(([iri]) => iri.startsWith(XSD) && !basicTypes[iri.slice(XSD.length)]),
];
export const proposalDatatypeName = (iri: string) => basicTypes[iri.slice(XSD.length)] ?? datatypeName(iri) ?? iri;

type NewTerm = { localName: string; label: string; definition: string };
export type PendingChange = { id: string } & (
  | ({ kind: 'class'; parent?: string } & NewTerm)
  | ({ kind: 'attribute'; classIri: string; range: string; howMany: HowMany } & NewTerm)
  | ({ kind: 'relationship'; from: string; to: string; howMany: HowMany } & NewTerm)
  | { kind: 'superclass'; classIri: string; parent: string; mode: 'replace' | 'add'; superClasses: string[] }
);

export function deriveLocalName(label: string, kind: 'class' | 'property'): string {
  const words = label.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[A-Za-z0-9]+/g) ?? [];
  const name = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  return kind === 'property' ? name.charAt(0).toLowerCase() + name.slice(1) : name;
}

export function localNameError(name: string, namespace: string, view: OntologyView, pending: PendingChange[]): string | undefined {
  if (!/^[A-Za-z0-9]+$/.test(name)) return 'Use only ASCII letters and digits for the name in the IRI.';
  const folded = name.toLowerCase();
  if (allTerms(view).some((t) => localName(t.iri).toLowerCase() === folded || t.iri.toLowerCase() === (namespace + name).toLowerCase()) || pending.some((p) => p.kind !== 'superclass' && p.localName.toLowerCase() === folded))
    return 'That name in the IRI is already used by an existing or proposed term.';
}

export function superClassesFor(current: string[], parent: string, mode: 'replace' | 'add'): string[] {
  return [...new Set([...(mode === 'add' ? current : []), parent])];
}

export function wouldCreateCycle(model: OntologyModel, classIri: string, parent: string): boolean {
  return classIri === parent || model.descendants(classIri).includes(parent);
}

export function references(p: PendingChange): string[] {
  switch (p.kind) {
    case 'class': return p.parent ? [p.parent] : [];
    case 'attribute': return [p.classIri];
    case 'relationship': return [p.from, p.to];
    case 'superclass': return [p.classIri, p.parent, ...p.superClasses];
  }
}

/** Remove dependent new classes transitively, as well as anything using those classes. */
export function undoChange(pending: PendingChange[], id: string, namespace: string): { items: PendingChange[]; alsoRemoved: number } {
  const removed = new Set([id]);
  const iris = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of pending) {
      if (!removed.has(p.id) && references(p).some((i) => iris.has(i))) { removed.add(p.id); changed = true; }
      if (removed.has(p.id) && p.kind === 'class' && !iris.has(namespace + p.localName)) { iris.add(namespace + p.localName); changed = true; }
    }
  }
  return { items: pending.filter((p) => !removed.has(p.id)), alsoRemoved: Math.max(0, removed.size - 1) };
}

export function describeChange(p: PendingChange, label: Labeler): string {
  const q = (iri: string) => `“${label(iri)}”`;
  const count = p.kind === 'relationship' || p.kind === 'attribute' ? p.howMany === 'any' ? '' : `, ${HOW_MANY[p.howMany].toLowerCase()}` : '';
  switch (p.kind) {
    case 'class': return `Add class “${p.label}”${p.parent ? `, subclass of ${q(p.parent)}` : ''}`;
    case 'attribute': return `Add attribute “${p.label}” (${proposalDatatypeName(p.range)}) to ${q(p.classIri)}${count}`;
    case 'relationship': return `Add relationship “${p.label}” from ${q(p.from)} to ${q(p.to)}${count}`;
    case 'superclass': return `Make ${q(p.classIri)} a subclass of ${p.superClasses.map(q).join(' and ')}`;
  }
}

export function proposalTitle(items: PendingChange[], label: Labeler): string {
  const first = items[0];
  if (!first) return '';
  const start = first.kind === 'superclass' ? `Change superclass of ${label(first.classIri)}` : `Add ${first.label}`;
  return `${start}${items.length > 1 ? ` and ${items.length - 1} more ${items.length === 2 ? 'change' : 'changes'}` : ''}`;
}

export function changesToOps(items: PendingChange[], namespace: string): ChangeOp[] {
  const classes: ChangeOp[] = [], properties: ChangeOp[] = [], restrictions: ChangeOp[] = [], superclasses: ChangeOp[] = [];
  for (const p of items) {
    if (p.kind === 'superclass') { superclasses.push({ op: 'setSuperClasses', iri: p.classIri, superClasses: p.superClasses }); continue; }
    const term = { localName: p.localName, label: p.label, definition: p.definition };
    if (p.kind === 'class') { classes.push({ op: 'addClass', ...term, subClassOf: p.parent ? [p.parent] : [] }); continue; }
    const from = p.kind === 'attribute' ? p.classIri : p.from;
    const range = p.kind === 'attribute' ? p.range : p.to;
    properties.push({ op: p.kind === 'attribute' ? 'addDatatypeProperty' : 'addObjectProperty', ...term, domain: [from], range: [range] });
    if (p.howMany !== 'any') restrictions.push({ op: 'addRestriction', classIri: from, restriction: { property: namespace + p.localName, kind: p.howMany, filler: range, cardinality: 1 } });
  }
  // A parent must be minted before its proposed subclasses, even for restored drafts.
  const sorted: ChangeOp[] = [];
  const remaining = [...classes];
  while (remaining.length) {
    const index = remaining.findIndex((op) => op.op === 'addClass' && !(op.subClassOf ?? []).some((parent) => remaining.some((other) => other.op === 'addClass' && namespace + other.localName === parent)));
    sorted.push(...remaining.splice(index < 0 ? 0 : index, 1));
  }
  return [...sorted, ...properties, ...restrictions, ...superclasses];
}

export interface ProposalPreview {
  model: OntologyModel;
  terms: Set<string>;
  classes: Set<string>;
  subclassEdges: Set<string>;
  scope: Set<string>;
}
export const subclassEdgeKey = (from: string, to: string) => JSON.stringify([from, to]);

/** A separate projection: the loaded ontology and all its arrays remain untouched. */
export function buildProposalPreview(view: OntologyView, items: PendingChange[], namespace: string): ProposalPreview {
  const next: OntologyView = { ...view, classes: view.classes.map((c) => ({ ...c, restrictions: [...c.restrictions], superClasses: [...c.superClasses] })), datatypeProperties: [...view.datatypeProperties], objectProperties: [...view.objectProperties] };
  const terms = new Set<string>(), classes = new Set<string>(), subclassEdges = new Set<string>(), scope = new Set<string>();
  for (const p of items) {
    for (const iri of references(p)) scope.add(iri);
    if (p.kind !== 'superclass') terms.add(namespace + p.localName);
    if (p.kind === 'class') { classes.add(namespace + p.localName); scope.add(namespace + p.localName); }
  }
  for (const op of changesToOps(items, namespace)) {
    if (op.op === 'addClass') {
      const iri = namespace + op.localName;
      next.classes.push({ iri, kind: 'class', label: op.label, definition: op.definition, superClasses: op.subClassOf ?? [], restrictions: [], equivalentClasses: [], disjointWith: [] });
      for (const parent of op.subClassOf ?? []) subclassEdges.add(subclassEdgeKey(iri, parent));
    } else if (op.op === 'addDatatypeProperty' || op.op === 'addObjectProperty') {
      (op.op === 'addDatatypeProperty' ? next.datatypeProperties : next.objectProperties).push({ iri: namespace + op.localName, kind: op.op === 'addDatatypeProperty' ? 'datatypeProperty' : 'objectProperty', label: op.label, definition: op.definition, domain: op.domain ?? [], range: op.range ?? [], characteristics: [], superProperties: [] });
    } else if (op.op === 'addRestriction') next.classes.find((c) => c.iri === op.classIri)?.restrictions.push(op.restriction);
    else if (op.op === 'setSuperClasses') {
      const cls = next.classes.find((c) => c.iri === op.iri);
      if (cls) cls.superClasses = [...op.superClasses];
    }
  }
  // Only final superclass links are marked; replacement removes the old links from the model.
  for (const p of items) {
    if (p.kind !== 'superclass') continue;
    const original = view.classes.find((c) => c.iri === p.classIri)?.superClasses ?? [];
    for (const parent of next.classes.find((c) => c.iri === p.classIri)?.superClasses ?? []) {
      if (!original.includes(parent)) subclassEdges.add(subclassEdgeKey(p.classIri, parent));
    }
  }
  return { model: buildModel(next), terms, classes, subclassEdges, scope };
}
