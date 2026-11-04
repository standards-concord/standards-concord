import { Parser, Store } from 'n3';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { seedDemo } from '../src/services/simulation.js';
import { POOL_LIMITS } from '../src/services/validationPool.js';

const app = createApp();
const SH = 'http://www.w3.org/ns/shacl#';

beforeAll(async () => {
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

  it('answers 503 when the queue is full', async () => {
    const before = POOL_LIMITS.queue;
    POOL_LIMITS.queue = 0;
    try {
      const busy = await post('/def/volunteering', VALID);
      expect(busy.status).toBe(503);
      expect(busy.headers['retry-after']).toBe('5');
    } finally {
      POOL_LIMITS.queue = before;
    }
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
    const statuses: number[] = [];
    for (let i = 0; i < 35; i++) statuses.push((await post('/def/volunteering', VALID)).status);
    expect(statuses).toContain(429);
  });
});
