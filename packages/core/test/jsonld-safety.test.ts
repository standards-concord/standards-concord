import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { OntologyGraph, applyChangeOps, serialize } from '../src/index.js';
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

  it('refuses malformed namespace IRIs when metadata is edited, and leaves the ontology unchanged', async () => {
    const g = await OntologyGraph.fromTurtle(ONT('e', EX));
    const bad = ['', 'not an iri', 'https://example.org/a b#', 'http://[bad', 'https://example.org/%zz#', 'https://example.org/%4#',
      'urn:x\u0001y', 'urn:x\ud800y', 'urn:x\udc00y', 'urn:[x]', 'https://example.org/<x>#', 'https:no-authority#', 'urn:x"y'];
    for (const preferredNamespace of bad) {
      // The prefix in the same edit is valid, but nothing is applied when the namespace is refused.
      expect(() => setMeta(g, { preferredPrefix: 'zz', preferredNamespace }), JSON.stringify(preferredNamespace)).toThrow(/preferredNamespace must be an absolute IRI/);
    }
    expect(g.metadata().preferredPrefix).toBe('e');
    for (const ok of ['https://w3id.org/odi/vol#', 'urn:example:vol:', 'https://例え.jp/語彙#', 'https://example.org/caf%C3%A9/', 'http://[::1]/ns#', 'https://example.org/\u{1F600}#']) {
      expect(isSafeNamespace(ok), ok).toBe(true);
    }
    expect(() => setMeta(g, { preferredPrefix: 'vol', preferredNamespace: 'https://w3id.org/odi/vol#' })).not.toThrow();
  });

  it('only calls Turtle prefix names safe', () => {
    for (const ok of ['e', 'vol', 'dc-terms', 'a_b', 'v1.2']) expect(isSafePrefix(ok), ok).toBe(true);
    for (const bad of ['@import', '_a', 'a.', '.a', 'a:b', '', '-a']) expect(isSafePrefix(bad), bad).toBe(false);
  });

  it('never uses a stored keyword prefix, and never fetches its namespace, when writing JSON-LD', async () => {
    const { hits, result } = await trap(async (base) => {
      // As already stored on main before the edit check existed.
      const g = await OntologyGraph.fromTurtle(ONT('@import', `${base}/context`));
      expect(g.prefixes['@import']).toBeUndefined();
      return [await serialize(g, 'jsonld'), await serialize(g, 'turtle')];
    });
    expect(hits).toBe(0);
    expect(result.status).toBe('fulfilled');
    const [jsonld, turtle] = (result as PromiseFulfilledResult<string[]>).value;
    // The stored value is still data ("@import" as a literal), but never a context entry.
    expect(Object.keys(JSON.parse(jsonld)['@context'])).not.toContain('@import');
    expect(turtle).not.toMatch(/@prefix @import/);
  });

  it('never fetches anything when writing JSON-LD, even if an unsafe prefix reaches the graph', async () => {
    const { hits, result } = await trap(async (base) => {
      const g = await OntologyGraph.fromTurtle(ONT('e', EX));
      // Bypasses every check above, as a future code path might.
      (g.prefixes as Record<string, string>)['@import'] = `${base}/context`;
      (g.prefixes as Record<string, string>)['@context'] = `${base}/context`;
      return serialize(g, 'jsonld');
    });
    expect(hits).toBe(0);
    expect(result.status).toBe('fulfilled');
  });
});
