import { describe, expect, it } from 'vitest';
import { DataFactory } from 'n3';
import { ChangeOpError, NS, XSD, applyChangeOps, lint, termDescription, toKGCL } from '../src/index.js';
import type { ChangeOp, ClassView, IndividualView, PropertyView } from '../src/index.js';
import { NSX, X, baseOntology } from './helpers.js';

const cls = (g: ReturnType<typeof baseOntology>, l: string) => g.term(X(l)) as ClassView;
const prop = (g: ReturnType<typeof baseOntology>, l: string) => g.term(X(l)) as PropertyView;

describe('applyChangeOps', () => {
  it('never mutates its input', () => {
    const g = baseOntology();
    const before = g.size;
    const r = applyChangeOps(g, [{ op: 'addClass', localName: 'Volunteer', label: 'volunteer', definition: 'A person who gives time unpaid.', subClassOf: [X('Person')] }]);
    expect(g.size).toBe(before);
    expect(g.term(X('Volunteer'))).toBeUndefined();
    expect(r.graph.term(X('Volunteer'))).toBeDefined();
    expect(r.touched).toEqual([X('Volunteer')]);
  });

  it('addClass adds label, definition, provenance and axioms', () => {
    const g = baseOntology();
    const { graph } = applyChangeOps(g, [{
      op: 'addClass', localName: 'Volunteer', label: 'volunteer', definition: 'A person who gives time unpaid.',
      subClassOf: ['ex:Person'], disjointWith: [X('Organisation')], altLabels: ['helper'], source: ['https://example.org/meeting/1'],
      restrictions: [{ property: X('worksFor'), kind: 'some', filler: X('Organisation') }],
    }], { author: 'Grace', date: '2026-02-02', source: 'Workshop 3' });
    const v = cls(graph, 'Volunteer');
    expect(v.label).toBe('volunteer');
    expect(v.definition).toBe('A person who gives time unpaid.');
    expect(v.superClasses).toEqual([X('Person')]);
    expect(v.disjointWith).toEqual([X('Organisation')]);
    expect(v.altLabels).toEqual(['helper']);
    expect(v.restrictions).toEqual([{ property: X('worksFor'), kind: 'some', filler: X('Organisation') }]);
    expect(v.source).toEqual(['Workshop 3', 'https://example.org/meeting/1']);
    const s = graph.store;
    const vals = (p: string) => s.getObjects(X('Volunteer') as any, p as any, null).map((o) => o.value);
    expect(vals(NS.rdfs + 'isDefinedBy')).toEqual(['https://example.org/test']);
    expect(vals(NS.dcterms + 'created')).toEqual(['2026-02-02']);
    expect(vals(NS.dcterms + 'contributor')).toEqual(['Grace']);
    // annotation properties used are declared (OWL 2 DL)
    expect(graph.term(NS.skos + 'definition')?.kind).toBe('annotationProperty');
  });

  it('addObjectProperty / addDatatypeProperty set domain, range and characteristics', () => {
    const { graph, warnings } = applyChangeOps(baseOntology(), [
      { op: 'addObjectProperty', localName: 'employs', label: 'employs', definition: 'Relates an organisation to a person it employs.', domain: [X('Organisation')], range: [X('Person')], inverseOf: X('worksFor'), characteristics: ['inverseFunctional'] },
      { op: 'addDatatypeProperty', localName: 'birthDate', label: 'birth date', definition: 'The date and time a person was born.', domain: [X('Person')], range: [XSD.dateTime], functional: true },
      { op: 'addObjectProperty', localName: 'relatedTo', label: 'related to', definition: 'A generic relation.' },
    ]);
    const e = prop(graph, 'employs');
    expect(e.kind).toBe('objectProperty');
    expect(e.inverseOf).toBe(X('worksFor'));
    expect(e.characteristics).toEqual(['inverseFunctional']);
    expect(prop(graph, 'worksFor').inverseOf).toBe(X('employs'));
    const b = prop(graph, 'birthDate');
    expect(b.kind).toBe('datatypeProperty');
    expect(b.range).toEqual([XSD.dateTime]);
    expect(b.characteristics).toEqual(['functional']);
    expect(warnings.some((w) => w.includes('relatedTo') && w.includes('no domain'))).toBe(true);
  });

  it('addIndividual types and facts', () => {
    const { graph } = applyChangeOps(baseOntology(), [
      { op: 'addIndividual', localName: 'acme', label: 'Acme', types: [X('Organisation')], facts: { [X('name')]: ['Acme Ltd'] } },
      { op: 'addIndividual', localName: 'ada', label: 'Ada', types: [X('Person')], facts: { [X('worksFor')]: [X('acme')], [X('age')]: ['36'] } },
    ]);
    const ada = graph.term(X('ada')) as IndividualView;
    expect(ada.kind).toBe('individual');
    expect(ada.types).toEqual([X('Person')]);
    expect(ada.facts[X('worksFor')]).toEqual([X('acme')]);
    expect(ada.facts[X('age')]).toEqual(['36']);
    const ageLit = graph.store.getObjects(X('ada') as any, X('age') as any, null)[0] as any;
    expect(ageLit.datatype.value).toBe(XSD.integer); // typed from the property range
  });

  it('updateAnnotations replaces values and keeps other languages', () => {
    const g0 = baseOntology();
    const s = g0.store;
    const { literal, namedNode } = DataFactory;
    s.addQuad(namedNode(X('Person')), namedNode(NS.rdfs + 'label'), literal('personne', 'fr'));
    const { graph } = applyChangeOps(g0, [{ op: 'updateAnnotations', iri: X('Person'), set: { label: 'human person', definition: 'An agent that is an individual human being.', examples: ['Ada Lovelace'], comment: '' } }]);
    const p = cls(graph, 'Person');
    expect(p.label).toBe('human person');
    expect(p.definition).toBe('An agent that is an individual human being.');
    expect(p.examples).toEqual(['Ada Lovelace']);
    expect(graph.store.getObjects(namedNode(X('Person')), namedNode(NS.rdfs + 'label'), null).map((o: any) => o.value).sort()).toEqual(['human person', 'personne']);
    expect(() => applyChangeOps(g0, [{ op: 'updateAnnotations', iri: X('Person'), set: { label: ' ' } }])).toThrow(ChangeOpError);
  });

  it('setSuperClasses replaces named superclasses but keeps restrictions', () => {
    const g = applyChangeOps(baseOntology(), [{ op: 'addRestriction', classIri: X('Employee'), restriction: { property: X('worksFor'), kind: 'some', filler: X('Organisation') } }]).graph;
    const { graph } = applyChangeOps(g, [{ op: 'setSuperClasses', iri: X('Employee'), superClasses: [X('Agent')] }]);
    const e = cls(graph, 'Employee');
    expect(e.superClasses).toEqual([X('Agent')]);
    expect(e.restrictions).toHaveLength(1);
    expect(() => applyChangeOps(g, [{ op: 'setSuperClasses', iri: X('Employee'), superClasses: [X('Employee')] }])).toThrow(/own superclass/);
  });

  it('setDomainRange replaces domain/range and checks kinds', () => {
    const { graph } = applyChangeOps(baseOntology(), [{ op: 'setDomainRange', iri: X('worksFor'), domain: [X('Employee')] }]);
    expect(prop(graph, 'worksFor').domain).toEqual([X('Employee')]);
    expect(prop(graph, 'worksFor').range).toEqual([X('Organisation')]);
    expect(() => applyChangeOps(baseOntology(), [{ op: 'setDomainRange', iri: X('worksFor'), range: [XSD.string] }])).toThrow(/datatype/);
    expect(() => applyChangeOps(baseOntology(), [{ op: 'setDomainRange', iri: X('name'), range: [X('Place')] }])).toThrow(/datatype/);
  });

  it('addRestriction / removeRestriction for every kind', () => {
    const kinds = [
      { property: X('worksFor'), kind: 'some', filler: X('Organisation') },
      { property: X('worksFor'), kind: 'only', filler: X('Organisation') },
      { property: X('worksFor'), kind: 'min', cardinality: 1, filler: X('Organisation') },
      { property: X('worksFor'), kind: 'max', cardinality: 3 },
      { property: X('name'), kind: 'exactly', cardinality: 1, filler: XSD.string },
      { property: X('name'), kind: 'value', literal: 'Ada' },
    ] as const;
    let g = baseOntology();
    for (const r of kinds) g = applyChangeOps(g, [{ op: 'addRestriction', classIri: X('Employee'), restriction: { ...r } }]).graph;
    const rs = cls(g, 'Employee').restrictions;
    expect(rs).toHaveLength(kinds.length);
    expect(rs).toContainEqual({ property: X('name'), kind: 'exactly', cardinality: 1, filler: XSD.string });
    expect(rs).toContainEqual({ property: X('worksFor'), kind: 'max', cardinality: 3 });
    // qualified data cardinality uses owl:onDataRange
    const nt = g.store.getQuads(null, NS.owl + 'onDataRange' as any, null, null);
    expect(nt).toHaveLength(1);
    expect(() => applyChangeOps(g, [{ op: 'addRestriction', classIri: X('Employee'), restriction: { ...kinds[0] } }])).toThrow(/already/);
    for (const r of kinds) g = applyChangeOps(g, [{ op: 'removeRestriction', classIri: X('Employee'), restriction: { ...r } }]).graph;
    expect(cls(g, 'Employee').restrictions).toEqual([]);
    expect(g.size).toBe(baseOntology().size); // blank nodes fully removed
    expect(() => applyChangeOps(g, [{ op: 'removeRestriction', classIri: X('Employee'), restriction: { ...kinds[0] } }])).toThrow(/not found/);
    expect(() => applyChangeOps(g, [{ op: 'addRestriction', classIri: X('Employee'), restriction: { property: X('worksFor'), kind: 'min' } }])).toThrow(/cardinality/);
    expect(() => applyChangeOps(g, [{ op: 'addRestriction', classIri: X('Employee'), restriction: { property: X('worksFor'), kind: 'some', filler: XSD.string } }])).toThrow(/datatype/);
  });

  it('addDisjointness / removeDisjointness (pairwise and AllDisjointClasses)', () => {
    let g = applyChangeOps(baseOntology(), [{ op: 'addDisjointness', classes: [X('Agent'), X('Place'), X('Employee')] }]).graph;
    expect(cls(g, 'Place').disjointWith).toEqual([X('Agent'), X('Employee')]);
    g = applyChangeOps(g, [{ op: 'removeDisjointness', classes: [X('Agent'), X('Employee')] }]).graph;
    expect(cls(g, 'Agent').disjointWith).toEqual([X('Place')]);
    expect(cls(g, 'Employee').disjointWith).toEqual([X('Place')]);
    g = applyChangeOps(g, [{ op: 'removeDisjointness', classes: [X('Person'), X('Organisation')] }]).graph;
    expect(cls(g, 'Person').disjointWith).toEqual([]);
    expect(() => applyChangeOps(g, [{ op: 'removeDisjointness', classes: [X('Person'), X('Organisation')] }])).toThrow(/no disjointness/);
    expect(() => applyChangeOps(g, [{ op: 'addDisjointness', classes: [X('Person')] }])).toThrow(/two/);
  });

  it('setCharacteristics', () => {
    const { graph } = applyChangeOps(baseOntology(), [{ op: 'setCharacteristics', iri: X('knows'), characteristics: ['symmetric', 'irreflexive'] }]);
    expect(prop(graph, 'knows').characteristics).toEqual(['symmetric', 'irreflexive']);
    const g2 = applyChangeOps(graph, [{ op: 'setCharacteristics', iri: X('knows'), characteristics: [] }]).graph;
    expect(prop(g2, 'knows').characteristics).toEqual([]);
    expect(prop(g2, 'knows').kind).toBe('objectProperty');
    expect(() => applyChangeOps(baseOntology(), [{ op: 'setCharacteristics', iri: X('name'), characteristics: ['transitive'] }])).toThrow(/functional/);
  });

  it('deprecateTerm sets owl:deprecated, history note and replacement', () => {
    const { graph } = applyChangeOps(baseOntology(), [{ op: 'deprecateTerm', iri: X('Employee'), reason: 'Out of scope.', replacedBy: X('Person') }]);
    const e = cls(graph, 'Employee');
    expect(e.deprecated).toBe(true);
    expect(e.replacedBy).toBe(X('Person'));
    expect(graph.store.getObjects(X('Employee') as any, NS.skos + 'historyNote' as any, null)[0].value).toBe('Out of scope.');
    expect(() => applyChangeOps(baseOntology(), [{ op: 'deprecateTerm', iri: X('Employee'), reason: '' }])).toThrow(/reason/);
  });

  it('removeTerm removes the term and every axiom mentioning it', () => {
    const g = applyChangeOps(baseOntology(), [
      { op: 'addRestriction', classIri: X('Employee'), restriction: { property: X('worksFor'), kind: 'some', filler: X('Organisation') } },
      { op: 'addDisjointness', classes: [X('Place'), X('Organisation'), X('Person')] },
    ]).graph;
    const { graph, warnings } = applyChangeOps(g, [{ op: 'removeTerm', iri: X('Organisation') }]);
    expect(graph.term(X('Organisation'))).toBeUndefined();
    expect(cls(graph, 'Employee').restrictions).toEqual([]);
    expect(prop(graph, 'worksFor').range).toEqual([]);
    expect(cls(graph, 'Place').disjointWith).toEqual([]);
    expect(graph.store.getQuads(null, null, X('Organisation') as any, null)).toHaveLength(0);
    expect(warnings.join(' ')).toMatch(/major/);
    // No dangling blank nodes: every blank subject is reachable or a root axiom
    expect(lint(graph).filter((i) => i.code === 'undeclared-term')).toEqual([]);
  });

  it('renameTerm mints a new IRI, rewrites references and deprecates the old IRI', () => {
    const g = applyChangeOps(baseOntology(), [{ op: 'addRestriction', classIri: X('Employee'), restriction: { property: X('worksFor'), kind: 'some', filler: X('Organisation') } }]).graph;
    const { graph, touched } = applyChangeOps(g, [{ op: 'renameTerm', iri: X('Organisation'), newLocalName: 'Organization' }], { date: '2026-03-03' });
    expect(touched).toEqual([X('Organisation'), X('Organization')]);
    const n = cls(graph, 'Organization');
    expect(n.label).toBe('organisation');
    expect(n.superClasses).toEqual([X('Agent')]);
    expect(n.disjointWith).toEqual([X('Person')]);
    const old = cls(graph, 'Organisation');
    expect(old.deprecated).toBe(true);
    expect(old.replacedBy).toBe(X('Organization'));
    expect(old.superClasses).toEqual([]);
    expect(old.label).toBe('obsolete organisation');
    expect(prop(graph, 'worksFor').range).toEqual([X('Organization')]);
    expect(cls(graph, 'Employee').restrictions[0].filler).toBe(X('Organization'));
    // Renaming a property also rewrites its use as a predicate
    const r2 = applyChangeOps(graph, [{ op: 'renameTerm', iri: X('worksFor'), newLocalName: 'employedBy' }]).graph;
    expect(cls(r2, 'Employee').restrictions[0].property).toBe(X('employedBy'));
    expect(lint(r2, { strict: true }).filter((i) => i.severity === 'error')).toEqual([]);
    expect(() => applyChangeOps(g, [{ op: 'renameTerm', iri: X('Person'), newLocalName: 'Agent' }])).toThrow(/exists/);
    expect(() => applyChangeOps(g, [{ op: 'renameTerm', iri: X('Person'), newLocalName: 'bad_name' }])).toThrow(/invalid/);
  });

  it('setMetadata and addImport', () => {
    const { graph } = applyChangeOps(baseOntology(), [
      { op: 'setMetadata', set: { title: 'Renamed', contributors: ['Ada', 'Grace'], modified: '2026-04-04', license: 'https://creativecommons.org/publicdomain/zero/1.0/' } },
      { op: 'addImport', iri: 'http://www.w3.org/ns/prov-o' },
    ]);
    const m = graph.view().metadata;
    expect(m.title).toBe('Renamed');
    expect(m.contributors).toEqual(['Ada', 'Grace']);
    expect(m.modified).toBe('2026-04-04');
    expect(m.license).toBe('https://creativecommons.org/publicdomain/zero/1.0/');
    expect(m.imports).toEqual(['http://www.w3.org/ns/prov-o']);
    expect(() => applyChangeOps(graph, [{ op: 'addImport', iri: 'http://www.w3.org/ns/prov-o' }])).toThrow(/already/);
  });

  it('setMetadata only accepts ISO dates for date fields', () => {
    expect(() => applyChangeOps(baseOntology(), [{ op: 'setMetadata', set: { modified: '<img src=x onerror=alert(1)>' } }])).toThrow(/ISO date/);
    expect(() => applyChangeOps(baseOntology(), [{ op: 'setMetadata', set: { issued: '2026-13-45' } }])).toThrow(/ISO date/);
    // Real calendar values only, in the lexical form xsd:date / xsd:dateTime require.
    for (const bad of ['2026-02-31', '2025-02-29', '2026-11-04T10:00Z', '2026-11-04T24:00:00', '2026-11-04T10:00:00+15:00', '0000-01-01'])
      expect(() => applyChangeOps(baseOntology(), [{ op: 'setMetadata', set: { issued: bad } }]), bad).toThrow(/ISO date/);
    for (const good of ['2024-02-29', '2026-11-04', '2026-11-04Z', '2026-11-04T10:00:00.123+01:00'])
      expect(() => applyChangeOps(baseOntology(), [{ op: 'setMetadata', set: { issued: good } }]), good).not.toThrow();
    const { graph } = applyChangeOps(baseOntology(), [{ op: 'setMetadata', set: { issued: '2026-11-04T10:00:00Z' } }]);
    expect(graph.view().metadata.issued).toBe('2026-11-04T10:00:00Z');
  });

  it('later ops can reference terms added by earlier ops in the same batch', () => {
    const { graph } = applyChangeOps(baseOntology(), [
      { op: 'addClass', localName: 'Skill', label: 'skill', definition: 'A learned capability.' },
      { op: 'addObjectProperty', localName: 'hasSkill', label: 'has skill', definition: 'Relates a person to a skill.', domain: [X('Person')], range: [X('Skill')] },
    ]);
    expect(prop(graph, 'hasSkill').range).toEqual([X('Skill')]);
  });

  describe('validation', () => {
    const g = baseOntology();
    const bad: [string, Parameters<typeof applyChangeOps>[1], RegExp][] = [
      ['unknown superclass', [{ op: 'addClass', localName: 'A', label: 'a', definition: 'A thing.', subClassOf: [X('Nope')] }], /not a declared class/],
      ['unknown range', [{ op: 'addObjectProperty', localName: 'p', label: 'p', definition: 'p.', range: [X('Nope')] }], /unknown range/],
      ['invalid class name', [{ op: 'addClass', localName: 'my class', label: 'a', definition: 'A thing.' }], /UpperCamelCase/],
      ['invalid property name', [{ op: 'addObjectProperty', localName: 'Has_Skill', label: 'p', definition: 'p.' }], /lowerCamelCase/],
      ['duplicate term', [{ op: 'addClass', localName: 'Person', label: 'person 2', definition: 'Again.' }], /already exists/],
      ['missing definition', [{ op: 'addClass', localName: 'Thing2', label: 'thing', definition: '' }], /definition is required/],
      ['unknown target', [{ op: 'updateAnnotations', iri: X('Nope'), set: { label: 'x' } }], /does not exist/],
      ['datatype range on object property', [{ op: 'addObjectProperty', localName: 'p', label: 'p', definition: 'p.', range: [XSD.string] }], /datatype/],
      ['class range on datatype property', [{ op: 'addDatatypeProperty', localName: 'p', label: 'p', definition: 'p.', range: [X('Place')] }], /datatype/],
      ['unknown replacement', [{ op: 'deprecateTerm', iri: X('Person'), reason: 'x', replacedBy: X('Nope') }], /unknown replacement/],
    ];
    for (const [name, ops, msg] of bad) {
      it(`rejects ${name}`, () => {
        let err: unknown;
        try { applyChangeOps(g, ops); } catch (e) { err = e; }
        expect(err).toBeInstanceOf(ChangeOpError);
        expect((err as ChangeOpError).opIndex).toBe(0);
        expect((err as Error).message).toMatch(msg);
      });
    }
    it('reports the index of the failing op', () => {
      try {
        applyChangeOps(g, [{ op: 'addClass', localName: 'Ok', label: 'ok', definition: 'Fine.' }, { op: 'removeTerm', iri: X('Missing') }]);
        throw new Error('should have thrown');
      } catch (e) {
        expect((e as ChangeOpError).opIndex).toBe(1);
      }
    });
    it('accepts well-known vocabulary terms without declaration', () => {
      const { graph } = applyChangeOps(g, [{ op: 'addClass', localName: 'Venue', label: 'venue', definition: 'A place where events happen.', subClassOf: ['https://schema.org/Place'] }]);
      expect(cls(graph, 'Venue').superClasses).toEqual(['https://schema.org/Place']);
    });
  });
});

