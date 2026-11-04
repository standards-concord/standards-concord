import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { OntologyGraph } from '../src/index.js';
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
    expect(() => yamlLdToJson('just a string')).toThrow(/mapping or a sequence/);
    expect(() => yamlLdToJson('a: 1\na: 2')).toThrow();
  });

  it('reads YAML 1.2 Core values as they are', () => {
    // In YAML 1.2, no and 2020-01-01 are strings, and << is an ordinary key.
    expect(yamlLdToJson('a: no\nb: 2020-01-01\nc: 1.5\nd: null\ne: true\n"<<": x')).toEqual({ a: 'no', b: '2020-01-01', c: 1.5, d: null, e: true, '<<': 'x' });
    expect(yamlLdToJson('base: &b {x: 1}\nuse: *b')).toEqual({ base: { x: 1 }, use: { x: 1 } });
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
    expect(() => yamlLdToJson(`${'['.repeat(80)}${']'.repeat(80)}`)).toThrow(/nested more than 64/);
    // Each level doubles the size: small to write, large to expand.
    const lines = ['a0: &a0 ["xxxxxxxxxxxxxxxxxxxxxxxx"]'];
    for (let i = 1; i < 20; i++) lines.push(`a${i}: &a${i} [*a${i - 1}, *a${i - 1}]`);
    expect(() => yamlLdToJson(lines.join('\n'), { maxExpandedBytes: 1_000_000 })).toThrow(/expands to over|alias/i);
  });
});
