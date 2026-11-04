import { Parser, Store } from 'n3';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { seedDemo } from '../src/services/simulation.js';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BODY_LIMITS, RATE_LIMITS } from '../src/public/validate.js';
import { gzipSync } from 'node:zlib';
import { admit, POOL_LIMITS, poolState } from '../src/services/validationPool.js';

const app = createApp();
const SH = 'http://www.w3.org/ns/shacl#';

const PER_MINUTE = RATE_LIMITS.perMinute;
beforeAll(async () => {
  // The rate limit has its own test, at the end.
  RATE_LIMITS.perMinute = 10_000;
  openDb();
  await seedDemo();
});

const PREFIXES = '@prefix vol: <https://w3id.org/odi/volunteering#> .\n@prefix ex: <https://example.org/> .\n';
const VALID = `${PREFIXES}
ex:org a vol:Organisation ; vol:offersOpportunity ex:opp .
ex:opp a vol:VolunteeringOpportunity ; vol:title "Park clean-up" ; vol:offeredBy ex:org ; vol:hasRole ex:role .
ex:role a vol:Role .
`;
// No role and no organisation; the application is submitted by an organisation, not a person.
const INVALID = `${PREFIXES}
ex:opp a vol:VolunteeringOpportunity ; vol:title "Park clean-up" .
ex:app a vol:Application ; vol:submittedBy ex:org ; vol:forOpportunity ex:opp .
ex:org a vol:Organisation .
`;

const post = (path: string, body: string, type = 'text/turtle') => request(app).post(path).set('Content-Type', type).send(body);

