import request from 'supertest';
import { DataFactory, Parser, Store } from 'n3';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { OntologyGraph } from '@concord/core';
import type { OntologyProject, Release } from '@concord/shared';
import { createApp } from '../src/app.js';
import { openDb, put } from '../src/db.js';
import { catalogueDescription, catalogueEntries, catalogueJsonLd, catalogueTurtle, renderCatalogue } from '../src/public/catalogue.js';
import { renderOntologyPage } from '../src/public/render.js';
import { pageInput } from '../src/public/routes.js';
import { PAGE_GENERATOR } from '../src/public/shell.js';
import { createProject } from '../src/services/ontologies.js';
import { ontologyStore } from '../src/services/ontologyStore.js';
import { createUser } from '../src/services/users.js';
import { createUseCase } from '../src/services/useCases.js';
import { createFork } from '../src/services/forks.js';
import { createFederation } from '../src/services/federations.js';

const BASE = 'https://concord.example';
let published: OntologyProject;
let draft: OntologyProject;
let held: OntologyProject;
const unsafeTitle = 'Apple <script>alert("catalogue")</script> & standard';
const description = 'A <script>description</script> with "quotes", backslashes \\ and & symbols. ' + 'Whole words at the boundary. '.repeat(12);

beforeAll(async () => {
  await openDb();
  const owner = await createUser({ name: 'PRIVATE_CATALOGUE_OWNER', provider: 'github', subject: 'catalogue-owner' });
  published = await createProject({ title: 'Zebra published standard', description: 'Published definitions.', prefix: 'cat', namespace: 'https://catalogue.example/vocab#', domain: 'Public services' }, owner);
  const graph = await OntologyGraph.fromTurtle(`
    @prefix ex: <https://catalogue.example/vocab#> .
    @prefix other: <https://other.example/> .
    @prefix owl: <http://www.w3.org/2002/07/owl#> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
    <https://catalogue.example/vocab> a owl:Ontology .
    ex:Local a owl:Class .
    other:Adopted a owl:Class ; rdfs:isDefinedBy <https://catalogue.example/vocab> .
    other:Foreign a owl:Class .
    ex:object a owl:ObjectProperty . ex:data a owl:DatatypeProperty . ex:note a owl:AnnotationProperty .
    other:property a owl:ObjectProperty .
  `);
  const date = '2026-11-03T12:00:00.000Z';
  const release: Release = {
    id: 'catalogue-release', ontologyId: published.id, version: '1.2.0', status: 'published', level: 'minor',
    versionIRI: `${published.ontologyIRI}/1.2.0`, changeRequestIds: [], notes: 'PRIVATE_CATALOGUE_NOTES',
    createdBy: owner.id, createdAt: date, publishedAt: date, statusSince: date,
  };
  await ontologyStore.writeRelease(published, release.version, graph, {}, release.notes, { name: owner.name }, undefined, async (commit) => {
    await put('releases', { ...release, commit }, published.id);
    published = await put('ontologies', { ...published, currentVersion: release.version });
  });
  // The working draft differs: the catalogue must count the released version.
  graph.store.addQuad(DataFactory.namedNode(published.namespace + 'DraftOnly'), DataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), DataFactory.namedNode('http://www.w3.org/2002/07/owl#Class'));
  await ontologyStore.commitWorking(published, graph, 'Draft change', { name: owner.name });
  draft = await createProject({ title: unsafeTitle, description, prefix: 'draft', creditCreator: true }, owner);
  held = await createProject({ title: 'Held standard', description: 'Public summary.', prefix: 'held' }, owner);
  await ontologyStore.writeRelease(held, '2.0.0', await OntologyGraph.fromTurtle(`
    @prefix owl: <http://www.w3.org/2002/07/owl#> .
    <${held.ontologyIRI}> a owl:Ontology .
    <${held.namespace}PRIVATE_HELD_CLASS> a owl:Class .
  `), {}, '', { name: owner.name });
  held = await put('ontologies', { ...held, currentVersion: '2.0.0' });
  await put('kv', { id: `public-hold:${held.id}`, ontologyId: held.id, versions: ['draft', '2.0.0'], since: date });
  await createUseCase(draft, owner, { visibility: 'private', sections: { name: 'PRIVATE_CATALOGUE_USE_CASE' } });
  await createFork(published, owner, { name: 'EXCLUDED_CATALOGUE_FORK' });
  await createFederation(owner, { title: 'EXCLUDED_CATALOGUE_FEDERATION' });
});

