import { Parser, Store } from 'n3';
import { describe, expect, it } from 'vitest';
import { checkTerms, classHierarchy, DataError, dataFormatForFile, dataFormatForMediaType, parseData, ShapesValidator, sniffDataFormat, toShacl } from '../src/index.js';
import { loadFixture } from './helpers.js';

const SH = 'http://www.w3.org/ns/shacl#';
const VOL = 'https://w3id.org/odi/volunteering#';
const P = `@prefix vol: <${VOL}> . @prefix ex: <https://example.org/> .\n`;

describe('reading data', () => {
  it('knows formats by media type, file name and content', () => {
    expect(dataFormatForMediaType('text/turtle; charset=utf-8')).toBe('turtle');
    expect(dataFormatForMediaType('application/json')).toBe('jsonld');
    expect(dataFormatForMediaType('application/pdf')).toBeUndefined();
    expect(dataFormatForFile('data.JSONLD')).toBe('jsonld');
    expect(dataFormatForFile('data.nq')).toBe('nquads');
    expect(dataFormatForFile('data.csv')).toBeUndefined();
    expect(sniffDataFormat('  {"@id": "x"}')).toBe('jsonld');
    expect(sniffDataFormat('<?xml version="1.0"?><rdf:RDF/>')).toBe('rdfxml');
    expect(sniffDataFormat('<https://g> { <a:b> <a:c> <a:d> . }')).toBe('trig');
    expect(sniffDataFormat('@prefix ex: <https://e/> .')).toBe('turtle');
  });

  it('merges named graphs into one data graph', async () => {
    const quads = await parseData('<https://e/g> { <https://e/a> <https://e/p> <https://e/b> . }', 'trig');
    expect(quads).toHaveLength(1);
    expect(quads[0].graph.termType).toBe('DefaultGraph');
  });

  it('refuses relative IRIs without a base, and resolves them with one', async () => {
    await expect(parseData('<#a> <https://e/p> 1 .', 'turtle')).rejects.toThrow(/relative IRI/);
    const [q] = await parseData('<#a> <https://e/p> 1 .', 'turtle', { baseIRI: 'https://data.example/' });
    expect(q.subject.value).toBe('https://data.example/#a');
  });

  it('refuses too many triples with a 413', async () => {
    const err = await parseData('<https://e/a> <https://e/p> 1, 2, 3 .', 'turtle', { maxTriples: 2 }).catch((e) => e);
    expect(err).toBeInstanceOf(DataError);
    expect(err.status).toBe(413);
  });

  it('never loads remote JSON-LD contexts', async () => {
    const err = await parseData(JSON.stringify({ '@context': 'https://schema.org/', '@id': 'https://e/a', name: 'x' }), 'jsonld').catch((e) => e);
    expect(err).toBeInstanceOf(DataError);
    expect(err.message).toMatch(/Remote JSON-LD contexts are not fetched \(https:\/\/schema\.org\//);
  });

  it('reports parse errors as 400s', async () => {
    const err = await parseData('<https://e/a> <https://e/p>', 'turtle').catch((e) => e);
    expect(err).toBeInstanceOf(DataError);
    expect(err.status).toBe(400);
  });
});

describe('SHACL validation against the derived shapes', () => {
  const setup = async () => {
    const graph = await loadFixture();
    return { graph, validator: ShapesValidator.fromTurtle(await toShacl(graph)) };
  };

  it('names the node shape and keeps the data’s blank node labels', async () => {
    const { graph, validator } = await setup();
    const data = await parseData(`${P}_:app a vol:Application ; vol:submittedBy ex:org . ex:org a vol:Organisation .`, 'turtle');
    const report = await validator.validate(data, classHierarchy(graph));
    expect(report.conforms).toBe(false);
    const cls = report.results.find((r) => r.constraint === `${SH}ClassConstraintComponent`)!;
    expect(cls).toMatchObject({ focusNode: '_:app', path: `${VOL}submittedBy`, value: '<https://example.org/org>', severity: 'Violation', shape: 'https://w3id.org/odi/volunteering/shapes#ApplicationShape' });
    expect(report.results.some((r) => r.constraint === `${SH}MinCountConstraintComponent` && r.path === `${VOL}forOpportunity`)).toBe(true);
  });

  it('writes a SHACL report whose source shapes are described in it', async () => {
    const { graph, validator } = await setup();
    const data = await parseData(`${P}ex:app a vol:Application .`, 'turtle');
    const report = await validator.validate(data, classHierarchy(graph));
    const store = new Store(new Parser({ format: 'Turtle' }).parse(validator.reportTurtle(report, graph.prefixes)));
    const results = store.getObjects(null, `${SH}result`, null);
    expect(results).toHaveLength(report.results.length);
    for (const r of results) {
      const shape = store.getObjects(r, `${SH}sourceShape`, null)[0];
      const path = store.getObjects(r, `${SH}resultPath`, null)[0];
      // The copied property shape has the result's path, and hangs off the named node shape.
      expect(store.getObjects(shape, `${SH}path`, null)[0].value).toBe(path.value);
      expect(store.getSubjects(`${SH}property`, shape, null)[0].value).toBe('https://w3id.org/odi/volunteering/shapes#ApplicationShape');
    }
  });

  it('conforms when nothing is targeted', async () => {
    const { graph, validator } = await setup();
    const report = await validator.validate(await parseData('<https://e/a> <https://e/p> "x" .', 'ntriples'), classHierarchy(graph));
    expect(report).toEqual({ conforms: true, results: [] });
  });
});

describe('checking terms', () => {
  it('flags undefined terms in the namespace with suggestions, and contradictions', async () => {
    const graph = await loadFixture();
    const data = await parseData(`${P}ex:x a vol:Person, vol:Organisation ; vol:titl "x" ; ex:own "fine" .`, 'turtle');
    const issues = checkTerms(graph, data);
    expect(issues.find((i) => i.term === `${VOL}titl`)?.message).toMatch(/vol:titl is used as a property but is not defined.*Did you mean vol:title/);
    expect(issues.some((i) => /contradicts the ontology/.test(i.message))).toBe(true);
    expect(issues.some((i) => i.term?.startsWith('https://example.org/'))).toBe(false);
  });
});
