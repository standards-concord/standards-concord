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

  it('stops keeping triples at the cap while it parses', async () => {
    const many = `<https://e/a> <https://e/p> ${Array.from({ length: 1000 }, (_, i) => i).join(', ')} .`;
    const err = await parseData(many, 'turtle', { maxTriples: 10 }).catch((e) => e);
    expect(err.status).toBe(413);
    expect(err.message).toMatch(/more than 10 triples/);
  });

  it('never loads remote contexts from @import or scoped contexts either', async () => {
    const docs = [
      { '@context': { '@version': 1.1, '@import': 'https://remote.example/import.jsonld' }, '@id': 'https://e/a', 'https://e/p': 1 },
      { '@context': { '@version': 1.1, p: { '@id': 'https://e/p', '@context': 'https://remote.example/scoped.jsonld' } }, '@id': 'https://e/a', p: { 'https://e/q': 1 } },
      { '@context': { '@version': 1.1, T: { '@id': 'https://e/T', '@context': ['https://remote.example/type.jsonld'] } }, '@id': 'https://e/a', '@type': 'T', 'https://e/q': 1 },
    ];
    for (const doc of docs) {
      const err = await parseData(JSON.stringify(doc), 'jsonld').catch((e) => e);
      expect(err).toBeInstanceOf(DataError);
      expect(err.message).toMatch(/Remote JSON-LD contexts are not fetched \(https:\/\/remote\.example\//);
    }
  });

  it('stops parsing at the cap, in every format', async () => {
    // Past the cap the data is broken: a 413, not a 400, shows the parser never read that far. (JSON-LD is converted whole, then counted as it is read back.)
    const n = 5000;
    const tail = ' this is not RDF <<<';
    const nt = Array.from({ length: n }, (_, i) => `<https://e/s${i}> <https://e/p> "${i}" .`).join('\n');
    const cases: [string, Parameters<typeof parseData>[1]][] = [
      [`<https://e/a> <https://e/p> ${Array.from({ length: n }, (_, i) => i).join(', ')} .${tail}`, 'turtle'],
      [nt + tail, 'ntriples'],
      [`{"@context": {"p": "https://e/p"}, "@graph": [${Array.from({ length: n }, (_, i) => `{"@id": "https://e/s${i}", "p": ${i}}`).join(',')}]}`, 'jsonld'],
      [`<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:e="https://e/">${Array.from({ length: n }, (_, i) => `<rdf:Description rdf:about="https://e/s${i}"><e:p>${i}</e:p></rdf:Description>`).join('')}<unclosed`, 'rdfxml'],
    ];
    for (const [text, format] of cases) {
      const err = await parseData(text, format, { maxTriples: 2 }).catch((e) => e);
      expect(err, format).toBeInstanceOf(DataError);
      expect([format, err.status, err.message]).toEqual([format, 413, 'The data has more than 2 triples, the limit.']);
    }
  });

  it('counts JSON-LD triples with its contexts applied', async () => {
    const ctx = { p: 'https://e/p', blob: { '@id': 'https://e/blob', '@type': '@json' }, items: { '@id': 'https://e/items', '@container': '@list' } };
    // A large @json literal is one triple, however many keys it has inside.
    const blob = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    const one = await parseData(JSON.stringify({ '@context': ctx, '@id': 'https://e/a', blob }), 'jsonld', { maxTriples: 1 });
    expect(one).toHaveLength(1);
    // A list from the context makes two triples per item, plus the link to it.
    const list = JSON.stringify({ '@context': ctx, '@id': 'https://e/a', items: Array.from({ length: 10 }, (_, i) => i) });
    expect(await parseData(list, 'jsonld', { maxTriples: 21 })).toHaveLength(21);
    expect((await parseData(list, 'jsonld', { maxTriples: 20 }).catch((e) => e)).status).toBe(413);
    // Lists of lists count their inner items too.
    const lists = JSON.stringify({ '@context': ctx, '@id': 'https://e/a', items: [[1, 2, 3], [4, [5, 6]]] });
    expect(await parseData(lists, 'jsonld')).toHaveLength(1 + 2 * 2 + 2 * 3 + 2 * 2 + 2 * 2);
    expect((await parseData(lists, 'jsonld', { maxTriples: 18 }).catch((e) => e)).status).toBe(413);
    const deepList = JSON.stringify({ '@context': ctx, '@id': 'https://e/a', items: [[Array.from({ length: 5000 }, (_, i) => i)]] });
    expect((await parseData(deepList, 'jsonld', { maxTriples: 25 }).catch((e) => e)).message).toMatch(/more than 25 triples/);
    // The same description repeated is one set of triples.
    const repeated = JSON.stringify({ '@context': ctx, '@graph': Array.from({ length: 50 }, () => ({ '@id': 'https://e/a', '@type': 'https://e/T', p: 1 })) });
    expect(await parseData(repeated, 'jsonld', { maxTriples: 2 })).toHaveLength(2);
    // Duplicates are judged as RDF: a plain string is an xsd:string, and @type is rdf:type.
    const same = JSON.stringify({
      '@context': ctx,
      '@id': 'https://e/a',
      '@type': 'https://e/T',
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#type': { '@id': 'https://e/T' },
      p: ['x', { '@value': 'x', '@type': 'http://www.w3.org/2001/XMLSchema#string' }],
    });
    expect(await parseData(same, 'jsonld', { maxTriples: 2 })).toHaveLength(2);
    // Arrays nested in arrays are flattened into one set of values.
    const nested = JSON.stringify({ '@context': ctx, '@id': 'https://e/a', p: [[1, [2, [3]]]] });
    expect(await parseData(nested, 'jsonld', { maxTriples: 3 })).toHaveLength(3);
    expect((await parseData(nested, 'jsonld', { maxTriples: 2 }).catch((e) => e)).status).toBe(413);
  });

  it('limits JSON-LD by size, as it is converted whole', async () => {
    const doc = JSON.stringify({ '@id': 'https://e/a', 'https://e/p': 'x'.repeat(2000) });
    const err = await parseData(doc, 'jsonld', { maxJsonLdBytes: 1000 }).catch((e) => e);
    expect([err.status, err.message]).toEqual([413, 'JSON-LD data is limited to 0.001 MB. Send larger data as Turtle or N-Triples.']);
    expect(await parseData(doc, 'jsonld', { maxJsonLdBytes: 4000 })).toHaveLength(1);
  });

  it('counts distinct triples in every format, so repeats are free', async () => {
    const repeated = Array.from({ length: 100 }, () => '<https://e/a> <https://e/p> "x" .').join('\n');
    expect(await parseData(repeated, 'ntriples', { maxTriples: 1 })).toHaveLength(1);
    expect(await parseData('<https://e/a> <https://e/p> "x", "x"^^<http://www.w3.org/2001/XMLSchema#string> .', 'turtle', { maxTriples: 1 })).toHaveLength(1);
  });

  it('refuses deeply nested JSON before expanding it', async () => {
    let deep = '1';
    for (let i = 0; i < 5000; i++) deep = `{"https://e/p": ${deep}}`;
    const t = performance.now();
    const err = await parseData(deep, 'jsonld').catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/nested more than 64 levels/);
    expect(performance.now() - t).toBeLessThan(1000);
  });

  it('parses data split across chunks, including multi-byte characters', async () => {
    const long = 'é😀'.repeat(20_000);
    const quads = await parseData(`<https://e/a> <https://e/p> "${long}" .\n<https://e/a> <https://e/q> "x" .`, 'turtle');
    expect(quads).toHaveLength(2);
    expect(quads.find((q) => q.predicate.value === 'https://e/p')!.object.value).toBe(long);
    const json = await parseData(JSON.stringify({ '@id': 'https://e/a', 'https://e/p': long }), 'jsonld');
    expect(json[0].object.value).toBe(long);
  });

  it('refuses RDF/XML DTDs', async () => {
    const err = await parseData('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/>', 'rdfxml').catch((e) => e);
    expect(err).toBeInstanceOf(DataError);
    expect(err.status).toBe(400);
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

  it('names the exact failing shape when two shapes share a path', async () => {
    const shapes = `@prefix sh: <${SH}> . @prefix ex: <https://e/> .
      ex:S a sh:NodeShape ; sh:targetClass ex:T ;
        sh:property [ sh:path ex:p ; sh:qualifiedValueShape [ sh:class ex:B ] ; sh:qualifiedMinCount 1 ] ,
                    [ sh:path ex:p ; sh:qualifiedValueShape [ sh:class ex:C ] ; sh:qualifiedMinCount 1 ] .`;
    const validator = ShapesValidator.fromTurtle(shapes);
    const data = await parseData('@prefix ex: <https://e/> . ex:x a ex:T ; ex:p ex:b . ex:b a ex:B .', 'turtle');
    const report = await validator.validate(data);
    expect(report.results).toHaveLength(1);
    const store = new Store(new Parser({ format: 'Turtle' }).parse(validator.reportTurtle(report)));
    const source = store.getObjects(null, `${SH}sourceShape`, null)[0];
    const qvs = store.getObjects(source, `${SH}qualifiedValueShape`, null)[0];
    expect(store.getObjects(qvs, `${SH}class`, null)[0].value).toBe('https://e/C');
  });

  it('conforms when nothing is targeted', async () => {
    const { graph, validator } = await setup();
    const report = await validator.validate(await parseData('<https://e/a> <https://e/p> "x" .', 'ntriples'), classHierarchy(graph));
    expect(report).toMatchObject({ conforms: true, results: [] });
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