describe('catalogue content', () => {
  it('lists published and draft-only standards by title with own terms from the public version', async () => {
    const entries = await catalogueEntries(BASE);
    expect(entries.map((e) => e.title)).toEqual([unsafeTitle, held.title, published.title]);
    expect(entries.find((e) => e.title === published.title)).toMatchObject({ version: '1.2.0', publishedAt: '2026-11-03T12:00:00.000Z', domain: 'Public services', counts: { classes: 2, properties: 3 } });
    expect(entries.find((e) => e.title === unsafeTitle)).toMatchObject({ version: 'draft', counts: { classes: 0, properties: 0 } });
    const html = renderCatalogue(entries, BASE);
    expect(html).toContain('Version 1.2.0, 3 November 2026 · Public services · 2 classes, 3 properties');
    expect(html).toContain('Draft, no published version yet');
    expect(html).toContain('<ul class="catalogue"');
    expect(html).toContain(PAGE_GENERATOR);
    expect(html).not.toMatch(/<script(?! type="application\/ld\+json")/);
    expect(html).toContain('Sign in to Concord');
  });

  it('shows Being reviewed without a version or counts and never reads held content', async () => {
    const read = vi.spyOn(ontologyStore, 'at');
    try {
      const entries = await catalogueEntries(BASE);
      const entry = entries.find((e) => e.title === held.title)!;
      expect(entry.held).toBe(true);
      expect(entry.counts).toBeUndefined();
      expect(entry.version).toBeUndefined();
      expect(read.mock.calls.filter(([p]) => p.slug === held.slug)).toEqual([]);
      const html = renderCatalogue([entry], BASE);
      expect(html).toContain('Being reviewed');
      expect(html).not.toMatch(/\d+ classes|\d+ properties|2\.0\.0|PRIVATE_HELD_CLASS/);
      expect(await catalogueTurtle([entry], `${BASE}/def`)).not.toContain('versionInfo');
    } finally {
      read.mockRestore();
    }
  });

  it('also withholds counts for a draft-only standard held under the legacy rules', async () => {
    await put('ontologies', { ...draft, publishedWithApproval: undefined });
    try {
      const entry = (await catalogueEntries(BASE)).find((e) => e.title === unsafeTitle)!;
      expect(entry).toMatchObject({ held: true });
      expect(entry.counts).toBeUndefined();
    } finally {
      await put('ontologies', draft);
    }
  });

  it('escapes titles and descriptions, truncates at a word boundary and reveals no private fields', async () => {
    const entries = await catalogueEntries(BASE);
    const entry = entries.find((e) => e.title === unsafeTitle)!;
    expect(entry.description.length).toBeLessThanOrEqual(240);
    expect(description.startsWith(entry.description)).toBe(true);
    expect(description.slice(entry.description.length)).toMatch(/^\s/);
    const html = renderCatalogue(entries, BASE);
    expect(html).toContain('Apple &lt;script&gt;alert(&quot;catalogue&quot;)&lt;/script&gt; &amp; standard');
    expect(html).toContain('&lt;script&gt;description&lt;/script&gt;');
    expect(html).not.toContain('<script>alert');
    expect(JSON.parse(html.match(/<script type="application\/ld\+json">([^]*?)<\/script>/)![1]).hasPart[0].name).toBe(unsafeTitle);
    for (const text of [html, JSON.stringify(catalogueJsonLd(entries, `${BASE}/def`)), await catalogueTurtle(entries, `${BASE}/def`)]) {
      expect(text).not.toMatch(/PRIVATE_CATALOGUE_|PRIVATE_HELD_|EXCLUDED_CATALOGUE_/);
      expect(text).not.toContain('ownerIds');
    }
    expect(catalogueDescription('a'.repeat(241))).toBe('');
    expect(catalogueDescription('x'.repeat(239) + ' word')).toBe('x'.repeat(239));
    expect(catalogueDescription('x'.repeat(240) + ' word')).toBe('x'.repeat(240));
  });

  it('parses JSON-LD and DCAT Turtle and agrees with the HTML list', async () => {
    const entries = await catalogueEntries(BASE);
    const url = `${BASE}/def`;
    const json = catalogueJsonLd(entries, url);
    const jsonGraph = await OntologyGraph.parse(JSON.stringify(json), 'jsonld');
    const turtle = new Store(new Parser().parse(await catalogueTurtle(entries, url)));
    const values = (store: Store, subject: string, predicate: string) => store.getObjects(subject, predicate, null).map((n) => n.value);
    expect(values(jsonGraph.store, url, 'https://schema.org/hasPart')).toEqual(entries.map((e) => e.url));
    expect(values(turtle, url, 'http://www.w3.org/ns/dcat#resource')).toEqual(entries.map((e) => e.url));
    for (const entry of entries) {
      expect(values(jsonGraph.store, entry.url, 'https://schema.org/name')).toEqual([entry.title]);
      expect(values(turtle, entry.url, 'http://purl.org/dc/terms/title')).toEqual([entry.title]);
      expect(values(turtle, entry.url, 'http://purl.org/dc/terms/description')).toEqual([entry.description]);
      expect(values(turtle, entry.url, 'http://www.w3.org/ns/dcat#landingPage')).toEqual([entry.url]);
      expect(values(turtle, entry.url, 'http://www.w3.org/2002/07/owl#versionInfo')).toEqual(entry.version ? [entry.version] : []);
      expect(values(jsonGraph.store, entry.url, 'https://schema.org/version')).toEqual(entry.version ? [entry.version] : []);
    }
    const embedded = JSON.parse(renderCatalogue(entries, BASE).match(/<script type="application\/ld\+json">([^]*?)<\/script>/)![1]);
    expect(embedded).toEqual(JSON.parse(JSON.stringify(json)));
  });

  it('renders the empty state and empty machine-readable catalogues', async () => {
    expect(renderCatalogue([], BASE)).toContain('No standards have been published here yet.');
    expect(catalogueJsonLd([], `${BASE}/def`).hasPart).toEqual([]);
    expect(new Parser().parse(await catalogueTurtle([], `${BASE}/def`))).toHaveLength(3);
  });

  it('links back from an ontology page through the shared public shell', async () => {
    const html = renderOntologyPage(await pageInput(draft, 'draft', BASE));
    expect(html).toContain(`href="${BASE}/def">All standards</a>`);
    expect(html).toContain(PAGE_GENERATOR);
  });
});

