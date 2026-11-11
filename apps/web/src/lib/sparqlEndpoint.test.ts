import { afterEach, describe, expect, it, vi } from 'vitest';
import { Parser } from 'sparqljs';
import { checkData, prepareOntology, DEFAULT_DATA_BASE, DATA_CHECK_LIMITS } from '@concord/core/data-check';
import { endpointClasses, endpointDrift, endpointFallback, endpointUrl, EndpointNetworkError, fetchEndpointSample, iriRef, responseFormat, responseTriples, sampleQuery } from './sparqlEndpoint';

const type = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const ns = 'https://standard.test/#';
const classes = ['A', 'B', 'C', 'D', 'E'].map((c) => ns + c);
const nt = (c: string) => `<https://data.test/${c.slice(-1)}> <${type}> <${c}> .\n`;
const response = (body: string, contentType = 'application/n-triples', status = 200) => new Response(body, { headers: { 'Content-Type': contentType }, status });
const options = () => ({ endpoint: 'https://store.test/sparql', classes, title: 'Example', limit: 50 });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('fixed sample queries', () => {
  it('puts the limit inside SELECT and both patterns inside the named graph', () => {
    const q = sampleQuery(classes[0], 20, 'urn:graph:one');
    expect(q).toContain(`SELECT DISTINCT ?s WHERE { GRAPH <urn:graph:one> { ?s a <${classes[0]}> } } LIMIT 20`);
    expect(q).toContain('GRAPH <urn:graph:one> { ?s ?p ?o }');
    expect(new Parser().parse(q).type).toBe('query');
    expect(sampleQuery(classes[0], 200)).not.toContain('GRAPH');
    expect(iriRef('https://example.org/café')).toBe('<https://example.org/café>');
  });
  it.each(['<', '>', '"', '{', '}', '|', '^', '`', '\\', ' ', '\t', '\n', '\u0000', '\u007f', '\uD800'])('rejects forbidden IRI characters %j', (c) => {
    expect(() => sampleQuery(`https://example.org/${c}`, 50)).toThrow('absolute IRI');
    expect(() => sampleQuery(classes[0], 50, `urn:graph:${c}`)).toThrow();
  });
  it('rejects relative IRIs and unbounded sample sizes', () => {
    expect(() => iriRef('relative')).toThrow();
    expect(() => sampleQuery(classes[0], Infinity)).toThrow('Choose');
  });
  it('reads only non-deprecated own owl classes from the version source', () => {
    const source = `@prefix owl: <http://www.w3.org/2002/07/owl#> .
      <${classes[0]}> a owl:Class . <${classes[1]}> a owl:Class; owl:deprecated true .
      <https://other.test/Class> a owl:Class . <${ns}Property> a owl:ObjectProperty .`;
    expect(endpointClasses(source, ns)).toEqual([classes[0]]);
  });
});

describe('URL rules and RDF responses', () => {
  it.each(['https://store.test/query', 'http://localhost:3000/query', 'http://127.0.0.1/query', 'http://[::1]/query'])('accepts %s', (url) => expect(endpointUrl(url).href).toBe(url));
  it.each(['http://store.test', 'ftp://localhost/query', 'javascript:alert(1)', 'https://user:secret@store.test', 'relative'])('refuses %s', (url) => expect(() => endpointUrl(url)).toThrow());
  it('recognizes supported MIME types and explains everything else', () => {
    expect(responseFormat('Application/N-Triples; charset=utf-8', 'store.test')).toBe('ntriples');
    expect(responseFormat('text/turtle', 'store.test')).toBe('turtle');
    expect(() => responseFormat('application/sparql-results+json', 'store.test')).toThrow('store.test returned application/sparql-results+json');
    expect(() => responseFormat('text/html', 'store.test')).toThrow('text/html');
  });
  it('relabels blank nodes, preserving labels inside strings and IRIs', () => {
    const body = '_:x <urn:p> "literal _:x and \\\"quoted\\\"" .\n_:x <urn:_:x> _:y .\n';
    const first = responseTriples(body, 1, 'https://store.test/').join('');
    expect(first).toContain('_:q1_b_x <urn:p> "literal _:x and \\\"quoted\\\""');
    expect(first).toContain('_:q1_b_x <urn:_:x> _:q1_b_y');
    expect(responseTriples(body, 2, 'https://store.test/').join('')).toContain('_:q2_b_x');
  });
  it('converts Turtle lists, nested blanks, base IRIs and typed literals to N-Triples', () => {
    const lines = responseTriples('@prefix ex: <https://example.test/> . <s> ex:p [ ex:q ("a\\n雪" 2) ] .', 0, 'https://store.test/');
    expect(lines.length).toBe(6);
    expect(lines.join('')).toContain('<https://store.test/s> <https://example.test/p>');
    expect(responseTriples(lines.join(''), 1, 'https://store.test/')).toHaveLength(6);
    expect(() => responseTriples('this is not RDF', 0, 'https://store.test/')).toThrow('could not be read');
  });
});

