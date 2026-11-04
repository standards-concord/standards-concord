import { describe, expect, it } from 'vitest';
import { FORMAT_INFO, NS, OntologyGraph, compactIRI, diffOntologies, expandIRI, isValidLocalName, localName, serialize } from '../src/index.js';
import { fixtureText, loadFixture } from './helpers.js';

const VOL = 'https://w3id.org/odi/volunteering#';

describe('OntologyGraph', () => {
  it('parses the fixture and exposes header, namespace and prefixes', async () => {
    const g = await loadFixture();
    expect(g.ontologyIRI).toBe('https://w3id.org/odi/volunteering');
    expect(g.namespace).toBe(VOL);
    expect(g.prefixes.vol).toBe(VOL);
    const m = g.view().metadata;
    expect(m.versionInfo).toBe('0.1.0');
    expect(m.versionIRI).toBe('https://w3id.org/odi/volunteering/0.1.0');
    expect(m.license).toBe('https://creativecommons.org/licenses/by/4.0/');
    expect(m.preferredPrefix).toBe('vol');
  });

  it('projects classes, properties and restrictions into the view', async () => {
    const g = await loadFixture();
    const v = g.view();
    expect(v.classes.length).toBeGreaterThanOrEqual(12);
    expect(v.objectProperties.length).toBeGreaterThanOrEqual(10);
    expect(v.datatypeProperties.length).toBeGreaterThanOrEqual(10);
    const app = g.term(VOL + 'Application');
    expect(app?.kind).toBe('class');
    if (app?.kind !== 'class') throw new Error();
    expect(app.restrictions).toContainEqual({ property: VOL + 'submittedBy', kind: 'exactly', cardinality: 1, filler: VOL + 'Person' });
    expect(app.disjointWith).toContain(VOL + 'Agent'); // via owl:AllDisjointClasses
    const loc = g.term(VOL + 'hasLocation');
    if (loc?.kind !== 'objectProperty') throw new Error();
    expect(loc.domainExpressions).toEqual(['vol:VolunteeringOpportunity or vol:Session']);
    const fn = g.term(VOL + 'submittedBy');
    if (fn?.kind !== 'objectProperty') throw new Error();
    expect(fn.characteristics).toEqual(['functional']);
  });

  it('searches labels, alt labels, local names and definitions', async () => {
    const g = await loadFixture();
    expect(g.search('shift')[0].iri).toBe(VOL + 'Session'); // alt label
    expect(g.search('volunteering opportunity')[0].iri).toBe(VOL + 'VolunteeringOpportunity');
    expect(g.search('hasSkill')[0].iri).toBe(VOL + 'hasSkill');
    expect(g.search('charity regulator').map((t) => t.iri)).toContain(VOL + 'charityNumber');
    expect(g.search('')).toEqual([]);
  });

  it('creates an empty ontology with a FAIR header', async () => {
    const g = OntologyGraph.empty({ iri: 'https://w3id.org/x/demo', namespace: 'https://w3id.org/x/demo#', prefix: 'demo', title: 'Demo', description: 'Demo ontology', creators: ['Ada', 'https://orcid.org/0000-0002-1825-0097'] });
    const m = g.view().metadata;
    expect(m.title).toBe('Demo');
    expect(m.creators).toEqual(['Ada', 'https://orcid.org/0000-0002-1825-0097']);
    expect(m.versionIRI).toBe('https://w3id.org/x/demo/0.1.0');
    expect(m.preferredNamespace).toBe('https://w3id.org/x/demo#');
    expect(g.namespace).toBe('https://w3id.org/x/demo#');
    expect(m.license).toContain('creativecommons.org');
  });

  it('clone() is independent', async () => {
    const g = await loadFixture();
    const c = g.clone();
    c.store.removeQuads(c.store.getQuads(null, null, null, null));
    expect(c.size).toBe(0);
    expect(g.size).toBeGreaterThan(300);
  });
});

