import type { OntologyView } from '@concord/shared';
import type { Labeler } from '../../lib/ontology';
import type { ValueType } from '../../lib/sparql-builder';

/** What the query builder needs to know about the ontology's terms. */

export const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';

export const ANNOTATION_OPTIONS: Record<string, string> = {
  [`${RDFS}label`]: 'label',
  [`${SKOS}definition`]: 'definition',
  [`${RDFS}comment`]: 'comment',
  [RDF_TYPE]: 'type',
};

export interface PropertyOption {
  iri: string;
  label: string;
  kind: 'object' | 'data' | 'annotation';
  /** For object properties, the class at the other end (first named range). */
  range?: string;
  group: 'suggested' | 'general' | 'annotation' | 'other';
  valueType: ValueType;
}

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const NUMERIC = new Set(
  'integer decimal double float long int short byte nonNegativeInteger positiveInteger nonPositiveInteger negativeInteger unsignedLong unsignedInt unsignedShort unsignedByte'
    .split(' ')
    .map((t) => `${XSD}${t}`),
);

/** A datatype property's value type from its declared range (text when undeclared or mixed). */
export function valueTypeForRange(range: string[]): ValueType {
  if (range.length && range.every((r) => NUMERIC.has(r))) return 'number';
  if (range.length && range.every((r) => r === `${XSD}boolean`)) return 'boolean';
  return 'text';
}

export function ancestors(view: OntologyView, cls: string): Set<string> {
  const byIri = new Map(view.classes.map((c) => [c.iri, c]));
  const out = new Set<string>();
  const todo = [cls];
  while (todo.length) {
    const c = todo.pop()!;
    if (out.has(c)) continue;
    out.add(c);
    for (const s of byIri.get(c)?.superClasses ?? []) todo.push(s);
  }
  return out;
}

/** Properties to offer for things of class `cls` (or anything, when cls is undefined). */
export function propertyOptions(view: OntologyView, cls: string | undefined, label: Labeler): PropertyOption[] {
  const anc = cls ? ancestors(view, cls) : new Set<string>();
  const classIris = new Set(view.classes.map((c) => c.iri));
  const out: PropertyOption[] = [];
  const props = [
    ...view.objectProperties.map((p) => ({ p, kind: 'object' as const })),
    ...view.datatypeProperties.map((p) => ({ p, kind: 'data' as const })),
  ];
  for (const { p, kind } of props) {
    const group = !cls ? 'general' : p.domain.length === 0 ? 'general' : p.domain.some((d) => anc.has(d)) ? 'suggested' : 'other';
    out.push({
      iri: p.iri,
      label: label(p.iri),
      kind,
      range: kind === 'object' ? p.range.find((r) => classIris.has(r)) : undefined,
      group,
      valueType: kind === 'object' ? 'resource' : valueTypeForRange(p.range),
    });
  }
  for (const [iri, name] of Object.entries(ANNOTATION_OPTIONS)) {
    out.push({ iri, label: name, kind: iri === RDF_TYPE ? 'object' : 'annotation', group: 'annotation', valueType: iri === RDF_TYPE ? 'resource' : 'text' });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

export const GROUP_LABELS: Record<PropertyOption['group'], string> = {
  suggested: 'Properties of this class',
  general: 'Properties of any class',
  annotation: 'Labels and notes',
  other: 'Other properties',
};
