import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { OntologyGraph, applyChangeOps, serialize } from '../src/index.js';
import { setMetadata } from '../src/changes.js';
import { compactJsonLd } from '../src/serialize.js';
import { isSafeNamespace, isSafePrefix, namespaceCacheForTests, setOxigraphLoaderForTests } from '../src/ns.js';
import { createRequire } from 'node:module';
import v8 from 'node:v8';
import vm from 'node:vm';

const EX = 'https://example.org/e#';

/** A graph's triples as sorted strings, for comparing what two readers produced (no blank nodes in these tests). */
const triples = (quads: Iterable<any>) =>
  [...quads].map((q) => [q.subject, q.predicate, q.object].map((t) => `${t.termType}|${t.value}|${t.datatype?.value ?? ''}|${t.language ?? ''}`).join(' ')).sort();

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
      // Characters an IRI (and Turtle) can't hold.
      'https://example.org/a|b#', 'https://example.org/?x={}#', 'https://example.org/?x=`#', 'https://example.org/#x\\y/',
      'https://example.org/<x>#', 'urn:x"y', 'urn:x\u0001y', 'urn:x\u0085y',
      // Unicode spaces: RFC 3987 allows some, but JSON-LD refuses them.
      'urn:x y', 'https://example.org/a b#',
      // Lone surrogates, noncharacters, private-use and excluded code points outside a query.
      'urn:x\ud800y', 'urn:x\udc00y', 'urn:x﷐y', 'urn:x\u{1fffe}y', 'urn:x#', 'urn:x￰#',
      // Component rules: one fragment, real IP-literal hosts, one @, a numeric port.
      'https://example.org/[x]#', 'urn:[x]', 'https://example.org/a#b#c', 'https://a@b@host/ns#', 'ftp://host:not-a-port/ns#', 'http://[::1/ns#',
      'http://[bad]/ns#', 'http://[::::]/ns#', 'http://host:foo:80/ns#'];
    for (const iri of bad) expect(isSafeNamespace(iri), JSON.stringify(iri)).toBe(false);
    const ok = ['https://w3id.org/odi/vol#', 'http://example.org/ns/', 'urn:example:vol:', 'https://例え.jp/語彙#', 'https://example.org/\u{1F600}#',
      'http://[::1]/ns#', 'ftp://[::1]/ns#', 'http://[V1.fe]/ns#', 'https://user:pw@example.org:8443/a/b?c=d#', 'https://example.org/caf%C3%A9/',
      // Percent-encoded octets are not the raw characters they encode.
      'https://example.org/%EF%B7%90/', 'tag:example.org,2026:vol#', 'https://example.org/ns'];
    for (const iri of ok) expect(isSafeNamespace(iri), iri).toBe(true);
  });

  it('writes every namespace it accepts, under any prefix, as Turtle and JSON-LD that read back', async () => {
    // Property check: random namespaces built from safe and unsafe characters, under random prefixes (some equal to
    // the namespace's scheme). Whatever the predicate accepts must be written as Turtle and JSON-LD and read back
    // to the same triples by our readers, and by Oxigraph for Turtle.
    let seed = 7;
    const rand = (n: number) => {
      // mulberry32: a small seeded generator, so the cases are the same on every run.
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n) | 0;
    };
    const pick = <T,>(xs: T[]) => xs[rand(xs.length)];
    const alphabet = [...'aZ09-._~:/?#[]@!$&\'()*+,;=%41|{}<>"\\^` vV', 'é', '語', '\u{1F600}', '\u0001', ' ', '﷐', '', '￰', '%EF%B7%90', '%zz'];
    const authorities = ['example.org', '[::1]', '[V1.fe]', '[bad]', '[::::]', 'host:80', 'host:foo:80', 'u@host', 'a@b@host', '例え.jp', ''];
    const heads = () => pick([`https://${pick(authorities)}/`, `http://${pick(authorities)}/`, 'urn:example:', 'tag:x,2026:', 'zz:', 'e:']);
    const prefixes = ['zz', 'e', 'urn', 'tag', 'http', 'https', 'vol', 'a.b', 'hasOwnProperty', 'constructor', 'toString', 'valueOf'];
    const candidates: Array<[string, string]> = [
      ['zz', 'http://[bad]/ns#'], ['zz', 'http://[::::]/ns#'], ['zz', 'http://host:foo:80/ns#'], ['zz', 'urn:x#'], ['zz', 'urn:x￰#'],
      ['zz', 'http://[V1.fe]/ns#'], ['zz', 'https://example.org/%EF%B7%90/'], ['urn', 'urn:example:vol:'], ['zz', 'zz:foo/'],
    ];
    for (let i = 0; i < 500; i++) {
      let ns = heads();
      for (let j = rand(5); j > 0; j--) ns += pick(alphabet);
      candidates.push([pick(prefixes), ns + (rand(2) ? '#' : '/')]);
    }
    const oxigraph = (await import('oxigraph')) as any;
    let accepted = 0;
    for (const [prefix, ns] of candidates) {
      if (!isSafeNamespace(ns)) continue;
      accepted++;
      const label = `${prefix} ${JSON.stringify(ns)}`;
      const g = await OntologyGraph.fromTurtle(ONT('e', EX));
      // Through setMetadata when the prefix is one it accepts; otherwise stored as found in imported data.
      const set = isSafePrefix(prefix)
        ? applyChangeOps(g, [{ op: 'setMetadata', set: { preferredPrefix: prefix, preferredNamespace: ns } }] as any).graph
        : await OntologyGraph.fromTurtle(ONT(prefix, ns));
      const graph = await OntologyGraph.fromTurtle(`${await set.toTurtle()}\n<${ns}Thing> a <http://www.w3.org/2002/07/owl#Class> ; <http://www.w3.org/2000/01/rdf-schema#comment> "${prefix}:Thing" .`);
      const want = triples(graph.store.getQuads(null, null, null, null));
      const turtle = await serialize(graph, 'turtle');
      expect(triples((await OntologyGraph.fromTurtle(turtle)).store.getQuads(null, null, null, null)), label).toEqual(want);
      expect(triples(oxigraph.parse(turtle, { format: 'text/turtle' })), label).toEqual(want);
      const jsonld = await serialize(graph, 'jsonld');
      expect(triples((await OntologyGraph.parse(jsonld, 'jsonld')).store.getQuads(null, null, null, null)), label).toEqual(want);
    }
    expect(accepted).toBeGreaterThan(40);
  });

  it('never caches namespaces over the length limit, and bounds what it caches', () => {
    // Rejected namespaces of any size used to be cached in full: 32 distinct 1 MiB strings stayed in memory.
    const before = namespaceCacheForTests();
    for (let i = 0; i < 32; i++) expect(isSafeNamespace(`https://example.org/${'x'.repeat(1 << 20)}${i}#`)).toBe(false);
    expect(namespaceCacheForTests().entries).toBe(before.entries);
    for (let i = 0; i < 600; i++) isSafeNamespace(`https://example.org/${'y'.repeat(4000)}${i}#`);
    expect(namespaceCacheForTests().chars).toBeLessThanOrEqual(1_000_000);
  });

  it('caches a copy of each namespace, not the document it was read from', () => {
    // The cache used to keep the parser's substring, which kept each whole source document in memory.
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    gc();
    const before = process.memoryUsage().heapUsed;
    // Substrings made with slice(), as readers that return parts of their input do. (N3 copies its literals, so
    // a document read with it doesn't show the problem: checked, it passes with or without the copy.)
    for (let i = 0; i < 20; i++) {
      const source = `https://example.org/heap${i}-${Math.random()}#` + 'x'.repeat(2_000_000);
      expect(isSafeNamespace(source.slice(0, source.indexOf('#') + 1))).toBe(true);
    }
    gc();
    // 20 sources of 2 MB each: about 40 MB if they were kept.
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(10_000_000);
  });

  it('fails closed without caching when Oxigraph can’t be loaded', () => {
    // A load failure used to be cached as an invalid namespace, so the namespace stayed refused after recovery.
    const ns = `https://example.org/load-failure-${Date.now()}#`;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      setOxigraphLoaderForTests(() => { throw new Error('simulated load failure'); });
      expect(isSafeNamespace(ns)).toBe(false);
      expect(isSafeNamespace(ns)).toBe(false);
      expect(errors).toHaveBeenCalledTimes(1);
      setOxigraphLoaderForTests(() => createRequire(import.meta.url)('oxigraph'));
      expect(isSafeNamespace(ns)).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });

  it('keeps JSON-LD terms that only look like they clash', async () => {
    // Literal text such as "e:Thing" in a comment, and http: IRIs under a prefix named http, used to drop the term.
    const g = await OntologyGraph.fromTurtle(`${ONT('e', EX)}\n<${EX}Thing> <http://www.w3.org/2000/01/rdf-schema#comment> "e:Thing and owl:Class" .`);
    const doc = JSON.parse(await serialize(g, 'jsonld'));
    expect(doc['@context'].e).toBe(EX);
    expect(doc['@context'].owl).toBe('http://www.w3.org/2002/07/owl#');
    expect(JSON.stringify(doc)).toContain('"e:Thing"');
    const h = await OntologyGraph.fromTurtle(`${ONT('http', 'http://example.org/')}\n<http://example.org/Thing> a <http://www.w3.org/2002/07/owl#Class> .`);
    const hdoc = JSON.parse(await serialize(h, 'jsonld'));
    expect(hdoc['@context'].http).toBe('http://example.org/');
    expect((await OntologyGraph.parse(JSON.stringify(hdoc), 'jsonld')).store.getQuads('http://example.org/Thing', null, null, null).length).toBe(1);
  });

  it('writes JSON-LD when a stored prefix is named like an Object method', async () => {
    // A context term named hasOwnProperty used to make the JSON-LD processor throw.
    for (const p of ['hasOwnProperty', 'constructor', 'toString', 'valueOf']) {
      expect(isSafePrefix(p), p).toBe(false);
      const g = await OntologyGraph.fromTurtle(`${ONT(p, 'https://example.org/m#')}\n<https://example.org/m#Thing> a <http://www.w3.org/2002/07/owl#Class> .`);
      const doc = JSON.parse(await serialize(g, 'jsonld'));
      expect(Object.keys(doc['@context']), p).not.toContain(p);
    }
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
