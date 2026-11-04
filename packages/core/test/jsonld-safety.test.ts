import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { OntologyGraph, applyChangeOps, serialize } from '../src/index.js';
import { setMetadata } from '../src/changes.js';
import { compactJsonLd } from '../src/serialize.js';
import { isSafeNamespace, isSafePrefix } from '../src/ns.js';

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

describe('reading JSON-LD never touches the network', () => {
  it('refuses remote contexts, nested contexts and @import', async () => {
    const docs = (base: string) => [
      { '@context': `${base}/context`, '@id': `${EX}x`, name: 'x' },
      { '@context': [{ e: EX }, `${base}/context`], '@id': `${EX}x`, name: 'x' },
      { '@context': { e: EX, thing: { '@id': `${EX}thing`, '@context': `${base}/nested` } }, '@id': `${EX}x`, thing: { name: 'y' } },
      { '@context': { '@version': 1.1, '@import': `${base}/import` }, '@id': `${EX}x`, name: 'x' },
    ];
    for (const i of [0, 1, 2, 3]) {
      const { hits, result } = await trap((base) => OntologyGraph.parse(JSON.stringify(docs(base)[i]), 'jsonld'));
      expect(hits, `document ${i}`).toBe(0);
      expect(result.status, `document ${i}`).toBe('rejected');
      // jsonld reports a refused scoped context as "invalid scoped context", without the loader's message.
      expect(String((result as PromiseRejectedResult).reason), `document ${i}`).toMatch(i === 2 ? /invalid scoped context/ : /Remote JSON-LD documents are not loaded/);
    }
  });

  it('still reads inline contexts', async () => {
    const g = await OntologyGraph.parse(JSON.stringify({ '@context': { e: EX }, '@id': 'e:x', '@type': 'e:Thing', 'e:name': 'hello' }), 'jsonld');
    expect(g.store.size).toBe(2);
  });
});

