import { describe, expect, it } from 'vitest';
import { DataFactory } from 'n3';
import { NS, OntologyGraph, XSD, applyChangeOps, fairCheck, lint, owlReasoner, runCompetencyQuestions, structuralReasoner, validate } from '../src/index.js';
import { X, baseOntology, fixtureText, hasOwlToolkit, loadFixture } from './helpers.js';

const { namedNode, literal } = DataFactory;
const VOL = 'https://w3id.org/odi/volunteering#';
const codes = (g: OntologyGraph, strict = true) => lint(g, { strict }).map((i) => i.code);

describe('lint', () => {
  it('the volunteering fixture is clean under strict lint (no errors or warnings)', async () => {
    const issues = lint(await loadFixture(), { strict: true });
    expect(issues.filter((i) => i.severity !== 'info')).toEqual([]);
    expect(issues.every((i) => i.reference)).toBe(true);
  });

  it('the base test ontology is clean too', () => {
    expect(lint(baseOntology(), { strict: true }).filter((i) => i.severity !== 'info')).toEqual([]);
  });

  /** Builds a deliberately bad ontology from Turtle. */
  const bad = (body: string) => OntologyGraph.fromTurtle(`
    @prefix ex: <https://example.org/test#> . @prefix owl: <http://www.w3.org/2002/07/owl#> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . @prefix skos: <http://www.w3.org/2004/02/skos/core#> .
    @prefix xsd: <http://www.w3.org/2001/XMLSchema#> . @prefix dcterms: <http://purl.org/dc/terms/> .
    <https://example.org/test> a owl:Ontology .
    ${body}`);

  const table: [string, string, 'error' | 'warning' | 'info'][] = [
    ['missing-label', 'ex:A a owl:Class ; skos:definition "A thing."@en .', 'error'],
    ['missing-definition', 'ex:A a owl:Class ; rdfs:label "a"@en .', 'error'],
    ['multiple-labels', 'ex:A a owl:Class ; rdfs:label "a"@en , "b"@en ; skos:definition "A thing."@en .', 'error'],
    ['naming-class-case', 'ex:my_class a owl:Class ; rdfs:label "my class"@en ; skos:definition "A thing."@en .', 'error'],
    ['naming-property-case', 'ex:HasPart a owl:ObjectProperty ; rdfs:label "has part"@en ; skos:definition "Parthood."@en ; rdfs:domain owl:Thing ; rdfs:range owl:Thing .', 'error'],
    ['undeclared-term', 'ex:A a owl:Class ; rdfs:label "a"@en ; skos:definition "A thing."@en ; rdfs:subClassOf ex:Ghost .', 'error'],
    ['missing-domain', 'ex:p a owl:ObjectProperty ; rdfs:label "p"@en ; skos:definition "A relation."@en ; rdfs:range owl:Thing .', 'warning'],
    ['missing-range', 'ex:p a owl:ObjectProperty ; rdfs:label "p"@en ; skos:definition "A relation."@en ; rdfs:domain owl:Thing .', 'warning'],
    ['multiple-domains', 'ex:A a owl:Class ; rdfs:label "a"@en ; skos:definition "A thing."@en . ex:B a owl:Class ; rdfs:label "b"@en ; skos:definition "B thing."@en . ex:p a owl:ObjectProperty ; rdfs:label "p"@en ; skos:definition "A relation."@en ; rdfs:domain ex:A , ex:B ; rdfs:range ex:A .', 'warning'],
    ['datatype-range-is-class', 'ex:A a owl:Class ; rdfs:label "a"@en ; skos:definition "A thing."@en . ex:p a owl:DatatypeProperty ; rdfs:label "p"@en ; skos:definition "A value."@en ; rdfs:domain ex:A ; rdfs:range ex:A .', 'error'],
    ['object-range-is-datatype', 'ex:A a owl:Class ; rdfs:label "a"@en ; skos:definition "A thing."@en . ex:p a owl:ObjectProperty ; rdfs:label "p"@en ; skos:definition "A relation."@en ; rdfs:domain ex:A ; rdfs:range xsd:string .', 'error'],
    ['datatype-not-owl2', 'ex:A a owl:Class ; rdfs:label "a"@en ; skos:definition "A thing."@en . ex:p a owl:DatatypeProperty ; rdfs:label "p"@en ; skos:definition "A date."@en ; rdfs:domain ex:A ; rdfs:range xsd:date .', 'warning'],
    ['deprecated-without-reason', 'ex:A a owl:Class ; rdfs:label "a"@en ; skos:definition "A thing."@en ; owl:deprecated true .', 'warning'],
    ['deprecated-without-replacement', 'ex:A a owl:Class ; rdfs:label "a"@en ; skos:definition "A thing."@en ; owl:deprecated true .', 'info'],
    ['misused-replaced-by', 'ex:A a owl:Class ; rdfs:label "a"@en ; skos:definition "A thing."@en ; dcterms:isReplacedBy ex:B . ex:B a owl:Class ; rdfs:label "b"@en ; skos:definition "B thing."@en .', 'warning'],
    ['deprecated-term-used', 'ex:A a owl:Class ; rdfs:label "a"@en ; skos:definition "A thing."@en ; owl:deprecated true ; skos:historyNote "gone" . ex:B a owl:Class ; rdfs:label "b"@en ; skos:definition "An a that is b."@en ; rdfs:subClassOf ex:A .', 'warning'],
    ['subclass-cycle', 'ex:A a owl:Class ; rdfs:label "a"@en ; skos:definition "A b."@en ; rdfs:subClassOf ex:B . ex:B a owl:Class ; rdfs:label "b"@en ; skos:definition "A a."@en ; rdfs:subClassOf ex:A .', 'error'],
    ['label-collision', 'ex:A a owl:Class ; rdfs:label "thing"@en ; skos:definition "A thing."@en . ex:B a owl:Class ; rdfs:label "Thing"@en ; skos:definition "Another thing."@en .', 'error'],
    ['punning', 'ex:A a owl:Class , owl:NamedIndividual ; rdfs:label "a"@en ; skos:definition "A thing."@en .', 'warning'],
    ['definition-not-genus-differentia', 'ex:A a owl:Class ; rdfs:label "animal"@en ; skos:definition "A living thing."@en . ex:B a owl:Class ; rdfs:label "dog"@en ; skos:definition "A domesticated canid."@en ; rdfs:subClassOf ex:A .', 'warning'],
    ['definition-circular', 'ex:A a owl:Class ; rdfs:label "dog"@en ; skos:definition "A dog that barks."@en .', 'warning'],
    ['missing-superclass', 'ex:A a owl:Class ; rdfs:label "a"@en ; skos:definition "A thing."@en .', 'info'],
    ['equivalent-pair', 'ex:A a owl:Class ; rdfs:label "a"@en ; skos:definition "A thing."@en ; owl:equivalentClass ex:B . ex:B a owl:Class ; rdfs:label "b"@en ; skos:definition "A thing too."@en .', 'warning'],
    ['annotation-whitespace', 'ex:A a owl:Class ; rdfs:label " a "@en ; skos:definition "A thing."@en .', 'warning'],
    ['illegal-builtin-use', 'owl:Thing rdfs:subClassOf owl:Nothing .', 'error'],
    ['property-kind-conflict', 'ex:p a owl:ObjectProperty , owl:DatatypeProperty ; rdfs:label "p"@en ; skos:definition "Both."@en ; rdfs:domain owl:Thing .', 'error'],
    ['missing-disjointness', 'ex:A a owl:Class ; rdfs:label "a"@en ; skos:definition "A thing."@en . ex:B a owl:Class ; rdfs:label "b"@en ; skos:definition "B thing."@en .', 'info'],
    ['header-missing-title', '', 'error'],
    ['header-missing-license', '', 'error'],
    ['header-missing-versionIRI', '', 'warning'],
    ['header-missing-prefix', '', 'warning'],
  ];
  for (const [code, ttl, severity] of table) {
    it(`detects ${code} (${severity})`, async () => {
      const issues = lint(await bad(ttl), { strict: true });
      const hit = issues.find((i) => i.code === code);
      expect(hit, JSON.stringify(issues.map((i) => i.code))).toBeDefined();
      expect(hit!.severity).toBe(severity);
      expect(hit!.reference).toBeTruthy();
    });
  }

  it('non-strict mode downgrades convention errors to warnings', async () => {
    const issues = lint(await bad('ex:A a owl:Class .'), { strict: false });
    expect(issues.find((i) => i.code === 'missing-label')!.severity).toBe('warning');
    expect(issues.find((i) => i.code === 'missing-superclass')).toBeUndefined();
  });

  it('accepts well-known vocabulary references and does not flag deprecated labels as collisions', () => {
    const g = applyChangeOps(baseOntology(), [
      { op: 'addClass', localName: 'Venue', label: 'venue', definition: 'A place where events happen.', subClassOf: ['https://schema.org/Place'] },
      { op: 'renameTerm', iri: X('Place'), newLocalName: 'Location' },
    ]).graph;
    const cs = codes(g);
    expect(cs).not.toContain('undeclared-term');
    expect(cs).not.toContain('label-collision');
  });
});

