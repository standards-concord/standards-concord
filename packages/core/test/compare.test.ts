import { describe, expect, it } from 'vitest';
import { compareGraphs, OntologyGraph, owlReasoner } from '../src/index.js';

const H = `@prefix : <https://ex.org/gov#> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . @prefix skos: <http://www.w3.org/2004/02/skos/core#> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<https://ex.org/gov> a owl:Ontology .`;

const gov = `${H}
:Agent a owl:Class ; rdfs:label "agent" .
:Person a owl:Class ; rdfs:label "person" ; rdfs:subClassOf :Agent .
:Business a owl:Class ; rdfs:label "business" ; rdfs:subClassOf :Agent .
:Address a owl:Class ; rdfs:label "address" .
:name a owl:DatatypeProperty ; rdfs:label "name" ; rdfs:range xsd:string .
:Charity a owl:Class ; rdfs:label "charity" ; rdfs:subClassOf :Agent .`;

describe('comparing two federations term by term', () => {
  it('sorts every term into same, equivalent, tightened, loosened, conflict or only on one side', async () => {
    const a = await OntologyGraph.fromTurtle(gov);
    const b = await OntologyGraph.fromTurtle(`${H}
:Agent a owl:Class ; rdfs:label "agent" .
:Person a owl:Class ; rdfs:label "individual person" ; rdfs:subClassOf :Agent .
:Business a owl:Class ; rdfs:label "business" ; rdfs:subClassOf :Agent ; owl:disjointWith :Person .
:Address a owl:Class ; rdfs:label "address" .
:name a owl:DatatypeProperty ; rdfs:label "name" ; rdfs:range xsd:string ; a owl:FunctionalProperty .
:Charity a owl:Class ; rdfs:label "charity" ; rdfs:subClassOf :Business .
:Firm a owl:Class ; rdfs:label "firm" ; rdfs:subClassOf :Business .`);
    const r = await compareGraphs(a, b, { reasonerA: await owlReasoner(a), reasonerB: await owlReasoner(b) });
    const rel = Object.fromEntries(r.terms.map((t) => [t.iri.replace('https://ex.org/gov#', ''), t.relation]));
    expect(rel).toEqual({ Address: 'same', Agent: 'same', Business: 'tightened', Charity: 'tightened', Firm: 'only-b', Person: 'equivalent', name: 'tightened' });
    expect(r.terms.find((t) => t.iri.endsWith('#Business'))?.onlyInB).toEqual(['disjointWith Person']);
    expect(r).toMatchObject({ shared: 6, agreeing: 6 });
  });

  it('calls a term loosened when B drops a constraint, and a conflict when both sides add different ones', async () => {
    const a = await OntologyGraph.fromTurtle(`${gov}\n:Person owl:disjointWith :Business .`);
    const b = await OntologyGraph.fromTurtle(`${H}
:Agent a owl:Class . :Person a owl:Class ; rdfs:label "person" ; rdfs:subClassOf :Agent .
:Business a owl:Class ; rdfs:label "business" ; rdfs:subClassOf :Agent .
:Address a owl:Class ; rdfs:label "address" ; rdfs:subClassOf :Agent .
:name a owl:DatatypeProperty ; rdfs:label "name" ; rdfs:range xsd:normalizedString .`);
    const r = await compareGraphs(a, b);
    const rel = Object.fromEntries(r.terms.map((t) => [t.iri.replace('https://ex.org/gov#', ''), t.relation]));
    expect(rel.Person).toBe('loosened');
    expect(rel.Address).toBe('tightened');
    expect(rel.name).toBe('conflict');
    expect(rel.Charity).toBe('only-a');
    expect(r.terms.find((t) => t.iri.endsWith('#name'))).toMatchObject({ onlyInA: ['range string'], onlyInB: ['range normalizedString'] });
  });

  it('treats a restated hierarchy as the same meaning, through the reasoner', async () => {
    // A says Charity ⊑ Business ⊑ Agent; B also states Charity ⊑ Agent outright: nothing new is entailed.
    const a = await OntologyGraph.fromTurtle(`${H}\n:Agent a owl:Class . :Business a owl:Class ; rdfs:subClassOf :Agent . :Charity a owl:Class ; rdfs:subClassOf :Business .`);
    const b = await OntologyGraph.fromTurtle(`${H}\n:Agent a owl:Class . :Business a owl:Class ; rdfs:subClassOf :Agent . :Charity a owl:Class ; rdfs:subClassOf :Business, :Agent .`);
    const r = await compareGraphs(a, b);
    expect(r.terms.find((t) => t.iri.endsWith('#Charity'))?.relation).toBe('equivalent');
  });

  // Review r1: equal term hashes overrode a change in entailed facts, so a class whose superclass gained
  // a superclass was still called "the same".
  it('does not call a term the same when what it entails has changed', async () => {
    const a = await OntologyGraph.fromTurtle(`${H}\n:Top a owl:Class . :Mid a owl:Class . :Leaf a owl:Class ; rdfs:subClassOf :Mid .`);
    const b = await OntologyGraph.fromTurtle(`${H}\n:Top a owl:Class . :Mid a owl:Class ; rdfs:subClassOf :Top . :Leaf a owl:Class ; rdfs:subClassOf :Mid .`);
    const r = await compareGraphs(a, b, { reasonerA: await owlReasoner(a), reasonerB: await owlReasoner(b) });
    const leaf = r.terms.find((t) => t.iri.endsWith('#Leaf'))!;
    expect(leaf.relation).toBe('tightened');
    expect(leaf.onlyInB).toEqual(['subClassOf Top']);
  });
});
