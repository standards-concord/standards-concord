import { describe, expect, it } from 'vitest';
import { applyChangeOps, OntologyGraph, upstreamOps } from '../src/index.js';

const H = `@prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . @prefix skos: <http://www.w3.org/2004/02/skos/core#> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .`;

describe('handing terms upstream', () => {
  it("re-creates chosen terms in the target's namespace, linked back, keeping what the target can say", async () => {
    const gov = await OntologyGraph.fromTurtle(`${H} @prefix gov: <https://ex.org/gov#> .
<https://ex.org/gov> a owl:Ontology ; <http://purl.org/dc/terms/title> "Government"@en .
gov:Organisation a owl:Class ; rdfs:label "organisation"@en ; skos:definition "A body of people."@en .`);
    const fs = await OntologyGraph.fromTurtle(`${H} @prefix gov: <https://ex.org/gov#> . @prefix fs: <https://ex.org/fs#> .
<https://ex.org/fs> a owl:Ontology .
gov:Organisation a owl:Class .
fs:Lender a owl:Class ; rdfs:label "lender"@en ; skos:definition "An organisation that lends money."@en ; rdfs:subClassOf fs:FinancialFirm .
fs:FinancialFirm a owl:Class ; rdfs:label "financial firm"@en ; skos:definition "An organisation that provides financial services."@en ; rdfs:subClassOf gov:Organisation, fs:Regulated .
fs:Regulated a owl:Class ; rdfs:label "regulated"@en ; skos:definition "Something a regulator oversees."@en .
fs:interestRate a owl:DatatypeProperty ; rdfs:label "interest rate"@en ; skos:definition "The rate a lender charges."@en ; rdfs:domain fs:Lender ; rdfs:range xsd:decimal .`);
    const plan = upstreamOps(fs, ['https://ex.org/fs#Lender', 'https://ex.org/fs#FinancialFirm', 'https://ex.org/fs#interestRate'], gov);
    expect(plan.mapping).toEqual({ 'https://ex.org/fs#Lender': 'https://ex.org/gov#Lender', 'https://ex.org/fs#FinancialFirm': 'https://ex.org/gov#FinancialFirm', 'https://ex.org/fs#interestRate': 'https://ex.org/gov#interestRate' });
    // FinancialFirm comes first (Lender builds on it); Regulated wasn't chosen and the target lacks it.
    expect(plan.ops.map((o) => (o as { localName: string }).localName)).toEqual(['FinancialFirm', 'Lender', 'interestRate']);
    expect(plan.ops[0]).toMatchObject({ op: 'addClass', subClassOf: ['https://ex.org/gov#Organisation'], label: 'financial firm', mappings: { 'http://www.w3.org/2004/02/skos/core#exactMatch': ['https://ex.org/fs#FinancialFirm'] } });
    expect(plan.ops[1]).toMatchObject({ subClassOf: ['https://ex.org/gov#FinancialFirm'] });
    expect(plan.ops[2]).toMatchObject({ op: 'addDatatypeProperty', domain: ['https://ex.org/gov#Lender'], range: ['http://www.w3.org/2001/XMLSchema#decimal'] });
    expect(plan.warnings).toEqual([expect.stringMatching(/FinancialFirm: its superclass Regulated isn't in the target/)]);
    // The target accepts the operations as they are.
    const { graph } = applyChangeOps(gov, plan.ops);
    expect(graph.isClassIri('https://ex.org/gov#Lender')).toBe(true);
  });
});
