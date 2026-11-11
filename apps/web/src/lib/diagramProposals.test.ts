import { describe, expect, it } from 'vitest';
import type { ClassView, OntologyView } from '@concord/core/types';
import { buildModel, XSD } from './ontologyModel';
import { buildProposalPreview, changesToOps, deriveLocalName, describeChange, localNameError, proposalTitle, subclassEdgeKey, superClassesFor, undoChange, wouldCreateCycle, type HowMany, type PendingChange } from './diagramProposals';

const NS = 'https://example.org/test#';
const iri = (name: string) => NS + name;
const cls = (name: string, parents: string[] = []): ClassView => ({ iri: iri(name), kind: 'class', label: name.toLowerCase(), superClasses: parents.map(iri), equivalentClasses: [], disjointWith: [], restrictions: [] });
const view: OntologyView = { metadata: { iri: NS, creators: [], contributors: [], imports: [] }, classes: [cls('Person'), cls('Volunteer', ['Person']), cls('Shift')], objectProperties: [], datatypeProperties: [], annotationProperties: [], individuals: [], prefixes: {}, tripleCount: 0 };
const added: PendingChange = { id: 'class', kind: 'class', localName: 'Coordinator', label: 'coordinator', definition: 'A person who coordinates shifts.', parent: iri('Person') };
const relationship: PendingChange = { id: 'relationship', kind: 'relationship', localName: 'coordinates', label: 'coordinates', definition: 'Connects a coordinator to a shift.', from: iri('Coordinator'), to: iri('Shift'), howMany: 'min' };
const attribute: PendingChange = { id: 'attribute', kind: 'attribute', localName: 'startDate', label: 'start date', definition: 'The date a shift starts.', classIri: iri('Shift'), range: XSD + 'date', howMany: 'exactly' };
const label = (i: string) => i.slice(NS.length).toLowerCase();