describe('bounded CORS transport', () => {
  it('posts simple form requests, at most three concurrently, and merges responses', async () => {
    let active = 0, peak = 0;
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
      const query = (init.body as URLSearchParams).get('query')!;
      const cls = classes.find((c) => query.includes(`<${c}>`))!;
      return response(nt(cls));
    });
    vi.stubGlobal('fetch', fetcher);
    const sample = await fetchEndpointSample(options());
    expect(peak).toBe(3);
    expect(sample.triples).toBe(5);
    expect(sample.classesSampled).toBe(5);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'omit', mode: 'cors', redirect: 'follow', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/n-triples, text/turtle;q=0.9' } });
    expect(Object.keys(fetcher.mock.calls[0][1].headers!)).toHaveLength(2);
  });
  it('stops scheduling queries at the triple budget, keeping complete RDF', async () => {
    const fetcher = vi.fn(async () => response(nt(classes[0])));
    vi.stubGlobal('fetch', fetcher);
    const sample = await fetchEndpointSample({ ...options(), budgets: { ...DATA_CHECK_LIMITS, triples: 1 } });
    expect(sample.triples).toBe(1);
    expect(sample.cutShort).toBe('triples');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('streams only up to the byte budget and drops an incomplete last N-Triples line', async () => {
    const line = nt(classes[0]);
    let cancelled = false;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(line + '<unfinished')); },
      cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': 'application/n-triples' } })));
    const sample = await fetchEndpointSample({ ...options(), classes: [classes[0]], budgets: { triples: 10, bytes: new TextEncoder().encode(line).length + 2 } });
    expect(sample.triples).toBe(1);
    expect(sample.text).not.toContain('unfinished');
    expect(sample.cutShort).toBe('bytes');
    expect(cancelled).toBe(true);
  });
  it('stops in-flight requests still waiting for headers when the sample fills', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      if (calls++ === 0) return Promise.resolve(response(nt(classes[0])));
      return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    }));
    const sample = await fetchEndpointSample({ ...options(), budgets: { ...DATA_CHECK_LIMITS, triples: 1 } });
    expect(sample.triples).toBe(1);
    expect(sample.classesSampled).toBe(1);
    expect(sample.cutShort).toBe('triples');
    expect(calls).toBe(3);
  });
  it('retains a complete last line without a newline at the byte boundary', async () => {
    const line = nt(classes[0]).trimEnd();
    // The serialized form adds a newline, so leave room for that while exhausting the
    // received-byte budget with an RDF comment at the end of the response.
    const body = line + ' # end';
    vi.stubGlobal('fetch', vi.fn(async () => response(body)));
    const sample = await fetchEndpointSample({ ...options(), classes: [classes[0]], budgets: { triples: 10, bytes: new TextEncoder().encode(body).length } });
    expect(sample.triples).toBe(1);
    expect(sample.cutShort).toBe('bytes');
  });
  it('bounds normalized N-Triples bytes even when Turtle expands beyond the wire size', async () => {
    const body = '@prefix ex: <https://example.test/very-long-namespace/> . ex:s ex:p "a", "b", "c" .';
    vi.stubGlobal('fetch', vi.fn(async () => response(body, 'text/turtle')));
    const sample = await fetchEndpointSample({ ...options(), classes: [classes[0]], budgets: { triples: 100, bytes: 180 } });
    expect(new TextEncoder().encode(sample.text).length).toBeLessThanOrEqual(180);
    expect(sample.cutShort).toBe('bytes');
    expect(sample.counts[classes[0]]).toBe(sample.triples);
  });
  it('does not turn a truncated N-Triples literal into a made-up value', async () => {
    const body = nt(classes[0]) + '<urn:s> <urn:p> "truncated literal with no closing quote';
    vi.stubGlobal('fetch', vi.fn(async () => response(body)));
    const sample = await fetchEndpointSample({ ...options(), classes: [classes[0]], budgets: { triples: 10, bytes: new TextEncoder().encode(body).length - 5 } });
    expect(sample.triples).toBe(1);
    expect(sample.text).not.toContain('truncated');
  });
  it('keeps blank identities across stream chunks and responses distinct', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode('_:x <urn:p> "one" .\n'));
      c.enqueue(new TextEncoder().encode('_:x <urn:q> "two" .\n')); c.close();
    } }), { headers: { 'Content-Type': 'application/n-triples' } })));
    const sample = await fetchEndpointSample({ ...options(), classes: classes.slice(0, 2) });
    expect(sample.triples).toBe(4);
    expect(sample.text.match(/_:q0_b_x/g)).toHaveLength(2);
    expect(sample.text.match(/_:q1_b_x/g)).toHaveLength(2);
  });
  it('accepts Turtle responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(`@prefix s: <${ns}> . <urn:r> a s:A; s:p [ s:q "value" ] .`, 'text/turtle')));
    expect((await fetchEndpointSample({ ...options(), classes: [classes[0]] })).triples).toBe(3);
  });
  it('refuses invalid URLs, graph IRIs and versions with no classes before fetching', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(fetchEndpointSample({ ...options(), endpoint: 'http://remote.test' })).rejects.toThrow('HTTPS');
    await expect(fetchEndpointSample({ ...options(), graph: 'urn:bad graph' })).rejects.toThrow();
    await expect(fetchEndpointSample({ ...options(), classes: [] })).rejects.toThrow('no classes');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('explains network/CORS errors, HTTP status/body, unexpected media, and empty graphs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(fetchEndpointSample(options())).rejects.toBeInstanceOf(EndpointNetworkError);
    await expect(fetchEndpointSample(options())).rejects.toThrow("Your browser couldn't read store.test. The endpoint has to accept requests from web pages on other sites (CORS), and be reachable from this device.");
    vi.stubGlobal('fetch', vi.fn(async () => response('Bad query details', 'text/plain', 400)));
    await expect(fetchEndpointSample(options())).rejects.toThrow('store.test returned HTTP 400: Bad query details');
    vi.stubGlobal('fetch', vi.fn(async () => response('<html>oops</html>', 'text/html')));
    await expect(fetchEndpointSample(options())).rejects.toThrow('store.test returned text/html');
    vi.stubGlobal('fetch', vi.fn(async () => response('')));
    await expect(fetchEndpointSample({ ...options(), graph: 'urn:graph' })).rejects.toThrow("store.test has no instances of Example's classes in that graph");
  });
  it('times out a query and cancels the whole run', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason)))));
    const controller = new AbortController();
    await expect(fetchEndpointSample({ ...options(), controller, timeoutMs: 10 })).rejects.toThrow('store.test took longer than 0.01 s');
    expect(controller.signal.aborted).toBe(true);
  });
  it('Cancel prevents queued classes from starting', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason))));
    vi.stubGlobal('fetch', fetcher);
    const sample = fetchEndpointSample({ ...options(), controller });
    controller.abort();
    await expect(sample).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

