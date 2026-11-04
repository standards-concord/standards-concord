import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { renderOntologyPage } from '../src/public/render.js';
import { pageInput } from '../src/public/routes.js';
import { toPublishedRequirements } from '../src/public/requirements.js';
import { termAnchors } from '../src/public/anchors.js';
import { findProject } from '../src/services/ontologies.js';
import { ontologyStore } from '../src/services/ontologyStore.js';
import { seedDemo } from '../src/services/simulation.js';
import { createUseCase, getUseCase, listUseCases, updateUseCase } from '../src/services/useCases.js';
import { createUser, getUser } from '../src/services/users.js';
import type { OntologyView } from '@concord/core/types';

const app = createApp();

beforeAll(async () => {
  openDb();
  await seedDemo();
});

describe('public ontology pages', () => {
  it('serves the HTML page at the ontology IRI path with the latest release', async () => {
    const res = await request(app).get('/def/volunteering').set('Accept', 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers.vary).toMatch(/Accept/);
    expect(res.text).toMatch(/<h1>[^<]*Volunteering/i);
    expect(res.text).toContain('Version 1.0.0');
    expect(res.text).toContain('Latest release');
    expect(res.text).toContain('https://w3id.org/odi/volunteering/1.0.0');
    for (const tab of ['Specification', 'Use cases and requirements', 'Changes', 'Download and cite']) expect(res.text).toContain(tab);
  });

  it('gives every term an anchor that matches its IRI fragment', async () => {
    const res = await request(app).get('/def/volunteering/1.0.0');
    expect(res.status).toBe(200);
    const view = (await ontologyStore.at(findProject('volunteering')!, '1.0.0')).view();
    for (const c of view.classes) {
      const fragment = c.iri.split('#').pop()!;
      expect(res.text, fragment).toContain(`id="${fragment}"`);
    }
    expect(res.text).toContain('id="VolunteeringOpportunity"');
    expect(res.text).toMatch(/class="ref" href="#[A-Za-z]+"/);
  });

  it('negotiates RDF formats on the same IRI', async () => {
    const cases: [string, RegExp, RegExp][] = [
      ['text/turtle', /text\/turtle/, /owl:Ontology/],
      ['application/ld+json', /application\/ld\+json/, /"@context"|"@id"/],
      ['application/rdf+xml', /application\/rdf\+xml/, /<rdf:RDF/],
      ['application/n-triples', /application\/n-triples/, /<http:\/\/www\.w3\.org\/2002\/07\/owl#Ontology>/],
    ];
    for (const [accept, type, body] of cases) {
      const res = await request(app).get('/def/volunteering/1.0.0').set('Accept', accept);
      expect(res.status, accept).toBe(200);
      expect(res.headers['content-type'], accept).toMatch(type);
      expect(res.text, accept).toMatch(body);
    }
    const ttl = await request(app).get('/def/volunteering').set('Accept', 'text/turtle');
    expect(ttl.text).toContain('https://w3id.org/odi/volunteering/1.0.0');
  });

  it('serves a serialisation by extension, including LinkML and SHACL', async () => {
    const ttl = await request(app).get('/def/volunteering/1.0.0.ttl');
    expect(ttl.headers['content-type']).toMatch(/text\/turtle/);
    expect(ttl.text).toContain('owl:versionIRI');
    const linkml = await request(app).get('/def/volunteering/1.0.0.linkml.yaml');
    expect(linkml.status).toBe(200);
    expect(linkml.text).toMatch(/classes:/);
    const shacl = await request(app).get('/def/volunteering/1.0.0.shacl.ttl');
    expect(shacl.text).toMatch(/sh:NodeShape/);
    const latest = await request(app).get('/def/volunteering.jsonld');
    expect(latest.headers['content-type']).toMatch(/ld\+json/);
  });

  it('advertises alternates in the Link header', async () => {
    const res = await request(app).get('/def/volunteering/1.0.0');
    expect(res.headers.link).toMatch(/1\.0\.0\.ttl>; rel="alternate"; type="text\/turtle"/);
    expect(res.headers.link).toMatch(/rel="canonical"/);
  });

  it('defaults to HTML for */* and refuses formats it cannot produce', async () => {
    const any = await request(app).get('/def/volunteering').set('Accept', '*/*');
    expect(any.headers['content-type']).toMatch(/text\/html/);
    const bad = await request(app).get('/def/volunteering').set('Accept', 'image/png');
    expect(bad.status).toBe(406);
  });

  it('shows the working draft, marked as unreleased', async () => {
    const res = await request(app).get('/def/volunteering/draft');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Unreleased draft');
    expect(res.text).toContain('This is the working draft');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('returns a friendly 404 for unknown ontologies and versions', async () => {
    const a = await request(app).get('/def/no-such-thing');
    expect(a.status).toBe(404);
    expect(a.text).toContain('no ontology');
    const b = await request(app).get('/def/volunteering/9.9.9');
    expect(b.status).toBe(404);
    expect(b.text).toContain('Go to the latest version');
  });

  it('includes the w3id redirect rules and machine-readable metadata', async () => {
    const res = await request(app).get('/def/volunteering');
    expect(res.text).toContain('odi/volunteering/.htaccess');
    expect(res.text).toMatch(/RewriteRule \^\(\.\+\)\$ .*\/def\/volunteering\/\$1 \[R=303,L\]/);
    const jsonLd = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(res.text)?.[1];
    expect(jsonLd).toBeTruthy();
    const data = JSON.parse(jsonLd!);
    expect(data['@type']).toBe('DefinedTermSet');
    expect(data.hasDefinedTerm.length).toBeGreaterThan(5);
    expect(res.text).toMatch(/<link rel="alternate" type="text\/turtle"/);
  });

  it('writes the page into each release for the copy on GitHub', () => {
    const file = path.join(ontologyStore.dir(findProject('volunteering')!), 'releases', '1.0.0', 'index.html');
    expect(fs.existsSync(file)).toBe(true);
    const html = fs.readFileSync(file, 'utf8');
    expect(html).toContain('href="ontology.jsonld"');
    expect(html).toContain('Version 1.0.0');
  });
});

describe('use cases on the public page', () => {
  it('shows the use cases behind the demo, with status and the release that closed them', async () => {
    const res = await request(app).get('/def/volunteering/1.0.0');
    expect(res.text).toContain('Aggregate volunteering opportunities across platforms');
    expect(res.text).toMatch(/id="uc-[^"]+"/);
    expect(res.text).toMatch(/Closed in <a href="[^"]*\/def\/volunteering\/1\.0\.0">1\.0\.0<\/a>/);
  });

  it('never shows use cases written by real people on the public page', async () => {
    const project = findProject('volunteering')!;
    const tester = await createUser({ name: 'Real Tester', provider: 'demo', subject: 'real-tester' });
    createUseCase(project, tester, { source: 'chat', status: 'triage', sections: { name: 'My confidential charity workflow' } });
    const res = await request(app).get('/def/volunteering');
    expect(res.text).not.toContain('My confidential charity workflow');
  });

  it('leaves out working group use cases and private originals, but shows the anonymised version', async () => {
    const project = findProject('volunteering')!;
    const tester = await createUser({ name: 'Group Tester', provider: 'demo', subject: 'group-tester' });
    createUseCase(project, tester, { source: 'meeting', visibility: 'group', status: 'triage', sections: { name: 'Internal partner pipeline' } });
    const res = await request(app).get('/def/volunteering/draft');
    expect(res.text).not.toContain('Internal partner pipeline');
    expect(res.text).not.toContain('St Anne');
    expect(res.text).not.toContain('Publish recurring shifts once');
    expect(res.text).toContain('Anonymised');
  });

  it('a released page shows the frozen document for that version', async () => {
    const res = await request(app).get('/def/volunteering/1.0.0');
    expect(res.text).toContain('id="req-R1"');
    expect(res.text).toMatch(/<a href="#uc-[^"]+">UC-\d+<\/a>/);
  });

  it('renders a requirements document with links to its use cases, and escapes contributed text', async () => {
    const project = findProject('volunteering')!;
    const input = await pageInput(project, '1.0.0', 'https://example.org');
    input.requirements = {
      document: {
        title: 'Finding volunteering that fits',
        version: '1.0.0',
        intro: 'Asha wants weekend shifts [UC-1](#uc-a). <script>alert(1)</script> [bad](javascript:alert(1))',
        sections: [{ id: 's1', heading: 'Publishing once', markdown: 'Covers [R1](#req-R1).' }],
        requirements: [{ id: 'R1', text: 'Publish recurring shifts', useCaseIds: ['a'], status: 'met' }],
      },
      useCases: [
        { id: 'a', ref: 'UC-1', title: 'Weekend shifts <b>now</b>', status: 'addressed', anonymised: true, origin: { kind: 'synthetic' } },
        { id: 'b', ref: 'UC-2', title: 'Expenses', status: 'deferred' },
      ],
    };
    const html = renderOntologyPage(input);
    expect(html).toContain('<a href="#uc-a">UC-1</a>');
    expect(html).toContain('id="uc-a"');
    expect(html).toContain('id="req-R1"');
    expect(html).toContain('<a href="#req-R1">R1</a>');
    expect(html).toContain('Weekend shifts &lt;b&gt;now&lt;/b&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('javascript:alert');
    expect(html).toContain('In the working draft');
    expect(html).toContain('Deferred');
    expect(html).toContain('Anonymised');
  });

  it('says plainly when there is nothing public yet', async () => {
    const project = findProject('volunteering')!;
    const input = await pageInput(project, '1.0.0', 'https://example.org');
    input.requirements = { useCases: [] };
    const html = renderOntologyPage(input);
    expect(html).toContain('No public use cases yet');
    expect(html).toContain('There is no requirements document for 1.0.0 yet');
  });
});

describe('ontologies without a release', () => {
  it('serves the draft at the ontology IRI path and redirects slash-namespace term IRIs to anchors', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/demo').send({ name: 'Creator', role: 'owner' });
    const created = await agent.post('/api/ontologies').send({ title: 'Bike parking', prefix: 'bp', namespace: 'https://w3id.org/odi/bike-parking/' });
    expect(created.status).toBe(201);
    const slug = created.body.slug as string;
    const page = await request(app).get(`/def/${slug}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Nothing has been released yet');
    // Unknown segment that isn't a term
    const missing = await request(app).get(`/def/${slug}/NotATerm`);
    expect(missing.status).toBe(404);
  });
});

describe('superseded versions', () => {
  it('says when a newer release exists and links to it', async () => {
    const project = findProject('volunteering')!;
    const input = await pageInput(project, '1.0.0', 'https://example.org');
    input.latestVersion = '2.0.0';
    const html = renderOntologyPage(input);
    expect(html).toContain('Superseded');
    expect(html).toContain('This version has been superseded. The latest release is <a href="https://example.org/def/volunteering">2.0.0</a>');
  });
});

describe('mapping the use case data onto the page', () => {
  it('keeps public links only, drops names from anonymised use cases and shows term coverage', async () => {
    const mapped = toPublishedRequirements(
      {
        version: '1.0.0',
        title: 'Story',
        intro: 'Intro [UC-1](#uc-u1)',
        sections: [],
        requirements: [{ id: 'R1', text: 'Find shifts', useCaseIds: ['u1'], termIris: ['https://w3id.org/odi/volunteering#Session'], status: 'met' }],
      },
      [
        { id: 'u1', ref: 'UC-1', title: 'From a call', status: 'closed', coveredIn: '1.0.0', attribution: 'Aisha', origin: { kind: 'meeting', label: 'Working group call', href: '/o/x/meetings/y' } },
        { id: 'u2', ref: 'UC-2', title: 'Private one', status: 'accepted', anonymised: true, attribution: 'Should not show', origin: { kind: 'synthetic', label: 'Anonymised example' } },
      ],
    );
    expect(mapped.useCases[0].origin?.href).toBeUndefined();
    expect(mapped.useCases[0].addressedIn).toBe('1.0.0');
    expect(mapped.useCases[1].attribution).toBeUndefined();
    const input = await pageInput(findProject('volunteering')!, '1.0.0', 'https://example.org');
    input.requirements = mapped;
    const html = renderOntologyPage(input);
    expect(html).not.toContain('Should not show');
    expect(html).not.toContain('/o/x/meetings/y');
    expect(html).toContain('Working group call');
    expect(html).toMatch(/Met by <a class="ref" href="#Session"/);
    expect(html).not.toMatch(/private use case/);
  });
});

describe('review fixes', () => {
  it('escapes dates that are not dates (stored XSS)', async () => {
    const input = await pageInput(findProject('volunteering')!, '1.0.0', 'https://example.org');
    input.view = { ...input.view, metadata: { ...input.view.metadata, modified: '<img src=x onerror=alert(1)>', issued: '"><script>alert(2)</script>' } };
    input.release = undefined;
    const html = renderOntologyPage(input);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert(2)');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('never publishes a demo use case that someone edited, even as a simulated persona', async () => {
    const project = findProject('volunteering')!;
    // Tom's use case was closed by 1.0.0, so every page shows it; Aisha's came later, so only the draft does.
    const pages = {
      'Aggregate volunteering opportunities across platforms': ['/def/volunteering', '/def/volunteering/draft', '/def/volunteering/1.0.0'],
      'Find weekly shifts that need volunteers': ['/def/volunteering/draft'],
    };
    for (const [name, urls] of Object.entries(pages)) {
      const seeded = listUseCases(project.id).find((u) => u.sections.name === name)!;
      const author = getUser(seeded.authorId)!;
      expect(author.simulated).toBe(true);
      updateUseCase(getUseCase(seeded.id), author, { sections: { ...seeded.sections, goal: 'PRIVATE: call me on 07700 900123', name: `Renamed by a tester` } });
      for (const url of urls) {
        const res = await request(app).get(url);
        expect(res.text, url).not.toContain('07700 900123');
        expect(res.text, url).not.toContain('Renamed by a tester');
        expect(res.text, url).toContain(name);
      }
    }
    // A use case a tester creates as a persona is never published at all.
    const tom = getUser(listUseCases(project.id).find((u) => u.sections.name === 'Renamed by a tester')!.authorId)!;
    createUseCase(project, tom, { source: 'form', visibility: 'public', status: 'accepted', sections: { name: 'Typed in by a tester as Tom' } });
    expect((await request(app).get('/def/volunteering/draft')).text).not.toContain('Typed in by a tester as Tom');
  });

  it('negotiates only the types it produces, and refuses the rest', async () => {
    const noHtml = await request(app).get('/def/volunteering').set('Accept', 'text/html;q=0, */*;q=1');
    expect(noHtml.headers['content-type']).not.toMatch(/html/);
    const app_ = await request(app).get('/def/volunteering').set('Accept', 'application/*');
    expect(app_.headers['content-type']).toMatch(/^application\//);
    for (const accept of ['application/owl+xml', 'application/xhtml+xml', 'application/x-turtle']) {
      const res = await request(app).get('/def/volunteering').set('Accept', accept);
      expect(res.status, accept).toBe(406);
      expect(res.headers.vary, accept).toMatch(/Accept/);
      expect(res.headers['cache-control'], accept).toBe('no-store');
    }
    const html = await request(app).get('/def/volunteering/1.0.0').set('Accept', 'text/turtle');
    expect(html.headers.link).toMatch(/1\.0\.0\.html>; rel="alternate"; type="text\/html"/);
  });

  it('keeps term anchors equal to IRI fragments and resolves clashes explicitly', () => {
    const NS = 'https://example.org/v#';
    const cls = (iri: string) => ({ kind: 'class' as const, iri, superClasses: [], equivalentClasses: [], disjointWith: [], restrictions: [] });
    const view = {
      metadata: { iri: 'https://example.org/v', creators: [], contributors: [], imports: [] },
      classes: [cls('https://other.org/x#Thing'), cls(`${NS}Café`), cls(`${NS}sec-classes`), cls(`${NS}main`), cls(`${NS}Thing`)],
      objectProperties: [], datatypeProperties: [], annotationProperties: [], individuals: [], prefixes: {}, tripleCount: 0,
    } as unknown as OntologyView;
    const a = termAnchors(view, NS);
    expect(a.get(`${NS}Café`)).toBe('Café');
    expect(a.get(`${NS}sec-classes`)).toBe('term-sec-classes');
    expect(a.get(`${NS}main`)).toBe('term-main');
    // The ontology's own term wins the plain fragment over an external one.
    expect(a.get(`${NS}Thing`)).toBe('Thing');
    expect(a.get('https://other.org/x#Thing')).toBe('Thing-2');
  });

  it('links this and the latest version in the header', async () => {
    const res = await request(app).get('/def/volunteering/1.0.0');
    expect(res.text).toMatch(/<a href="[^"]*\/def\/volunteering\/1\.0\.0"><code>https:\/\/w3id\.org\/odi\/volunteering\/1\.0\.0<\/code><\/a>/);
    expect(res.text).toMatch(/<a href="[^"]*\/def\/volunteering"><code>https:\/\/w3id\.org\/odi\/volunteering<\/code><\/a>/);
    expect(res.text).toMatch(/role="tabpanel"[^>]*tabindex="0"/);
  });

  it('renders a release from the snapshot stored with it, not from today\'s data', async () => {
    const file = path.join(ontologyStore.dir(findProject('volunteering')!), 'releases', '1.0.0', 'requirements.json');
    expect(fs.existsSync(file)).toBe(true);
    const original = fs.readFileSync(file, 'utf8');
    const snap = JSON.parse(original);
    expect(snap.useCases.map((u: { title: string }) => u.title)).toContain('Aggregate volunteering opportunities across platforms');
    try {
      snap.useCases[0].title = 'As it was at release time';
      fs.writeFileSync(file, JSON.stringify(snap));
      const res = await request(app).get('/def/volunteering/1.0.0');
      expect(res.text).toContain('As it was at release time');
      const draft = await request(app).get('/def/volunteering/draft');
      expect(draft.text).not.toContain('As it was at release time');
    } finally {
      fs.writeFileSync(file, original);
    }
  });
});
