import { describe, it, expect, vi } from 'vitest';
import { OntologyGraph, lint, owlReasoner, serialize, foreignAxioms } from '../src/index.js';

const ns = 'https://example.org/codes#';
async function representation() {
  const g = OntologyGraph.empty({ iri: 'https://example.org/codes', namespace: ns, prefix: 'ex', title: 'Codes', description: 'Controlled values' });
  const raw = await OntologyGraph.fromTurtle(`
    @prefix ex: <${ns}> . @prefix owl: <http://www.w3.org/2002/07/owl#> .
    @prefix skos: <http://www.w3.org/2004/02/skos/core#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
    skos:Concept a owl:Class . skos:ConceptScheme a owl:Class .
    skos:inScheme a owl:ObjectProperty . skos:broader a owl:ObjectProperty . skos:topConceptOf a owl:ObjectProperty .
    skos:notation a owl:DatatypeProperty . skos:prefLabel a owl:AnnotationProperty .
    ex:ActivityTypes a owl:NamedIndividual, skos:ConceptScheme ; skos:prefLabel "activity types"@en ; skos:definition "Permitted activities"@en .
    ex:outdoor a owl:NamedIndividual, skos:Concept ; skos:prefLabel "outdoor"@en ; skos:definition "Outdoor activities"@en ; skos:inScheme ex:ActivityTypes ; skos:topConceptOf ex:ActivityTypes .
    ex:gardening a owl:NamedIndividual, skos:Concept ; skos:prefLabel "gardening"@en ; skos:definition "Growing plants"@en ; skos:notation "GARD" ; skos:inScheme ex:ActivityTypes ; skos:broader ex:outdoor .
    ex:indoor a owl:NamedIndividual, skos:Concept ; skos:prefLabel "indoor"@en ; skos:definition "Indoor activities"@en ; skos:inScheme ex:ActivityTypes ; skos:topConceptOf ex:ActivityTypes .
    ex:activity a owl:ObjectProperty ; rdfs:label "activity"@en ; skos:definition "The activity undertaken"@en ;
      rdfs:range [ a owl:Class ; owl:intersectionOf (skos:Concept [ a owl:Restriction ; owl:onProperty skos:inScheme ; owl:hasValue ex:ActivityTypes ]) ] .
  `);
  g.store.addQuads(raw.store.getQuads(null, null, null, null));
  return g;
}
describe('code list representation', () => {
  it('is consistent OWL 2 DL with the server sparq path', async () => {
    const result = await owlReasoner(await representation());
    expect(result.engine).toBe('sparq');
    expect(result.available).toBe(true);
    expect(result.consistent).toBe(true);
    expect(result.profile ?? []).toEqual([]);
  }, 60000);
  it('has no strict lint errors or foreign axioms and round trips RDF formats', async () => {
    const g = await representation();
    expect(lint(g, { strict: true }).filter(x => x.severity === 'error')).toEqual([]);
    const skos = OntologyGraph.empty({ iri: 'http://www.w3.org/2004/02/skos/core', namespace: 'http://www.w3.org/2004/02/skos/core#', prefix: 'skos', title: 'SKOS' });
    expect(foreignAxioms(g, [{ graph: skos, title: 'SKOS' }])).toEqual([]);
    for (const format of ['turtle', 'rdfxml', 'jsonld', 'ntriples'] as const) {
      const back = await OntologyGraph.parse(await serialize(g, format), format);
      expect(back.size, format).toBe(g.size);
    }
    const manchester = await serialize(g, 'manchester');
    expect(manchester).toContain('Individual: ex:gardening');
    expect(manchester).toContain('skos:inScheme ex:ActivityTypes');
  });
});

