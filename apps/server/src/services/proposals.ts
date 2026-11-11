import { expandIRI, localName as localNameOf, NS, type OntologyGraph } from '@concord/core';
import type { ChangeOp, Restriction } from '@concord/core/types';
import type { ProposedTerm } from '../llm/schemas.js';

/** "volunteering opportunity" -> "VolunteeringOpportunity" / "volunteeringOpportunity" */
export function toLocalName(label: string, kind: ProposedTerm['kind']): string {
  const words = label
    .replace(/['’]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const camel = words.map((w, i) => (i === 0 && kind !== 'class' ? w[0].toLowerCase() + w.slice(1) : w[0].toUpperCase() + w.slice(1))).join('');
  const name = /^[0-9]/.test(camel) ? `_${camel}` : camel;
  if (kind === 'class') return name;
  return name[0].toLowerCase() + name.slice(1);
}

const isFullIri = (s: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s);

/**
 * Resolves the label/CURIE/localName references a model (or a person) uses to
 * real IRIs: first the terms added in the same proposal, then CURIEs, then
 * existing terms by local name or label.
 */
export class TermResolver {
  private byName = new Map<string, string>();
  readonly warnings: string[] = [];

  constructor(
    private graph: OntologyGraph,
    newTerms: { localName: string }[] = [],
  ) {
    const view = graph.view();
    const all = [...view.classes, ...view.objectProperties, ...view.datatypeProperties, ...view.annotationProperties, ...view.individuals, ...view.concepts, ...view.conceptSchemes];
    for (const t of all) {
      this.byName.set(localNameOf(t.iri).toLowerCase(), t.iri);
      if (t.label) this.byName.set(t.label.toLowerCase(), t.iri);
    }
    for (const t of newTerms) this.byName.set(t.localName.toLowerCase(), graph.namespace + t.localName);
  }

  resolve(ref: string, kind: ProposedTerm['kind'] = 'class'): string {
    const s = ref.trim().replace(/^<|>$/g, '');
    if (isFullIri(s)) return s;
    const curie = s.match(/^([A-Za-z][\w-]*):(\S+)$/);
    if (curie) {
      const prefixes: Record<string, string> = { ...this.graph.prefixes, xsd: NS.xsd, rdfs: NS.rdfs, owl: NS.owl, skos: NS.skos, schema: NS.schema, prov: NS.prov, dcterms: NS.dcterms, foaf: NS.foaf };
      if (prefixes[curie[1]]) {
        const iri = expandIRI(s, prefixes);
        // A CURIE in our own namespace may still refer to a new term.
        return iri;
      }
    }
    const hit = this.byName.get(s.toLowerCase()) ?? this.byName.get(toLocalName(s, kind).toLowerCase());
    if (hit) return hit;
    const minted = this.graph.namespace + toLocalName(s, kind);
    this.warnings.push(`"${ref}" did not match an existing term; assumed ${minted}.`);
    return minted;
  }
}

/** Compile the model's flat proposal into engine ChangeOps. */
export function proposalToOps(graph: OntologyGraph, terms: ProposedTerm[], source?: string | string[]): { ops: ChangeOp[]; warnings: string[] } {
  const adds = terms
    .filter((t) => t.action === 'add')
    .map((t) => ({ ...t, localName: t.localName ? toLocalName(t.localName, t.kind) === t.localName ? t.localName : toLocalName(t.localName, t.kind) : toLocalName(t.label ?? 'Unnamed', t.kind) }));
  const resolver = new TermResolver(graph, adds as { localName: string }[]);
  const ops: ChangeOp[] = [];
  const r = (x: string, k: ProposedTerm['kind'] = 'class') => resolver.resolve(x, k);
  const restrictions = (t: ProposedTerm): Restriction[] =>
    (t.restrictions ?? []).map((x) => ({
      property: r(x.property, 'objectProperty'),
      kind: x.kind,
      filler: x.filler ? r(x.filler) : undefined,
      cardinality: x.cardinality,
    }));
  const src = source === undefined ? undefined : Array.isArray(source) ? source : [source];

  // Adds first (classes, then properties, then individuals) so later references resolve.
  const order = { class: 0, objectProperty: 1, datatypeProperty: 2, individual: 3 } as const;
  for (const t of [...adds].sort((a, b) => order[a.kind] - order[b.kind])) {
    const base = {
      localName: t.localName,
      label: t.label ?? t.localName,
      definition: t.definition ?? `TODO: definition for ${t.label ?? t.localName}`,
      comment: t.comment,
      altLabels: t.altLabels,
      source: src,
      editorialNote: t.reason,
    };
    if (t.kind === 'class')
      ops.push({ op: 'addClass', ...base, subClassOf: t.superClasses?.map((x) => r(x)), disjointWith: t.disjointWith?.map((x) => r(x)), restrictions: restrictions(t) });
    else if (t.kind === 'objectProperty')
      ops.push({ op: 'addObjectProperty', ...base, domain: t.domain?.map((x) => r(x)), range: t.range?.map((x) => r(x)), characteristics: t.characteristics });
    else if (t.kind === 'datatypeProperty')
      ops.push({
        op: 'addDatatypeProperty',
        ...base,
        domain: t.domain?.map((x) => r(x)),
        range: t.range?.map((x) => r(x)) ?? [NS.xsd + 'string'],
        functional: t.characteristics?.includes('functional'),
      });
    else ops.push({ op: 'addIndividual', ...base, types: (t.types ?? []).map((x) => r(x)) });
  }

  for (const t of terms) {
    if (t.action === 'add') continue;
    const iri = r(t.existing ?? t.localName ?? t.label ?? '', t.kind);
    if (t.action === 'deprecate') {
      ops.push({ op: 'deprecateTerm', iri, reason: t.reason ?? 'Deprecated', replacedBy: t.replacedBy ? r(t.replacedBy, t.kind) : undefined });
      continue;
    }
    const set = { label: t.label, definition: t.definition, comment: t.comment, altLabels: t.altLabels };
    if (Object.values(set).some((v) => v !== undefined)) ops.push({ op: 'updateAnnotations', iri, set: JSON.parse(JSON.stringify(set)) });
    if (t.superClasses) ops.push({ op: 'setSuperClasses', iri, superClasses: t.superClasses.map((x) => r(x)) });
    if (t.domain || t.range) ops.push({ op: 'setDomainRange', iri, domain: t.domain?.map((x) => r(x)), range: t.range?.map((x) => r(x)) });
    for (const restriction of restrictions(t)) ops.push({ op: 'addRestriction', classIri: iri, restriction });
    if (t.disjointWith?.length) ops.push({ op: 'addDisjointness', classes: [iri, ...t.disjointWith.map((x) => r(x))] });
    if (t.characteristics) ops.push({ op: 'setCharacteristics', iri, characteristics: t.characteristics });
  }
  return { ops, warnings: resolver.warnings };
}

/** Human-readable one-liners for a ChangeOp, used in prompts, timelines and agent responses. */
export function describeOp(op: ChangeOp, compact: (iri: string) => string): string {
  switch (op.op) {
    case 'addConceptScheme':
      return `Create the code list “${op.label}”`;
    case 'addConcept':
      return `Add code “${op.label}”${op.notation ? ` (${op.notation})` : ''} to ${compact(op.scheme)}`;
    case 'updateConcept':
      return `Edit the code or code list “${compact(op.iri)}”: ${Object.keys(op.set).join(', ')}`;
    case 'moveConcept':
      return `Move code “${compact(op.iri)}” ${op.broader ? `under ${compact(op.broader)}` : 'to the top of its code list'}`;
    case 'setCodeList':
      return `${op.scheme ? 'Set' : 'Clear'} the code list of ${compact(op.property)}${op.scheme ? ` to ${compact(op.scheme)}` : ''}`;
    case 'deprecateConcept':
      return `Deprecate code “${compact(op.iri)}”: ${op.reason}`;
    case 'addClass':
      return `Add class ${op.localName} ("${op.label}")${op.subClassOf?.length ? `, subclass of ${op.subClassOf.map(compact).join(', ')}` : ''}: ${op.definition}`;
    case 'addObjectProperty':
      return `Add object property ${op.localName} (${(op.domain ?? []).map(compact).join(' or ') || 'any'} → ${op.codeList ? `code list ${compact(op.codeList)}` : (op.range ?? []).map(compact).join(' or ') || 'any'}): ${op.definition}`;
    case 'addDatatypeProperty':
      return `Add datatype property ${op.localName} (${(op.domain ?? []).map(compact).join(' or ') || 'any'} → ${(op.range ?? []).map(compact).join(' or ') || 'literal'}): ${op.definition}`;
    case 'addIndividual':
      return `Add individual ${op.localName} of type ${op.types.map(compact).join(', ')}`;
    case 'updateAnnotations':
      return `Update ${compact(op.iri)}: ${Object.entries(op.set)
        .map(([k, v]) => `${k} → ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('; ')}`;
    case 'setSuperClasses':
      return `Set superclasses of ${compact(op.iri)} to ${op.superClasses.map(compact).join(', ') || 'none'}`;
    case 'setDomainRange':
      return `Set ${compact(op.iri)} ${op.domain ? `domain ${op.domain.map(compact).join(', ')}` : ''} ${op.range ? `range ${op.range.map(compact).join(', ')}` : ''}`.trim();
    case 'addRestriction':
      return `Add restriction on ${compact(op.classIri)}: ${compact(op.restriction.property)} ${op.restriction.kind} ${op.restriction.cardinality ?? ''} ${op.restriction.filler ? compact(op.restriction.filler) : op.restriction.literal ?? ''}`.replace(/\s+/g, ' ');
    case 'removeRestriction':
      return `Remove restriction on ${compact(op.classIri)}: ${compact(op.restriction.property)} ${op.restriction.kind}`;
    case 'addDisjointness':
      return `Declare ${op.classes.map(compact).join(', ')} disjoint`;
    case 'removeDisjointness':
      return `Remove disjointness between ${op.classes.map(compact).join(', ')}`;
    case 'setCharacteristics':
      return `Set characteristics of ${compact(op.iri)} to ${op.characteristics.join(', ') || 'none'}`;
    case 'deprecateTerm':
      return `Deprecate ${compact(op.iri)}${op.replacedBy ? ` (replaced by ${compact(op.replacedBy)})` : ''}: ${op.reason}`;
    case 'removeTerm':
      return `Remove ${compact(op.iri)}`;
    case 'renameTerm':
      return `Rename ${compact(op.iri)} to ${op.newLocalName} (old IRI deprecated)`;
    case 'setMetadata':
      return `Update ontology metadata: ${Object.keys(op.set).join(', ')}`;
    case 'addImport':
      return `Import ${op.iri}`;
  }
}
