import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { OntologyGraph, applyChangeOps, serialize } from '../src/index.js';
import { yamlLdToJson } from '../src/yamlld.js';

const EX = 'https://example.org/e#';

/** A local server that counts requests, standing in for any URL a document might point at. */
async function trap<T>(run: (base: string) => Promise<T>): Promise<{ hits: number; result: PromiseSettledResult<T> }> {
  let hits = 0;
  const server = createServer((_, res) => {
    hits++;
    res.setHeader('Content-Type', 'application/ld+json');
    res.end(JSON.stringify({ '@context': { name: 'https://example.org/e#name' } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const [result] = await Promise.allSettled([run(base)]);
  await new Promise((r) => server.close(r));
  return { hits, result };
}

describe('reading JSON-LD and YAML-LD never touches the network', () => {
  it('refuses remote contexts, nested contexts and @import', async () => {
    const docs = (base: string) => [
      { '@context': `${base}/context`, '@id': `${EX}x`, name: 'x' },
      { '@context': [{ e: EX }, `${base}/context`], '@id': `${EX}x`, name: 'x' },
      { '@context': { e: EX, thing: { '@id': `${EX}thing`, '@context': `${base}/nested` } }, '@id': `${EX}x`, thing: { name: 'y' } },
      { '@context': { '@version': 1.1, '@import': `${base}/import` }, '@id': `${EX}x`, name: 'x' },
    ];
    for (const i of [0, 1, 2, 3]) {
      for (const format of ['jsonld', 'yamlld'] as const) {
        const { hits, result } = await trap((base) => {
          const doc = docs(base)[i];
          return OntologyGraph.parse(format === 'jsonld' ? JSON.stringify(doc) : JSON.stringify(doc, null, 1), format);
        });
        expect(hits, `${format} ${i}`).toBe(0);
        expect(result.status, `${format} ${i}`).toBe('rejected');
        expect(String((result as PromiseRejectedResult).reason), `${format} ${i}`).toMatch(/Remote JSON-LD documents are not loaded|loading remote context failed|context/i);
      }
    }
  });

  it('still reads inline contexts', async () => {
    const g = await OntologyGraph.parse(`"@context":\n  e: ${EX}\n"@id": e:x\n"@type": e:Thing\ne:name: hello\n`, 'yamlld');
    expect(g.store.size).toBe(2);
  });
});

describe('YAML-LD core requirements', () => {
  it('refuses values JSON can’t hold rather than changing them', () => {
    expect(() => yamlLdToJson('a: .nan')).toThrow(/JSON has no such number/);
    expect(() => yamlLdToJson('a: -.inf')).toThrow(/JSON has no such number/);
    expect(() => yamlLdToJson('a: !!timestamp 2020-01-01')).toThrow(/tag/);
    expect(() => yamlLdToJson('a: !custom x')).toThrow(/tag/);
    expect(() => yamlLdToJson('1: one')).toThrow(/keys must be strings/);
    expect(() => yamlLdToJson('? [a]\n: b')).toThrow(/keys must be strings/);
    expect(() => yamlLdToJson('%YAML 1.1\n---\na: no')).toThrow(/YAML 1\.2/);
    expect(() => yamlLdToJson('just a string')).toThrow(/mapping, a sequence or null/);
    expect(() => yamlLdToJson('a: 1\na: 2')).toThrow();
  });

  it('reads YAML 1.2 Core values as they are', () => {
    // In YAML 1.2, no and 2020-01-01 are strings, and << is an ordinary key.
    expect(yamlLdToJson('a: no\nb: 2020-01-01\nc: 1.5\nd: null\ne: true\n"<<": x')).toEqual({ a: 'no', b: '2020-01-01', c: 1.5, d: null, e: true, '<<': 'x' });
    expect(yamlLdToJson('base: &b {x: 1}\nuse: *b')).toEqual({ base: { x: 1 }, use: { x: 1 } });
  });

  it('reads empty and null documents as no data', async () => {
    expect(yamlLdToJson('')).toBeNull();
    expect(yamlLdToJson('# only a comment\n')).toBeNull();
    expect(yamlLdToJson('null')).toBeNull();
    expect(yamlLdToJson('~')).toBeNull();
    expect(yamlLdToJson('', { extractAllScripts: true })).toEqual([]);
    expect(yamlLdToJson('---\n~\n---\n"@id": a\n', { extractAllScripts: true })).toEqual([{ '@id': 'a' }]);
    expect((await OntologyGraph.parse('', 'yamlld')).store.size).toBe(0);
  });

  it('rejects a malformed stream, even past the document it reads', () => {
    expect(() => yamlLdToJson('a: one\n---\na: [unterminated')).toThrow(/isn't valid/);
    expect(() => yamlLdToJson('a: one\n---\n%YAML 1.1\n---\nb: two')).toThrow();
  });

  it('reads the first document of a stream, or all of them when asked', () => {
    const stream = '"@id": a\n---\n"@id": b\n';
    expect(yamlLdToJson(stream)).toEqual({ '@id': 'a' });
    expect(yamlLdToJson(stream, { extractAllScripts: true })).toEqual([{ '@id': 'a' }, { '@id': 'b' }]);
    // Each document is checked, even ones not read.
    expect(() => yamlLdToJson('"@id": a\n---\nb: .nan\n', { extractAllScripts: true })).toThrow(/JSON has no such number/);
  });

  it('bounds input size, nesting and expansion', () => {
    expect(() => yamlLdToJson(`a: "${'x'.repeat(2000)}"`, { maxBytes: 1000 })).toThrow(/over 1000 bytes/);
    // Bytes, not characters: 400 two-byte characters are 800 bytes.
    expect(() => yamlLdToJson(`a: "${'é'.repeat(400)}"`, { maxBytes: 600 })).toThrow(/over 600 bytes/);
    expect(() => yamlLdToJson(`a: "${'é'.repeat(40)}"`, { maxExpandedBytes: 60 })).toThrow(/expands to over 60 bytes/);
    expect(yamlLdToJson(`a: "${'é'.repeat(20)}"`, { maxExpandedBytes: 60 })).toEqual({ a: 'é'.repeat(20) });
    // Aliases count at the depth where they are used: a shallow anchor reused deep inside nests past the limit.
    const deep = `base: &b ${'['.repeat(40)}x${']'.repeat(40)}\nuse: ${'['.repeat(40)}*b${']'.repeat(40)}`;
    expect(() => yamlLdToJson(deep)).toThrow(/nested more than 64/);
    expect(() => yamlLdToJson(`${'['.repeat(80)}${']'.repeat(80)}`)).toThrow(/nested more than 64/);
    // Each level doubles the size: small to write, large to expand.
    const lines = ['a0: &a0 ["xxxxxxxxxxxxxxxxxxxxxxxx"]'];
    for (let i = 1; i < 20; i++) lines.push(`a${i}: &a${i} [*a${i - 1}, *a${i - 1}]`);
    expect(() => yamlLdToJson(lines.join('\n'), { maxExpandedBytes: 1_000_000 })).toThrow(/expands to over|alias/i);
    // Refused while building, long before 2^19 copies exist: well under a second.
    const started = Date.now();
    expect(() => yamlLdToJson(lines.join('\n'), { maxExpandedBytes: 50_000 })).toThrow(/expands to over 50000/);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('keeps __proto__ as an ordinary key', () => {
    const v = yamlLdToJson('"__proto__": {polluted: true}') as Record<string, unknown>;
    expect(Object.keys(v)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
  });
});

describe('editable metadata can’t put JSON-LD keywords in a context', () => {
  const ONT = (prefix: string, ns: string) => `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix vann: <http://purl.org/vocab/vann/> .
<https://example.org/e> a owl:Ontology ; vann:preferredNamespacePrefix "${prefix}" ; vann:preferredNamespaceUri "${ns}" .
<https://example.org/e#Thing> a owl:Class .`;

  it('refuses keyword prefixes and bad namespaces when metadata is edited', async () => {
    const g = await OntologyGraph.fromTurtle(ONT('e', 'https://example.org/e#'));
    for (const preferredPrefix of ['@import', '@context', '@vocab', 'a:b', 'has space', '']) {
      if (!preferredPrefix) continue;
      expect(() => applyChangeOps(g, [{ op: 'setMetadata', set: { preferredPrefix } }] as any), preferredPrefix).toThrow(/preferredPrefix must be a prefix name/);
    }
    expect(() => applyChangeOps(g, [{ op: 'setMetadata', set: { preferredNamespace: 'not an iri' } }] as any)).toThrow(/preferredNamespace must be an absolute IRI/);
    expect(() => applyChangeOps(g, [{ op: 'setMetadata', set: { preferredPrefix: 'vol', preferredNamespace: 'https://w3id.org/odi/vol#' } }] as any)).not.toThrow();
  });

  it('never uses a stored keyword prefix, and never fetches its namespace, when writing JSON-LD', async () => {
    const { hits, result } = await trap(async (base) => {
      // As already stored on main before this check existed.
      const g = await OntologyGraph.fromTurtle(ONT('@import', `${base}/context`));
      expect(g.prefixes['@import']).toBeUndefined();
      return [await serialize(g, 'jsonld'), await serialize(g, 'yamlld'), await serialize(g, 'turtle')];
    });
    expect(hits).toBe(0);
    expect(result.status).toBe('fulfilled');
    const [jsonld, yamlld, turtle] = (result as PromiseFulfilledResult<string[]>).value;
    // The stored value is still data ("@import" as a literal), but never a context entry.
    expect(Object.keys(JSON.parse(jsonld)['@context'])).not.toContain('@import');
    expect(Object.keys((yamlLdToJson(yamlld) as Record<string, Record<string, unknown>>)['@context'])).not.toContain('@import');
    expect(turtle).not.toMatch(/@prefix @import/);
  });
});
