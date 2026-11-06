import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OntologyGraph, allTerms, findTerm, searchTerms, termDetail } from '../src/index.js';

const turtle = readFileSync(new URL('../fixtures/volunteering.ttl', import.meta.url), 'utf8');

// The web app answers term clicks and search from the ontology view it already holds,
// instead of asking the server each time. These pin that it gets the same answers the graph does.
describe('term lookups over a view', () => {
  it('finds every term exactly as OntologyGraph.term() gives it', async () => {
    const g = await OntologyGraph.fromTurtle(turtle);
    const v = g.view();
    const iris = new Set(allTerms(v).map((t) => t.iri));
    expect(iris.size).toBeGreaterThan(10);
    for (const iri of iris) expect(findTerm(v, iri)).toEqual(g.term(iri));
    expect(findTerm(v, 'https://example.org/nothing')).toBeUndefined();
  });

  it('prefers the class view of a punned IRI, like the graph', async () => {
    const g = await OntologyGraph.fromTurtle(`@prefix owl: <http://www.w3.org/2002/07/owl#> .
      @prefix ex: <https://example.org/> .
      ex:Both a owl:Class, owl:NamedIndividual, owl:ObjectProperty .
      ex:Other a owl:Class .`);
    const v = g.view();
    expect(findTerm(v, 'https://example.org/Both')?.kind).toBe('class');
    expect(findTerm(v, 'https://example.org/Both')).toEqual(g.term('https://example.org/Both'));
    // Listed once in search, though the view lists it under three kinds.
    expect(searchTerms(allTerms(v), 'both').map((t) => t.iri)).toEqual(['https://example.org/Both']);
  });

  it('lists what refers to a term, with IRIs in `via` compacted by the ontology prefixes', async () => {
    const g = await OntologyGraph.fromTurtle(turtle);
    const v = g.view();
    const cls = v.classes.find((c) => v.classes.some((o) => o.superClasses.includes(c.iri)))!;
    const d = termDetail(v, cls.iri)!;
    expect(d.usedBy.some((u) => u.via === 'subclass of')).toBe(true);
    const restricted = v.classes.find((c) => c.restrictions.length)!;
    const r = restricted.restrictions[0];
    const via = termDetail(v, r.property)!.usedBy.find((u) => u.iri === restricted.iri)!.via;
    expect(via).toMatch(/^restriction \S+:\S+ /);
    expect(termDetail(v, 'https://example.org/nothing')).toBeUndefined();
  });

  it('ranks exact and prefix label matches first, and finds nothing for gibberish', async () => {
    const g = await OntologyGraph.fromTurtle(turtle);
    const all = allTerms(g.view());
    const target = all.find((t) => t.kind === 'class' && t.label && !t.deprecated)!;
    expect(searchTerms(all, target.label!.toUpperCase(), 30)[0].iri).toBe(target.iri);
    expect(searchTerms(all, target.label!.slice(0, 4), 30).some((t) => t.iri === target.iri)).toBe(true);
    expect(searchTerms(all, 'zzzzqq')).toEqual([]);
    expect(searchTerms(all, '   ')).toEqual([]);
  });
});

import { dataConsistency, structuralReasoner } from '../src/reasoner.js';
import { parseData } from '../src/index.js';

// The data check works out the ontology's half of the structural reasoner once and keeps it,
// instead of copying the ontology and reasoning over it on every check (most of each check's time).
describe('data consistency against a kept analysis of the ontology', () => {
  const merged = async (g: OntologyGraph, data: Awaited<ReturnType<typeof parseData>>) => {
    const m = g.clone();
    m.store.addQuads(data);
    const r = structuralReasoner(m);
    return { consistent: r.consistent, notes: new Set(r.explanation?.split('\n') ?? []) };
  };
  const fast = (g: OntologyGraph, data: Awaited<ReturnType<typeof parseData>>) => {
    const r = dataConsistency(g, data);
    return { consistent: r.consistent, notes: new Set(r.explanation?.split('\n') ?? []) };
  };
  const ttl = `@prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
    @prefix xsd: <http://www.w3.org/2001/XMLSchema#> . @prefix ex: <https://example.org/> .
    ex:Person a owl:Class . ex:Org a owl:Class ; owl:disjointWith ex:Person . ex:Volunteer a owl:Class ; rdfs:subClassOf ex:Person .
    ex:worksFor a owl:ObjectProperty ; rdfs:domain ex:Person ; rdfs:range ex:Org .
    ex:age a owl:DatatypeProperty , owl:FunctionalProperty .`;
  const cases: Record<string, string> = {
    consistent: 'ex:a a ex:Volunteer ; ex:worksFor ex:b ; rdfs:label "A" ; rdfs:comment "Labels and comments are only annotations." .',
    'labelled, with disjoint types': 'ex:a rdfs:label "A" ; a ex:Volunteer , ex:Org .',
    'disjoint types': 'ex:a a ex:Volunteer , ex:Org .',
    'typed by domain and range': 'ex:a ex:worksFor ex:b . ex:b ex:worksFor ex:c .',
    'two functional values': 'ex:a ex:age 3 , 4 .',
    'data that adds to the hierarchy': 'ex:Org rdfs:subClassOf ex:Person . ex:x a ex:Org .',
    'data that declares a class': 'ex:New a owl:Class ; owl:disjointWith ex:Person . ex:y a ex:New , ex:Person .',
  };
  for (const [name, data] of Object.entries(cases)) {
    it(`agrees with reasoning over a merged copy: ${name}`, async () => {
      const g = await OntologyGraph.fromTurtle(ttl);
      const quads = await parseData(`@prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . @prefix ex: <https://example.org/> .\n${data}`, 'turtle');
      expect(fast(g, quads)).toEqual(await merged(g, quads));
      // And again, from the kept analysis.
      expect(fast(g, quads)).toEqual(await merged(g, quads));
    });
  }
  it('agrees on the volunteering example data', async () => {
    const g = await OntologyGraph.fromTurtle(turtle);
    const quads = await parseData(readFileSync(new URL('../fixtures/volunteering-example-data.ttl', import.meta.url), 'utf8'), 'turtle');
    expect(fast(g, quads)).toEqual(await merged(g, quads));
  });
});