describe('fairCheck', () => {
  it('the fixture scores 1.0', async () => {
    const r = fairCheck(await loadFixture());
    expect(r.checks.filter((c) => !c.passed)).toEqual([]);
    expect(r.score).toBe(1);
    expect(r.checks.length).toBeGreaterThanOrEqual(12);
    expect(new Set(r.checks.map((c) => c.principle))).toEqual(new Set(['F', 'A', 'I', 'R']));
  });

  it('flags missing metadata', async () => {
    const g = await OntologyGraph.fromTurtle('<http://example.com/onto> a <http://www.w3.org/2002/07/owl#Ontology> .');
    const r = fairCheck(g);
    const failed = r.checks.filter((c) => !c.passed).map((c) => c.id);
    for (const id of ['F1-persistent-iri', 'F1-version-iri', 'F2-title', 'R1.1-license', 'R1.2-provenance-agents', 'F4-prefix-namespace']) expect(failed).toContain(id);
    expect(r.score).toBeLessThan(0.5);
    expect(r.checks.find((c) => c.id === 'A1-content-negotiation')!.passed).toBe(true);
  });
});

/* ------------------------------------------------------------------------ */

/** Unsatisfiable: C ⊑ A, C ⊑ B, A disjoint B. */
const unsatisfiable = () => applyChangeOps(baseOntology(), [
  { op: 'addClass', localName: 'PersonOrganisation', label: 'person organisation', definition: 'A person that is also an organisation.', subClassOf: [X('Person'), X('Organisation')] },
]).graph;

