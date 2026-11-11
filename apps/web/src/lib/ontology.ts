import type { ChangeOp, OntologyView, TermView } from '@concord/shared';
import type { Restriction, ClassView, PropertyView } from '@concord/core/types';
import { compactIri, datatypeName, localName } from './format';
import { allTerms } from '@concord/core/terms';

export type Labeler = (iri: string) => string;

/** Build an IRI -> label resolver from an OntologyView (falls back to CURIE/local name). */
export function makeLabeler(view?: OntologyView, extra: Record<string, string> = {}): Labeler {
  const map = new Map<string, string>();
  if (view) {
    for (const t of allTerms(view)) if (t.label) map.set(t.iri, t.label);
  }
  for (const [k, v] of Object.entries(extra)) map.set(k, v);
  return (iri: string) => {
    if (!iri) return '';
    const l = map.get(iri) ?? datatypeName(iri);
    if (l) return l;
    const c = compactIri(iri, view?.prefixes);
    return c === iri ? localName(iri) : c;
  };
}

export { allTerms };

export const KIND_LABEL: Record<TermView['kind'], string> = {
  class: 'Class',
  objectProperty: 'Object property',
  datatypeProperty: 'Datatype property',
  annotationProperty: 'Annotation property',
  individual: 'Individual', conceptScheme: 'Code list', concept: 'Code',
};

/** Manchester-ish rendering of a restriction, e.g. "hasRole some Role". */
export function restrictionText(r: Restriction, label: Labeler): string {
  const p = label(r.property);
  const f = r.filler ? label(r.filler) : r.literal !== undefined ? JSON.stringify(r.literal) : 'Thing';
  switch (r.kind) {
    case 'some':
    case 'only':
      return `${p} ${r.kind} ${f}`;
    case 'value':
      return `${p} value ${r.literal !== undefined ? JSON.stringify(r.literal) : f}`;
    case 'min':
    case 'max':
    case 'exactly':
      return `${p} ${r.kind} ${r.cardinality ?? 0}${r.filler ? ` ${f}` : ''}`;
    default:
      return `${p} ${r.kind} ${f}`;
  }
}

