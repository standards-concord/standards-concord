import type { ChangeOp, ChangeRequest, OntologyView } from '@concord/shared';
import type { Restriction, TermAnnotations } from '@concord/core/types';
import { isValidLocalName } from '@concord/core/term-rules';
import { allTerms } from './ontology';

/** The same token updateOps uses for AI revisions, from the exact edits loaded by the page. */
export const changeEditsBasis = (cr: ChangeRequest) => `${cr.opsUpdatedAt ?? cr.createdAt} ${JSON.stringify(cr.ops)}`;

export type AddedOp = Extract<ChangeOp, { localName: string }>;
export const isAddedOp = (op: ChangeOp): op is AddedOp => 'localName' in op;

export function draftedNameError(op: AddedOp, name: string, namespace: string, view: OntologyView, ops: ChangeOp[], index: number) {
  const kind = op.op === 'addClass' || op.op === 'addConceptScheme' ? 'class' : op.op === 'addObjectProperty' || op.op === 'addDatatypeProperty' ? 'property' : 'individual';
  if (!isValidLocalName(name, kind)) return kind === 'class' ? 'Use UpperCamelCase letters and digits, starting with a capital letter.' : kind === 'property' ? 'Use lowerCamelCase letters and digits, starting with a small letter.' : 'Use letters, digits and hyphens, starting with a letter or digit.';
  if (allTerms(view).some((t) => t.iri === namespace + name) || ops.some((o, i) => i !== index && ((isAddedOp(o) && o.localName === name) || (o.op === 'renameTerm' && o.newLocalName === name)))) return 'This IRI is already used. Choose another local name.';
}

/** Rewrite references, never prose or annotation expectations (which record the starting values). */
export function rewriteOpIris(op: ChangeOp, oldIri: string, newIri: string, prefixes: Record<string, string> = {}): ChangeOp {
  const iri = (value: string): string => {
    if (value === oldIri) return newIri;
    const colon = value.indexOf(':');
    if (colon >= 0 && prefixes[value.slice(0, colon)] + value.slice(colon + 1) === oldIri) return newIri;
    return value;
  };
  const list = (values: string[] | undefined) => values?.map(iri);
  const record = (values: Record<string, string[]>) => Object.fromEntries(Object.entries(values).map(([key, values]) => [iri(key), values.map(iri)]));
  const annotations = <T extends TermAnnotations>(a: T): T => ({ ...a, ...(a.source && { source: list(a.source) }), ...(a.mappings && { mappings: record(a.mappings) }) });
  const restriction = (r: Restriction): Restriction => ({ ...r, property: iri(r.property), ...(r.filler !== undefined && { filler: iri(r.filler) }),
    ...(r.fillerExpression !== undefined && { fillerExpression: r.fillerExpression.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|<[^>]*>|[^\s()]+/g, (token) => {
      if (token.startsWith('"') || token.startsWith("'")) return token;
      if (token.startsWith('<')) return `<${iri(token.slice(1, -1))}>`;
      const rewritten = iri(token);
      return rewritten === token ? token : `<${rewritten}>`;
    }) }),
  });
  switch (op.op) {
    case 'addClass': return { ...annotations(op), ...(op.subClassOf && { subClassOf: list(op.subClassOf) }), ...(op.equivalentTo && { equivalentTo: list(op.equivalentTo) }), ...(op.disjointWith && { disjointWith: list(op.disjointWith) }), ...(op.restrictions && { restrictions: op.restrictions.map(restriction) }) };
    case 'addObjectProperty': return { ...annotations(op), ...(op.domain && { domain: list(op.domain) }), ...(op.range && { range: list(op.range) }), ...(op.subPropertyOf && { subPropertyOf: list(op.subPropertyOf) }), ...(op.inverseOf && { inverseOf: iri(op.inverseOf) }), ...(op.codeList && { codeList: iri(op.codeList) }) };
    case 'addDatatypeProperty': return { ...annotations(op), ...(op.domain && { domain: list(op.domain) }), ...(op.range && { range: list(op.range) }), ...(op.subPropertyOf && { subPropertyOf: list(op.subPropertyOf) }) };
    case 'addIndividual': return { ...annotations(op), types: op.types.map(iri), ...(op.facts && { facts: record(op.facts) }) };
    case 'addConceptScheme': return annotations(op);
    case 'addConcept': return { ...annotations(op), scheme: iri(op.scheme), ...(op.broader && { broader: iri(op.broader) }) };
    case 'updateAnnotations': return { ...op, iri: iri(op.iri), set: annotations(op.set) };
    case 'updateConcept': return { ...op, iri: iri(op.iri) };
    case 'moveConcept': return { ...op, iri: iri(op.iri), broader: op.broader === null ? null : iri(op.broader), ...(op.expect && { expect: { broader: op.expect.broader === null ? null : iri(op.expect.broader) } }) };
    case 'setCodeList': return { ...op, property: iri(op.property), scheme: op.scheme === null ? null : iri(op.scheme) };
    case 'setSuperClasses': return { ...op, iri: iri(op.iri), superClasses: op.superClasses.map(iri) };
    case 'setDomainRange': return { ...op, iri: iri(op.iri), ...(op.domain && { domain: list(op.domain) }), ...(op.range && { range: list(op.range) }) };
    case 'addRestriction': case 'removeRestriction': return { ...op, classIri: iri(op.classIri), restriction: restriction(op.restriction) };
    case 'addDisjointness': case 'removeDisjointness': return { ...op, classes: op.classes.map(iri) };
    case 'deprecateTerm': case 'deprecateConcept': return { ...op, iri: iri(op.iri), ...(op.replacedBy && { replacedBy: iri(op.replacedBy) }) };
    case 'setCharacteristics': case 'removeTerm': case 'renameTerm': case 'addImport': return { ...op, iri: iri(op.iri) };
    case 'setMetadata': {
      const set = { ...op.set };
      for (const key of ['versionIRI', 'priorVersion', 'license', 'publisher', 'preferredNamespace'] as const) if (set[key] !== undefined) set[key] = iri(set[key]);
      for (const key of ['backwardCompatibleWith', 'incompatibleWith', 'creators', 'contributors'] as const) if (set[key]) set[key] = list(set[key]);
      return { ...op, set };
    }
    default: { const unreachable: never = op; return unreachable; }
  }
}

/** Rename the new term and every reference to it in one immutable edit list. */
export function renameDraftedTerm(ops: ChangeOp[], index: number, name: string, namespace: string, prefixes: Record<string, string> = {}): ChangeOp[] {
  const op = ops[index];
  if (!op || !isAddedOp(op)) return ops;
  return ops.map((other, i) => {
    const rewritten = rewriteOpIris(other, namespace + op.localName, namespace + name, prefixes);
    return i === index && isAddedOp(rewritten) ? { ...rewritten, localName: name } : rewritten;
  });
}

export function dependentEdits(ops: ChangeOp[], index: number, namespace: string, prefixes: Record<string, string> = {}): number[] {
  const op = ops[index];
  if (!op || !isAddedOp(op)) return [];
  return ops.flatMap((other, i) => i !== index && JSON.stringify(other) !== JSON.stringify(rewriteOpIris(other, namespace + op.localName, namespace + '__removed__', prefixes)) ? [i] : []);
}