/** Inconsistent: an individual typed with two disjoint classes. */
const inconsistent = () => applyChangeOps(baseOntology(), [
  { op: 'addIndividual', localName: 'acme', label: 'Acme', types: [X('Person'), X('Organisation')] },
]).graph;

/** Unsatisfiable via restriction: C ⊑ worksFor some Person, but range(worksFor) = Organisation, disjoint with Person. */
const unsatViaRange = () => applyChangeOps(baseOntology(), [
  { op: 'addClass', localName: 'Contractor', label: 'contractor', definition: 'A person who works for a person.', subClassOf: [X('Person')], restrictions: [{ property: X('worksFor'), kind: 'some', filler: X('Person') }] },
]).graph;

describe('structuralReasoner', () => {
  it('fixture is consistent and coherent', async () => {
    const r = structuralReasoner(await loadFixture());
    expect(r).toMatchObject({ engine: 'structural', available: true, consistent: true, unsatisfiable: [] });
  });
  it('detects an unsatisfiable class (subclass of disjoint classes)', () => {
    const r = structuralReasoner(unsatisfiable());
    expect(r.consistent).toBe(true);
    expect(r.unsatisfiable).toEqual([X('PersonOrganisation')]);
    expect(r.explanation).toMatch(/disjoint/);
  });
  it('detects unsatisfiability through an existential restriction and the property range', () => {
    expect(structuralReasoner(unsatViaRange()).unsatisfiable).toEqual([X('Contractor')]);
  });
  it('detects an inconsistent ABox (individual in disjoint classes)', () => {
    const r = structuralReasoner(inconsistent());
    expect(r.consistent).toBe(false);
    expect(r.explanation).toMatch(/acme/);
  });
  it('detects inconsistency via domain typing and a functional data property clash', () => {
    const g = applyChangeOps(baseOntology(), [
      { op: 'addIndividual', localName: 'acme', label: 'Acme', types: [X('Organisation')], facts: { [X('worksFor')]: [X('acme')] } },
    ]).graph; // worksFor has domain Person → acme is a Person and an Organisation
    expect(structuralReasoner(g).consistent).toBe(false);
    const g2 = applyChangeOps(baseOntology(), [
      { op: 'setCharacteristics', iri: X('age'), characteristics: ['functional'] },
      { op: 'addIndividual', localName: 'ada', label: 'Ada', types: [X('Person')], facts: { [X('age')]: ['36', '37'] } },
    ]).graph;
    expect(structuralReasoner(g2).consistent).toBe(false);
  });
  it('infers subclasses from existential restrictions and domains', () => {
    const g = applyChangeOps(baseOntology(), [
      { op: 'addClass', localName: 'Worker', label: 'worker', definition: 'An agent that works for an organisation.', subClassOf: [X('Agent')], restrictions: [{ property: X('worksFor'), kind: 'some', filler: X('Organisation') }] },
    ]).graph;
    expect(structuralReasoner(g).inferredSubClassOf).toContainEqual([X('Worker'), X('Person')]);
  });
});