it('lists each undefined own-namespace term once, preserving suggestions, and empty sampled classes', () => {
  const typo = { severity: 'error' as const, term: `${ns}Typo`, message: 'Typo is undefined. Did you mean Type?' };
  expect(endpointDrift([], ns, { [classes[0]]: 3 })).toEqual({ undefinedTerms: [], emptyClasses: [] });
  expect(endpointDrift([typo, typo, { ...typo, term: 'https://other.test/Term' }, { severity: 'warning', term: `${ns}Old`, message: 'Deprecated' }], ns, { [classes[0]]: 3, [classes[1]]: 0 })).toEqual({ undefinedTerms: [typo], emptyClasses: [classes[1]] });
});

it('builds a shell-quoted fallback for every class and this version IRI', () => {
  const pipeline = endpointFallback("https://store.test/O'Neil/sparql", 'https://concord.test/def/example/1.0.0', classes, 20, 'urn:graph');
  expect(pipeline).toContain(`O'"'"'Neil`);
  expect(pipeline).toContain("--data-binary @- 'https://concord.test/def/example/1.0.0'");
  const q = pipeline.slice(pipeline.indexOf('query=') + 6, pipeline.indexOf("' 'https://store.test"));
  expect(new Parser().parse(q).type).toBe('query');
  for (const c of classes) expect(q).toContain(`<${c}>`);
  expect(q.match(/LIMIT 20/g)).toHaveLength(classes.length);
});


it('feeds the merged N-Triples to the existing checker, with separate blank subjects and normal findings', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response(`@prefix s: <${ns}> . _:x a s:A; s:value "yes" .`, 'text/turtle')));
  const sample = await fetchEndpointSample({ ...options(), classes: classes.slice(0, 2) });
  const ontology = `@prefix owl: <http://www.w3.org/2002/07/owl#> . <https://standard.test/> a owl:Ontology . <${classes[0]}> a owl:Class .`;
  const shapes = `@prefix sh: <http://www.w3.org/ns/shacl#> . <urn:Shape> a sh:NodeShape; sh:targetClass <${classes[0]}>; sh:property [ sh:path <${ns}value>; sh:minCount 1 ] .`;
  const prepared = await prepareOntology(ontology, shapes);
  const result = await checkData(prepared, sample.text, 'ntriples', { baseIRI: DEFAULT_DATA_BASE, maxTriples: DATA_CHECK_LIMITS.triples });
  expect(result.conforms).toBe(true);
  expect(result.triples).toBe(4);
  const bad = await checkData(prepared, `<urn:missing> <${type}> <${classes[0]}> .`, 'ntriples', { baseIRI: DEFAULT_DATA_BASE, maxTriples: DATA_CHECK_LIMITS.triples });
  expect(bad.conforms).toBe(false);
  expect(bad.results[0].path).toBe(`${ns}value`);
});