describe('toKGCL', () => {
  it('renders change ops as KGCL-style statements', () => {
    const prefixes = { ex: NSX, rdfs: NS.rdfs };
    const lines = toKGCL([
      { op: 'addClass', localName: 'Shift', label: 'shift', definition: 'A period of work.', subClassOf: [X('Agent')], restrictions: [{ property: X('worksFor'), kind: 'some', filler: X('Organisation') }] },
      { op: 'deprecateTerm', iri: X('Employee'), reason: 'merged', replacedBy: X('Person') },
      { op: 'renameTerm', iri: X('Place'), newLocalName: 'Location' },
      { op: 'updateAnnotations', iri: X('Person'), set: { definition: 'A human.' } },
      { op: 'removeDisjointness', classes: [X('Person'), X('Organisation')] },
      { op: 'addRestriction', classIri: X('Person'), restriction: { property: X('worksFor'), kind: 'max', cardinality: 1 } },
    ], prefixes, NSX);
    expect(lines).toContain("create class ex:Shift 'shift'");
    expect(lines).toContain("add definition 'A period of work.' to ex:Shift");
    expect(lines).toContain('create edge ex:Shift rdfs:subClassOf ex:Agent');
    expect(lines).toContain('create edge ex:Shift ex:worksFor ex:Organisation');
    expect(lines).toContain('obsolete ex:Employee with replacement ex:Person');
    expect(lines).toContain('obsolete ex:Place with replacement ex:Location');
    expect(lines).toContain("change definition of ex:Person to 'A human.'");
    expect(lines).toContain('delete edge ex:Person owl:disjointWith ex:Organisation');
    expect(lines.some((l) => l.startsWith('#') && l.includes('max 1'))).toBe(true);
  });
});