import { applyChangeOps, classifyChange, diffOntologies, allTerms, termDetail, NS, toShacl, toShaclc, deriveShapes, toLinkML, prepareOntology, checkData } from '../src/index.js';
import type { ChangeOp, ConceptView } from '../src/types.js';
import { nn, literal, langLit, objects, readList } from '../src/rdf.js';
import { P, T, SKOS_DECLARATIONS } from '../src/graph.js';
import YAML from 'yaml';
import { Store, DataFactory } from 'n3';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { toWrapperClasses } from '../src/codegen.js';
const I = (local: string) => ns + local;
const empty = () => OntologyGraph.empty({ iri: 'https://example.org/codes', namespace: ns, prefix: 'ex', title: 'Codes', description: 'Controlled values' });
const schemeOp: ChangeOp = { op: 'addConceptScheme', localName: 'ActivityTypes', label: 'activity types', definition: 'Permitted activities' };
const codeOp = (name: string, extra = {}): ChangeOp => ({ op: 'addConcept', scheme: I('ActivityTypes'), localName: name, label: name, definition: `The activity ${name}`, ...extra });
function governed() {
  return applyChangeOps(empty(), [schemeOp, codeOp('outdoor'), codeOp('gardening', { notation: 'GARD', broader: I('outdoor') }), codeOp('indoor'),
    { op: 'addClass', localName: 'Event', label: 'event', definition: 'An occurrence' },
    { op: 'addObjectProperty', localName: 'activity', label: 'activity', definition: 'The activity undertaken', domain: [I('Event')], codeList: I('ActivityTypes') },
  ]).graph;
}
function apply(g: OntologyGraph, ...ops: ChangeOp[]) { return applyChangeOps(g, ops).graph; }
function rules(g: OntologyGraph, ...ops: ChangeOp[]) {
  const after = apply(g, ...ops);
  return classifyChange(diffOntologies(g, after), g, after);
}

