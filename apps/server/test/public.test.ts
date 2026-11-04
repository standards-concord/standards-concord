import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { PAGE_GENERATOR, renderOntologyPage } from '../src/public/render.js';
import { pageInput, refreshReleasePages } from '../src/public/routes.js';
import { toPublishedRequirements } from '../src/public/requirements.js';
import { fragment, termAnchors } from '../src/public/anchors.js';
import { createProject, findProject } from '../src/services/ontologies.js';
import { ontologyStore } from '../src/services/ontologyStore.js';
import { config } from '../src/config.js';
import { OntologyGraph } from '@concord/core';
import { seedDemo } from '../src/services/simulation.js';
import { createUseCase, listUseCases, synthesise, updateUseCase } from '../src/services/useCases.js';
import { redactOps, redactText, secretsFor } from '../src/services/redact.js';
import { getCR, merge, revise } from '../src/services/changeRequests.js';
import { put } from '../src/db.js';
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
    createUseCase(project, tester, { source: 'chat', status: 'ready', sections: { name: 'My confidential charity workflow' } });
    const res = await request(app).get('/def/volunteering');
    expect(res.text).not.toContain('My confidential charity workflow');
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
        unpublished: { group: 2, private: 1 },
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
    expect(html).toContain('2 working group use cases and 1 private use case also informed this version');
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
    const seeded = listUseCases(project.id).find((u) => u.sections.name === 'Find weekly shifts that need volunteers')!;
    const author = getUser(seeded.authorId)!;
    expect(author.simulated).toBe(true);
    updateUseCase(seeded, author, { sections: { ...seeded.sections, goal: 'PRIVATE: call me on 07700 900123', name: 'Renamed by a tester' } });
    for (const url of ['/def/volunteering', '/def/volunteering/draft', '/def/volunteering/1.0.0']) {
      const res = await request(app).get(url);
      expect(res.text, url).not.toContain('07700 900123');
      expect(res.text, url).not.toContain('Renamed by a tester');
      expect(res.text, url).toContain('Find weekly shifts that need volunteers');
    }
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

  it('keeps every own term anchor equal to its full IRI fragment, and moves page ids out of the way', async () => {
    const NS = 'https://example.org/v#';
    const cls = (iri: string, label?: string) => ({ kind: 'class' as const, iri, label, superClasses: [], equivalentClasses: [], disjointWith: [], restrictions: [], annotations: [] });
    const view = {
      metadata: { iri: 'https://example.org/v', creators: [], contributors: [], imports: [], keywords: [], extra: [] },
      classes: [
        cls('https://other.org/x#Thing'),
        cls('https://other.org/x#main'),
        cls(`${NS}Café`),
        cls(`${NS}sec-classes`),
        cls(`${NS}main`),
        cls(`${NS}term-main`),
        cls(`${NS}part:Child`),
        cls(`${NS}part/Child`),
        cls(`${NS}Child`),
        cls(`${NS}%41`),
        cls(`${NS}A`),
        cls(`${NS}Thing`),
        cls(`${NS}Caf%C3%A9`),
      ],
      objectProperties: [], datatypeProperties: [], annotationProperties: [], individuals: [], prefixes: {}, tripleCount: 0,
    } as unknown as OntologyView;
    const a = termAnchors(view, NS);
    // Own terms: exactly the fragment, whatever it looks like.
    for (const f of ['sec-classes', 'main', 'term-main', 'part:Child', 'part/Child', 'Child', '%41', 'A', 'Thing']) expect(a.get(`${NS}${f}`), f).toBe(f);
    // External terms: their local name, kept clear of own fragments and page ids.
    expect(a.get('https://other.org/x#Thing')).toBe('Thing-2');
    expect(a.get('https://other.org/x#main')).toBe('term-main-2');
    expect(new Set(a.values()).size).toBe(a.size);
    // #Café and a literal #Caf%C3%A9 are the same once encoded. Browsers rewrite #Café
    // as #Caf%C3%A9, so Café keeps that href and the literal one is numbered.
    expect(a.get(`${NS}Café`)).toBe('Café');
    expect(a.get(`${NS}Caf%C3%A9`)).toBe('Caf%C3%A9-2');
    expect(new Set([...a.values()].map(fragment)).size, 'hrefs are distinct').toBe(a.size);

    // The page's own ids step aside: #main and #sec-classes are the terms.
    const input = await pageInput(findProject('volunteering')!, '1.0.0', 'https://example.org');
    input.project = { ...input.project, namespace: NS };
    input.view = view;
    const html = renderOntologyPage(input);
    const ids = [...html.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]);
    expect(new Set(ids).size, 'ids are unique').toBe(ids.length);
    expect(html).toMatch(/<article class="term" id="main" /);
    expect(html).toMatch(/<article class="term" id="sec-classes" /);
    expect(html).toMatch(/<article class="term" id="part:Child" /);
    expect(html).toMatch(/<article class="term" id="part\/Child" /);
    expect(html).toMatch(/<article class="term" id="%41" /);
    expect(html).toContain('<main id="main-page" class="wrap">');
    expect(html).toContain('<a class="skip" href="#main-page">');
    expect(html).toContain('<section id="sec-classes-page" class="block">');
    // Hrefs keep % as written (the browser tries the raw fragment first) and encode what a URL can't hold.
    expect(html).toContain('href="#%41"');
    expect(html).toContain('href="#Caf%C3%A9-2"');
    expect(html).toContain('href="#Caf%C3%A9"');
  });

  it('redirects slash-namespace term IRIs to the same anchor the page uses', async () => {
    const { fragment } = await import('../src/public/anchors.js');
    expect(fragment('Café')).toBe('Caf%C3%A9');
    expect(fragment('%41')).toBe('%41');
    expect(fragment('part:Child')).toBe('part:Child');
    expect(fragment('a b"<')).toBe('a%20b%22%3C');
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

describe('re-review fixes', () => {
  it('synthesis never copies a use case title or its author into the ontology', async () => {
    const project = findProject('volunteering')!;
    const tester = await createUser({ name: 'Morgan Secretname', provider: 'github', subject: 'synth-privacy' });
    const uc = createUseCase(project, tester, {
      source: 'chat',
      status: 'ready',
      sections: { name: 'CONFIDENTIAL_PERSON_NAME_AND_CASE' },
      terms: [{ label: 'Respite Break', kind: 'class' }],
    });
    const cr = await synthesise(project, tester, [uc.id]);
    const ops = JSON.stringify(cr.ops);
    expect(cr.ops.length).toBeGreaterThan(0);
    expect(ops).not.toContain('CONFIDENTIAL_PERSON_NAME_AND_CASE');
    expect(ops).not.toContain('Morgan Secretname');
    // Provenance is a sign-in-only link to the use case.
    expect(ops).toContain(`/o/volunteering/use-cases/${uc.id}`);
    // The working group still sees which use case it came from.
    expect(cr.description).toContain('CONFIDENTIAL_PERSON_NAME_AND_CASE');

    // Merging doesn't add the requester as dcterms:contributor either.
    put('changeRequests', { ...cr, status: 'approved' }, cr.ontologyId);
    const merged = await merge(getCR(cr.id), undefined);
    expect(merged.status).toBe('merged');
    const ttl = (await request(app).get('/def/volunteering/draft.ttl')).text;
    expect(ttl).toMatch(/RespiteBreak/);
    expect(ttl).not.toContain('Morgan Secretname');
    expect(ttl).not.toContain('CONFIDENTIAL_PERSON_NAME_AND_CASE');
  });

  it('redacts titles and names however they are spaced, however short, and in labels too', async () => {
    const project = findProject('volunteering')!;
    const ann = await createUser({ name: 'Ann', provider: 'github', subject: 'short-name' });
    const morgan = await createUser({ name: 'Morgan  Secretname', provider: 'github', subject: 'spaced-name' });
    const base = listUseCases(project.id)[0];
    const secrets = secretsFor([
      { ...base, authorId: ann.id, sections: { name: 'NHS' } },
      { ...base, authorId: morgan.id, sections: { name: 'Secret  Pilot' } },
    ]);
    expect(redactText('NHS for Ann.', secrets)).toBe('a use case for a participant.');
    expect(redactText('From the secret\npilot, asked by Morgan Secretname', secrets)).toBe('From the a use case, asked by a participant');
    // Whole words only: "Annual" and "channels" are left alone.
    expect(redactText('Annual reports on NHS-run channels', secrets)).toBe('Annual reports on a use case-run channels');
    const { ops, dropped } = redactOps(
      [
        { op: 'addClass', localName: 'SecretPilot', label: 'secret pilot', definition: 'x' },
        { op: 'addClass', localName: 'AnnRecord', label: 'ann record', definition: 'x' },
        { op: 'addClass', localName: 'Respite', label: 'respite', definition: 'Wanted by Ann for Secret Pilot.', altLabels: ['break', 'Secret Pilot'], editorialNote: 'From NHS' },
      ],
      secrets,
    );
    expect(dropped).toEqual(['SecretPilot', 'AnnRecord']);
    // Single-word titles, and titles inside longer names, are caught in labels and local names too.
    const inside = redactOps(
      [
        { op: 'addClass', localName: 'NHS', label: 'nhs', definition: 'x' },
        { op: 'addClass', localName: 'SecretPilotRecord', label: 'secret pilot record', definition: 'x' },
        { op: 'addClass', localName: 'Record', label: 'secret pilot record', definition: 'x' },
        { op: 'renameTerm', iri: 'https://w3id.org/odi/volunteering#NHS', newLocalName: 'HealthService' },
      ],
      secrets,
    );
    expect(inside.dropped).toEqual(['NHS', 'SecretPilotRecord', 'Record']);
    // Removing a revealing name is still allowed.
    expect(inside.ops).toEqual([{ op: 'renameTerm', iri: 'https://w3id.org/odi/volunteering#NHS', newLocalName: 'HealthService' }]);
    // One-letter titles are redacted as written, not every letter of that kind.
    const x = secretsFor([{ ...base, authorId: ann.id, sections: { name: 'X' } }]);
    expect(redactText('Project X, x-axis, X.', x)).toBe('Project a use case, x-axis, a use case.');
    expect(ops).toEqual([{ op: 'addClass', localName: 'Respite', label: 'respite', definition: 'Wanted by a participant for a use case.', altLabels: ['break'], editorialNote: 'From a use case' }]);
  });

  it('keeps titles out of AI revisions of a synthesised change request', async () => {
    const project = findProject('volunteering')!;
    const tester = await createUser({ name: 'Rev Iser', provider: 'github', subject: 'revise-leak' });
    const uc = createUseCase(project, tester, { source: 'chat', status: 'ready', sections: { name: 'Secret Pilot Scheme' }, terms: [{ label: 'Respite Break', kind: 'class' }] });
    const cr = await synthesise(project, tester, [uc.id]);
    const revised = await revise(cr, tester, 'Add a class ReviewLeak for Secret Pilot Scheme');
    expect(JSON.stringify(revised.ops)).not.toMatch(/Secret Pilot Scheme/i);
  });

  it('names an ontology\'s owner as its creator only when they ask', async () => {
    const owner = await createUser({ name: 'Quinn Private', provider: 'github', subject: 'no-credit' });
    // Off unless asked for, in the service and the API alike.
    const hidden = await createProject({ title: 'Uncredited vocab', description: '', prefix: 'uv' }, owner);
    expect((await request(app).get(`/def/${hidden.slug}`)).text).not.toContain('Quinn Private');
    const credited = await createProject({ title: 'Credited vocab', description: '', prefix: 'cv', creditCreator: true }, owner);
    expect((await request(app).get(`/def/${credited.slug}`)).text).toContain('Quinn Private');
  });

  it('says so when a release has no use case snapshot, instead of showing current data', async () => {
    const file = path.join(ontologyStore.dir(findProject('volunteering')!), 'releases', '1.0.0', 'requirements.json');
    const original = fs.readFileSync(file, 'utf8');
    try {
      for (const broken of [undefined, '{not json', '{"useCases": "nope"}']) {
        if (broken === undefined) fs.rmSync(file);
        else fs.writeFileSync(file, broken);
        const res = await request(app).get('/def/volunteering/1.0.0');
        expect(res.text).toContain('were not recorded when it was published');
        expect(res.text).not.toContain('Aggregate volunteering opportunities across platforms');
      }
    } finally {
      fs.writeFileSync(file, original);
    }
  });

  it('regenerates release pages from trusted state, keeps unreadable snapshots, and backfills missing ones', async () => {
    const project = findProject('volunteering')!;
    const dir = path.join(ontologyStore.dir(project), 'releases', '1.0.0');
    const page = path.join(dir, 'index.html');
    const snap = path.join(dir, 'requirements.json');
    const stateFile = path.join(config.dataDir, 'public-pages.json');
    const original = { page: fs.readFileSync(page, 'utf8'), snap: fs.readFileSync(snap, 'utf8') };
    const forget = () => fs.rmSync(stateFile, { force: true });
    try {
      // A page from before the fixes that even carries the marker text: state, not content, decides.
      forget();
      fs.writeFileSync(page, `<html><p>${PAGE_GENERATOR}</p><img src=x onerror=alert(1)></html>`);
      fs.rmSync(snap);
      await refreshReleasePages();
      expect(fs.readFileSync(page, 'utf8')).not.toContain('onerror');
      expect(fs.readFileSync(page, 'utf8')).toContain(`content="${PAGE_GENERATOR}"`);
      // The demo's use cases are fixed content, so its missing snapshot is backfilled.
      expect(JSON.parse(fs.readFileSync(snap, 'utf8')).useCases.map((u: { title: string }) => u.title)).toContain('Aggregate volunteering opportunities across platforms');
      expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).volunteering).toBe(PAGE_GENERATOR);

      // Up to date: nothing is rewritten or committed, whatever the page says.
      fs.writeFileSync(page, 'hand-edited');
      const head = ontologyStore.head(project);
      await refreshReleasePages();
      expect(fs.readFileSync(page, 'utf8')).toBe('hand-edited');
      expect(ontologyStore.head(project)).toBe(head);

      // An unreadable snapshot is kept as it is, and the page says the use cases weren't recorded.
      for (const broken of ['{not json', '{"useCases":[null]}', '{"useCases":[{"id":"x"}]}']) {
        forget();
        fs.writeFileSync(snap, broken);
        await refreshReleasePages();
        expect(fs.readFileSync(snap, 'utf8'), broken).toBe(broken);
        expect(fs.readFileSync(page, 'utf8'), broken).toContain('were not recorded when it was published');
        expect((await request(app).get('/def/volunteering/1.0.0')).text, broken).toContain('were not recorded when it was published');
      }

      // A valid snapshot is history: only the page is re-rendered from it.
      forget();
      fs.writeFileSync(snap, JSON.stringify({ useCases: [{ id: 'demo-aggregation', ref: 'UC-9', title: 'Kept as released', status: 'closed' }] }));
      await refreshReleasePages();
      expect(JSON.parse(fs.readFileSync(snap, 'utf8')).useCases[0].title).toBe('Kept as released');
      expect(fs.readFileSync(page, 'utf8')).toContain('Kept as released');
      expect(ontologyStore.log(project, 1)[0].subject).toMatch(/Regenerate public pages \(1\.0\.0\)/);

      // ...unless it holds a use case that was never public (only the demo's fixed ones are).
      forget();
      fs.writeFileSync(snap, JSON.stringify({ useCases: [{ id: 'uc_real', ref: 'UC-9', title: 'PRIVATE_SNAPSHOT_TITLE', status: 'closed' }] }));
      await refreshReleasePages();
      expect(fs.readFileSync(snap, 'utf8')).not.toContain('PRIVATE_SNAPSHOT_TITLE');
      expect(fs.readFileSync(page, 'utf8')).not.toContain('PRIVATE_SNAPSHOT_TITLE');
      expect(fs.readFileSync(snap, 'utf8')).toContain('Aggregate volunteering opportunities across platforms');
    } finally {
      fs.writeFileSync(page, original.page);
      fs.writeFileSync(snap, original.snap);
      forget();
      await refreshReleasePages();
    }
  });

  it('removes contributor names and use case titles that older versions wrote into the RDF', async () => {
    const project = findProject('volunteering')!;
    // Merges wrote users' names; a credit an editor added for someone else stays.
    await createUser({ name: 'Leaky Name', provider: 'github', subject: 'leaky-name' });
    fs.rmSync(path.join(config.dataDir, 'public-pages.json'), { force: true });
    const dir = path.join(ontologyStore.dir(project), 'releases', '1.0.0');
    const leak = (ttl: string) =>
      `${ttl}\n<https://w3id.org/odi/volunteering#Volunteer> <http://purl.org/dc/terms/contributor> "Leaky Name", "Explicitly credited editor" ; <http://purl.org/dc/terms/source> "use cases: Leaky Title" ; <http://www.w3.org/2004/02/skos/core#editorialNote> "Needed by the use case “Leaky Title”" .\n`;
    // In the working draft...
    const working = await ontologyStore.working(project);
    const dirty = await OntologyGraph.fromTurtle(leak(await working.toTurtle()));
    await ontologyStore.commitWorking(project, dirty, 'simulate an old merge', { name: 'Test' });
    // ...and in a released version and its other serialisations.
    const releasedTtl = fs.readFileSync(path.join(dir, 'ontology.ttl'), 'utf8');
    const releasedJson = fs.readFileSync(path.join(dir, 'ontology.jsonld'), 'utf8');
    fs.writeFileSync(path.join(dir, 'ontology.ttl'), leak(releasedTtl));
    fs.writeFileSync(path.join(dir, 'ontology.jsonld'), releasedJson.replace('{', '{"leak":"Leaky Name",'));
    ontologyStore.forgetReleases(project);
    await refreshReleasePages();
    for (const url of ['/def/volunteering/draft.ttl', '/def/volunteering/1.0.0.ttl', '/def/volunteering/1.0.0', '/def/volunteering/draft']) {
      const text = (await request(app).get(url)).text;
      expect(text, url).not.toContain('Leaky Name');
      expect(text, url).not.toContain('Leaky Title');
    }
    expect(fs.readFileSync(path.join(dir, 'ontology.jsonld'), 'utf8')).not.toContain('Leaky Name');
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).not.toContain('Leaky');
    // Editorial notes keep their meaning, and hand-written sources stay.
    expect((await request(app).get('/def/volunteering/draft.ttl')).text).toContain('Needed by a use case (see source).');
    expect((await request(app).get('/def/volunteering/draft.ttl')).text).toContain('NCVO definition of formal volunteering');
    expect((await request(app).get('/def/volunteering/draft.ttl')).text).toContain('Explicitly credited editor');
  });
});