describe('POST to the ontology IRI validates data', () => {
  it('reports conforming data as valid, against the latest release', async () => {
    const res = await post('/def/volunteering', VALID);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.body).toMatchObject({ ontology: 'https://w3id.org/odi/volunteering', version: '1.0.0', conforms: true, valid: true, results: [], terms: [] });
    expect(res.body.triples).toBe(7);
    expect(res.body.shapes).toMatch(/\/def\/volunteering\/1\.0\.0\.shacl\.ttl$/);
    expect(res.headers.link).toMatch(/1\.0\.0\.shacl\.ttl>; rel="describedby"/);
  });

  it('lists each SHACL violation with its focus node, path, shape and constraint', async () => {
    const res = await post('/def/volunteering/1.0.0', INVALID);
    expect(res.status).toBe(200);
    expect(res.body.conforms).toBe(false);
    expect(res.body.valid).toBe(false);
    const results = res.body.results as { focusNode: string; path: string; constraint: string; shape: string; severity: string; value?: string }[];
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          focusNode: 'https://example.org/opp',
          path: 'https://w3id.org/odi/volunteering#hasRole',
          constraint: `${SH}MinCountConstraintComponent`,
          shape: 'https://w3id.org/odi/volunteering/shapes#VolunteeringOpportunityShape',
          severity: 'Violation',
        }),
        expect.objectContaining({
          focusNode: 'https://example.org/app',
          path: 'https://w3id.org/odi/volunteering#submittedBy',
          constraint: `${SH}ClassConstraintComponent`,
          value: '<https://example.org/org>',
        }),
      ]),
    );
    expect(res.body.summary.violations).toBe(results.length);
  });

  it('checks the terms the data uses, with suggestions', async () => {
    const res = await post('/def/volunteering', `${VALID}ex:opp vol:titl "typo" .\n`);
    expect(res.body.conforms).toBe(true);
    expect(res.body.valid).toBe(false);
    expect(res.body.terms[0]).toMatchObject({ severity: 'error', term: 'https://w3id.org/odi/volunteering#titl' });
    expect(res.body.terms[0].message).toMatch(/vol:titl .*not defined.*Did you mean vol:title/);
  });

  it('sees subclasses: a subclass instance satisfies sh:class and is targeted by its superclass shape', async () => {
    const res = await post('/def/volunteering', `${VALID}ex:opp vol:offeredBy ex:vio .\nex:vio a vol:VolunteerInvolvingOrganisation ; vol:offersOpportunity ex:opp .\n`);
    expect(res.body.results).toEqual([]);
    const missing = await post('/def/volunteering', `${VALID}ex:vio2 a vol:VolunteerInvolvingOrganisation .\n`);
    expect(missing.body.results.map((r: { focusNode: string }) => r.focusNode)).toContain('https://example.org/vio2');
  });

  it('returns a SHACL validation report in Turtle on request', async () => {
    const res = await post('/def/volunteering/1.0.0', INVALID).set('Accept', 'text/turtle');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/turtle/);
    const store = new Store(new Parser({ format: 'Turtle' }).parse(res.text));
    const [report] = store.getSubjects(`http://www.w3.org/1999/02/22-rdf-syntax-ns#type`, `${SH}ValidationReport`, null);
    expect(store.getObjects(report, `${SH}conforms`, null)[0].value).toBe('false');
    const results = store.getObjects(report, `${SH}result`, null);
    expect(results.length).toBeGreaterThan(1);
    for (const r of results) {
      for (const p of ['focusNode', 'resultSeverity', 'sourceConstraintComponent', 'sourceShape']) expect(store.getObjects(r, `${SH}${p}`, null), p).toHaveLength(1);
      // Every source shape is described in the report, with its path.
      const shape = store.getObjects(r, `${SH}sourceShape`, null)[0];
      expect(store.getObjects(shape, `${SH}path`, null)).toHaveLength(1);
    }
  });

  it('accepts JSON-LD, N-Triples and RDF/XML, and sniffs unlabelled bodies', async () => {
    const jsonld = JSON.stringify({
      '@context': { vol: 'https://w3id.org/odi/volunteering#', ex: 'https://example.org/' },
      '@id': 'ex:opp',
      '@type': 'vol:VolunteeringOpportunity',
    });
    const j = await post('/def/volunteering', jsonld, 'application/ld+json');
    expect(j.status).toBe(200);
    expect(j.body.results.length).toBeGreaterThan(0);
    const nt = await post('/def/volunteering', '<https://example.org/r> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://w3id.org/odi/volunteering#Role> .\n', 'application/n-triples');
    expect(nt.body).toMatchObject({ conforms: true, triples: 1 });
    const xml = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:vol="https://w3id.org/odi/volunteering#"><vol:Role rdf:about="https://example.org/r"/></rdf:RDF>`;
    expect((await post('/def/volunteering', xml, 'application/rdf+xml')).body).toMatchObject({ conforms: true, triples: 1 });
    // curl --data-binary @data.ttl sends application/x-www-form-urlencoded.
    const curl = await post('/def/volunteering', INVALID, 'application/x-www-form-urlencoded');
    expect(curl.body.conforms).toBe(false);
    expect((await post('/def/volunteering?format=jsonld', jsonld, 'text/plain')).status).toBe(200);
  });

  it('never fetches remote JSON-LD contexts', async () => {
    const res = await post('/def/volunteering', JSON.stringify({ '@context': 'http://169.254.169.254/latest/meta-data/', '@id': 'https://example.org/x' }), 'application/ld+json');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Remote JSON-LD contexts are not fetched/);
  });

  it('resolves relative IRIs against a placeholder base, or ?base=', async () => {
    const rel = await post('/def/volunteering', '@prefix vol: <https://w3id.org/odi/volunteering#> . <#opp> a vol:VolunteeringOpportunity .');
    expect(rel.body.results[0].focusNode).toBe('https://data.example/#opp');
    const based = await post('/def/volunteering?base=https://myapp.example.org/data', '@prefix vol: <https://w3id.org/odi/volunteering#> . <#opp> a vol:VolunteeringOpportunity .');
    expect(based.body.results[0].focusNode).toBe('https://myapp.example.org/data#opp');
  });

  it('validates against the working draft', async () => {
    const res = await post('/def/volunteering/draft', VALID);
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('draft');
    expect(res.body.shapes).toMatch(/\/def\/volunteering\/draft\.shacl\.ttl$/);
  });

  it('explains bad requests', async () => {
    const parse = await post('/def/volunteering', '@prefix vol: <https://w3id.org/odi/volunteering#> . vol:x vol:y');
    expect(parse.status).toBe(400);
    expect(parse.body.error).toMatch(/Could not parse the data as Turtle/);
    const empty = await post('/def/volunteering', '');
    expect(empty.status).toBe(400);
    const unsupported = await post('/def/volunteering', '%PDF-1.4', 'application/pdf');
    expect(unsupported.status).toBe(415);
    expect(unsupported.headers['accept-post']).toContain('text/turtle');
    expect((await post('/def/volunteering/9.9.9', VALID)).status).toBe(404);
    expect((await post('/def/nothing-here', VALID)).status).toBe(404);
    expect((await post('/def/volunteering', VALID).set('Accept', 'image/png')).status).toBe(406);
  });

  it('negotiates the report with its charset, like any other parameter', async () => {
    const type = async (accept: string) => {
      const res = await post('/def/volunteering', VALID).set('Accept', accept);
      return res.status === 200 ? res.headers['content-type'].split(';')[0] : res.status;
    };
    expect(await type('text/turtle;charset=utf-8')).toBe('text/turtle');
    expect(await type('application/json;charset=utf-8')).toBe('application/json');
    expect(await type('text/turtle;charset=utf-8;q=0, text/turtle;q=1')).toBe(406);
    expect(await type('application/json;charset=utf-8;q=0, application/json')).toBe(406);
    expect(await type('application/json;charset=utf-8;q=0, */*')).toBe('text/turtle');
    expect(await type('text/turtle;charset=iso-8859-1')).toBe(406);
    expect(await type('text/turtle, application/json')).toBe('text/turtle');
    expect(await type('application/json;q=0.5, text/turtle;q=0.9')).toBe('text/turtle');
    expect(await type('*/*')).toBe('application/json');
    // The type decides before parameters: an exact type beats a wildcard with a charset.
    expect(await type('text/turtle;q=0, text/*;charset=utf-8')).toBe(406);
    expect(await type('application/json, */*;charset=utf-8;q=0')).toBe('application/json');
  });

  it('refuses data over the size and triple limits', async () => {
    const big = await post('/def/volunteering', `# ${'x'.repeat(5 * 1024 * 1024 + 10)}\n`);
    expect(big.status).toBe(413);
    expect(big.body.error).toMatch(/larger than 5 MB/);
    let many = PREFIXES;
    for (let i = 0; i < 12_600; i++) many += `ex:r${i} a vol:Role ; vol:title "r" .\n`;
    const tooMany = await post('/def/volunteering', many);
    expect(tooMany.status).toBe(413);
    expect(tooMany.body.error).toMatch(/more than 25,000 triples/);
  });

  it('refuses RDF/XML with a DTD, which could expand entities without limit', async () => {
    const lol = `<?xml version="1.0"?><!DOCTYPE rdf:RDF [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:vol="${'https://w3id.org/odi/volunteering#'}"><vol:Role rdf:about="https://example.org/r"><vol:title>&b;</vol:title></vol:Role></rdf:RDF>`;
    const res = await post('/def/volunteering', lol, 'application/rdf+xml');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/DOCTYPE or entity declarations is not accepted/);
  });

  it('keeps one blank node as one node throughout the Turtle report', async () => {
    const res = await post('/def/volunteering', `${PREFIXES}_:app a vol:Application .`).set('Accept', 'text/turtle');
    const store = new Store(new Parser({ format: 'Turtle' }).parse(res.text));
    const focus = store.getQuads(null, `${SH}focusNode`, null, null).map((q) => q.object);
    expect(focus.length).toBeGreaterThan(1);
    expect(new Set(focus.map((f) => f.value)).size).toBe(1);
    expect(focus[0].termType).toBe('BlankNode');
  });

  it('stops a validation that runs too long, and keeps serving', async () => {
    const before = POOL_LIMITS.timeoutMs;
    POOL_LIMITS.timeoutMs = 1;
    try {
      const slow = await post('/def/volunteering', VALID);
      expect(slow.status).toBe(422);
      expect(slow.body.error).toMatch(/took longer than/);
    } finally {
      POOL_LIMITS.timeoutMs = before;
    }
    expect((await post('/def/volunteering', VALID)).body.conforms).toBe(true);
  });

  it('treats running out of time on JSON-LD as its size limit', async () => {
    const before = POOL_LIMITS.timeoutMs;
    POOL_LIMITS.timeoutMs = 1;
    try {
      const slow = await post('/def/volunteering', JSON.stringify({ '@id': 'https://example.org/r', '@type': 'https://w3id.org/odi/volunteering#Role' }), 'application/ld+json');
      expect(slow.status).toBe(413);
      expect(slow.body.error).toMatch(/JSON-LD took longer than 0.001 s to convert to triples/);
    } finally {
      POOL_LIMITS.timeoutMs = before;
    }
  });

  it('refuses JSON-LD over its own size limit, and counts distinct triples', async () => {
    const big = JSON.stringify({ '@id': 'https://example.org/r', 'https://example.org/note': 'x'.repeat(2 * 1024 * 1024) });
    const res = await post('/def/volunteering', big, 'application/ld+json');
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/JSON-LD data is limited to 2 MB/);
    // 30,000 copies of one triple are one triple, well under the limit.
    const repeated = Array.from({ length: 30_000 }, () => '<https://example.org/r> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://w3id.org/odi/volunteering#Role> .').join('\n');
    const ok = await post('/def/volunteering', repeated, 'application/n-triples');
    expect(ok.status).toBe(200);
    expect(ok.body.triples).toBe(1);
  });

  it('gives a job to a free worker even when the queue is full, and answers 503 when there is no room', async () => {
    const before = { ...POOL_LIMITS };
    try {
      POOL_LIMITS.queue = 0;
      expect((await post('/def/volunteering', VALID)).status).toBe(200);
      POOL_LIMITS.workers = 0;
      const busy = await post('/def/volunteering', VALID);
      expect(busy.status).toBe(503);
      expect(busy.headers['retry-after']).toBe('5');
    } finally {
      Object.assign(POOL_LIMITS, before);
    }
  });

  it('keeps places for other formats when JSON-LD has taken all of its own', async () => {
    const held = Array.from({ length: 1 + POOL_LIMITS.jsonldQueue }, (_, i) => admit(`test:${i}`, 'jsonld'));
    try {
      expect(held.every((p) => p.ok)).toBe(true);
      const jsonld = await post('/def/volunteering', JSON.stringify({ '@id': 'https://example.org/r', '@type': 'https://w3id.org/odi/volunteering#Role' }), 'application/ld+json');
      expect([jsonld.status, jsonld.body.error]).toEqual([503, expect.stringMatching(/busy with other JSON-LD/)]);
      expect((await post('/def/volunteering', VALID)).status).toBe(200);
    } finally {
      for (const p of held) if (p.ok) p.release();
    }
  });

  it('lists at most 1,000 results and counts them all', async () => {
    // Each opportunity lacks a role and an organisation: two results each, in the JSON and the Turtle report.
    const roles = PREFIXES + Array.from({ length: 700 }, (_, i) => `ex:o${i} a vol:VolunteeringOpportunity ; vol:title "t" .`).join('\n');
    const all = await post('/def/volunteering', roles);
    expect(all.status).toBe(200);
    expect(all.body.truncated).toBe(true);
    expect(all.body.results).toHaveLength(1000);
    expect(all.body.summary.violations + all.body.summary.warnings + all.body.summary.infos).toBeGreaterThan(1000);
    const ttl = await request(app).post('/def/volunteering').set('Content-Type', 'text/turtle').set('Accept', 'text/turtle').send(roles);
    expect(ttl.text).toMatch(/^# The first 1,000 of [\d,]+ results\./);
    const store = new Store(new Parser().parse(ttl.text));
    expect(store.getQuads(null, 'http://www.w3.org/ns/shacl#result', null, null)).toHaveLength(1000);
    // Fewer than that: no flag.
    expect((await post('/def/volunteering', VALID)).body.truncated).toBeUndefined();
    // A review's 77 KB document: 1,900 nodes named with a 4,000-character prefix make 3,800 results of about
    // 4,000 characters each. The report used to be written out whole (twice, for Turtle) before its size was checked.
    const wide = `${PREFIXES}@prefix e: <https://e/${'x'.repeat(3990)}/> .\n${Array.from({ length: 1900 }, (_, i) => `e:s${i} a vol:VolunteeringOpportunity .`).join('\n')}`;
    const many = await post('/def/volunteering', wide);
    expect([many.status, many.body.summary.violations, many.body.results.length, many.body.truncated]).toEqual([200, 3800, 1000, true]);
  });

  it('stops a worker that uses more memory in all than allowed, and replaces one that grew large', async () => {
    const before = { ...POOL_LIMITS };
    try {
      // Memory outside the heap (the SHACL engine's WebAssembly memory) counts: here any worker is over.
      POOL_LIMITS.rssMb = 1;
      const over = await post('/def/volunteering', VALID);
      expect([over.status, over.body.error]).toEqual([413, expect.stringMatching(/more memory than the validator allows/)]);
      POOL_LIMITS.rssMb = before.rssMb;
      // A worker past recycleMb after its job is stopped, so it doesn't keep what it grew to.
      POOL_LIMITS.recycleMb = 1;
      expect((await post('/def/volunteering', VALID)).status).toBe(200);
      for (let i = 0; i < 100 && poolState().threads; i++) await new Promise((r) => setTimeout(r, 20));
      expect(poolState().threads).toBe(0);
    } finally {
      Object.assign(POOL_LIMITS, before);
    }
    expect((await post('/def/volunteering', VALID)).status).toBe(200);
  });

  it('survives data that would exhaust a worker: it answers 413 and the next request works', async () => {
    // A review's 152 KB document: 100 relative @vocabs of 1,000 characters make a 100,000-character
    // property, on 2,000 nodes. Written out for the SHACL engine that was 200 MB, and running out of
    // memory in a worker thread took the whole server down.
    const vocabs = [{ '@vocab': 'https://e/' }, ...Array.from({ length: 100 }, () => ({ '@vocab': `${'x'.repeat(1000)}/` }))];
    const doc = { '@context': vocabs, '@graph': Array.from({ length: 2000 }, (_, i) => ({ '@id': `https://e/s${i}`, p: 1 })) };
    const refused = await post('/def/volunteering', JSON.stringify(doc), 'application/ld+json');
    expect([refused.status, refused.body.error]).toEqual([413, expect.stringMatching(/IRI longer than 4,096 characters/)]);
    // Under the IRI limit, the same trick is stopped by the limit on how much text the triples hold.
    const wide = { '@context': { '@vocab': `https://e/${'x'.repeat(3900)}/` }, '@graph': doc['@graph'].concat(doc['@graph'].map((n) => ({ ...n, '@id': `${n['@id']}b` }))) };
    const tooMuch = await post('/def/volunteering', JSON.stringify(wide), 'application/ld+json');
    expect([tooMuch.status, tooMuch.body.error]).toEqual([413, expect.stringMatching(/million characters of IRIs and literals/)]);
    // And whatever gets past every limit runs in a separate process: here 50,000 terms each defined
    // through the one before expand to gigabytes, the worker runs out of memory, and only it stops.
    const chain: Record<string, string> = { a0: 'https://e/' };
    for (let i = 1; i < 50_000; i++) chain[`a${i}`] = `a${i - 1}:x/`;
    const exhausted = await post('/def/volunteering', JSON.stringify({ '@context': chain, '@id': 'https://e/s', 'a3:p': 1 }), 'application/ld+json');
    expect([exhausted.status, exhausted.body.error]).toEqual([413, expect.stringMatching(/more memory than the validator allows/)]);
    expect((await post('/def/volunteering', VALID)).status).toBe(200);
  }, 60_000);

  describe('places in the validator, taken before the data is read', () => {
    let server: http.Server;
    let port: number;
    beforeAll(async () => {
      server = app.listen(0);
      await new Promise((r) => server.once('listening', r));
      port = (server.address() as AddressInfo).port;
    });
    afterAll(() => new Promise((r) => server.close(r)));

    // Every request comes from 127.0.0.1, one client (localhost can be ::1 instead).
    const open: http.ClientRequest[] = [];
    afterEach(() => {
      for (const r of open.splice(0)) r.destroy();
    });
    const local = () => request(`http://127.0.0.1:${port}`);
    /** Starts a POST that sends `first` and then, unless `rest` is given, never finishes. */
    const send = (first: string | Buffer, headers: Record<string, string> = {}, rest?: string | Buffer) => {
      const length = rest === undefined ? 100_000 : Buffer.byteLength(first) + Buffer.byteLength(rest);
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/def/volunteering', headers: { 'Content-Type': 'text/turtle', 'Content-Length': String(length), ...headers } });
      open.push(req);
      req.on('error', () => {});
      req.write(first);
      if (rest !== undefined) req.end(rest);
      const answer = new Promise<{ status: number; body: string }>((resolve) =>
        req.on('response', (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve({ status: res.statusCode!, body }));
        }),
      );
      return { req, answer };
    };
    const trickle = () => send(PREFIXES);
    /** Waits until every place is free and no job is waiting or running. */
    const idle = async (ms = 3000) => {
      for (let i = 0; i < ms / 10; i++) {
        const { admitted, queued, running } = poolState();
        if (!admitted && !queued && !running) return { admitted, queued, running };
        await new Promise((r) => setTimeout(r, 10));
      }
      const { admitted, queued, running } = poolState();
      return { admitted, queued, running };
    };
    const bigData = (n: number) => {
      let big = PREFIXES;
      for (let i = 0; i < n; i++) big += `ex:r${i} a vol:Role ; vol:title "r" .\n`;
      return big;
    };

    it('lets one client hold two at once, and gives them back when it goes away', async () => {
      const a = trickle();
      const b = trickle();
      await new Promise((r) => setTimeout(r, 100));
      const third = await local().post('/def/volunteering').set('Content-Type', 'text/turtle').send(VALID);
      expect(third.status).toBe(429);
      expect(third.body.error).toMatch(/already have 2 validations in progress/);
      expect(third.headers['retry-after']).toBe('5');
      a.req.destroy();
      b.req.destroy();
      expect(await idle()).toEqual({ admitted: 0, queued: 0, running: 0 });
      expect((await local().post('/def/volunteering').set('Content-Type', 'text/turtle').send(VALID)).status).toBe(200);
    });

    it('cancels the validations of a client that goes away, and only then gives its places back', async () => {
      const before = POOL_LIMITS.perClient;
      POOL_LIMITS.perClient = 10;
      try {
        const data = bigData(12_000);
        // Fill both workers and the queue, then hang up on all of them as they are being checked.
        const sent = Array.from({ length: POOL_LIMITS.workers + POOL_LIMITS.queue }, () => send(data.slice(0, 10), {}, data.slice(10)));
        for (let i = 0; i < 100 && poolState().running < POOL_LIMITS.workers; i++) await new Promise((r) => setTimeout(r, 10));
        expect(poolState().running).toBe(POOL_LIMITS.workers);
        // Watch the pool while they stop: never more threads than workers, and no place
        // given back while a stopped worker is still exiting.
        const samples: ReturnType<typeof poolState>[] = [];
        const watch = setInterval(() => samples.push(poolState()), 0);
        for (const s of sent) s.req.destroy();
        // Far sooner than the jobs could finish: they were stopped, not waited for.
        const end = await idle(300);
        clearInterval(watch);
        expect(end).toEqual({ admitted: 0, queued: 0, running: 0 });
        expect(samples.length).toBeGreaterThan(0);
        expect(Math.max(...samples.map((x) => x.threads))).toBeLessThanOrEqual(POOL_LIMITS.workers);
        expect(samples.filter((x) => x.stopping > 0 && x.admitted < x.stopping)).toEqual([]);
      } finally {
        POOL_LIMITS.perClient = before;
      }
      expect((await local().post('/def/volunteering').set('Content-Type', 'text/turtle').send(VALID)).status).toBe(200);
    });

    it('converts one JSON-LD document at a time, while other formats carry on', async () => {
      const before = POOL_LIMITS.perClient;
      POOL_LIMITS.perClient = 10;
      const jsonld = JSON.stringify({
        '@context': { vol: 'https://w3id.org/odi/volunteering#' },
        '@graph': Array.from({ length: 3000 }, (_, i) => ({ '@id': `https://example.org/r${i}`, '@type': 'vol:Role', 'vol:title': 'r' })),
      });
      const samples: number[] = [];
      const watch = setInterval(() => samples.push(poolState().jsonld), 0);
      try {
        const answers = await Promise.all([
          ...Array.from({ length: 3 }, () => post('/def/volunteering', jsonld, 'application/ld+json')),
          post('/def/volunteering', VALID),
        ]);
        expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200]);
        expect(Math.max(...samples)).toBe(1);
      } finally {
        clearInterval(watch);
        POOL_LIMITS.perClient = before;
      }
    });

    it('drops a compressed upload as soon as its client goes away', async () => {
      const gz = gzipSync(bigData(2000));
      const { req } = send(gz.subarray(0, gz.length >> 1), { 'Content-Encoding': 'gzip', 'Content-Length': String(gz.length) });
      for (let i = 0; i < 100 && !poolState().admitted; i++) await new Promise((r) => setTimeout(r, 10));
      expect(poolState().admitted).toBe(1);
      req.destroy();
      expect(await idle()).toEqual({ admitted: 0, queued: 0, running: 0 });
    });

    it('answers 415 for a format it can’t read without taking a place', async () => {
      const places = Array.from({ length: POOL_LIMITS.workers + POOL_LIMITS.queue }, (_, i) => admit(`test:${i}`));
      try {
        expect((await post('/def/volunteering', '%PDF-1.4', 'application/pdf')).status).toBe(415);
        expect((await post('/def/volunteering?format=csv', VALID)).status).toBe(415);
      } finally {
        for (const p of places) if (p.ok) p.release();
      }
    });

    it('turns everyone away while every place is taken, without reading their data', async () => {
      const places = Array.from({ length: POOL_LIMITS.workers + POOL_LIMITS.queue }, (_, i) => admit(`test:${i}`));
      try {
        const busy = await post('/def/volunteering', VALID);
        expect(busy.status).toBe(503);
        expect(busy.headers.connection).toBe('close');
        // Requests that would fail anyway still get their real answer.
        expect((await post('/def/nothing-here', VALID)).status).toBe(404);
      } finally {
        for (const p of places) if (p.ok) p.release();
      }
      expect((await post('/def/volunteering', VALID)).status).toBe(200);
    });

    it('stops waiting for data that arrives too slowly', async () => {
      const before = BODY_LIMITS.ms;
      BODY_LIMITS.ms = 150;
      try {
        const { answer } = trickle();
        const res = await answer;
        expect(res.status).toBe(408);
        expect(res.body).toMatch(/took longer than 0.15 s to arrive/);
      } finally {
        BODY_LIMITS.ms = before;
      }
    });

    it('turns a job away when it has waited too long for a worker', async () => {
      const before = { wait: POOL_LIMITS.queueWaitMs, perClient: POOL_LIMITS.perClient };
      POOL_LIMITS.queueWaitMs = 0;
      POOL_LIMITS.perClient = 10;
      const big = bigData(3000);
      try {
        const answers = await Promise.all(Array.from({ length: POOL_LIMITS.workers + 1 }, () => post('/def/volunteering', big)));
        const statuses = answers.map((r) => r.status);
        expect(statuses).toContain(503);
        expect(statuses).toContain(200);
      } finally {
        Object.assign(POOL_LIMITS, { queueWaitMs: before.wait, perClient: before.perClient });
      }
    });
  });

  it('answers CORS preflight for cross-site POSTs', async () => {
    const res = await request(app).options('/def/volunteering/1.0.0').set('Origin', 'https://app.example.org').set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-headers']).toMatch(/Content-Type/);
    expect(res.headers['accept-post']).toContain('application/ld+json');
  });
});

