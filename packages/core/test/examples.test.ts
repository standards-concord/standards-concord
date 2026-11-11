import { Parser } from 'n3';
import { fixtureText, loadFixture } from './helpers.js';
import { describe, expect, it } from 'vitest';
import { checkData, exampleData, exampleFiles, OntologyGraph, prepareOntology, toShacl, workedExamples } from '../src/index.js';

const graph = () => OntologyGraph.fromTurtle('@prefix ex: <https://example.org/> . @prefix owl: <http://www.w3.org/2002/07/owl#> . ex:standard a owl:Ontology . ex:Record a owl:Class .');
const data = '@prefix ex: <https://example.org/> . ex:first a ex:Record ; ex:name "First" .';
const question = { id: 'cq-one', source: 'uc-one', question: 'What is its name?', sparql: 'SELECT ?name ?missing WHERE { ?record ex:name ?name }', exampleData: data, exampleAnswer: 'First' };

describe('worked examples', () => {
  it('keeps the question, source, expected answer and actual SELECT answer with prefixes', async () => {
    const [e] = await workedExamples(await graph(), [question]);
    expect(e).toMatchObject({ question: question.question, source: 'uc-one', exampleData: data, exampleAnswer: 'First', answered: true, result: { variables: ['name', 'missing'], rows: [{ name: 'First' }], totalCount: 1 } });
    expect(e.sparql).toContain('PREFIX ex: <https://example.org/>');
    expect(exampleFiles([e])[e.queryFile]).toBe(`${e.sparql}\n`);
    expect(JSON.parse(exampleFiles([e])['examples.json'])).toEqual([e]);
  });

  it('keeps ASK true and false as booleans', async () => {
    const examples = await workedExamples(await graph(), [
      { ...question, sparql: 'ASK { ?s a ex:Record }' },
      { ...question, id: 'cq-two', sparql: 'ASK { ?s a ex:Absent }' },
    ]);
    expect(examples.map((e) => [e.answered, e.result.boolean, e.result.rows])).toEqual([[true, true, []], [false, false, []]]);
  });

  it('keeps errors and empty answers without claiming they were answered', async () => {
    const examples = await workedExamples(await graph(), [
      { ...question, sparql: 'not a query' },
      { ...question, sparql: 'SELECT ?name WHERE { ?s ex:absent ?name }' },
      { ...question, exampleData: 'not Turtle' },
    ]);
    expect(examples.map((e) => e.answered)).toEqual([false, false, false]);
    expect(examples[0].result.error).toBeTruthy();
    expect(examples[2].result.error).toBeTruthy();
    expect(examples[1].result).toEqual({ variables: ['name'], rows: [], totalCount: 0 });
  });

  it('caps displayed rows at twenty and counts all answers', async () => {
    const sparql = `SELECT ?n WHERE { VALUES ?n { ${Array.from({ length: 27 }, (_, i) => i).join(' ')} } } ORDER BY ?n`;
    const [e] = await workedExamples(await graph(), [{ ...question, sparql }]);
    expect(e.result.totalCount).toBe(27);
    expect(e.result.rows).toHaveLength(20);
    expect(e.result.rows[19]).toEqual({ n: '19' });
  });

  it('keeps explicit prefixes and stable anchors when questions move', async () => {
    const q = { ...question, sparql: 'PREFIX ex: <https://other.example/> SELECT ?s WHERE { ?s a ex:Record }' };
    const [first] = await workedExamples(await graph(), [q]);
    const [, moved] = await workedExamples(await graph(), [{ ...question, id: 'other' }, q]);
    expect(first.id).toBe(moved.id);
    expect(first.slug).toBe(moved.slug);
    expect(first.sparql.match(/PREFIX ex:/g)).toHaveLength(1);
    expect(first.sparql).toContain('<https://other.example/>');
  });

  it('provides demo data that passes the same check as Validate data', async () => {
    const g = await loadFixture();
    const questions = JSON.parse(fixtureText('volunteering-cqs.json')).map((q: typeof question) => ({ ...q, source: 'uc-demo', exampleData: fixtureText('volunteering-example-data.ttl') }));
    const data = exampleData(await workedExamples(g, questions), g.ontologyIRI);
    const checked = await checkData(await prepareOntology(g, await toShacl(g)), data, 'turtle', { baseIRI: 'https://data.example/', maxTriples: 25000 });
    expect(checked).toMatchObject({ conforms: true, valid: true, summary: { violations: 0, termErrors: 0, termWarnings: 0 } });
  });

  it('combines data without leaking prefix declarations, relative bases or blank nodes between examples', async () => {
    const examples = await workedExamples(await graph(), [
      { ...question, exampleData: '@prefix ex: <https://one.example/> . _:same ex:p <#a> .' },
      { ...question, id: 'two', exampleData: '@prefix ex: <https://two.example/> . _:same ex:p <#a> .' },
    ]);
    const quads = new Parser().parse(exampleData(examples, 'https://example.org/standard'));
    expect(quads).toHaveLength(2);
    expect(quads[0].subject.value).not.toBe(quads[1].subject.value);
    expect(quads.map((q) => q.predicate.value).sort()).toEqual(['https://one.example/p', 'https://two.example/p']);
    expect(quads.every((q) => q.object.value === 'https://example.org/standard#a')).toBe(true);
  });
});