describe('Turtle output', () => {
  it('is deterministic and stable under re-parsing', async () => {
    const g = await loadFixture();
    const t1 = await g.toTurtle();
    const t2 = await (await OntologyGraph.fromTurtle(t1)).toTurtle();
    expect(t2).toBe(t1);
    // Order of input triples does not matter.
    const nt = await serialize(g, 'ntriples');
    const shuffled = nt.trim().split('\n').reverse().join('\n');
    const t3 = await (await OntologyGraph.parse(shuffled, 'ntriples')).toTurtle();
    expect(t3.replace(/^@prefix.*\n/gm, '')).toBe(t1.replace(/^@prefix.*\n/gm, ''));
  });

  it('the committed fixture is already in canonical form', async () => {
    expect(await (await loadFixture()).toTurtle()).toBe(fixtureText('volunteering.ttl'));
  });

  it('has prefixes, header, sections and inline blank nodes', async () => {
    const t = await (await loadFixture()).toTurtle();
    expect(t.startsWith('@prefix dcat:')).toBe(true);
    const idx = (s: string) => t.indexOf(s);
    expect(idx('### Ontology')).toBeLessThan(idx('### Classes'));
    expect(idx('### Classes')).toBeLessThan(idx('### Object properties'));
    expect(idx('### Object properties')).toBeLessThan(idx('### Datatype properties'));
    expect(idx('### Datatype properties')).toBeLessThan(idx('### Annotation properties'));
    expect(t).toContain('[ a owl:Restriction ;');
    expect(t).toContain('owl:unionOf ( vol:VolunteeringOpportunity vol:Session )');
    expect(t).toMatch(/\[ a owl:AllDisjointClasses ;\s+owl:members \(/);
    expect(t).not.toMatch(/_:/);
  });
});

describe('serialisation round-trips', () => {
  for (const format of ['turtle', 'ntriples', 'rdfxml', 'jsonld'] as const) {
    it(`turtle → ${format} → parse gives an isomorphic graph`, async () => {
      const g = await loadFixture();
      const text = await serialize(g, format);
      const back = await OntologyGraph.parse(text, format);
      expect(back.size).toBe(g.size);
      const d = diffOntologies(g, back);
      expect(d.addedTriples + d.removedTriples).toBe(0);
      expect(d.terms).toEqual([]);
    });
  }

  it('fromTurtle() also accepts RDF/XML', async () => {
    const g = await loadFixture();
    const xml = await serialize(g, 'rdfxml');
    expect(xml.startsWith('<?xml')).toBe(true);
    expect(xml).toContain('rdf:parseType="Collection"');
    const back = await OntologyGraph.fromTurtle(xml);
    expect(back.size).toBe(g.size);
    expect(back.prefixes.vol).toBe(VOL);
  });

  it('every output format produces text and has FORMAT_INFO', async () => {
    const g = await loadFixture();
    for (const f of Object.keys(FORMAT_INFO) as (keyof typeof FORMAT_INFO)[]) {
      const out = await serialize(g, f);
      expect(out.length, f).toBeGreaterThan(200);
      expect(FORMAT_INFO[f].mediaType).toMatch(/\//);
    }
  });

  it('handles literals that need escaping', async () => {
    const src = `@prefix ex: <https://example.org/e#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      ex:a rdfs:comment "line one\\nline \\"two\\" \\\\ back"@en , "<tag> & amp" .`;
    const g = await OntologyGraph.fromTurtle(src);
    for (const f of ['turtle', 'ntriples', 'rdfxml', 'jsonld'] as const) {
      const back = await OntologyGraph.parse(await serialize(g, f), f);
      expect(diffOntologies(g, back).addedTriples, f).toBe(0);
    }
  });
});

describe('IRI helpers', () => {
  const prefixes = { vol: VOL, xsd: NS.xsd, '': 'https://example.org/default#' };
  it('compacts and expands', () => {
    expect(compactIRI(VOL + 'Volunteer', prefixes)).toBe('vol:Volunteer');
    expect(compactIRI('https://example.org/default#X', prefixes)).toBe(':X');
    expect(compactIRI('https://nope.org/x', prefixes)).toBe('https://nope.org/x');
    expect(expandIRI('vol:Volunteer', prefixes)).toBe(VOL + 'Volunteer');
    expect(expandIRI('<https://a.org/b>', prefixes)).toBe('https://a.org/b');
    expect(expandIRI('skos:definition', {})).toBe(NS.skos + 'definition');
    expect(localName(VOL + 'Volunteer')).toBe('Volunteer');
    expect(localName('https://a.org/x/y')).toBe('y');
  });
  it('validates local names', () => {
    expect(isValidLocalName('VolunteerRole', 'class')).toBe(true);
    expect(isValidLocalName('volunteerRole', 'class')).toBe(false);
    expect(isValidLocalName('Volunteer_Role', 'class')).toBe(false);
    expect(isValidLocalName('hasSkill', 'property')).toBe(true);
    expect(isValidLocalName('HasSkill', 'property')).toBe(false);
    expect(isValidLocalName('has skill', 'property')).toBe(false);
  });
  it('keeps the fixture text parseable', () => {
    expect(fixtureText('volunteering.ttl')).toContain('owl:Ontology');
  });
});
