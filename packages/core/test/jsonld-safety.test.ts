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

  it('accepts IRIs of any scheme, and refuses malformed ones', () => {
    const bad = ['', 'not an iri', 'https://example.org/a b#', 'http://[bad', 'https://example.org/%zz#', 'https://example.org/%4#',
      // Characters an IRI (and Turtle) can't hold: these used to pass the URL round-trip check.
      'https://example.org/a|b#', 'https://example.org/?x={}#', 'https://example.org/?x=`#', 'https://example.org/#x\\y/',
      'https://example.org/<x>#', 'urn:x"y', 'urn:x\u0001y', 'urn:x\u0085y',
      // Lone surrogates and noncharacters, raw or percent-encoded.
      // Unicode spaces: RFC 3987 allows some, but JSON-LD refuses them.
      'urn:x\u00a0y', 'https://example.org/a\u2003b#',
      'urn:x\ud800y', 'urn:x\udc00y', 'urn:x﷐y', 'urn:x\u{1fffe}y', 'https://example.org/%EF%B7%90/',
      // Component rules: one fragment, brackets only around an IP-literal host, one @, a numeric port.
      'https://example.org/[x]#', 'urn:[x]', 'https://example.org/a#b#c', 'https://a@b@host/ns#', 'ftp://host:not-a-port/ns#', 'http://[::1/ns#'];
    for (const iri of bad) expect(isSafeNamespace(iri), JSON.stringify(iri)).toBe(false);
    const ok = ['https://w3id.org/odi/vol#', 'http://example.org/ns/', 'urn:example:vol:', 'https://例え.jp/語彙#', 'https://example.org/\u{1F600}#',
      'http://[::1]/ns#', 'ftp://[::1]/ns#', 'https://user@example.org:8443/a/b?c=d#', 'https://example.org/caf%C3%A9/', 'tag:example.org,2026:vol#', 'https://example.org/ns'];
    for (const iri of ok) expect(isSafeNamespace(iri), iri).toBe(true);
  });

  it('writes every namespace it accepts as Turtle that reads back', async () => {
    // Property check: random namespaces built from safe and unsafe characters. Whatever the predicate accepts
    // must survive being written as a Turtle prefix and a class IRI, and read back unchanged.
    let seed = 7;
    const rand = (n: number) => {
      // mulberry32: a small seeded generator, so the cases are the same on every run.
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * n | 0;
    };
    const alphabet = [...'aZ09-._~:/?#[]@!$&\'()*+,;=%41|{}<>"\\^` ', 'é', '語', '\u{1F600}', '\u0001', '\u00a0', '\ufdd0', '%EF%B7%90', '%zz'];
    const heads = ['https://example.org/', 'urn:example:', 'http://[::1]/', 'tag:x,2026:', 'https://例え.jp/'];
    // Astra's malformed examples first, then random ones.
    const candidates = ['https://example.org/a|b#', 'https://example.org/?x={}#', 'https://example.org/?x=`#', 'https://example.org/#x\\y/', 'urn:example:vol:'];
    for (let i = 0; i < 1500; i++) {
      let ns = heads[rand(heads.length)];
      for (let j = rand(6); j > 0; j--) ns += alphabet[rand(alphabet.length)];
      candidates.push(ns + (rand(2) ? '#' : '/'));
    }
    let accepted = 0;
    for (const ns of candidates) {
      if (!isSafeNamespace(ns)) continue;
      accepted++;
      const g = await OntologyGraph.fromTurtle(ONT('e', EX));
      const r = applyChangeOps(g, [{ op: 'setMetadata', set: { preferredPrefix: 'zz', preferredNamespace: ns } }] as any);
      const withClass = await OntologyGraph.fromTurtle(`${await r.graph.toTurtle()}\n<${ns}Thing> a <http://www.w3.org/2002/07/owl#Class> .`);
      const back = await OntologyGraph.fromTurtle(await serialize(withClass, 'turtle'));
      expect(back.metadata().preferredNamespace, ns).toBe(ns);
      expect(back.store.getQuads(ns + 'Thing', null, null, null).length, ns).toBe(1);
      expect(Object.keys(JSON.parse(await serialize(back, 'jsonld'))['@context']), ns).toContain('zz');
    }
    expect(accepted).toBeGreaterThan(40);
  });

  it('keeps a stored URN or Unicode namespace usable, as on main', async () => {
    for (const ns of ['urn:example:vol:', 'https://例え.jp/語彙#']) {
      // Stored as N-Triples, so the prefix can only come from the preferred-prefix metadata.
      const nt = `<https://example.org/e> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Ontology> .
<https://example.org/e> <http://purl.org/vocab/vann/preferredNamespacePrefix> "zz" .
<https://example.org/e> <http://purl.org/vocab/vann/preferredNamespaceUri> "${ns}" .
<${ns}Thing> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
`;
      const g = await OntologyGraph.parse(nt, 'ntriples');
      expect(g.prefixes.zz, ns).toBe(ns);
      const r = applyChangeOps(g, [{ op: 'addClass', localName: 'Part', label: 'part', definition: 'A part of a thing, for this test.', subClassOf: ['zz:Thing'] }] as any);
      expect(r.graph.store.getQuads(null, 'http://www.w3.org/2000/01/rdf-schema#subClassOf', ns + 'Thing', null).length, ns).toBe(1);
      // Resubmitting the unchanged namespace is fine.
      expect(() => applyChangeOps(g, [{ op: 'setMetadata', set: { preferredPrefix: 'zz', preferredNamespace: ns } }] as any), ns).not.toThrow();
      expect(JSON.parse(await serialize(g, 'jsonld'))['@context'].zz, ns).toBe(ns);
    }
  });

  it('refuses a malformed namespace when metadata is edited, changing nothing', async () => {
    const g = await OntologyGraph.fromTurtle(ONT('e', EX));
    for (const preferredNamespace of ['https://example.org/[x]#', 'https://example.org/a#b#c', 'https://example.org/a|b#', '']) {
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
