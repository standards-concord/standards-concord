import { describe, expect, it } from 'vitest';
import { DataFactory } from 'n3';
import { NS, OntologyGraph, XSD, applyChangeOps, fairCheck, lint, owlReasoner, runCompetencyQuestions, structuralReasoner, validate } from '../src/index.js';
import { directInferred } from '../src/reasoner.js';
import { X, baseOntology, fixtureText, loadFixture } from './helpers.js';

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
    expect(r.checks.filter((c) => c.status === 'fail')).toEqual([]);
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
    expect(r.checks.find((c) => c.id === 'A1-rdf')!.status).toBe('not-checked');
  });

  it('scores each principle equally and leaves unchecked items out', async () => {
    const g = await loadFixture();
    const offline = fairCheck(g);
    expect(offline.byPrinciple.A.total).toBe(1);
    const unresolved = fairCheck(g, { resolution: { rdf: false, html: false } });
    expect(unresolved.byPrinciple.A).toEqual({ passed: 1, total: 3, score: 1 / 3 });
    // Only A drops: (1 + 1/3 + 1 + 1) / 4
    expect(unresolved.score).toBeCloseTo((3 + 1 / 3) / 4, 3);
    const resolved = fairCheck(g, { resolution: { rdf: true, html: true } });
    expect(resolved.score).toBe(1);
    const sum = Object.values(unresolved.byPrinciple).reduce((a, p) => a + p.score, 0);
    expect(unresolved.score).toBeCloseTo(sum / 4, 3);
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

describe('owlReasoner (sparq OWL 2 DL)', () => {
  const T = (body: string) => OntologyGraph.fromTurtle(`@prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
    @prefix xsd: <http://www.w3.org/2001/XMLSchema#> . @prefix ex: <https://example.org/t#> .
    <https://example.org/t> a owl:Ontology .
    ex:Agent a owl:Class . ex:Person a owl:Class ; rdfs:subClassOf ex:Agent .
    ex:Organisation a owl:Class ; rdfs:subClassOf ex:Agent ; owl:disjointWith ex:Person .
    ex:worksFor a owl:ObjectProperty ; rdfs:domain ex:Person ; rdfs:range ex:Organisation .
    ex:employs a owl:ObjectProperty ; owl:inverseOf ex:worksFor .
    ex:age a owl:DatatypeProperty, owl:FunctionalProperty ; rdfs:domain ex:Person ; rdfs:range xsd:nonNegativeInteger .
    ex:alice a owl:NamedIndividual . ex:bob a owl:NamedIndividual . ex:acme a owl:NamedIndividual .
    ${body}`);
  const E = (l: string) => 'https://example.org/t#' + l;

  it('fixture is consistent and coherent, with nothing inferred beyond the asserted hierarchy', async () => {
    const r = await owlReasoner(await loadFixture());
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ engine: 'sparq', available: true, consistent: true, unsatisfiable: [], inferredSubClassOf: [] });
    // The header's dcterms:created "…"^^xsd:date is an annotation: no caveat, no profile note.
    expect(r.explanation).toBeUndefined();
    expect(r.profile).toBeUndefined();
  });
  it('fixture plus its example data is consistent', async () => {
    const g = await OntologyGraph.fromTurtle(fixtureText('volunteering.ttl') + '\n' + fixtureText('volunteering-example-data.ttl'));
    expect(await owlReasoner(g)).toMatchObject({ engine: 'sparq', available: true, consistent: true });
  });
  it('detects an unsatisfiable class', async () => {
    const r = await owlReasoner(unsatisfiable());
    expect(r).toMatchObject({ engine: 'sparq', available: true, consistent: true, unsatisfiable: [X('PersonOrganisation')] });
    expect(r.explanation).toMatch(/ex:PersonOrganisation is a subclass of disjoint classes/);
  });
  it('detects unsatisfiability through a restriction and range', async () => {
    expect((await owlReasoner(unsatViaRange())).unsatisfiable).toEqual([X('Contractor')]);
  });
  it('detects an inconsistent ontology and names the likely cause', async () => {
    const r = await owlReasoner(inconsistent());
    expect(r).toMatchObject({ engine: 'sparq', available: true, consistent: false });
    expect(r.explanation).toMatch(/Likely cause: individual ex:acme is an instance of disjoint classes/);
  });
  it('reports direct inferred subclass relations, not ones the asserted hierarchy already gives', async () => {
    const g = applyChangeOps(baseOntology(), [
      { op: 'addClass', localName: 'Worker', label: 'worker', definition: 'An agent that works for an organisation.', subClassOf: [X('Agent')], restrictions: [{ property: X('worksFor'), kind: 'some', filler: X('Organisation') }] },
    ]).graph;
    expect((await owlReasoner(g)).inferredSubClassOf).toEqual([[X('Worker'), X('Person')]]);
    const h = await T(`ex:Staff a owl:Class ; owl:equivalentClass [ owl:intersectionOf ( ex:Person [ a owl:Restriction ; owl:onProperty ex:worksFor ; owl:someValuesFrom ex:Organisation ] ) ] .
      ex:Nurse a owl:Class ; rdfs:subClassOf ex:Person, [ a owl:Restriction ; owl:onProperty ex:worksFor ; owl:someValuesFrom ex:Organisation ] .
      ex:Employer a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ex:employs ; owl:someValuesFrom owl:Thing ] .`);
    // Nurse ⊑ Staff ⊑ Person: only the direct link is reported; Employer ⊑ Organisation comes through the inverse.
    expect((await owlReasoner(h)).inferredSubClassOf).toEqual([[E('Employer'), E('Organisation')], [E('Nurse'), E('Staff')], [E('Staff'), E('Person')]]);
  });
  // Constructs outside ALCH that HermiT used to be needed for (sparq#7031).
  it.each([
    ['a qualified cardinality clash', 'ex:Busy a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ex:worksFor ; owl:onClass ex:Organisation ; owl:minQualifiedCardinality "2"^^xsd:nonNegativeInteger ], [ a owl:Restriction ; owl:onProperty ex:worksFor ; owl:onClass ex:Organisation ; owl:maxQualifiedCardinality "1"^^xsd:nonNegativeInteger ] .', ['Busy']],
    ['a union domain', 'ex:Place a owl:Class ; owl:disjointWith ex:Agent . ex:at a owl:ObjectProperty ; rdfs:domain [ owl:unionOf ( ex:Person ex:Organisation ) ] . ex:Spot a owl:Class ; rdfs:subClassOf ex:Place, [ a owl:Restriction ; owl:onProperty ex:at ; owl:someValuesFrom owl:Thing ] .', ['Spot']],
    ['AllDisjointClasses', 'ex:Role a owl:Class . [ a owl:AllDisjointClasses ; owl:members ( ex:Agent ex:Role ) ] . ex:AR a owl:Class ; rdfs:subClassOf ex:Agent, ex:Role .', ['AR']],
  ])('finds the unsatisfiable class in %s', async (_, body, unsat) => {
    expect((await owlReasoner(await T(body))).unsatisfiable).toEqual(unsat.map(E));
  });
  it.each([
    ['two values for a functional data property', 'ex:alice ex:age 30, 31 .'],
    ['a literal of the wrong type for the range', 'ex:alice ex:age "sixteen" .'],
    ['a negative value for a nonNegativeInteger range', 'ex:alice ex:age -3 .'],
    ['a functional object property with two different values', 'ex:boss a owl:ObjectProperty, owl:FunctionalProperty . ex:alice ex:boss ex:bob, ex:acme . ex:bob owl:differentFrom ex:acme .'],
    ['typing through an inverse property', 'ex:alice ex:employs ex:bob . ex:alice a ex:Person .'],
    ['two individuals sharing a key', 'ex:Person owl:hasKey ( ex:age ) . ex:alice a ex:Person ; ex:age 3 . ex:bob a ex:Person ; ex:age 3 . ex:alice owl:differentFrom ex:bob .'],
  ])('finds the inconsistency in %s', async (_, body) => {
    expect(await owlReasoner(await T(body))).toMatchObject({ engine: 'sparq', available: true, consistent: false });
  });
  it('classifies with nominals and property chains', async () => {
    const r = await owlReasoner(await T(`ex:Colour a owl:Class ; owl:equivalentClass [ owl:oneOf ( ex:red ex:green ) ] . ex:red a owl:NamedIndividual . ex:green a owl:NamedIndividual .
      ex:hasColour a owl:ObjectProperty . ex:RedThing a owl:Class ; owl:equivalentClass [ a owl:Restriction ; owl:onProperty ex:hasColour ; owl:hasValue ex:red ] .
      ex:Coloured a owl:Class ; owl:equivalentClass [ a owl:Restriction ; owl:onProperty ex:hasColour ; owl:someValuesFrom ex:Colour ] .
      ex:hasParent a owl:ObjectProperty . ex:hasGrandparent a owl:ObjectProperty ; owl:propertyChainAxiom ( ex:hasParent ex:hasParent ) .
      ex:GP a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ex:hasParent ; owl:someValuesFrom [ a owl:Restriction ; owl:onProperty ex:hasParent ; owl:someValuesFrom ex:Person ] ] .
      ex:HasPersonGP a owl:Class ; owl:equivalentClass [ a owl:Restriction ; owl:onProperty ex:hasGrandparent ; owl:someValuesFrom ex:Person ] .`));
    expect(r.inferredSubClassOf).toEqual([[E('GP'), E('HasPersonGP')], [E('RedThing'), E('Coloured')]]);
  });
  it('treats non-OWL 2 datatypes as rdfs:Literal instead of abstaining, and says so', async () => {
    const g = applyChangeOps(baseOntology(), [{ op: 'addDatatypeProperty', localName: 'birthDate', label: 'birth date', definition: 'The date a person was born.', domain: [X('Person')], range: [XSD.date] }]).graph;
    const r = await owlReasoner(g);
    expect(r).toMatchObject({ engine: 'sparq', available: true, consistent: true });
    expect(r.explanation).toMatch(/xsd:date/);
  });
  it('reports profile violations that do not stop reasoning', async () => {
    const r = await owlReasoner(await T('ex:alice ex:undeclaredProp ex:bob .'));
    expect(r).toMatchObject({ engine: 'sparq', available: true, consistent: true });
    expect(r.profile?.map((n) => n.kind)).toContain('Undeclared');
  });
  it('rewrites a declared data property in a vocabulary namespace as logical, and says so', async () => {
    // dcterms:custom is declared a functional data property, so its xsd:date values matter to reasoning.
    const r = await owlReasoner(await T('<http://purl.org/dc/terms/custom> a owl:DatatypeProperty, owl:FunctionalProperty . ex:alice <http://purl.org/dc/terms/custom> "2000-01-01"^^xsd:date .'));
    expect(r.explanation).toMatch(/treated as rdfs:Literal: xsd:date/);
  });
  it('validation does not pass when the OWL reasoner gives no verdict', async () => {
    const g = await T('ex:partOf a owl:ObjectProperty, owl:TransitiveProperty . ex:Thing1 a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ex:partOf ; owl:maxCardinality "1"^^xsd:nonNegativeInteger ] .');
    const report = await validate(g, { reasoner: 'owl' });
    expect(report.reasoner).toMatchObject({ available: false, checked: 'none', consistent: true, unsatisfiable: [] });
    expect(report.passed).toBe(false);
  });
  it('validation does not pass when only consistency was decided', async () => {
    const g = await loadFixture();
    const report = await validate(g, { reasoner: 'owl', owlReasoner: async (graph) => ({ ...(await owlReasoner(graph)), available: false, checked: 'consistency' }) });
    expect(report.passed).toBe(false);
    expect((await validate(g, { reasoner: 'owl' })).reasoner.checked).toBe('complete');
  });
  it('reduces a long hierarchy to direct relations quickly', () => {
    // A 1,000-class chain: sparq reports every entailed, non-asserted pair (about half a million).
    // The first version recomputed closures and took about 20 s here.
    const n = 1000;
    const ops = Array.from({ length: n }, (_, i) => ({ op: 'addClass' as const, localName: `C${i}`, label: `c ${i}`, definition: `Class number ${i}.`, subClassOf: i ? [X(`C${i - 1}`)] : [] }));
    const g = applyChangeOps(baseOntology(), ops).graph;
    const entailed: [string, string][] = [];
    for (let i = 2; i < n; i++) for (let j = 0; j < i - 1; j++) entailed.push([X(`C${i}`), X(`C${j}`)]);
    entailed.push([X('Extra'), X('C5')]);
    const t0 = performance.now();
    expect(directInferred(g, entailed, new Set())).toEqual([[X('Extra'), X('C5')]]);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
  it('keeps inferred parents of classes that are equivalent to each other', async () => {
    // Round 2 of the reduction walked A -> B -> A through the equivalence and took A's own
    // inferred parent for an asserted one, so A ≡ B with A, B ⊑ P (via a domain) gave nothing.
    const g = await T(`
      ex:Parent a owl:Class . ex:Other a owl:Class . ex:rel a owl:ObjectProperty ; rdfs:domain ex:Parent .
      ex:A a owl:Class ; owl:equivalentClass ex:B ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ex:rel ; owl:someValuesFrom ex:Other ] .
      ex:B a owl:Class .`);
    const E = (l: string) => `https://example.org/t#${l}`;
    expect(directInferred(g, [[E('A'), E('Parent')], [E('B'), E('Parent')]], new Set())).toEqual([[E('A'), E('Parent')], [E('B'), E('Parent')]]);
    const r = await owlReasoner(g);
    expect(r.checked).toBe('complete');
    expect(r.inferredSubClassOf).toEqual(expect.arrayContaining([[E('A'), E('Parent')], [E('B'), E('Parent')]]));
  });
  it('falls back to the structural checks, saying why, when the ontology is outside OWL 2 DL', async () => {
    const r = await owlReasoner(await T('ex:partOf a owl:ObjectProperty, owl:TransitiveProperty . ex:Thing1 a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ex:partOf ; owl:maxCardinality "1"^^xsd:nonNegativeInteger ] .'));
    expect(r).toMatchObject({ engine: 'structural', available: false });
    expect(r.error).toMatch(/outside OWL 2 DL: .*partOf is not simple/);
  });
  it('falls back to the structural checks when sparq runs out of budget', async () => {
    const r = await owlReasoner(unsatViaRange(), { budget: { maxSteps: 1 } });
    expect(r).toMatchObject({ engine: 'structural', available: false });
    expect(r.error).toMatch(/budget/);
    expect(r.unsatisfiable).toEqual([X('Contractor')]); // from the structural checks
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
