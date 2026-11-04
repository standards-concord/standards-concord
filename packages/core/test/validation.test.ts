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
      expect([format, err.status]).toEqual([format, 413]);
      // JSON-LD is refused before conversion, for having too many JSON values (eight per allowed triple, but at least 1,024).
      expect(err.message).toBe(format === 'jsonld' ? 'This JSON-LD has more than 1,024 values, too many to convert. Send it as Turtle or N-Triples instead.' : 'The data has more than 2 triples, the limit.');
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
    expect((await parseData(deepList, 'jsonld', { maxTriples: 25 }).catch((e) => e)).status).toBe(413);
    expect(await parseData(deepList, 'jsonld', { maxTriples: 10_005 })).toHaveLength(10_005);
    // The same description repeated is one set of triples.
    // (Repeats still count towards the values JSON-LD may have before conversion: four per allowed triple.)
    const repeated = JSON.stringify({ '@context': ctx, '@graph': Array.from({ length: 50 }, () => ({ '@id': 'https://e/a', '@type': 'https://e/T', p: 1 })) });
    expect(await parseData(repeated, 'jsonld', { maxTriples: 40 })).toHaveLength(2);
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

  it('refuses data whose triples would hold too much text, as the triples are made, in every format', async () => {
    const refused = async (text: string, format: Parameters<typeof parseData>[1], why: RegExp) => {
      const t = performance.now();
      const err = await parseData(text, format, { maxTriples: 25_000 }).catch((e) => e);
      expect(err, format).toBeInstanceOf(DataError);
      expect([err.status, err.message]).toEqual([413, expect.stringMatching(why)]);
      expect(performance.now() - t).toBeLessThan(2000);
    };
    const tooLong = /longer than 4,096 characters/;
    const tooMuch = /more than 8 million characters of IRIs and literals/;
    const nodes = (n: number) => Array.from({ length: n }, (_, i) => ({ '@id': `https://e/s${i}`, p: 1 }));
    // A 100,000-character property IRI used on 5,000 nodes: about 140 KB that would expand to 500 MB.
    await refused(JSON.stringify({ '@context': { p: `https://e/${'x'.repeat(100_000)}` }, '@graph': nodes(5000) }), 'jsonld', tooLong);
    // Under the IRI limit, but used so often that the triples would still hold too much.
    await refused(JSON.stringify({ '@context': { p: `https://e/${'x'.repeat(4000)}` }, '@graph': nodes(5000) }), 'jsonld', tooMuch);
    // The same through a Turtle prefix, or a relative @vocab, or prefixes chained through other terms.
    await refused(`@prefix e: <https://e/${'x'.repeat(4000)}> .\n${Array.from({ length: 5000 }, (_, i) => `<https://s/${i}> e:p ${i} .`).join('\n')}`, 'turtle', tooMuch);
    // (A review's 152 KB document: 100 relative @vocabs of 1,000 characters each make a 100,000-character property.)
    const vocabs = [{ '@vocab': 'https://e/' }, ...Array.from({ length: 100 }, () => ({ '@vocab': `${'x'.repeat(1000)}/` }))];
    await refused(JSON.stringify({ '@context': vocabs, '@graph': nodes(2000) }), 'jsonld', tooLong);
    const chain: Record<string, string> = { t0: `https://e/${'x'.repeat(3000)}/` };
    for (let i = 1; i < 10; i++) chain[`t${i}`] = `t${i - 1}:${'y'.repeat(3000)}/`;
    await refused(JSON.stringify({ '@context': { ...chain, p: 't9:z' }, '@id': 'https://e/a', p: 1 }), 'jsonld', tooLong);
    // A long IRI written out in full is refused too, in any format.
    await refused(JSON.stringify({ '@id': `https://e/${'x'.repeat(5000)}`, 'https://e/p': 1 }), 'jsonld', tooLong);
    await refused(`<https://e/${'x'.repeat(5000)}> <https://e/p> "1" .`, 'ntriples', tooLong);
    // Literals count too.
    const err = await parseData(`<https://e/a> <https://e/p> "${'x'.repeat(200)}" .`, 'ntriples', { maxChars: 100 }).catch((e) => e);
    expect([err.status, err.message]).toEqual([413, expect.stringMatching(/characters of IRIs and literals/)]);
    // Ordinary data with a context, or many long-ish IRIs, passes.
    expect(await parseData(JSON.stringify({ '@context': { p: 'https://e/p' }, '@graph': nodes(5000) }), 'jsonld', { maxTriples: 25_000 })).toHaveLength(5000);
    expect(await parseData(JSON.stringify({ '@context': { p: `https://e/${'x'.repeat(1000)}` }, '@graph': nodes(5000) }), 'jsonld', { maxTriples: 25_000 })).toHaveLength(5000);
  });

  it('checks datatype IRIs and language tags like any other term, in every format', async () => {
    const long = `https://e/${'d'.repeat(5000)}`;
    const ns = 'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:e="https://e/"';
    const typed = (dt: string): [string, Parameters<typeof parseData>[1]][] => [
      [`<https://e/s> <https://e/p> "x"^^<${dt}> .`, 'turtle'],
      [`<https://e/s> <https://e/p> "x"^^<${dt}> .`, 'ntriples'],
      [`<https://e/s> <https://e/p> "x"^^<${dt}> <https://e/g> .`, 'nquads'],
      [`{ <https://e/s> <https://e/p> "x"^^<${dt}> . }`, 'trig'],
      [`<?xml version="1.0"?><rdf:RDF ${ns}><rdf:Description rdf:about="https://e/s"><e:p rdf:datatype="${dt}">x</e:p></rdf:Description></rdf:RDF>`, 'rdfxml'],
      [JSON.stringify({ '@id': 'https://e/s', 'https://e/p': { '@value': 'x', '@type': dt } }), 'jsonld'],
    ];
    for (const [text, format] of typed(long)) {
      const err = await parseData(text, format).catch((e) => e);
      expect([format, err.status, err.message]).toEqual([format, 413, expect.stringMatching(/datatype IRI longer than 4,096 characters/)]);
    }
    // A datatype IRI that would break the N-Triples written for the SHACL engine is a 400 (a review's 61-byte example).
    const broken = await parseData('{"@id":"urn:s","urn:p":{"@value":"x","@type":"https://e/a>"}}', 'jsonld').catch((e) => e);
    expect([broken.status, broken.message]).toEqual([400, expect.stringMatching(/datatype IRI with characters IRIs can't contain/)]);
    const relative = await parseData('<https://e/s> <https://e/p> "x"^^<int> .', 'turtle').catch((e) => e);
    expect([relative.status, relative.message]).toEqual([400, expect.stringMatching(/relative datatype IRI <int>/)]);
    const lang = await parseData(JSON.stringify({ '@id': 'https://e/s', 'https://e/p': { '@value': 'x', '@language': 'en> .' } }), 'jsonld').catch((e) => e);
    expect([lang.status, lang.message]).toEqual([400, expect.stringMatching(/language tag/)]);
    // Ordinary datatypes, tags and labels pass.
    const ok = await parseData('_:b1 <https://e/p> "x"@en-GB, "1"^^<http://www.w3.org/2001/XMLSchema#integer> .', 'turtle');
    expect(ok).toHaveLength(2);
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

  it('validates in batches of focus nodes exactly as in one run, keeping only the first results', async () => {
    const { graph, validator } = await setup();
    // Blank nodes, a subclass declared in the data, values whose types decide sh:class, nodes with two shapes.
    const data = await parseData(
      `${P}@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      ex:Special rdfs:subClassOf vol:Organisation .
      ${Array.from({ length: 30 }, (_, i) => `_:app${i} a vol:Application ; vol:submittedBy ${i % 3 ? 'ex:org' : 'ex:special'}${i % 4 ? ' ; vol:forOpportunity ex:opp' : ''} .`).join('\n')}
      ex:org a vol:Organisation . ex:special a ex:Special .
      ex:opp a vol:VolunteeringOpportunity, vol:Role ; vol:title "t" ; vol:offeredBy _:app1 .`,
      'turtle',
    );
    const context = classHierarchy(graph);
    const whole = await validator.validate(data, context, { batched: false });
    const batched = await validator.validate(data, context, { batchChars: 1 });
    expect(whole.results.length).toBeGreaterThan(10);
    expect(batched).toEqual(whole);
    // A limit keeps the first results and still counts every one.
    const limited = await validator.validate(data, context, { limit: 5, batchChars: 1 });
    expect(limited.results).toHaveLength(5);
    expect(limited.counts).toEqual(whole.counts);
    expect(limited.conforms).toBe(false);
  });

  it('keeps memory to a batch when data breaks thousands of constraints', async () => {
    // A review's 31 KB document: 1,900 nodes with 4,000-character IRIs, each missing ten required properties.
    const props = Array.from({ length: 10 }, (_, i) => `sh:property [ sh:path ex:p${i} ; sh:minCount 1 ]`).join(' ; ');
    const validator = ShapesValidator.fromTurtle(`@prefix sh: <${SH}> . @prefix ex: <https://e/> . ex:S a sh:NodeShape ; sh:targetClass ex:T ; ${props} .`);
    const data = await parseData(`@prefix e: <https://e/${'x'.repeat(3990)}/> . @prefix ex: <https://e/> .\n${Array.from({ length: 1900 }, (_, i) => `e:s${i} a ex:T .`).join('\n')}`, 'turtle');
    const before = process.memoryUsage().rss;
    const report = await validator.validate(data, [], { limit: 1000 });
    expect(report.counts.Violation).toBe(19_000);
    expect(report.results).toHaveLength(1000);
    // In one run the engine's report alone was about 76 million characters.
    expect(process.memoryUsage().rss - before).toBeLessThan(150 * 1024 * 1024);
  });

  it('keeps blank node labels N-Triples can write, and renames the others', async () => {
    const { graph, validator } = await setup();
    // a + U+0301, and labels with U+203F and U+200C: all valid labels.
    for (const label of ['a\u0301', 'a\u203fb', 'a\u200cb']) {
      const data = await parseData(`${P}_:${label} a vol:Application .`, 'turtle');
      const report = await validator.validate(data, classHierarchy(graph));
      expect(report.results.length, label).toBeGreaterThan(0);
      expect(report.results[0].focusNode).toMatch(/^_:b\d+$/);
    }
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