describe('governed code list operations', () => {
  // Notation checks used to rebuild every term's view for each added code.
  it('checks notation directly in the store without projecting the whole ontology', () => {
    const view = vi.spyOn(OntologyGraph.prototype, 'view');
    try {
      const graph = apply(empty(), schemeOp, codeOp('outdoor', { notation: 'OUT' }));
      expect(() => apply(graph, codeOp('another', { notation: 'OUT' }))).toThrow(/already used/);
      expect(view).not.toHaveBeenCalled();
    } finally { view.mockRestore(); }
  });
  // Code edits must reject undeclared subjects just as the other term edits do.
  it.each<ChangeOp>([
    { op: 'updateConcept', iri: I('missing'), set: { label: 'new' } },
    { op: 'moveConcept', iri: I('missing'), broader: null },
    { op: 'deprecateConcept', iri: I('missing'), reason: 'Retired' },
  ])('requires a declared term for $op', (op) => {
    expect(() => apply(governed(), op)).toThrow(/does not exist in this ontology/);
  });

  it('mints schemes and codes with provenance, SKOS labels and idempotent vocabulary declarations', async () => {
    const g = applyChangeOps(empty(), [schemeOp, codeOp('outdoor'), codeOp('gardening', { notation: 'GARD', broader: I('outdoor') })], { author: 'Ada', date: '2026-11-10', provenance: 'cr:test' }).graph;
    expect(g.term(I('ActivityTypes'))).toMatchObject({ kind: 'conceptScheme', label: 'activity types', topConcepts: [I('outdoor')] });
    expect(g.term(I('gardening'))).toMatchObject({ kind: 'concept', label: 'gardening', notation: 'GARD', inScheme: [I('ActivityTypes')], broader: [I('outdoor')], narrower: [], topConceptOf: [] });
    expect(g.term(I('outdoor'))).toMatchObject({ narrower: [I('gardening')] });
    expect(g.view().individuals).toEqual([]);
    for (const [iri, type] of SKOS_DECLARATIONS) expect(objects(g.store, iri, NS.rdf + 'type').map((t) => t.value)).toEqual([type]);
    expect(objects(g.store, I('gardening'), P.label)).toEqual([]);
    expect(objects(g.store, I('gardening'), P.created)[0].value).toBe('2026-11-10');
    expect(objects(g.store, I('gardening'), P.contributor)[0].value).toBe('Ada');
    expect(objects(g.store, I('gardening'), P.isDefinedBy)[0].value).toBe(g.ontologyIRI);
    expect(objects(g.store, I('gardening'), P.provenance)[0].value).toBe('cr:test');
    expect(g.view().classes).toEqual([]);
    expect(g.view().objectProperties).toEqual([]);
    expect(g.view().datatypeProperties).toEqual([]);
    expect(g.view().annotationProperties.some((p) => SKOS_DECLARATIONS.has(p.iri))).toBe(false);
    expect(g.search('gardening')[0].kind).toBe('concept');
    expect(apply(g, codeOp('short-code', { label: 'other activity', notation: '00X' })).search('00X')[0].iri).toBe(I('short-code'));
    expect(g.search('activity types')[0].kind).toBe('conceptScheme');
    expect(termDetail(g.view(), I('outdoor'))?.usedBy).toContainEqual({ iri: I('gardening'), label: 'gardening', via: 'broader code' });
    expect(allTerms(g.view()).filter((t) => t.kind === 'concept')).toHaveLength(2);
    const reasoned = await owlReasoner(governed());
    expect(reasoned).toMatchObject({ engine: 'sparq', available: true, consistent: true });
    expect(reasoned.profile ?? []).toEqual([]);
    expect(lint(governed(), { strict: true }).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it.each([
    [schemeOp, { ...schemeOp, localName: 'activity_types' }, /invalid local name/],
    [schemeOp, { ...schemeOp, localName: 'Other', label: '' }, /label is required/],
    [schemeOp, { ...schemeOp, localName: 'Other', definition: '' }, /definition is required/],
    [schemeOp, schemeOp, /already exists/],
    [schemeOp, codeOp('bad_name'), /invalid local name/],
    [schemeOp, codeOp('new', { scheme: I('Missing') }), /not a code list/],
    [schemeOp, codeOp('new', { definition: '' }), /definition is required/],
    [schemeOp, codeOp('new', { broader: I('ActivityTypes') }), /not a code/],
  ] as [ChangeOp, ChangeOp, RegExp][])('rejects invalid creation %#', (setup, op, error) => {
    expect(() => apply(apply(empty(), setup), op)).toThrow(error);
  });

  it('enforces per-scheme notation uniqueness on creation and update', () => {
    const g = governed();
    expect(() => apply(g, codeOp('more', { notation: 'GARD' }))).toThrow(/already used/);
    expect(() => apply(g, { op: 'updateConcept', iri: I('indoor'), set: { notation: 'GARD' } })).toThrow(/already used/);
    const h = apply(g, { ...schemeOp, localName: 'Statuses', label: 'statuses' }, codeOp('another', { scheme: I('Statuses'), notation: 'GARD' }));
    expect(h.term(I('another'))).toMatchObject({ notation: 'GARD' });
  });

  it('updates codes and schemes, keeps translations and checks expected values as sets', () => {
    const g = governed();
    g.store.addQuad(nn(I('gardening')), nn(P.prefLabel), langLit('jardinage', 'fr'));
    const h = apply(g, { op: 'updateConcept', iri: I('gardening'), set: { label: 'growing', notation: 'GROW', altLabels: ['horticulture'], examples: ['Planting'], editorialNote: 'Reviewed' }, expect: { label: 'gardening', altLabels: [], notation: 'GARD' } }, { op: 'updateConcept', iri: I('ActivityTypes'), set: { label: 'activities', definition: 'Allowed activities' }, expect: { definition: 'Permitted activities' } });
    expect(h.term(I('gardening'))).toMatchObject({ label: 'growing', notation: 'GROW', examples: ['Planting'] });
    expect(objects(h.store, I('gardening'), P.prefLabel).map((t) => t.value)).toContain('jardinage');
    expect(h.term(I('ActivityTypes'))?.label).toBe('activities');
    expect(() => apply(h, { op: 'updateConcept', iri: I('gardening'), set: { label: 'other' }, expect: { label: 'gardening' } })).toThrow(/label.*changed since/);
    expect(() => apply(h, { op: 'updateConcept', iri: I('gardening'), set: { notation: 'OTHER' }, expect: { notation: 'GARD' } })).toThrow(/notation.*changed since/);
    expect(() => apply(g, { op: 'updateConcept', iri: I('gardening'), set: { label: '' } })).toThrow(/label cannot be empty/);
    expect(() => apply(g, { op: 'updateConcept', iri: I('Event'), set: { label: 'x' } })).toThrow(/not a code or code list/);
    for (const field of ['notation', 'examples']) expect(() => apply(g, { op: 'updateConcept', iri: I('ActivityTypes'), set: { [field]: field === 'examples' ? ['x'] : 'X' } })).toThrow(/code lists have no/);
    expect(apply(h, { op: 'updateConcept', iri: I('gardening'), set: { notation: '' } }).term(I('gardening'))).toMatchObject({ notation: undefined });
  });

  it('moves codes between parents and roots, refusing cycles and cross-scheme moves', () => {
    const g = governed();
    const root = apply(g, { op: 'moveConcept', iri: I('gardening'), broader: null });
    expect(root.term(I('gardening'))).toMatchObject({ broader: [], topConceptOf: [I('ActivityTypes')] });
    const h = apply(root, { op: 'moveConcept', iri: I('gardening'), broader: I('indoor') });
    expect(h.term(I('gardening'))).toMatchObject({ broader: [I('indoor')], topConceptOf: [] });
    expect(() => apply(g, { op: 'moveConcept', iri: I('outdoor'), broader: I('gardening') })).toThrow(/cycle/);
    expect(() => apply(g, { op: 'moveConcept', iri: I('outdoor'), broader: I('outdoor') })).toThrow(/cycle/);
    expect(() => apply(g, { op: 'moveConcept', iri: I('outdoor'), broader: I('Event') })).toThrow(/not a code/);
    const two = apply(g, { ...schemeOp, localName: 'Statuses', label: 'statuses' }, codeOp('active', { scheme: I('Statuses') }));
    expect(() => apply(two, { op: 'moveConcept', iri: I('outdoor'), broader: I('active') })).toThrow(/same scheme/);
    expect(() => apply(two, codeOp('bad', { broader: I('active') }))).toThrow(/same scheme/);
  });

  it('deprecates without losing scheme membership; replacement must be a different code in the same scheme', () => {
    const g = governed();
    expect(apply(g, { op: 'deprecateConcept', iri: I('gardening'), reason: 'Use the broader code', replacedBy: I('outdoor') }).term(I('gardening'))).toMatchObject({ deprecated: true, replacedBy: I('outdoor'), inScheme: [I('ActivityTypes')] });
    expect(() => apply(g, { op: 'deprecateConcept', iri: I('gardening'), reason: '' })).toThrow(/reason is required/);
    expect(() => apply(g, { op: 'deprecateConcept', iri: I('gardening'), reason: 'x', replacedBy: I('gardening') })).toThrow(/itself/);
    expect(() => apply(g, { op: 'deprecateConcept', iri: I('gardening'), reason: 'x', replacedBy: I('Event') })).toThrow(/not a code/);
    const two = apply(g, { ...schemeOp, localName: 'Statuses', label: 'statuses' }, codeOp('active', { scheme: I('Statuses') }));
    expect(() => apply(two, { op: 'deprecateConcept', iri: I('gardening'), reason: 'x', replacedBy: I('active') })).toThrow(/same scheme/);
  });

  it('sets and clears the single range encoding and refuses non-schemes or non-object properties', () => {
    const g = governed();
    expect(g.term(I('activity'))).toMatchObject({ codeList: I('ActivityTypes'), range: [] });
    expect((g.term(I('activity')) as import('../src/types.js').PropertyView).rangeExpressions).toBeUndefined();
    expect(objects(g.store, I('activity'), P.range)).toHaveLength(1);
    const cleared = apply(g, { op: 'setCodeList', property: I('activity'), scheme: null });
    expect(objects(cleared.store, I('activity'), P.range)).toEqual([]);
    const h = apply(cleared, { op: 'setDomainRange', iri: I('activity'), range: [I('Event')] }, { op: 'setCodeList', property: I('activity'), scheme: I('ActivityTypes') });
    expect(objects(h.store, I('activity'), P.range)).toHaveLength(1);
    expect(() => apply(g, { op: 'setCodeList', property: I('Event'), scheme: I('ActivityTypes') })).toThrow(/not an object property/);
    expect(() => apply(g, { op: 'setCodeList', property: I('activity'), scheme: I('Event') })).toThrow(/not a code list/);
    expect(() => apply(g, { op: 'addObjectProperty', localName: 'other', label: 'other', definition: 'Other', range: [I('Event')], codeList: I('ActivityTypes') })).toThrow(/replaces range/);
    expect(termDetail(g.view(), I('ActivityTypes'))?.usedBy.some((u) => u.iri === I('activity') && u.via === 'code list')).toBe(true);
  });

  it('guards removal and rewrites hierarchy, membership, replacement and range references on rename', () => {
    const g = governed();
    expect(() => apply(g, { op: 'removeTerm', iri: I('ActivityTypes') })).toThrow(/still has codes/);
    expect(() => apply(g, { op: 'removeTerm', iri: I('outdoor') })).toThrow(/narrower codes/);
    expect(apply(g, { op: 'removeTerm', iri: I('gardening') }).term(I('gardening'))).toBeUndefined();
    const h = apply(g, { op: 'deprecateConcept', iri: I('indoor'), reason: 'Use outdoor', replacedBy: I('outdoor') }, { op: 'renameTerm', iri: I('outdoor'), newLocalName: 'outside' });
    expect(h.term(I('gardening'))).toMatchObject({ broader: [I('outside')] });
    expect(h.term(I('indoor'))?.replacedBy).toBe(I('outside'));
    expect(h.term(I('outdoor'))).toMatchObject({ label: 'obsolete outdoor', deprecated: true, inScheme: [I('ActivityTypes')] });
    expect(lint(h, { strict: true }).filter((i) => i.severity === 'error')).toEqual([]);
    const renamed = apply(h, { op: 'renameTerm', iri: I('ActivityTypes'), newLocalName: 'Activities' });
    expect(renamed.term(I('activity'))).toMatchObject({ codeList: I('Activities') });
    expect(renamed.term(I('outside'))).toMatchObject({ inScheme: [I('Activities')], topConceptOf: [I('Activities')] });
    expect(() => apply(g, { op: 'renameTerm', iri: I('ActivityTypes'), newLocalName: 'bad-name' })).toThrow(/invalid local name/);
  });
});

describe('code list classification', () => {
  it('uses dedicated minor addition rules, including widening a used list', () => {
    expect(rules(empty(), schemeOp).reasons.map((r) => r.rule)).toEqual(['code-list-added']);
    expect(rules(governed(), codeOp('new')).reasons.map((r) => r.rule)).toEqual(['code-added']);
    expect(rules(governed(), codeOp('new')).level).toBe('minor');
  });
  it.each([
    [{ op: 'updateConcept', iri: I('gardening'), set: { notation: 'NEW' } }, 'code-notation-changed', 'major'],
    [{ op: 'updateConcept', iri: I('gardening'), set: { notation: '' } }, 'code-notation-changed', 'major'],
    [{ op: 'updateConcept', iri: I('indoor'), set: { notation: 'IN' } }, 'code-notation-added', 'minor'],
    [{ op: 'moveConcept', iri: I('gardening'), broader: null }, 'code-moved', 'major'],
    [{ op: 'removeTerm', iri: I('gardening') }, 'code-removed', 'major'],
    [{ op: 'setCodeList', property: I('activity'), scheme: null }, 'code-list-cleared', 'minor'],
  ] as [ChangeOp, string, string][])('classifies %j cleanly', (op, rule, level) => {
    const c = rules(governed(), op);
    expect(c.level).toBe(level);
    expect(c.reasons.map((r) => r.rule)).toEqual([rule]);
  });
  // Creating a list and its first property association used to classify as major,
  // unlike other axioms that only relate an existing term to newly added terms.
  it('classifies a newly created list and its first property association as minor', () => {
    const before = apply(empty(), { op: 'addClass', localName: 'Activity', label: 'activity', definition: 'An activity' }, { op: 'addObjectProperty', localName: 'activity', label: 'activity', definition: 'Activity', range: [I('Activity')] });
    const result = rules(before, schemeOp, codeOp('outdoor'), { op: 'setCodeList', property: I('activity'), scheme: I('ActivityTypes') });
    expect(result.level).toBe('minor');
    expect(result.reasons.map((r) => r.rule)).toContain('axiom-relates-new-term');
    // Replacing an existing controlled list still changes what data is accepted.
    expect(rules(governed(), { ...schemeOp, localName: 'NewActivities' }, { op: 'setCodeList', property: I('activity'), scheme: I('NewActivities') }).level).toBe('major');
  });
  it('classifies scheme removal and property code-list additions/changes', () => {
    expect(rules(apply(empty(), schemeOp), { op: 'removeTerm', iri: I('ActivityTypes') }).reasons.map((r) => r.rule)).toEqual(['code-list-removed']);
    const g = governed();
    const cleared = apply(g, { op: 'setCodeList', property: I('activity'), scheme: null });
    const ranged = apply(cleared, { op: 'setDomainRange', iri: I('activity'), range: [I('Event')] });
    for (const before of [cleared, ranged]) expect(rules(before, { op: 'setCodeList', property: I('activity'), scheme: I('ActivityTypes') }).reasons.map((r) => r.rule)).toEqual(['code-list-set']);
    const two = apply(g, { ...schemeOp, localName: 'Statuses', label: 'statuses' });
    expect(rules(two, { op: 'setCodeList', property: I('activity'), scheme: I('Statuses') }).reasons.map((r) => r.rule)).toEqual(['code-list-set']);
    expect(rules(g, { op: 'setDomainRange', iri: I('activity'), range: [I('Event')] }).level).toBe('major');
    expect(rules(apply(empty(), schemeOp), { op: 'addObjectProperty', localName: 'activity', label: 'activity', definition: 'Activity', codeList: I('ActivityTypes') }).reasons.map((r) => r.rule)).toEqual(['term-added']);
  });
  it('reuses annotation, definition and deprecation rules', () => {
    const g = governed();
    for (const iri of [I('gardening'), I('ActivityTypes')]) {
      expect(rules(g, { op: 'updateConcept', iri, set: { label: 'different', altLabels: ['synonym'], editorialNote: 'editor note' } }).level).toBe('patch');
      expect(rules(g, { op: 'updateConcept', iri, set: { definition: 'Reworded definition' } }).reasons.map((r) => r.rule)).toEqual(['annotation-changed', 'definition-reworded']);
    }
    expect(rules(g, { op: 'deprecateConcept', iri: I('gardening'), reason: 'retired', replacedBy: I('outdoor') }).reasons.map((r) => r.rule)).toEqual(['term-deprecated']);
  });
});

describe('SKOS lint', () => {
  const errors = (g: OntologyGraph) => lint(g, { strict: true }).filter((i) => i.severity === 'error');
  it.each([
    [P.prefLabel, 'code-missing-pref-label'],
    [P.inScheme, 'code-missing-scheme'],
  ])('requires %s without generic double reporting', (predicate, code) => {
    const g = governed();
    g.store.removeQuads(g.store.getQuads(nn(I('gardening')), nn(predicate), null, null));
    expect(errors(g).map((i) => i.code)).toEqual([code]);
  });
  it('reports cycles, duplicate notations, and invalid broader targets', () => {
    const g = governed();
    g.store.addQuad(nn(I('outdoor')), nn(P.broader), nn(I('gardening')));
    expect(errors(g).map((i) => i.code)).toEqual(['code-broader-cycle']);
    const duplicate = governed();
    duplicate.store.addQuad(nn(I('indoor')), nn(P.notation), literal('GARD'));
    expect(errors(duplicate).map((i) => i.code)).toEqual(['code-duplicate-notation']);
    for (const parent of [I('Event'), I('active')]) {
      const h = apply(governed(), { ...schemeOp, localName: 'Statuses', label: 'statuses' }, codeOp('active', { scheme: I('Statuses') }));
      h.store.addQuad(nn(I('indoor')), nn(P.broader), nn(parent));
      expect(errors(h).map((i) => i.code)).toEqual(['code-invalid-broader']);
    }
  });
  it('reports invalid property schemes and missing definitions/empty lists as warnings', () => {
    const g = governed();
    for (const q of g.store.getQuads(null, nn(NS.owl + 'hasValue'), nn(I('ActivityTypes')), null)) {
      g.store.removeQuad(q); g.store.addQuad(q.subject, q.predicate, nn(I('Event')));
    }
    expect(errors(g).map((i) => i.code)).toEqual(['property-invalid-code-list']);
    const emptyScheme = apply(empty(), schemeOp);
    expect(lint(emptyScheme).some((i) => i.code === 'code-list-empty' && i.severity === 'warning')).toBe(true);
    for (const name of ['gardening', 'ActivityTypes']) {
      const h = governed();
      h.store.removeQuads(h.store.getQuads(nn(I(name)), nn(P.definition), null, null));
      expect(lint(h).filter((i) => i.iri === I(name)).map((i) => [i.code, i.severity])).toEqual([['code-missing-definition', 'warning']]);
    }
  });
  it('allows the same code labels in different schemes and catches every imported notation', () => {
    const g = apply(governed(), { ...schemeOp, localName: 'Other', label: 'other' }, codeOp('other-garden', { scheme: I('Other'), label: 'gardening', notation: 'GARD' }));
    expect(errors(g)).toEqual([]);
    g.store.addQuad(nn(I('gardening')), nn(P.notation), literal('SECOND'));
    expect(() => apply(g, codeOp('duplicate', { notation: 'SECOND' }))).toThrow(/notation.*already used/);
  });
  it('warns about duplicate same-language prefLabels (S14), allows translations and falls back for display', () => {
    const g = governed();
    g.store.addQuad(nn(I('gardening')), nn(P.prefLabel), langLit('growing plants'));
    expect(lint(g).filter((i) => i.iri === I('gardening')).map((i) => [i.code, i.severity])).toEqual([['skos-multiple-pref-labels', 'warning']]);
    const h = governed();
    h.store.addQuad(nn(I('gardening')), nn(P.prefLabel), langLit('jardinage', 'fr'));
    expect(errors(h)).toEqual([]);
    h.store.removeQuads(h.store.getQuads(nn(I('gardening')), nn(P.prefLabel), null, null));
    h.store.addQuad(nn(I('gardening')), nn(P.label), langLit('legacy label'));
    expect(h.term(I('gardening'))?.label).toBe('legacy label');
    expect(errors(h).map((i) => i.code)).toEqual(['code-missing-pref-label']);
  });
});

describe('code list exports and data checking', () => {
  it('derives sh:in with all codes, including deprecated codes, without sh:class', async () => {
    const g = apply(governed(), { op: 'deprecateConcept', iri: I('gardening'), reason: 'retired' });
    const derived = deriveShapes(g).shapes.find((s) => s.targetClass === I('Event'))!;
    expect(derived.properties[0]).toMatchObject({ path: I('activity'), in: [I('gardening'), I('indoor'), I('outdoor')] });
    expect(derived.properties[0].cls).toBeUndefined();
    const shapes = await OntologyGraph.fromTurtle(await toShacl(g));
    const p = shapes.store.getSubjects(nn(NS.sh + 'path'), nn(I('activity')), null)[0];
    expect(objects(shapes.store, p, NS.sh + 'class')).toEqual([]);
    expect(readList(shapes.store, objects(shapes.store, p, NS.sh + 'in')[0])?.map((t) => t.value)).toEqual([I('gardening'), I('indoor'), I('outdoor')]);
    const compact = await toShaclc(g);
    expect(compact).toContain('ex:gardening');
    expect(compact).toContain('ex:outdoor');
  });
  it('accepts an untyped listed IRI and rejects an unlisted IRI through the browser/server checkData path', async () => {
    const g = governed();
    const prepared = await prepareOntology(await g.toTurtle(), await toShacl(g));
    const data = (value: string) => `<https://data.example/event> a <${I('Event')}> ; <${I('activity')}> <${value}> .`;
    const opts = { baseIRI: 'https://data.example/', maxTriples: 100 };
    expect(await checkData(prepared, data(I('gardening')), 'turtle', opts)).toMatchObject({ valid: true, conforms: true });
    const bad = await checkData(prepared, data('https://other.example/unknown'), 'turtle', opts);
    expect(bad.valid).toBe(false);
    expect(bad.results[0]).toMatchObject({ path: I('activity'), constraint: NS.sh + 'InConstraintComponent' });
    expect(bad.results[0].message).toBeTruthy();
    const emptyList = apply(g, { op: 'removeTerm', iri: I('gardening') }, { op: 'removeTerm', iri: I('outdoor') }, { op: 'removeTerm', iri: I('indoor') });
    const noValues = await prepareOntology(emptyList, await toShacl(emptyList));
    expect((await checkData(noValues, data(I('gardening')), 'turtle', opts)).conforms).toBe(false);
    expect(await toShaclc(emptyList)).toContain('activity');
    const deprecated = apply(g, { op: 'deprecateConcept', iri: I('gardening'), reason: 'Retired' });
    const legacy = await prepareOntology(deprecated, await toShacl(deprecated));
    expect((await checkData(legacy, data(I('gardening')), 'turtle', opts)).valid).toBe(true);
  });
  it('exports LinkML enum keys, meanings, definitions and slot range; code generation keeps an IRI string', async () => {
    const g = governed();
    const schema = YAML.parse(toLinkML(g));
    expect(schema.enums.ActivityTypes.permissible_values.GARD).toEqual({ meaning: I('gardening'), description: 'The activity gardening' });
    expect(schema.enums.ActivityTypes.permissible_values.outdoor.meaning).toBe(I('outdoor'));
    expect(schema.slots.activity.range).toBe('ActivityTypes');
    const generated = await serialize(g, 'typescript');
    expect(generated).toContain('activity');
    expect(generated).toContain('get activity(): Set<string>');
    expect(generated).toContain('NamedNodeAs.string');
    expect(generated).toContain('NamedNodeFrom.string');
  });
  it('generated accessors read and write code IRIs as named nodes, including single-valued properties', async () => {
    for (const single of [false, true]) {
      const g = single ? apply(governed(), { op: 'setCharacteristics', iri: I('activity'), characteristics: ['functional'] }) : governed();
      const generated = await toWrapperClasses(g);
      const dir = new URL('../.gen/test/', import.meta.url);
      mkdirSync(dir, { recursive: true });
      const file = new URL(`code-list-${process.pid}-${single}.mjs`, dir);
      writeFileSync(file, generated.js);
      try {
        const { Event } = await import(file.href);
        const store = new Store();
        const instance = new Event('https://data.example/event', store, DataFactory);
        if (single) instance.activity = I('gardening');
        else instance.activity.add(I('gardening'));
        expect(store.getObjects(nn('https://data.example/event'), nn(I('activity')), null)).toEqual([nn(I('gardening'))]);
        expect(single ? instance.activity : [...instance.activity][0]).toBe(I('gardening'));
      } finally { rmSync(file, { force: true }); }
    }
  });
  it('round trips every RDF serialisation with the same view and retains Manchester declarations and facts', async () => {
    const g = governed();
    for (const format of ['turtle', 'rdfxml', 'jsonld', 'ntriples'] as const) {
      const back = await OntologyGraph.parse(await serialize(g, format), format);
      expect(back.view().concepts, format).toEqual(g.view().concepts);
      expect(back.view().conceptSchemes, format).toEqual(g.view().conceptSchemes);
      expect(back.term(I('activity')), format).toEqual(g.term(I('activity')));
    }
    const manchester = await serialize(g, 'manchester');
    for (const [iri] of SKOS_DECLARATIONS) expect(manchester).toContain('skos:' + iri.split('#')[1]);
    expect(manchester).toContain('skos:notation "GARD"');
    expect(manchester).toContain('skos:broader ex:outdoor');
    expect(manchester).toContain('skos:Concept and (skos:inScheme value ex:ActivityTypes)');
  });
});
