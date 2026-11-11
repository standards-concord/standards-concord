import { applyChangeOps, isValidLocalName, OntologyGraph, termNamespace } from '@concord/core';
import { describe, expect, it } from 'vitest';
import type { ClassView, OntologyView } from '@concord/core/types';
import { buildModel, XSD } from './ontologyModel';
import { buildProposalPreview, changesToOps, deriveLocalName, describeChange, localNameError, proposalTitle, proposalError, replaySuperClasses, undoFocusTarget, subclassEdgeKey, superClassesFor, undoChange, wouldCreateCycle, type HowMany, type PendingChange } from './diagramProposals';

const NS = 'https://example.org/test#';
const iri = (name: string) => NS + name;
const cls = (name: string, parents: string[] = []): ClassView => ({ iri: iri(name), kind: 'class', label: name.toLowerCase(), superClasses: parents.map(iri), equivalentClasses: [], disjointWith: [], restrictions: [] });
const view: OntologyView = { metadata: { iri: NS, creators: [], contributors: [], imports: [] }, classes: [cls('Person'), cls('Volunteer', ['Person']), cls('Shift')], objectProperties: [], datatypeProperties: [], annotationProperties: [], individuals: [], conceptSchemes: [], concepts: [], prefixes: {}, tripleCount: 0 };
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
    expect(deriveLocalName('你好 !', 'class')).toBe('Term');
  });

  it('refuses existing and pending names regardless of case or term kind', () => {
    const withIndividual = { ...view, individuals: [{ iri: iri('Record'), kind: 'individual' as const, types: [], facts: {} }] };
    for (const name of ['Person', 'person', 'PERSON', 'Record']) expect(localNameError(name, NS, withIndividual, [], 'class')).toMatch(/already used/);
    expect(localNameError('coordinator', NS, view, [added], 'class')).toMatch(/already used/);
    expect(localNameError('STARTDATE', NS, view, [attribute], 'property')).toMatch(/already used/);
    for (const name of ['', 'two words', 'café', 'two-words']) expect(localNameError(name, NS, view, [], 'class')).toBeTruthy();
    expect(localNameError('NewThing2', NS, view, [added], 'class')).toBeUndefined();
  });

  it('emits new classes first, properties next, then restrictions and full superclass lists', () => {
    const superclass: PendingChange = { id: 'super', kind: 'superclass', classIri: iri('Shift'), parent: iri('Coordinator'), mode: 'add' };
    const ops = changesToOps([superclass, relationship, attribute, added], NS, view);
    expect(ops).toEqual([
      { op: 'addClass', localName: 'Coordinator', label: added.label, definition: added.definition, subClassOf: [iri('Person')] },
      { op: 'addObjectProperty', localName: relationship.localName, label: relationship.label, definition: relationship.definition, domain: [iri('Coordinator')], range: [iri('Shift')] },
      { op: 'addDatatypeProperty', localName: attribute.localName, label: attribute.label, definition: attribute.definition, domain: [iri('Shift')], range: [XSD + 'date'] },
      { op: 'addRestriction', classIri: iri('Coordinator'), restriction: { property: iri('coordinates'), kind: 'min', filler: iri('Shift'), cardinality: 1 } },
      { op: 'addRestriction', classIri: iri('Shift'), restriction: { property: iri('startDate'), kind: 'exactly', filler: XSD + 'date', cardinality: 1 } },
      { op: 'setSuperClasses', iri: iri('Shift'), superClasses: [iri('Coordinator')] },
    ]);
    const child: PendingChange = { ...added, id: 'child', localName: 'JuniorCoordinator', parent: iri('Coordinator') };
    expect(changesToOps([child, added], NS, view).map((o) => o.op === 'addClass' && o.localName)).toEqual(['Coordinator', 'JuniorCoordinator']);
    expect(changesToOps([{ ...added, parent: undefined }], NS, view)[0]).toMatchObject({ subClassOf: [] });
  });

  it.each(['any', 'min', 'exactly', 'max'] as HowMany[])('maps %s counts to the same restriction for attributes and relationships', (howMany) => {
    for (const item of [attribute, relationship]) {
      const ops = changesToOps([{ ...item, howMany }], NS, { ...view, classes: [...view.classes, cls('Coordinator')] });
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
    const changed: PendingChange = { kind: 'superclass', id: 's', classIri: iri('Shift'), parent: iri('Volunteer'), mode: 'replace' };
    expect(wouldCreateCycle(buildProposalPreview(view, [changed], NS).model, iri('Person'), iri('Shift'))).toBe(true);
  });

  it('undo removes direct and transitive dependents while preserving unrelated proposals', () => {
    const child: PendingChange = { ...added, id: 'child', localName: 'Junior', parent: iri('Coordinator') };
    const childAttribute: PendingChange = { ...attribute, id: 'child-attribute', classIri: iri('Junior') };
    const superclass: PendingChange = { id: 'super', kind: 'superclass', classIri: iri('Volunteer'), parent: iri('Coordinator'), mode: 'replace' };
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
    const replaced: PendingChange = { id: 'super', kind: 'superclass', classIri: iri('Volunteer'), parent: iri('Shift'), mode: 'replace' };
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

describe('diagram proposal review regressions', () => {
  const external = 'https://other.example/vocab#Parent';
  const withExternal: OntologyView = { ...view, classes: view.classes.map((c) => c.iri === iri('Volunteer') ? { ...c, superClasses: [iri('Person'), external] } : c) };
  const addParent: PendingChange = { id: 'add-parent', kind: 'superclass', classIri: iri('Volunteer'), parent: iri('Shift'), mode: 'add' };

  it('preserves undeclared external asserted parents in preview, descriptions and generated ops', () => {
    // The diagram filters out external classes, but setSuperClasses must retain their axioms.
    expect(buildModel(withExternal).parents.get(iri('Volunteer'))).toEqual([iri('Person')]);
    const preview = buildProposalPreview(withExternal, [addParent], NS);
    const expected = [iri('Person'), external, iri('Shift')];
    expect(preview.model.classes.get(iri('Volunteer'))?.superClasses).toEqual(expected);
    expect(preview.superClasses.get(addParent.id)).toEqual(expected);
    expect(describeChange(addParent, (i) => i, preview.superClasses.get(addParent.id))).toContain(external);
    expect(changesToOps([addParent], NS, withExternal)).toEqual([{ op: 'setSuperClasses', iri: iri('Volunteer'), superClasses: expected }]);
    expect(changesToOps([{ ...addParent, mode: 'replace' }], NS, withExternal)).toEqual([{ op: 'setSuperClasses', iri: iri('Volunteer'), superClasses: [iri('Shift')] }]);
  });

  it('replays remaining intents after undo without retaining undone parent snapshots', () => {
    const first: PendingChange = { ...addParent, id: 'first', parent: iri('Person'), mode: 'replace' };
    const all = [first, addParent];
    const remaining = undoChange(all, first.id, NS).items;
    const expected = [iri('Person'), external, iri('Shift')];
    expect(replaySuperClasses(withExternal, remaining, NS).parents.get(iri('Volunteer'))).toEqual(expected);
    expect(changesToOps(remaining, NS, withExternal)[0]).toMatchObject({ superClasses: expected });
    const another: PendingChange = { ...addParent, id: 'another', parent: iri('Person') };
    const afterUndo = undoChange([addParent, another], addParent.id, NS).items;
    expect(changesToOps(afterUndo, NS, withExternal)[0]).toMatchObject({ superClasses: [iri('Person'), external] });
    expect(buildProposalPreview(withExternal, afterUndo, NS).model.classes.get(iri('Volunteer'))?.superClasses).not.toContain(iri('Shift'));
  });

  it('retains but blocks proposals that become cyclic after undo, and allows fixing them', () => {
    // Volunteer -> Person initially. Undoing the first edit makes the second form a cycle.
    const first: PendingChange = { ...addParent, mode: 'replace' };
    const second: PendingChange = { ...addParent, id: 'second', classIri: iri('Person'), parent: iri('Volunteer') };
    expect(proposalError(view, [first, second], NS)).toBeUndefined();
    const remaining = undoChange([first, second], first.id, NS).items;
    expect(remaining).toEqual([second]);
    expect(proposalError(view, remaining, NS)).toMatch(/subclasses/);
    expect(() => changesToOps(remaining, NS, view)).toThrow(/subclasses/);
    expect(buildProposalPreview(view, remaining, NS).model.classes.has(iri('Person'))).toBe(true);
    const repair: PendingChange = { ...first, id: 'repair' };
    expect(proposalError(view, [...remaining, repair], NS)).toBeUndefined();
  });

  it('checks preserved superclass intersections when adding, undoing and sending superclass changes', async () => {
    // Undo used to make A -> B -> (C and D), C -> A sendable because validation omitted B's conjuncts.
    const graph = await OntologyGraph.fromTurtle(`
      @prefix ex: <${NS}> .
      @prefix owl: <http://www.w3.org/2002/07/owl#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      ex:A a owl:Class; rdfs:subClassOf ex:B .
      ex:B a owl:Class; rdfs:subClassOf [ a owl:Class; owl:intersectionOf (ex:C ex:D) ] .
      ex:C a owl:Class . ex:D a owl:Class . ex:E a owl:Class .
    `);
    const intersected = graph.view();
    expect(intersected.classes.find((c) => c.iri === iri('B'))?.superClassConjuncts?.[0].classes).toEqual([iri('C'), iri('D')]);
    const first: PendingChange = { id: 'first', kind: 'superclass', classIri: iri('A'), parent: iri('E'), mode: 'replace' };
    const second: PendingChange = { id: 'second', kind: 'superclass', classIri: iri('C'), parent: iri('A'), mode: 'add' };
    expect(wouldCreateCycle(buildModel(intersected), iri('C'), iri('A'))).toBe(true);
    expect(proposalError(intersected, [second], NS)).toMatch(/subclasses/);
    expect(wouldCreateCycle(buildProposalPreview(intersected, [first], NS).model, iri('C'), iri('A'))).toBe(false);
    expect(proposalError(intersected, [first, second], NS)).toBeUndefined();
    expect(() => changesToOps([first, second], NS, intersected)).not.toThrow();
    const remaining = undoChange([first, second], first.id, NS).items;
    expect(remaining).toEqual([second]);
    expect(buildProposalPreview(intersected, remaining, NS).model.parents.get(iri('B'))).toEqual([iri('C'), iri('D')]);
    expect(proposalError(intersected, remaining, NS)).toMatch(/subclasses/);
    expect(() => changesToOps(remaining, NS, intersected)).toThrow(/subclasses/);
    // Replacing B's direct parents still preserves its anonymous intersection axiom.
    const replaceB: PendingChange = { ...first, id: 'replace-b', classIri: iri('B') };
    expect(proposalError(intersected, [replaceB, second], NS)).toMatch(/subclasses/);
    expect(() => changesToOps([replaceB, second], NS, intersected)).toThrow(/subclasses/);
  });

  it('blocks missing references before generating ops without dropping proposals', () => {
    for (const item of [
      { ...added, parent: iri('Missing') },
      { ...attribute, classIri: iri('Missing') },
      { ...relationship, from: iri('Person'), to: iri('Missing') },
      { ...addParent, classIri: iri('Missing') },
      { ...addParent, parent: iri('Missing') },
    ] as PendingChange[]) {
      expect(proposalError(view, [item], NS)).toMatch(/no longer available/);
      expect(() => changesToOps([item], NS, view)).toThrow(/no longer available/);
    }
  });

  it.each(['class', 'property'] as const)('uses the exact core validation rule for %s names', (kind) => {
    for (const name of ['1Thing', 'thing', 'Thing', 'aThing', 'AThing', 'A_thing', 'a-thing', 'éclair', '']) {
      expect(!localNameError(name, NS, { ...view, classes: [] }, [], kind)).toBe(isValidLocalName(name, kind));
    }
    for (const text of ['123 things', '9', '你好', '!!!', 'éclair', 'alreadyCamelCase']) {
      expect(isValidLocalName(deriveLocalName(text, kind), kind)).toBe(true);
    }
  });

  it('revalidates saved names, definitions and clashes again at the ops boundary', () => {
    for (const item of [
      { ...added, localName: '1Thing' }, { ...added, localName: 'lowercase' },
      { ...attribute, localName: 'Uppercase' }, { ...relationship, localName: 'Uppercase', from: iri('Person') },
      { ...added, localName: 'Person' }, { ...added, definition: '' },
    ] as PendingChange[]) {
      expect(proposalError(view, [item], NS)).toBeTruthy();
      expect(() => changesToOps([item], NS, view)).toThrow();
    }
  });

  it('blocks cyclic new-class declarations even if a later intent repairs the final preview', () => {
    const first: PendingChange = { ...added, parent: iri('Junior') };
    const second: PendingChange = { ...added, id: 'junior', localName: 'Junior', parent: iri('Coordinator') };
    const repair: PendingChange = { id: 'repair', kind: 'superclass', classIri: iri('Coordinator'), parent: iri('Person'), mode: 'replace' };
    expect(proposalError(view, [first, second, repair], NS)).toMatch(/subclasses/);
    expect(() => changesToOps([first, second, repair], NS, view)).toThrow(/subclasses/);
    expect(proposalError(view, [added, { ...attribute, id: added.id }], NS)).toMatch(/duplicate identifiers/);
  });

  it('chooses the next Undo, then the previous Undo, then Add class, including cascades', () => {
    const items = [attribute, added, relationship];
    expect(undoFocusTarget(items, attribute.id, [added, relationship])).toBe(added.id);
    expect(undoFocusTarget(items, added.id, [attribute, relationship])).toBe(relationship.id);
    expect(undoFocusTarget(items, relationship.id, [attribute, added])).toBe(added.id);
    const remaining = undoChange(items, added.id, NS).items;
    expect(undoFocusTarget(items, added.id, remaining)).toBe(attribute.id);
    expect(undoFocusTarget([added, relationship], added.id, [])).toBeNull();
  });

  async function baseGraph() {
    return OntologyGraph.fromTurtle(`
      @prefix ex: <${NS}> .
      @prefix owl: <http://www.w3.org/2002/07/owl#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix vann: <http://purl.org/vocab/vann/> .
      <https://example.org/test> a owl:Ontology; vann:preferredNamespaceUri "${NS}" .
      ex:Person a owl:Class .
      ex:Volunteer a owl:Class; rdfs:subClassOf ex:Person, <${external}> .
      ex:Shift a owl:Class .
    `);
  }

  it.each(['any', 'min', 'exactly', 'max'] as HowMany[])('round-trips generated class, attribute and relationship ops with %s through core', async (howMany) => {
    const graph = await baseGraph();
    const items: PendingChange[] = [added, { ...attribute, howMany }, { ...relationship, howMany }];
    const ops = changesToOps(items, graph.namespace, graph.view());
    const result = applyChangeOps(graph, ops).graph.view();
    const preview = buildProposalPreview(graph.view(), items, graph.namespace);
    expect(result.classes.find((c) => c.iri === iri('Coordinator'))?.superClasses).toEqual([iri('Person')]);
    expect(result.datatypeProperties.find((p) => p.iri === iri('startDate'))).toMatchObject({ domain: [iri('Shift')], range: [XSD + 'date'] });
    expect(result.objectProperties.find((p) => p.iri === iri('coordinates'))).toMatchObject({ domain: [iri('Coordinator')], range: [iri('Shift')] });
    for (const [className, property, filler] of [['Shift', 'startDate', XSD + 'date'], ['Coordinator', 'coordinates', iri('Shift')]]) {
      const restrictions = result.classes.find((c) => c.iri === iri(className))!.restrictions;
      expect(restrictions).toEqual(howMany === 'any' ? [] : [expect.objectContaining({ property: iri(property), kind: howMany, cardinality: 1, filler })]);
      expect(preview.model.classes.get(iri(className))!.restrictions).toEqual(restrictions);
    }
  });

  it.each(['replace', 'add'] as const)('round-trips superclass %s including an external parent through core', async (mode) => {
    const graph = await baseGraph();
    const items = [{ ...addParent, mode }];
    const ops = changesToOps(items, graph.namespace, graph.view());
    const result = applyChangeOps(graph, ops).graph;
    const expected = mode === 'add' ? [iri('Person'), external, iri('Shift')] : [iri('Shift')];
    expect(result.classView(iri('Volunteer')).superClasses.sort()).toEqual([...expected].sort());
    expect(buildProposalPreview(graph.view(), items, graph.namespace).model.classes.get(iri('Volunteer'))!.superClasses.sort()).toEqual([...expected].sort());
  });

  it.each([
    ['https://example.org/o', undefined, {}, 'https://example.org/o#'],
    ['https://example.org/o', undefined, { ex: 'https://example.org/o/' }, 'https://example.org/o/'],
    ['https://example.org/o', undefined, { ex: 'https://example.org/o/', other: 'https://example.org/o#' }, 'https://example.org/o#'],
    ['https://example.org/o/', undefined, {}, 'https://example.org/o/'],
    ['https://example.org/o#', undefined, {}, 'https://example.org/o#'],
    ['https://example.org/o', 'https://example.org/current/', {}, 'https://example.org/current/'],
    ['', undefined, {}, ''],
  ] as [string, string | undefined, Record<string, string>, string][])('uses the graph namespace rules for %s (%s)', async (iri, preferredNamespace, prefixes, expected) => {
    const graph = await OntologyGraph.fromTurtle(iri ? `<${iri}> a <http://www.w3.org/2002/07/owl#Ontology> .` : '');
    Object.assign(graph.prefixes, prefixes);
    const updated = preferredNamespace ? applyChangeOps(graph, [{ op: 'setMetadata', set: { preferredNamespace } }]).graph : graph;
    expect(termNamespace(updated.view().metadata, updated.view().prefixes)).toBe(updated.namespace);
    expect(updated.namespace).toBe(expected);
  });
});