describe('editable metadata can’t put JSON-LD keywords in a context', () => {
  const ONT = (prefix: string, ns: string) => `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix vann: <http://purl.org/vocab/vann/> .
<https://example.org/e> a owl:Ontology ; vann:preferredNamespacePrefix "${prefix}" ; vann:preferredNamespaceUri "${ns}" .
<https://example.org/e#Thing> a owl:Class .`;
  const setMeta = (g: OntologyGraph, set: Record<string, unknown>) => applyChangeOps(g, [{ op: 'setMetadata', set }] as any);

  it('refuses keyword, empty and non-Turtle prefixes when metadata is edited', async () => {
    const g = await OntologyGraph.fromTurtle(ONT('e', EX));
    for (const preferredPrefix of ['@import', '@context', '@vocab', 'a:b', 'has space', '', '_x', 'x.', '1x']) {
      expect(() => setMeta(g, { preferredPrefix }), JSON.stringify(preferredPrefix)).toThrow(/preferredPrefix must be a prefix name/);
    }
    // An empty list or several values would clear or confuse the prefix, so they are refused too.
    expect(() => setMeta(g, { preferredPrefix: [] })).toThrow(/exactly one value/);
    expect(() => setMeta(g, { preferredPrefix: ['a', 'b'] })).toThrow(/exactly one value/);
    expect(setMeta(g, { preferredPrefix: 'vol' })).toBeTruthy();
  });

  it('accepts only canonical http(s) namespace IRIs', () => {
    const bad = ['', 'not an iri', 'https://example.org/a b#', 'http://[bad', 'https://example.org/%zz#', 'https://example.org/%4#',
      'https://example.org/[x]#', 'https://example.org/a#b#c', 'https://a@b@host/ns#', 'https://user:pw@example.org/ns#',
      'ftp://host:not-a-port/ns#', 'ftp://[::1]/ns#', 'urn:example:vol:', 'https:no-authority#', 'https://example.org/<x>#',
      // Not in the form a URL parser gives back: upper-case host, default port, raw non-ASCII.
      'https://EXAMPLE.org/ns#', 'https://example.org:443/ns#', 'https://例え.jp/語彙#',
      // Percent-decoded: invalid UTF-8, a control character, noncharacters U+FDD0 and U+1FFFE, a lone surrogate.
      'https://example.org/%C3/', 'https://example.org/%01/', 'https://example.org/%EF%B7%90/', 'https://example.org/%F0%9F%BF%BE/', 'https://example.org/%ED%A0%80/',
      // A namespace ends in # or /.
      'https://example.org/ns', 'https://example.org/ns#x'];
    for (const iri of bad) expect(isSafeNamespace(iri), JSON.stringify(iri)).toBe(false);
    const ok = ['https://w3id.org/odi/vol#', 'http://example.org/ns/', 'http://[::1]/ns#', 'https://xn--r8jz45g.jp/%E8%AA%9E%E5%BD%99#',
      'https://example.org/caf%C3%A9/', 'https://example.org/%F0%9F%98%80#', 'https://example.org:8443/a/b?c=d#'];
    for (const iri of ok) expect(isSafeNamespace(iri), iri).toBe(true);
  });

  it('refuses a malformed namespace when metadata is edited, changing nothing', async () => {
    const g = await OntologyGraph.fromTurtle(ONT('e', EX));
    for (const preferredNamespace of ['https://example.org/[x]#', 'https://example.org/a#b#c', 'urn:x:', '']) {
      expect(() => setMeta(g, { preferredPrefix: 'zz', preferredNamespace }), JSON.stringify(preferredNamespace)).toThrow(/preferredNamespace must be an absolute IRI/);
    }
    // Called directly, without the copy applyChangeOps makes: a valid field in the same edit is not applied either,
    // whichever order the fields come in.
    expect(() => setMetadata(g, { preferredPrefix: 'zz', preferredNamespace: 'https://example.org/a#b#c' })).toThrow(/preferredNamespace/);
    expect(() => setMetadata(g, { preferredNamespace: 'https://w3id.org/odi/zz#', preferredPrefix: '@import' })).toThrow(/preferredPrefix/);
    expect(() => setMetadata(g, { title: 'Changed', preferredPrefix: [] })).toThrow(/exactly one value/);
    const meta = g.metadata();
    expect(meta.preferredPrefix).toBe('e');
    expect(meta.preferredNamespace).toBe(EX);
    expect(meta.title).not.toBe('Changed');
    setMetadata(g, { preferredPrefix: 'vol', preferredNamespace: 'https://w3id.org/odi/vol#' });
    expect(g.metadata().preferredPrefix).toBe('vol');
  });

  it('only calls Turtle prefix names safe', () => {
    for (const ok of ['e', 'vol', 'dc-terms', 'a_b', 'v1.2']) expect(isSafePrefix(ok), ok).toBe(true);
    for (const bad of ['@import', '_a', 'a.', '.a', 'a:b', '', '-a']) expect(isSafePrefix(bad), bad).toBe(false);
  });

  it('never uses a stored keyword prefix, and never fetches its namespace, when writing JSON-LD', async () => {
    // As already stored on main before the edit check existed, with the namespace used by a class, so that
    // without the filter the compactor gets {"@import": namespace} and fetches it (it did on main).
    let prefixes: Record<string, string> = {};
    const { hits, result } = await trap(async (base) => {
      const g = await OntologyGraph.fromTurtle(`${ONT('@import', `${base}/context#`)}\n<${base}/context#Trap> a <http://www.w3.org/2002/07/owl#Class> .`);
      prefixes = { ...g.prefixes };
      return [await serialize(g, 'jsonld'), await serialize(g, 'turtle')];
    });
    expect(hits).toBe(0);
    expect(result.status).toBe('fulfilled');
    expect(prefixes['@import']).toBeUndefined();
    const [jsonld, turtle] = (result as PromiseFulfilledResult<string[]>).value;
    // The stored value is still data ("@import" as a literal), but never a context entry.
    expect(Object.keys(JSON.parse(jsonld)['@context'])).not.toContain('@import');
    expect(turtle).not.toMatch(/@prefix @import/);
  });

  it('leaves unsafe prefixes out of the JSON-LD context even if they reach the graph', async () => {
    const { hits, result } = await trap(async (base) => {
      const g = await OntologyGraph.fromTurtle(`${ONT('e', EX)}\n<${base}/ns#Trap> a <http://www.w3.org/2002/07/owl#Class> .`);
      // Bypasses every check above, as a future code path might, with a namespace the graph uses.
      (g.prefixes as Record<string, string>)['@import'] = `${base}/ns#`;
      (g.prefixes as Record<string, string>)['@context'] = `${base}/ns#`;
      return serialize(g, 'jsonld');
    });
    expect(hits).toBe(0);
    expect(result.status).toBe('fulfilled');
    expect(Object.keys(JSON.parse((result as PromiseFulfilledResult<string>).value)['@context'])).not.toContain('@import');
  });

  it('compacts without loading anything, whatever the context holds', async () => {
    // Tests the compaction call itself, apart from the prefix filter: without its loader, each of these makes a request.
    const expanded = [{ '@id': `${EX}x`, [`${EX}name`]: [{ '@value': 'x' }] }];
    const contexts = (base: string) => [
      { '@import': `${base}/import` },
      { e: EX, '@import': `${base}/import`, '@version': 1.1 },
      `${base}/context`,
      [{ e: EX }, `${base}/context`],
    ];
    for (const i of [0, 1, 2, 3]) {
      const { hits, result } = await trap((base) => compactJsonLd(expanded, contexts(base)[i] as any));
      expect(hits, `context ${i}`).toBe(0);
      expect(result.status, `context ${i}`).toBe('rejected');
    }
  });
});
