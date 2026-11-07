import { describe, expect, it } from 'vitest';
import { checkFederation, OntologyGraph, owlReasoner, type FederationMemberInput } from '../src/index.js';

const H = '@prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .';
const none = { imported: [], unresolved: [], direct: [] };

async function member(id: string, ttl: string): Promise<FederationMemberInput> {
  return { id, title: id.toUpperCase(), version: '1.0.0', graph: await OntologyGraph.fromTurtle(`${H}\n${ttl}`), closure: none };
}

const people = () =>
  member('people', `@prefix p: <https://ex.org/people#> . <https://ex.org/people> a owl:Ontology .
p:Person a owl:Class . p:Organisation a owl:Class ; owl:disjointWith p:Person .`);

describe('checking a federation', () => {
  it('passes members that can be used together', async () => {
    const jobs = await member('jobs', `@prefix j: <https://ex.org/jobs#> . @prefix p: <https://ex.org/people#> . <https://ex.org/jobs> a owl:Ontology .
j:Employee a owl:Class ; rdfs:subClassOf p:Person .`);
    const r = await checkFederation('urn:test:fed', [await people(), jobs], owlReasoner);
    expect(r.passed).toBe(true);
    expect(r.members.map((m) => [m.ontologyId, m.passed])).toEqual([['people', true], ['jobs', true]]);
    expect(r.conflicts).toEqual([]);
  });

  it('finds the pair of members that conflict, though each passes alone', async () => {
    // "charity" says a Charity is a Person; "orgs" says a Charity is an Organisation. Each is fine alone.
    const charity = await member('charity', `@prefix c: <https://ex.org/charity#> . @prefix p: <https://ex.org/people#> . <https://ex.org/charity> a owl:Ontology .
c:Charity a owl:Class ; rdfs:subClassOf p:Person .`);
    const orgs = await member('orgs', `@prefix o: <https://ex.org/orgs#> . @prefix c: <https://ex.org/charity#> . @prefix p: <https://ex.org/people#> . <https://ex.org/orgs> a owl:Ontology .
o:Body a owl:Class . c:Charity rdfs:subClassOf p:Organisation .`);
    const r = await checkFederation('urn:test:fed', [await people(), charity, orgs], owlReasoner);
    expect(r.members.every((m) => m.passed)).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.joint.unsatisfiable).toEqual([{ iri: 'https://ex.org/charity#Charity', member: 'charity', alone: false }]);
    // It takes all three (people's disjointness and both claims about Charity), so no pair conflicts on its own.
    expect(r.conflicts).toEqual([]);
    expect(r.foreignAxioms).toEqual([{ member: 'orgs', subject: 'https://ex.org/charity#Charity', predicate: 'http://www.w3.org/2000/01/rdf-schema#subClassOf', object: 'https://ex.org/people#Organisation', owner: 'CHARITY' }]);
  });

  it('names a pair when two members alone are enough to conflict', async () => {
    const strict = await member('strict', `@prefix p: <https://ex.org/people#> . @prefix s: <https://ex.org/strict#> . <https://ex.org/strict> a owl:Ontology .
s:Volunteer a owl:Class ; rdfs:subClassOf p:Person, p:Organisation .`);
    const loose = await member('loose', `@prefix l: <https://ex.org/loose#> . <https://ex.org/loose> a owl:Ontology . l:Thing a owl:Class .`);
    const r = await checkFederation('urn:test:fed', [await people(), strict, loose], owlReasoner);
    expect(r.members.find((m) => m.ontologyId === 'strict')?.passed).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.conflicts).toEqual([{ a: 'people', b: 'strict', inconsistent: false, unsatisfiable: ['https://ex.org/strict#Volunteer'] }]);
  });

  it('fails when a member already has an impossible class on its own, without blaming a pair', async () => {
    const broken = await member('broken', `@prefix p: <https://ex.org/people#> . @prefix b: <https://ex.org/broken#> . <https://ex.org/broken> a owl:Ontology .
p:Person a owl:Class . p:Organisation a owl:Class ; owl:disjointWith p:Person . b:Both a owl:Class ; rdfs:subClassOf p:Person, p:Organisation .`);
    const r = await checkFederation('urn:test:fed', [await people(), broken], owlReasoner);
    expect(r.members.find((m) => m.ontologyId === 'broken')).toMatchObject({ passed: false, unsatisfiable: ['https://ex.org/broken#Both'] });
    expect(r.passed).toBe(false);
    expect(r.joint.unsatisfiable).toEqual([{ iri: 'https://ex.org/broken#Both', member: 'broken', alone: true }]);
    expect(r.conflicts).toEqual([]);
  });
});