/** Human-readable card content for each structured change operation. */
export function describeOp(op: ChangeOp, label: Labeler): { verb: string; tone: 'add' | 'remove' | 'modify' | 'deprecate'; title: string; lines: string[] } {
  const list = (xs?: string[]) => (xs ?? []).map(label).join(', ');
  switch (op.op) {
    case 'addConceptScheme':
      return { verb: 'Create code list', tone: 'add', title: op.label, lines: [op.definition] };
    case 'addConcept':
      return { verb: 'Add code', tone: 'add', title: op.label, lines: [`In “${label(op.scheme)}”${op.broader ? `, under “${label(op.broader)}”` : ', at the top level'}`, ...(op.notation ? [`Code: ${op.notation}`] : []), op.definition] };
    case 'moveConcept':
      return { verb: 'Move code', tone: 'modify', title: label(op.iri), lines: [op.broader ? `Now under “${label(op.broader)}”` : 'Now at the top level'] };
    case 'setCodeList':
      return op.scheme
        ? { verb: 'Use code list', tone: 'modify', title: label(op.scheme), lines: [`For the values of “${label(op.property)}”`] }
        : { verb: 'Stop using a code list for', tone: 'modify', title: label(op.property), lines: ['Its values are no longer limited to a list'] };
    case 'addClass': {
      const lines: string[] = [];
      if (op.definition) lines.push(`“${op.definition}”`);
      if (op.subClassOf?.length) lines.push(`Subclass of ${list(op.subClassOf)}`);
      if (op.equivalentTo?.length) lines.push(`Equivalent to ${list(op.equivalentTo)}`);
      if (op.disjointWith?.length) lines.push(`Disjoint with ${list(op.disjointWith)}`);
      for (const r of op.restrictions ?? []) lines.push(`Restriction: ${restrictionText(r, label)}`);
      return { verb: 'Add class', tone: 'add', title: op.label || op.localName, lines };
    }
    case 'addObjectProperty':
    case 'addDatatypeProperty': {
      const lines: string[] = [];
      if (op.definition) lines.push(`“${op.definition}”`);
      if (op.domain?.length) lines.push(`Domain: ${list(op.domain)}`);
      if (op.range?.length) lines.push(`Range: ${list(op.range)}`);
      if (op.subPropertyOf?.length) lines.push(`Sub-property of ${list(op.subPropertyOf)}`);
      if (op.op === 'addObjectProperty') {
        if (op.codeList) lines.push(`Code list: ${label(op.codeList)}`);
        if (op.inverseOf) lines.push(`Inverse of ${label(op.inverseOf)}`);
        if (op.characteristics?.length) lines.push(`Characteristics: ${op.characteristics.join(', ')}`);
      } else if (op.functional) lines.push('Functional');
      return { verb: op.op === 'addObjectProperty' ? 'Add object property' : 'Add datatype property', tone: 'add', title: op.label || op.localName, lines };
    }
    case 'addIndividual': {
      const lines = [`Instance of ${list(op.types)}`];
      if (op.definition) lines.unshift(`“${op.definition}”`);
      for (const [p, vs] of Object.entries(op.facts ?? {})) lines.push(`${label(p)}: ${vs.map((v) => (v.startsWith('http') ? label(v) : v)).join(', ')}`);
      return { verb: 'Add individual', tone: 'add', title: op.label || op.localName, lines };
    }
    case 'updateConcept':
      return { verb: 'Edit', tone: 'modify', title: label(op.iri), lines: Object.entries(op.set).map(([k, v]) => `${({ label: 'Label', definition: 'Definition', notation: 'Code', altLabels: 'Also known as', examples: 'Examples', editorialNote: 'Editorial note' } as Record<string, string>)[k] ?? k}: ${Array.isArray(v) ? v.join('; ') : v || '—'}`) };
    case 'updateAnnotations': {
      const lines = Object.entries(op.set)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join('; ') : String(v)}`);
      return { verb: 'Update annotations on', tone: 'modify', title: label(op.iri), lines };
    }
    case 'setSuperClasses':
      return { verb: 'Change superclasses of', tone: 'modify', title: label(op.iri), lines: [op.superClasses.length ? `Now a subclass of ${list(op.superClasses)}` : 'No longer a subclass of anything (top-level)'] };
    case 'setDomainRange': {
      const lines: string[] = [];
      if (op.domain) lines.push(`Domain: ${list(op.domain) || '(none)'}`);
      if (op.range) lines.push(`Range: ${list(op.range) || '(none)'}`);
      return { verb: 'Change domain/range of', tone: 'modify', title: label(op.iri), lines };
    }
    case 'addRestriction':
      return { verb: 'Add restriction to', tone: 'add', title: label(op.classIri), lines: [restrictionText(op.restriction, label)] };
    case 'removeRestriction':
      return { verb: 'Remove restriction from', tone: 'remove', title: label(op.classIri), lines: [restrictionText(op.restriction, label)] };
    case 'addDisjointness':
      return { verb: 'Declare disjoint', tone: 'add', title: list(op.classes), lines: ['Nothing can be an instance of more than one of these'] };
    case 'removeDisjointness':
      return { verb: 'Remove disjointness', tone: 'remove', title: list(op.classes), lines: [] };
    case 'setCharacteristics':
      return { verb: 'Set characteristics of', tone: 'modify', title: label(op.iri), lines: [op.characteristics.length ? op.characteristics.join(', ') : '(none)'] };
    case 'deprecateConcept':
      return { verb: 'Deprecate code', tone: 'deprecate', title: label(op.iri), lines: [op.reason, ...(op.replacedBy ? [`Replaced by ${label(op.replacedBy)}`] : [])] };
    case 'deprecateTerm':
      return { verb: 'Deprecate', tone: 'deprecate', title: label(op.iri), lines: [op.reason, ...(op.replacedBy ? [`Replaced by ${label(op.replacedBy)}`] : [])] };
    case 'removeTerm':
      return { verb: 'Remove term', tone: 'remove', title: label(op.iri), lines: ['Breaking: data using this term will no longer validate'] };
    case 'renameTerm':
      return { verb: 'Rename', tone: 'modify', title: label(op.iri), lines: [`New local name: ${op.newLocalName}`] };
    case 'setMetadata':
      return {
        verb: 'Update ontology metadata',
        tone: 'modify',
        title: '',
        lines: Object.entries(op.set).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`),
      };
    case 'addImport':
      return { verb: 'Import', tone: 'add', title: op.iri, lines: [] };
    default: {
      const o = op as { op: string };
      return { verb: o.op, tone: 'modify', title: '', lines: [JSON.stringify(op)] };
    }
  }
}

export function isClass(t: TermView): t is ClassView {
  return t.kind === 'class';
}
export function isProperty(t: TermView): t is PropertyView {
  return t.kind === 'objectProperty' || t.kind === 'datatypeProperty' || t.kind === 'annotationProperty';
}