describe.skipIf(!hasOwlToolkit)('owlReasoner (HermiT via owlready2)', () => {
  it('fixture is consistent and coherent', async () => {
    const r = await owlReasoner(await loadFixture());
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ engine: 'hermit', available: true, consistent: true, unsatisfiable: [] });
  }, 60000);
  it('detects an unsatisfiable class', async () => {
    const r = await owlReasoner(unsatisfiable());
    expect(r.available).toBe(true);
    expect(r.consistent).toBe(true);
    expect(r.unsatisfiable).toEqual([X('PersonOrganisation')]);
  }, 60000);
  it('detects unsatisfiability through a restriction and range', async () => {
    expect((await owlReasoner(unsatViaRange())).unsatisfiable).toEqual([X('Contractor')]);
  }, 60000);
  it('detects an inconsistent ontology', async () => {
    const r = await owlReasoner(inconsistent());
    expect(r.available).toBe(true);
    expect(r.consistent).toBe(false);
  }, 60000);
  it('reports inferred subclass relations', async () => {
    const g = applyChangeOps(baseOntology(), [
      { op: 'addClass', localName: 'Worker', label: 'worker', definition: 'An agent that works for an organisation.', subClassOf: [X('Agent')], restrictions: [{ property: X('worksFor'), kind: 'some', filler: X('Organisation') }] },
    ]).graph;
    const r = await owlReasoner(g);
    expect(r.inferredSubClassOf).toContainEqual([X('Worker'), X('Person')]);
  }, 60000);
  it('treats non-OWL 2 datatypes as rdfs:Literal instead of failing', async () => {
    const g = applyChangeOps(baseOntology(), [{ op: 'addDatatypeProperty', localName: 'birthDate', label: 'birth date', definition: 'The date a person was born.', domain: [X('Person')], range: [XSD.date] }]).graph;
    const r = await owlReasoner(g);
    expect(r.available).toBe(true);
    expect(r.explanation).toMatch(/xsd:date/);
  }, 60000);
});

describe('owlReasoner fallback', () => {
  it('falls back to the structural reasoner when Python is missing', async () => {
    const r = await owlReasoner(inconsistent(), { python: '/nonexistent/python3' });
    expect(r.available).toBe(false);
    expect(r.engine).toBe('structural');
    expect(r.consistent).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

describe('competency questions', () => {
  it('the fixture CQs are satisfied by the example data', async () => {
    const cqs = JSON.parse(fixtureText('volunteering-cqs.json')) as { question: string; sparql: string }[];
    const data = fixtureText('volunteering-example-data.ttl');
    const res = await runCompetencyQuestions(await loadFixture(), cqs.map((c) => ({ ...c, exampleData: data })));
    for (const r of res) {
      expect(r.error, r.question).toBeUndefined();
      expect(r.ok).toBe(true);
      expect(r.satisfied, r.question).toBe(true);
    }
    expect(res[0].rows).toEqual([{ opportunity: 'https://example.org/volunteering-data/parkCleanUp', title: 'Saturday park clean-up', organisation: 'https://example.org/volunteering-data/greenSpacesTrust' }]);
    expect(res[3].rows).toEqual([{ result: 'true' }]);
  });

  it('runs against the ontology itself, adds missing prefixes and reports errors', async () => {
    const g = await loadFixture();
    const [schema, unsat, broken] = await runCompetencyQuestions(g, [
      { question: 'Which classes are subclasses of agent?', sparql: 'SELECT ?c WHERE { ?c rdfs:subClassOf vol:Agent }' },
      { question: 'Any volunteers?', sparql: 'ASK { ?v a vol:Volunteer }' },
      { question: 'Broken', sparql: 'SELEKT nonsense' },
    ]);
    expect(schema.rows.map((r) => r.c).sort()).toEqual([VOL + 'Organisation', VOL + 'Person']);
    expect(schema.satisfied).toBe(true);
    expect(unsat.ok).toBe(true);
    expect(unsat.satisfied).toBe(false);
    expect(broken.ok).toBe(false);
    expect(broken.error).toBeTruthy();
  });
});

describe('validate', () => {
  it('passes for the fixture', async () => {
    const r = await validate(await loadFixture(), { reasoner: 'structural' });
    expect(r.passed).toBe(true);
    expect(r.fair.score).toBe(1);
  });
  it('fails on unsatisfiable classes', async () => {
    const r = await validate(unsatisfiable(), { reasoner: 'structural' });
    expect(r.passed).toBe(false);
  });
  it('fails on lint errors', async () => {
    const g = baseOntology().clone();
    g.store.addQuad(namedNode(X('Ghost')), namedNode(NS.rdf + 'type'), namedNode(NS.owl + 'Class'));
    g.store.addQuad(namedNode(X('Ghost')), namedNode(NS.rdfs + 'comment'), literal('no label'));
    const r = await validate(g, { reasoner: 'structural' });
    expect(r.passed).toBe(false);
    expect(r.lint.some((i) => i.code === 'missing-label')).toBe(true);
  });
});