describe('diagram proposals', () => {
  it('derives class and property names from labels, retaining only ASCII letters and digits', () => {
    expect(deriveLocalName('volunteer coordinator', 'class')).toBe('VolunteerCoordinator');
    expect(deriveLocalName('start date', 'property')).toBe('startDate');
    expect(deriveLocalName('  café — shift (2)! ', 'class')).toBe('CafeShift2');
    expect(deriveLocalName('alreadyCamelCase', 'property')).toBe('alreadyCamelCase');
    expect(deriveLocalName('你好 !', 'class')).toBe('');
  });

  it('refuses existing and pending names regardless of case or term kind', () => {
    const withIndividual = { ...view, individuals: [{ iri: iri('Record'), kind: 'individual' as const, types: [], facts: {} }] };
    for (const name of ['Person', 'person', 'PERSON', 'Record']) expect(localNameError(name, NS, withIndividual, [])).toMatch(/already used/);
    expect(localNameError('coordinator', NS, view, [added])).toMatch(/already used/);
    expect(localNameError('STARTDATE', NS, view, [attribute])).toMatch(/already used/);
    for (const name of ['', 'two words', 'café', 'two-words']) expect(localNameError(name, NS, view, [])).toBeTruthy();
    expect(localNameError('NewThing2', NS, view, [added])).toBeUndefined();
  });

  it('emits new classes first, properties next, then restrictions and full superclass lists', () => {
    const superclass: PendingChange = { id: 'super', kind: 'superclass', classIri: iri('Shift'), parent: iri('Coordinator'), mode: 'add', superClasses: [iri('Coordinator')] };
    const ops = changesToOps([superclass, relationship, attribute, added], NS);
    expect(ops).toEqual([
      { op: 'addClass', localName: 'Coordinator', label: added.label, definition: added.definition, subClassOf: [iri('Person')] },
      { op: 'addObjectProperty', localName: relationship.localName, label: relationship.label, definition: relationship.definition, domain: [iri('Coordinator')], range: [iri('Shift')] },
      { op: 'addDatatypeProperty', localName: attribute.localName, label: attribute.label, definition: attribute.definition, domain: [iri('Shift')], range: [XSD + 'date'] },
      { op: 'addRestriction', classIri: iri('Coordinator'), restriction: { property: iri('coordinates'), kind: 'min', filler: iri('Shift'), cardinality: 1 } },
      { op: 'addRestriction', classIri: iri('Shift'), restriction: { property: iri('startDate'), kind: 'exactly', filler: XSD + 'date', cardinality: 1 } },
      { op: 'setSuperClasses', iri: iri('Shift'), superClasses: [iri('Coordinator')] },
    ]);
    const child: PendingChange = { ...added, id: 'child', localName: 'JuniorCoordinator', parent: iri('Coordinator') };
    expect(changesToOps([child, added], NS).map((o) => o.op === 'addClass' && o.localName)).toEqual(['Coordinator', 'JuniorCoordinator']);
    expect(changesToOps([{ ...added, parent: undefined }], NS)[0]).toMatchObject({ subClassOf: [] });
  });

  it.each(['any', 'min', 'exactly', 'max'] as HowMany[])('maps %s counts to the same restriction for attributes and relationships', (howMany) => {
    for (const item of [attribute, relationship]) {
      const ops = changesToOps([{ ...item, howMany }], NS);
      expect(ops).toHaveLength(howMany === 'any' ? 1 : 2);
      if (howMany !== 'any') expect(ops[1]).toMatchObject({ op: 'addRestriction', restriction: { kind: howMany, cardinality: 1, filler: item.kind === 'attribute' ? XSD + 'date' : iri('Shift') } });
    }
  });

  it('replaces or extends the complete parent list, without duplicate parents', () => {
    expect(superClassesFor([iri('Person')], iri('Shift'), 'replace')).toEqual([iri('Shift')]);
    expect(superClassesFor([iri('Person')], iri('Shift'), 'add')).toEqual([iri('Person'), iri('Shift')]);
    expect(superClassesFor([iri('Person')], iri('Person'), 'add')).toEqual([iri('Person')]);
  });

  it('refuses a class itself, descendants and cycles through proposed classes or superclass changes', () => {
    const model = buildModel(view);
    expect(wouldCreateCycle(model, iri('Person'), iri('Person'))).toBe(true);
    expect(wouldCreateCycle(model, iri('Person'), iri('Volunteer'))).toBe(true);
    expect(wouldCreateCycle(model, iri('Volunteer'), iri('Person'))).toBe(false);
    expect(wouldCreateCycle(buildProposalPreview(view, [added], NS).model, iri('Person'), iri('Coordinator'))).toBe(true);
    const changed: PendingChange = { kind: 'superclass', id: 's', classIri: iri('Shift'), parent: iri('Volunteer'), mode: 'replace', superClasses: [iri('Volunteer')] };
    expect(wouldCreateCycle(buildProposalPreview(view, [changed], NS).model, iri('Person'), iri('Shift'))).toBe(true);
  });

  it('undo removes direct and transitive dependents while preserving unrelated proposals', () => {
    const child: PendingChange = { ...added, id: 'child', localName: 'Junior', parent: iri('Coordinator') };
    const childAttribute: PendingChange = { ...attribute, id: 'child-attribute', classIri: iri('Junior') };
    const superclass: PendingChange = { id: 'super', kind: 'superclass', classIri: iri('Volunteer'), parent: iri('Coordinator'), mode: 'replace', superClasses: [iri('Coordinator')] };
    expect(undoChange([added, relationship, child, childAttribute, superclass, attribute], added.id, NS)).toEqual({ items: [attribute], alsoRemoved: 4 });
    expect(undoChange([added, relationship, attribute], relationship.id, NS)).toEqual({ items: [added, attribute], alsoRemoved: 0 });
  });

  it('describes proposals as plain sentences and derives the batch title', () => {
    expect(describeChange(added, label)).toBe('Add class “coordinator”, subclass of “person”');
    expect(describeChange(attribute, label)).toBe('Add attribute “start date” (date) to “shift”, exactly one');
    expect(describeChange(relationship, label)).toBe('Add relationship “coordinates” from “coordinator” to “shift”, at least one');
    expect(proposalTitle([added, relationship, attribute], label)).toBe('Add coordinator and 2 more changes');
  });

  it('builds the preview in the existing model, including cardinalities, without changing the ontology', () => {
    const snapshot = JSON.stringify(view);
    const replaced: PendingChange = { id: 'super', kind: 'superclass', classIri: iri('Volunteer'), parent: iri('Shift'), mode: 'replace', superClasses: [iri('Shift')] };
    const preview = buildProposalPreview(view, [added, relationship, attribute, replaced], NS);
    expect(preview.model.parents.get(iri('Volunteer'))).toEqual([iri('Shift')]);
    expect(preview.model.parents.get(iri('Coordinator'))).toEqual([iri('Person')]);
    expect(preview.subclassEdges.has(subclassEdgeKey(iri('Volunteer'), iri('Shift')))).toBe(true);
    expect(preview.model.ownSlots(iri('Shift'))[0]).toMatchObject({ min: 1, max: 1, range: [XSD + 'date'] });
    expect(preview.model.ownSlots(iri('Coordinator'))[0]).toMatchObject({ min: 1, max: '*', range: [iri('Shift')] });
    expect(preview.classes).toEqual(new Set([iri('Coordinator')]));
    expect(preview.scope.has(iri('Shift'))).toBe(true);
    expect(JSON.stringify(view)).toBe(snapshot);
  });
});