describe('catalogue HTTP routes', () => {
  const app = createApp();

  it('answers /def and /def/ as HTML with the public cache, Vary and CORS headers', async () => {
    for (const url of ['/def', '/def/']) {
      const response = await request(app).get(url).set('Accept', 'text/html');
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/html/);
      expect(response.headers['cache-control']).toBe('public, max-age=300');
      expect(response.headers.vary).toMatch(/Accept/);
      expect(response.headers['access-control-allow-origin']).toBe('*');
      expect(response.text).toContain('<h1>Standards on Concord</h1>');
    }
  });

  it('negotiates JSON-LD and Turtle and serves both extensions ahead of the ontology route', async () => {
    for (const [extension, accept] of [['jsonld', 'application/ld+json'], ['ttl', 'text/turtle']]) {
      const negotiated = await request(app).get('/def').set('Host', 'concord.example').set('Accept', accept);
      const explicit = await request(app).get(`/def.${extension}`).set('Host', 'concord.example').set('Accept', 'text/html');
      expect(negotiated.status).toBe(200);
      expect(explicit.status).toBe(200);
      expect(negotiated.headers['content-type']).toContain(accept);
      expect(explicit.headers['content-type']).toContain(accept);
      expect(negotiated.text).toBe(explicit.text);
      if (extension === 'jsonld') await OntologyGraph.parse(explicit.text, 'jsonld');
      else expect(new Parser().parse(explicit.text).length).toBeGreaterThan(3);
    }
    const rejected = await request(app).get('/def').set('Accept', 'image/png');
    expect(rejected.status).toBe(406);
    expect(rejected.headers['cache-control']).toBe('no-store');
  });
});
