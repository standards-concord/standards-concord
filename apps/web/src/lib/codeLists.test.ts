import { describe, expect, it } from 'vitest';
import { OntologyGraph, isValidLocalName } from '@concord/core';
import { codeListNamespace, derivedCodeName } from './codeLists';
import { describeOp } from './ontology';

const iri = 'https://example.org/activity';
const view = () => OntologyGraph.empty({ iri, namespace: iri + '#', prefix: 'act', title: 'Activities' }).view();
describe('code list form names', () => {
  it('derives engine-valid names, and leaves invalid starts for the inline validation', () => {
    expect(derivedCodeName('Activity types', true)).toBe('ActivityTypes');
    expect(derivedCodeName('Gardening & planting')).toBe('gardening-planting');
    expect(derivedCodeName(' Café / art ')).toBe('cafe-art');
    expect(isValidLocalName(derivedCodeName('Activity types', true), 'class')).toBe(true);
    expect(isValidLocalName(derivedCodeName('Gardening & planting'), 'individual')).toBe(true);
    expect(isValidLocalName(derivedCodeName('12 types', true), 'class')).toBe(false);
  });
  it('uses the same namespace fallback order as the engine', () => {
    const v = view();
    expect(codeListNamespace(v)).toBe(iri + '#');
    v.metadata.preferredNamespace = 'https://codes.example/';
    expect(codeListNamespace(v)).toBe('https://codes.example/');
    delete v.metadata.preferredNamespace;
    v.prefixes = { act: iri + '/' };
    expect(codeListNamespace(v)).toBe(iri + '/');
    v.prefixes = {};
    expect(codeListNamespace(v)).toBe(iri + '#');
    v.metadata.iri = iri + '/';
    expect(codeListNamespace(v)).toBe(iri + '/');
  });
});

describe('code list change request previews', () => {
  const labels: Record<string, string> = { list: 'Activity types', parent: 'outdoor', code: 'gardening', property: 'has activity type', replacement: 'planting' };
  const label = (iri: string) => labels[iri] ?? iri;
  it('names the new code, notation, parent and list', () => {
    expect(describeOp({ op: 'addConcept', localName: 'gardening', label: 'gardening', definition: 'Growing plants.', notation: 'GARD', scheme: 'list', broader: 'parent' }, label)).toMatchObject({ verb: 'Add code', title: '“gardening” (GARD) under “outdoor” to “Activity types”' });
  });
  it('explains moving, deprecating and using a list for a property', () => {
    expect(describeOp({ op: 'moveConcept', iri: 'code', broader: null }, label).title).toBe('“gardening” to the top level');
    expect(describeOp({ op: 'deprecateConcept', iri: 'code', reason: 'Too broad', replacedBy: 'replacement' }, label).title).toBe('“gardening”: Too broad, use “planting” instead');
    expect(describeOp({ op: 'setCodeList', property: 'property', scheme: 'list' }, label)).toMatchObject({ verb: 'Values of', title: '“has activity type” come from “Activity types”' });
    expect(describeOp({ op: 'updateConcept', iri: 'code', set: { notation: 'NEW', altLabels: ['growing'] } }, label).lines).toEqual(['Code: NEW', 'Also known as: growing']);
  });
});