describe('generated provenance', () => {
  it('is stamped as dcterms:provenance, apart from requested sources, and ignored when comparing terms', () => {
    const op = { op: 'addClass', localName: 'Volunteer', label: 'volunteer', definition: 'A person who gives time unpaid.', source: ['https://example.org/meeting/1'] } satisfies ChangeOp;
    const a = applyChangeOps(baseOntology(), [op], { provenance: 'example#1' }).graph;
    const b = applyChangeOps(baseOntology(), [op], { provenance: 'example fork f' }).graph;
    const vals = (g: typeof a, p: string) => g.store.getObjects(X('Volunteer') as any, p as any, null).map((o) => o.value);
    expect(vals(a, NS.dcterms + 'provenance')).toEqual(['example#1']);
    expect(vals(a, NS.dcterms + 'source')).toEqual(['https://example.org/meeting/1']);
    expect(termDescription(a, X('Volunteer'))).toBe(termDescription(b, X('Volunteer')));
    const c = applyChangeOps(baseOntology(), [{ ...op, source: ['example#1'] }], { provenance: 'example#1' }).graph;
    expect(termDescription(c, X('Volunteer'))).not.toBe(termDescription(a, X('Volunteer')));
  });
});

describe('recorded provenance cannot be reached indirectly', () => {
  // Eighth review: the guard only looked at an op's own `iri`, so a rename whose destination was
  // built from a temporarily changed namespace turned every dcterms:source into a forged
  // dcterms:provenance, and the `classes` of a disjointness were never checked.
  const DCT = 'http://purl.org/dc/terms/';
  const intoDcterms = { op: 'setMetadata', set: { preferredNamespace: DCT } } satisfies ChangeOp;
  const property = { op: 'addDatatypeProperty', localName: 'sourceNote', label: 'source note', definition: 'Where a statement came from.', range: [NS.xsd + 'string'] } satisfies ChangeOp;

  it('refuses a rename into a recorded property', () => {
    expect(() => applyChangeOps(baseOntology(), [property, intoDcterms, { op: 'renameTerm', iri: X('sourceNote'), newLocalName: 'provenance' }])).toThrow(/recorded by Concord/);
  });

  it('refuses a new term built at a recorded property', () => {
    expect(() =>
      applyChangeOps(baseOntology(), [intoDcterms, { op: 'addDatatypeProperty', localName: 'modified', label: 'modified', definition: 'When it changed.', range: [NS.xsd + 'date'] }]),
    ).toThrow(/recorded by Concord/);
  });

  it.each(['addDisjointness', 'removeDisjointness'] as const)('refuses %s that names a recorded property', (op) => {
    expect(() => applyChangeOps(baseOntology(), [{ op, classes: [X('Person'), DCT + 'created'] }])).toThrow(/recorded by Concord/);
  });
});