describe('the SHACL profile of the ontology IRI', () => {
  const isShapes = (res: request.Response) => {
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/turtle/);
    expect(res.text).toMatch(/sh:NodeShape/);
    expect(res.headers['content-profile']).toBe('<http://www.w3.org/ns/shacl#>');
    expect(res.headers.vary).toMatch(/Accept-Profile/);
  };

  it('returns the shapes for Accept-Profile, a profile parameter or ?_profile=shacl', async () => {
    const r = await request(app).get('/def/volunteering/1.0.0').set('Accept-Profile', '<http://www.w3.org/ns/shacl#>');
    isShapes(r);
    isShapes(await request(app).get('/def/volunteering').set('Accept', 'text/turtle;profile="http://www.w3.org/ns/shacl#"'));
    isShapes(await request(app).get('/def/volunteering?_profile=shacl').set('Accept', 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'));
  });

  it('still returns the ontology without the profile, or when it is refused with q=0', async () => {
    const plain = await request(app).get('/def/volunteering/1.0.0').set('Accept', 'text/turtle');
    expect(plain.text).toMatch(/owl:Ontology/);
    expect(plain.text).not.toMatch(/sh:NodeShape/);
    expect(plain.headers['accept-post']).toContain('text/turtle');
    const refused = await request(app).get('/def/volunteering/1.0.0').set('Accept', 'text/turtle').set('Accept-Profile', '<http://www.w3.org/ns/shacl#>;q=0');
    expect(refused.text).not.toMatch(/sh:NodeShape/);
  });

  it('lets any site read the shapes, with the profile headers', async () => {
    const res = await request(app).get('/def/volunteering/1.0.0').set('Origin', 'https://app.example.org').set('Accept-Profile', '<http://www.w3.org/ns/shacl#>');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-expose-headers']).toMatch(/Content-Profile/);
    expect(res.headers.link).toContain('<http://www.w3.org/ns/shacl#>; rel="profile"');
    const plain = await request(app).get('/def/volunteering/1.0.0').set('Accept', 'text/turtle');
    expect(plain.headers.link).not.toContain('rel="profile"');
  });

  it('respects a more specific refusal of Turtle', async () => {
    const res = await request(app).get('/def/volunteering/1.0.0').set('Accept', 'text/turtle;q=0, */*;q=1').set('Accept-Profile', '<http://www.w3.org/ns/shacl#>');
    expect(res.status).toBe(406);
    const ok = await request(app).get('/def/volunteering/1.0.0').set('Accept', 'text/*;q=0, text/turtle;q=0.5').set('Accept-Profile', '<http://www.w3.org/ns/shacl#>');
    expect(ok.status).toBe(200);
    // A range naming the profile is more specific than the bare type.
    const refusedProfile = await request(app)
      .get('/def/volunteering/1.0.0')
      .set('Accept', 'text/turtle;profile="http://www.w3.org/ns/shacl#";q=0, text/turtle;q=1')
      .set('Accept-Profile', '<http://www.w3.org/ns/shacl#>');
    expect(refusedProfile.status).toBe(406);
    const otherProfile = await request(app)
      .get('/def/volunteering/1.0.0')
      .set('Accept', 'text/turtle;profile="https://example.org/other";q=0, text/turtle;q=1')
      .set('Accept-Profile', '<http://www.w3.org/ns/shacl#>');
    expect(otherProfile.status).toBe(200);
    expect(otherProfile.text).toMatch(/sh:NodeShape/);
    // charset is matched like profile: the shapes are UTF-8.
    const refusedWithCharset = await request(app)
      .get('/def/volunteering/1.0.0')
      .set('Accept', 'text/turtle;profile="http://www.w3.org/ns/shacl#";charset=utf-8;q=0, text/turtle;q=1')
      .set('Accept-Profile', '<http://www.w3.org/ns/shacl#>');
    expect(refusedWithCharset.status).toBe(406);
    const utf8Only = await request(app).get('/def/volunteering/1.0.0').set('Accept', 'text/turtle;charset=utf-8').set('Accept-Profile', '<http://www.w3.org/ns/shacl#>');
    expect(utf8Only.status).toBe(200);
    expect(utf8Only.text).toMatch(/sh:NodeShape/);
    const latin1Only = await request(app).get('/def/volunteering/1.0.0').set('Accept', 'text/turtle;charset=iso-8859-1').set('Accept-Profile', '<http://www.w3.org/ns/shacl#>');
    expect(latin1Only.status).toBe(406);
  });

  it('refuses the profile in a type it is not available in', async () => {
    const res = await request(app).get('/def/volunteering/1.0.0').set('Accept', 'application/ld+json').set('Accept-Profile', '<http://www.w3.org/ns/shacl#>');
    expect(res.status).toBe(406);
  });

  it('advertises the shapes with their profile in the Link header', async () => {
    const res = await request(app).get('/def/volunteering/1.0.0').set('Accept', 'text/turtle');
    expect(res.headers.link).toContain('1.0.0.shacl.ttl>; rel="alternate"; type="text/turtle"; profile="http://www.w3.org/ns/shacl#"');
  });
});

describe('the public page', () => {
  it('explains how to validate, and links to the validator', async () => {
    const res = await request(app).get('/def/volunteering/1.0.0').set('Accept', 'text/html');
    expect(res.text).toContain('id="validate"');
    expect(res.text).toMatch(/curl -X POST https?:\/\/[^ ]+\/def\/volunteering\/1\.0\.0/);
    expect(res.text).toMatch(/\/o\/volunteering\/validate\?version=1\.0\.0/);
    expect(res.text).toContain('Accept-Profile: &lt;http://www.w3.org/ns/shacl#&gt;');
  });
});

describe('rate limits', () => {
  it('limits validation requests per client', async () => {
    RATE_LIMITS.perMinute = PER_MINUTE;
    const statuses: number[] = [];
    for (let i = 0; i < 35; i++) statuses.push((await post('/def/volunteering', VALID)).status);
    expect(statuses).toContain(429);
  });
});