describe('third review fixes', () => {
  const NS = 'https://w3id.org/odi/volunteering#';

  it('re-checks a change request queued before redaction existed when it merges', async () => {
    const project = findProject('volunteering')!;
    const tester = await createUser({ name: 'Pending Person', provider: 'github', subject: 'queued-leak' });
    const uc = createUseCase(project, tester, { source: 'chat', status: 'ready', sections: { name: 'PENDING_SECRET_TITLE' } });
    const cr = await synthesise(project, tester, [uc.id]);
    // As older versions stored it: the title in the source, the definition and a label.
    const ops = [
      { op: 'addClass', localName: 'QueuedThing', label: 'queued thing', definition: 'Needed for PENDING_SECRET_TITLE by Pending Person.', source: ['use cases: PENDING_SECRET_TITLE'] },
      { op: 'addClass', localName: 'PendingSecretTitleRecord', label: 'PENDING_SECRET_TITLE record', definition: 'x' },
    ];
    put('changeRequests', { ...getCR(cr.id), ops, status: 'approved' }, cr.ontologyId);
    const merged = await merge(getCR(cr.id), undefined);
    expect(merged.status).toBe('merged');
    const ttl = (await request(app).get('/def/volunteering/draft.ttl')).text;
    expect(ttl).toContain('QueuedThing');
    expect(ttl).not.toContain('PENDING_SECRET_TITLE');
    expect(ttl).not.toContain('Pending Person');
    expect(ttl).not.toContain('PendingSecretTitleRecord');
    expect(merged.timeline.some((e) => /left out PendingSecretTitleRecord/.test(e.message))).toBe(true);
    // The commit is published with the ontology, so it names no one; signed-in history still does.
    const head = ontologyStore.log(project, 1)[0];
    expect(head.author).toBe('Concord');
    expect(head.subject).not.toContain('PENDING_SECRET_TITLE');
    const agent = request.agent(app);
    await agent.post('/api/auth/demo').send({ name: 'History reader', role: 'contributor' });
    const history = (await agent.get('/api/ontologies/volunteering')).body.history as { author: string; subject: string }[];
    expect(history.find((h) => h.subject.startsWith(`#${cr.number} `))?.author).toBe('Pending Person');
  });

  it('keeps a renamed use case\'s old title out of revisions', async () => {
    const project = findProject('volunteering')!;
    const tester = await createUser({ name: 'Re Namer', provider: 'github', subject: 'rename-leak' });
    const uc = createUseCase(project, tester, { source: 'chat', status: 'ready', sections: { name: 'Original Confidential' }, terms: [{ label: 'Respite Break', kind: 'class' }] });
    const cr = await synthesise(project, tester, [uc.id]);
    updateUseCase(listUseCases(project.id).find((u) => u.id === uc.id)!, tester, { sections: { name: 'Renamed Case' } });
    const revised = await revise(getCR(cr.id), tester, 'Add a class Pilot Note for the Original Confidential study.');
    expect(JSON.stringify(revised.ops)).toContain('PilotNote');
    expect(JSON.stringify(revised.ops)).not.toMatch(/Original Confidential/i);
  });

  it('cleans what synthesised requests wrote into earlier releases, their notes and the changelog, release by release', async () => {
    const project = findProject('volunteering')!;
    const tester = await createUser({ name: 'Legacy Author', provider: 'github', subject: 'legacy-leak' });
    const uc = createUseCase(project, tester, { source: 'chat', status: 'ready', sections: { name: 'LEGACY_SECRET' } });
    const cr = await synthesise(project, tester, [uc.id]);
    put('changeRequests', { ...getCR(cr.id), status: 'released', ops: [{ op: 'updateAnnotations', iri: `${NS}Volunteer`, set: { comment: 'x' } }] }, cr.ontologyId);
    const dir = ontologyStore.dir(project);
    const rel = path.join(dir, 'releases', '1.0.0');
    const broken = path.join(dir, 'releases', '9.9.9');
    const release = (await import('../src/db.js')).list<{ id: string; version: string; notes: string; changeRequestIds: string[]; ontologyId: string }>('releases', project.id).find((r) => r.version === '1.0.0')!;
    const saved = { ttl: fs.readFileSync(path.join(rel, 'ontology.ttl'), 'utf8'), notes: release.notes, changelog: fs.existsSync(path.join(dir, 'CHANGELOG.md')) ? fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8') : undefined };
    try {
      // Model-written text from that request, in a comment and an example.
      fs.writeFileSync(
        path.join(rel, 'ontology.ttl'),
        `${saved.ttl}\n<${NS}Volunteer> <http://www.w3.org/2000/01/rdf-schema#comment> "Raised in LEGACY_SECRET by Legacy Author." ; <http://www.w3.org/2004/02/skos/core#example> "LEGACY_SECRET example" .\n`,
      );
      fs.writeFileSync(path.join(rel, 'RELEASE_NOTES.md'), '# Notes\n\n- #1 Changes for LEGACY_SECRET\n');
      fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n- Changes for LEGACY_SECRET\n');
      put('releases', { ...release, notes: 'Changes for LEGACY_SECRET', changeRequestIds: [...release.changeRequestIds, cr.id] }, project.id);
      // A release that can't be read doesn't stop the others being cleaned.
      fs.mkdirSync(broken, { recursive: true });
      fs.writeFileSync(path.join(broken, 'ontology.ttl'), 'this is @@ not turtle');
      ontologyStore.forgetReleases(project);
      fs.rmSync(path.join(config.dataDir, 'public-pages.json'), { force: true });
      await refreshReleasePages();
      for (const url of ['/def/volunteering/1.0.0.ttl', '/def/volunteering/1.0.0']) {
        const text = (await request(app).get(url)).text;
        expect(text, url).not.toContain('LEGACY_SECRET');
        expect(text, url).not.toContain('Legacy Author');
      }
      expect(fs.readFileSync(path.join(rel, 'RELEASE_NOTES.md'), 'utf8')).not.toContain('LEGACY_SECRET');
      expect(fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8')).not.toContain('LEGACY_SECRET');
      // Not recorded as done, so the unreadable release is tried again next time.
      expect(JSON.parse(fs.readFileSync(path.join(config.dataDir, 'public-pages.json'), 'utf8'))['cleanup:volunteering']).toBeUndefined();
    } finally {
      fs.rmSync(broken, { recursive: true, force: true });
      fs.writeFileSync(path.join(rel, 'ontology.ttl'), saved.ttl);
      fs.rmSync(path.join(rel, 'RELEASE_NOTES.md'), { force: true });
      if (saved.changelog !== undefined) fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), saved.changelog);
      put('releases', release, project.id);
      ontologyStore.forgetReleases(project);
      fs.rmSync(path.join(config.dataDir, 'public-pages.json'), { force: true });
      await refreshReleasePages();
    }
  });
});
