import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { PAGE_GENERATOR, renderOntologyPage } from '../src/public/render.js';
import { pageInput, refreshReleasePages } from '../src/public/routes.js';
import { holdOf } from '../src/public/holds.js';
import { toPublishedRequirements } from '../src/public/requirements.js';
import { fragment, termAnchors } from '../src/public/anchors.js';
import { createProject, findProject } from '../src/services/ontologies.js';
import { ontologyStore } from '../src/services/ontologyStore.js';
import { config } from '../src/config.js';
import { OntologyGraph } from '@concord/core';
import { seedDemo } from '../src/services/simulation.js';
import { createUseCase, listUseCases, synthesise, updateUseCase } from '../src/services/useCases.js';
import { redactText, revealing, secretsFor } from '../src/services/redact.js';
import { approvePublication, getCR, merge, publicationPreview, revise, updateOps } from '../src/services/changeRequests.js';
import { draftRelease, publishRelease } from '../src/services/releases.js';
import { put } from '../src/db.js';
import { createUser, getUser } from '../src/services/users.js';
import type { OntologyView } from '@concord/core/types';
import type { ChangeRequest, OntologySummary, PublicHoldReview, Release } from '@concord/shared';

const app = createApp();

beforeAll(async () => {
  openDb();
  await seedDemo();
});

/**
 * Store files beside a release, as if it had been published with them (null
 * removes one). The app reads them from the repository's commits, so they
 * are committed, not just written to the checkout.
 */
function storeReleaseFiles(version: string, files: Record<string, string | null>, project = findProject('volunteering')!) {
  const dir = ontologyStore.dir(project);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, 'releases', version, name);
    if (content === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, content);
  }
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.org', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.org' };
  execFileSync('git', ['add', '-A', 'releases'], { cwd: dir, env });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'Test: store release files'], { cwd: dir, env });
}
const stored = (version: string, name: string) => ontologyStore.releaseFile(findProject('volunteering')!, version, name);

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

  it('answers creating an ontology without waiting for its first validation', async () => {
    // public-page.spec's creation test timed out with this POST still pending: it ran the new ontology's
    // validation (the reasoner's first run) before answering, though nothing waits on that.
    const agent = request.agent(app);
    await agent.post('/api/auth/demo').send({ name: 'Quick creator', role: 'owner' });
    const created = await agent.post('/api/ontologies').send({ title: 'Quick vocab', prefix: 'qv' });
    expect(created.status).toBe(201);
    expect(created.body.health).toBeUndefined();
    expect(created.body.stats.classes).toBeGreaterThanOrEqual(0);
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
    for (const accept of ['application/owl+xml', 'application/xhtml+xml', 'application/x-turtle', 'application/javascript', 'text/typescript']) {
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
    expect(html).toContain('<section id="sec-classes-page" class="term-group"');
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
    const original = stored('1.0.0', 'requirements.json');
    expect(original).toBeDefined();
    const snap = JSON.parse(original!);
    expect(snap.useCases.map((u: { title: string }) => u.title)).toContain('Aggregate volunteering opportunities across platforms');
    try {
      snap.useCases[0].title = 'As it was at release time';
      storeReleaseFiles('1.0.0', { 'requirements.json': JSON.stringify(snap) });
      const res = await request(app).get('/def/volunteering/1.0.0');
      expect(res.text).toContain('As it was at release time');
      const draft = await request(app).get('/def/volunteering/draft');
      expect(draft.text).not.toContain('As it was at release time');
    } finally {
      storeReleaseFiles('1.0.0', { 'requirements.json': original! });
    }
  });
});

describe('re-review fixes', () => {
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
    // Single-word titles, and titles inside longer names, are found in labels and local names too.
    for (const name of ['SecretPilot', 'AnnRecord', 'NHS', 'SecretPilotRecord', 'secret pilot record']) expect(revealing(name, secrets), name).toBe(true);
    expect(revealing('HealthService', secrets)).toBe(false);
    // One-letter titles are redacted as written, not every letter of that kind.
    const x = secretsFor([{ ...base, authorId: ann.id, sections: { name: 'X' } }]);
    expect(redactText('Project X, x-axis, X.', x)).toBe('Project a use case, x-axis, a use case.');
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
    const original = stored('1.0.0', 'requirements.json')!;
    try {
      for (const broken of [null, '{not json', '{"useCases": "nope"}']) {
        storeReleaseFiles('1.0.0', { 'requirements.json': broken });
        const res = await request(app).get('/def/volunteering/1.0.0');
        expect(res.text).toContain('were not recorded when it was published');
        expect(res.text).not.toContain('Aggregate volunteering opportunities across platforms');
      }
    } finally {
      storeReleaseFiles('1.0.0', { 'requirements.json': original });
    }
  });

  it('regenerates release pages from trusted state, keeps unreadable snapshots, and backfills missing ones', async () => {
    const project = findProject('volunteering')!;
    const stateFile = path.join(config.dataDir, 'public-pages.json');
    const original = { page: stored('1.0.0', 'index.html')!, snap: stored('1.0.0', 'requirements.json')! };
    const page = () => stored('1.0.0', 'index.html');
    const snap = () => stored('1.0.0', 'requirements.json');
    const forget = () => fs.rmSync(stateFile, { force: true });
    try {
      // A page from before the fixes that even carries the marker text: state, not content, decides.
      forget();
      storeReleaseFiles('1.0.0', { 'index.html': `<html><p>${PAGE_GENERATOR}</p><img src=x onerror=alert(1)></html>`, 'requirements.json': null });
      await refreshReleasePages();
      expect(page()).not.toContain('onerror');
      expect(page()).toContain(`content="${PAGE_GENERATOR}"`);
      // The demo's use cases are fixed content, so its missing snapshot is backfilled.
      expect(JSON.parse(snap()!).useCases.map((u: { title: string }) => u.title)).toContain('Aggregate volunteering opportunities across platforms');
      expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).volunteering).toBe(PAGE_GENERATOR);
      const canonical = snap()!;

      // Up to date: nothing is rewritten or committed, whatever the page says.
      storeReleaseFiles('1.0.0', { 'index.html': 'hand-edited' });
      const head = ontologyStore.head(project);
      await refreshReleasePages();
      expect(page()).toBe('hand-edited');
      expect(ontologyStore.head(project)).toBe(head);

      // An unreadable snapshot is kept as it is, and the page says the use cases weren't recorded.
      for (const broken of ['{not json', '{"useCases":[null]}', '{"useCases":[{"id":"x"}]}']) {
        forget();
        storeReleaseFiles('1.0.0', { 'requirements.json': broken });
        await refreshReleasePages();
        expect(snap(), broken).toBe(broken);
        expect(page(), broken).toContain('were not recorded when it was published');
        expect((await request(app).get('/def/volunteering/1.0.0')).text, broken).toContain('were not recorded when it was published');
      }

      // A snapshot holding exactly what may be published is history: kept, and the page re-rendered from it.
      forget();
      storeReleaseFiles('1.0.0', { 'requirements.json': canonical });
      await refreshReleasePages();
      expect(snap()).toBe(canonical);
      expect(ontologyStore.log(project, 1)[0].subject).toMatch(/Regenerate public pages \(1\.0\.0\)/);
      // Committed, and the checkout follows.
      expect(fs.readFileSync(path.join(ontologyStore.dir(project), 'releases', '1.0.0', 'requirements.json'), 'utf8')).toBe(canonical);
    } finally {
      storeReleaseFiles('1.0.0', { 'index.html': original.page, 'requirements.json': original.snap });
      forget();
      await refreshReleasePages();
    }
  });

});

describe('fourth review fixes', () => {
  const NS = 'https://w3id.org/odi/volunteering#';
  const base = () => listUseCases(findProject('volunteering')!.id)[0];

  it('catches titles in identifiers and alternative labels however they are written', async () => {
    const ann = await createUser({ name: 'Ann', provider: 'github', subject: 'ids-ann' });
    const s = secretsFor([
      { ...base(), authorId: ann.id, sections: { name: 'PENDING_SECRET_TITLE' } },
      { ...base(), authorId: ann.id, sections: { name: 'Secret Pilot' } },
    ]);
    for (const name of ['PendingSecretTitleRecord', 'pending_secret_title', 'SecretPilotRecord', 'secret-pilot', 'AnnRecord', 'create class :SecretPilotRecord']) expect(revealing(name, s), name).toBe(true);
    for (const name of ['Safe', 'fine', 'neutral record']) expect(revealing(name, s), name).toBe(false);
  });

  it('leaves ordinary words alone when a title is short or common, and never redacts twice', async () => {
    const ann = await createUser({ name: 'Ann', provider: 'github', subject: 'common-ann' });
    for (const title of ['a', 'use', 'record', 'use case', 'The plan']) {
      const s = secretsFor([{ ...base(), authorId: ann.id, sections: { name: title } }]);
      expect(redactText('A record is a useful item for the plan.', s), title).toBe('A record is a useful item for the plan.');
      expect(revealing('Record', s), title).toBe(false);
    }
    // A title or name that shares words with the replacements: running again changes nothing.
    const p = await createUser({ name: 'Participant', provider: 'github', subject: 'common-participant' });
    const s = secretsFor([{ ...base(), authorId: p.id, sections: { name: 'Secret Pilot' } }]);
    const once = redactText('Secret Pilot, asked by Participant.', s);
    expect(once).toBe('a use case, asked by a participant.');
    expect(redactText(once, s)).toBe(once);
    expect(redactText(redactText(once, s), s)).toBe(once);
  });

});

describe('fifth review fixes', () => {
  const NS = 'https://w3id.org/odi/volunteering#';
  const base = () => listUseCases(findProject('volunteering')!.id)[0];
  const releaseDir = () => path.join(ontologyStore.dir(findProject('volunteering')!), 'releases', '1.0.0');
  const cleanupDone = () => fs.readFileSync(path.join(config.dataDir, 'public-pages.json'), 'utf8').includes('"cleanup:volunteering": "privacy clean-up 5"');
  const rerun = async () => {
    fs.rmSync(path.join(config.dataDir, 'public-pages.json'), { force: true });
    await refreshReleasePages();
  };

  it('redacts people with short or common names, as written', async () => {
    const an = await createUser({ name: 'An', provider: 'github', subject: 'short-an' });
    const s = secretsFor([{ ...base(), authorId: an.id, sections: { name: 'Secret Pilot' } }]);
    expect(s.people.length).toBe(1);
    expect(redactText('Requested by An for Secret Pilot, an ordinary word.', s)).toBe('Requested by a participant for a use case, an ordinary word.');
  });

  it('catches one-letter titles inside identifiers and alternative labels', async () => {
    const ann = await createUser({ name: 'Ann One', provider: 'github', subject: 'one-letter' });
    const s = secretsFor([{ ...base(), authorId: ann.id, sections: { name: 'X' } }]);
    expect(revealing('XRecord', s)).toBe(true);
    expect(revealing('x_record', s)).toBe(false);
    expect(revealing('Xylophone', s)).toBe(false);
    expect(revealing('TaxRecord', s)).toBe(false);
  });

});

describe('sixth review fixes', () => {
  const NS = 'https://w3id.org/odi/volunteering#';
  const owlClass = 'http://www.w3.org/2002/07/owl#Class';
  const DEF = 'http://www.w3.org/2004/02/skos/core#definition';
  const CONTRIB = 'http://purl.org/dc/terms/contributor';
  const SRC = 'http://purl.org/dc/terms/source';
  const base = () => listUseCases(findProject('volunteering')!.id)[0];
  const rerun = async () => {
    fs.rmSync(path.join(config.dataDir, 'public-pages.json'), { force: true });
    await refreshReleasePages();
  };
  const cleanupDone = () => fs.readFileSync(path.join(config.dataDir, 'public-pages.json'), 'utf8').includes('"cleanup:volunteering": "privacy clean-up 5"');
  const everyFormat = async (version: string) =>
    Promise.all(['', '.ttl', '.nt', '.owl', '.jsonld', '.omn', '.yaml'].map(async (ext) => (await request(app).get(`/def/volunteering/${version}${ext}`)).text)).then((xs) => xs.join('\n'));

  it('catches cased, plural and run-together forms of titles and names, and holds back a merge that has them', async () => {
    const { findSecrets } = await import('../src/services/redact.js');
    const mac = await createUser({ name: 'MacDonald', provider: 'github', subject: 'six-mac' });
    const s = secretsFor([{ ...base(), authorId: mac.id, sections: { name: 'SecretPilot' } }]);
    for (const t of ['SecretPilotsRecord', 'SECRETPILOTRECORD', 'MACDONALDRECORD', 'Requested by MacDonalds for SecretPilots', 'secret-pilots', 'Secret  Pilots', 'macdonaldrecord'])
      expect(findSecrets(t, s).length, t).toBeGreaterThan(0);
    const an = await createUser({ name: 'An', provider: 'github', subject: 'six-an' });
    const x = secretsFor([{ ...base(), authorId: an.id, sections: { name: 'X' } }]);
    for (const t of ['Requested by AN', 'ANRECORD', 'XRECORD', 'XRecord', 'Requested by An']) expect(findSecrets(t, x).length, t).toBeGreaterThan(0);
    for (const t of ['an apple', 'Xylophone', 'TaxRecord', 'A plan for an index']) expect(findSecrets(t, x), t).toEqual([]);
    // Through synthesis and merge: nothing reaches the draft.
    const project = findProject('volunteering')!;
    const uc = createUseCase(project, mac, { source: 'chat', status: 'ready', sections: { name: 'SecretPilot' } });
    const cr = await synthesise(project, mac, [uc.id]);
    put(
      'changeRequests',
      {
        ...getCR(cr.id),
        title: 'Changes',
        status: 'approved',
        ops: [
          { op: 'addClass', localName: 'SECRETPILOTRECORD', label: 'record', definition: 'Requested by MacDonalds for SecretPilots.' },
          { op: 'addClass', localName: 'SixSafe', label: 'six safe', definition: 'Fine.', altLabels: ['MACDONALDRECORD'] },
        ],
      },
      project.id,
    );
    expect((await merge(getCR(cr.id), undefined)).status).toBe('needs-work');
    expect(await everyFormat('draft')).not.toMatch(/SECRETPILOT|MacDonald|MACDONALD|SixSafe/i);
  });

  it('never changes what unrelated text means', async () => {
    const { findSecrets, redactText } = await import('../src/services/redact.js');
    const anna = await createUser({ name: 'Anna', provider: 'github', subject: 'six-anna' });
    const will = await createUser({ name: 'Will', provider: 'github', subject: 'six-will' });
    const s = secretsFor([
      { ...base(), authorId: anna.id, sections: { name: 'Secret Pilot' } },
      { ...base(), authorId: will.id, sections: { name: 'Secret Pilot' } },
    ]);
    for (const t of ['An N/A value is allowed.', 'A record will remain valid.', 'A summary of the savannah.']) {
      expect(findSecrets(t, s), t).toEqual([]);
      expect(redactText(t, s)).toBe(t);
    }
    expect(findSecrets('Requested by Will and Anna.', s)).toEqual(['name']);
  });

});

describe('seventh review: a person approves exactly what is published', () => {
  const draftTtl = async () => (await request(app).get('/def/volunteering/draft.ttl')).text;
  const editor = async (name: string) => {
    const agent = request.agent(app);
    const { body } = await agent.post('/api/auth/demo').send({ name, role: 'editor' });
    return { agent, user: getUser(body.user.id)! };
  };
  const drafted = async (title: string, ops: unknown[]) => {
    const project = findProject('volunteering')!;
    const tester = await createUser({ name: `Tester ${title}`, provider: 'github', subject: `seventh-${title}` });
    const uc = createUseCase(project, tester, { source: 'chat', status: 'ready', sections: { name: `Use case ${title}` } });
    const cr = await synthesise(project, tester, [uc.id]);
    put('changeRequests', { ...getCR(cr.id), title, ops, status: 'approved' }, project.id);
    return { project, tester, cr: getCR(cr.id) };
  };

  it('holds every request drafted from use cases until an editor approves what it publishes, however private-looking or not', async () => {
    // Nothing here looks private: it's held all the same, because spotting names can't be relied on.
    const { cr } = await drafted('Plainly safe', [{ op: 'addClass', localName: 'SeventhPlain', label: 'seventh plain', definition: 'Requested for The Plan by Will.' }]);
    const held = await merge(cr, undefined);
    expect(held.status).toBe('needs-work');
    expect(held.heldForPublication).toBe(true);
    expect(await draftTtl()).not.toContain('SeventhPlain');
    // The editor sees each statement it adds, exactly.
    const preview = await publicationPreview(getCR(cr.id));
    expect(preview.title).toBe('Plainly safe');
    expect(preview.statements).toEqual(
      expect.arrayContaining([expect.objectContaining({ subject: expect.stringMatching(/[#/]SeventhPlain$/), predicate: expect.stringMatching(/^http.*definition$/), object: 'Requested for The Plan by Will.' })]),
    );
    expect(preview.kgcl.join('\n')).toContain('SeventhPlain');
    const { agent } = await editor('Seventh editor');
    const ok = await agent.post(`/api/change-requests/${cr.id}/approve-publication`).send({ fingerprint: preview.fingerprint });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('merged');
    expect(await draftTtl()).toContain('Requested for The Plan by Will.');
    // Nobody's name is added as a contributor, and the commit names no one.
    expect(await draftTtl()).not.toContain('Tester Plainly safe');
    expect(ontologyStore.log(findProject('volunteering')!, 1)[0].author).toBe('Concord');
  });

  it('approves only the version the editor saw: a change in between is refused, and nothing is published', async () => {
    const { cr, tester } = await drafted('Version check', [{ op: 'addClass', localName: 'SeventhSeen', label: 'seventh seen', definition: 'What the editor saw.' }]);
    const seen = await publicationPreview(cr);
    // The author changes it to something private after the editor looked.
    await updateOps(getCR(cr.id), tester, { ops: [{ op: 'addClass', localName: 'SeventhSeen', label: 'seventh seen', definition: 'Private: Visitor Person at the Secret Pilot.' }] });
    const { agent, user } = await editor('Seventh checker');
    const stale = await agent.post(`/api/change-requests/${cr.id}/approve-publication`).send({ fingerprint: seen.fingerprint });
    expect(stale.status).toBe(409);
    expect(getCR(cr.id).privacyCleared).toBeUndefined();
    expect(await draftTtl()).not.toContain('Visitor Person');
    // With no fingerprint at all, nothing is approved either; contributors can't approve.
    expect((await agent.post(`/api/change-requests/${cr.id}/approve-publication`).send({})).status).toBe(400);
    const contributor = request.agent(app);
    await contributor.post('/api/auth/demo').send({ name: 'Seventh contributor', role: 'contributor' });
    expect((await contributor.post(`/api/change-requests/${cr.id}/approve-publication`).send({ fingerprint: (await publicationPreview(getCR(cr.id))).fingerprint })).status).toBe(403);
    // Approving it early, then editing it, needs approval again before it merges.
    await approvePublication(getCR(cr.id), user, (await publicationPreview(getCR(cr.id))).fingerprint);
    expect(getCR(cr.id).privacyCleared).toBeDefined();
    await updateOps(getCR(cr.id), tester, { title: 'Version check, retitled' });
    expect(getCR(cr.id).privacyCleared).toBeUndefined();
    put('changeRequests', { ...getCR(cr.id), status: 'approved' }, cr.ontologyId);
    expect((await merge(getCR(cr.id), undefined)).status).toBe('needs-work');
  });

  it('publishes release notes only from what editors approved, and notes a steward wrote as written', async () => {
    const { project, cr } = await drafted('Notes check', [{ op: 'addClass', localName: 'SeventhNoted', label: 'seventh noted', definition: 'For the notes.' }]);
    const { user } = await editor('Seventh notes editor');
    await merge(cr, undefined);
    const approved = await approvePublication(getCR(cr.id), user, (await publicationPreview(getCR(cr.id))).fingerprint);
    expect(approved.status).toBe('merged');
    // A request merged before approvals existed: no clearance, so neither its title nor its edits reach the notes.
    const legacy = await drafted('LEGACY_UNAPPROVED_TITLE', []);
    put('changeRequests', { ...legacy.cr, status: 'merged', kgcl: ['create class :LegacyUnapproved'] }, project.id);
    const steward = await createUser({ name: 'Seventh steward', provider: 'github', subject: 'seventh-steward' });
    (await import('../src/services/ontologies.js')).setRoles(project.id, steward.id, ['steward']);
    const release = await draftRelease(project, steward);
    expect(release.notes).toContain('Notes check');
    expect(release.notes).not.toContain('LEGACY_UNAPPROVED_TITLE');
    expect(release.notes).not.toContain('LegacyUnapproved');
    // Stale text put into a drafted note is rebuilt when it's published.
    put('releases', { ...release, notes: `${release.notes}\nLEGACY_UNAPPROVED_TITLE`, status: 'draft' }, project.id);
    const published = await publishRelease((await import('../src/db.js')).get('releases', release.id)!, steward);
    expect(published.notes).not.toContain('LEGACY_UNAPPROVED_TITLE');
    expect((await request(app).get(`/def/volunteering/${published.version}`)).text).not.toContain('LEGACY_UNAPPROVED_TITLE');
  });

  it('rewrites nothing an AI drafts: revisions are held for approval like any draft from use cases', async () => {
    const { cr, tester } = await drafted('Revision check', [{ op: 'addClass', localName: 'SeventhRevised', label: 'seventh revised', definition: 'x' }]);
    const revised = await revise(getCR(cr.id), tester, 'Add a class SeventhExtra for the Secret Pilot');
    expect(revised.privacyCleared).toBeUndefined();
    put('changeRequests', { ...getCR(cr.id), status: 'approved' }, cr.ontologyId);
    expect((await merge(getCR(cr.id), undefined)).status).toBe('needs-work');
    expect(await draftTtl()).not.toContain('SeventhRevised');
  });

  it('shows every statement in full, IRIs and all, exactly as it will be published (eighth review)', async () => {
    const hidden = 'https://internal.example/SecretPilot/VisitorPerson/record';
    const { cr } = await drafted('Full terms', [{ op: 'addClass', localName: 'EighthSourced', label: 'eighth sourced', definition: 'Plain.', source: [hidden] }]);
    const preview = await publicationPreview(cr);
    const st = preview.statements.find((x) => x.nt.includes(hidden))!;
    expect(st).toBeDefined();
    expect(st.object).toBe(hidden);
    expect(st.subject).toMatch(/^https?:\/\/.*EighthSourced$/);
    expect(st.predicate).toMatch(/^http/);
    // Every statement carries its exact N-Triples form; what's approved is what's published.
    for (const x of preview.statements) expect(x.nt).toMatch(/ \.$/);
    const { user } = await editor('Eighth full editor');
    await approvePublication(getCR(cr.id), user, preview.fingerprint);
    put('changeRequests', { ...getCR(cr.id), status: 'approved' }, cr.ontologyId);
    expect((await merge(getCR(cr.id), undefined)).status).toBe('merged');
    expect(await draftTtl()).toContain(hidden);
  });

  it('changes the fingerprint when a written date, the edits or the draft underneath change, but not from one day to the next (eighth review)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const { cr, project } = await drafted('Dated', [{ op: 'addClass', localName: 'EighthDated', label: 'eighth dated', definition: 'Written on DATE.' }]);
    const first = (await publicationPreview(cr)).fingerprint;
    // A date someone wrote is part of what's approved.
    put('changeRequests', { ...getCR(cr.id), ops: [{ op: 'addClass', localName: 'EighthDated', label: 'eighth dated', definition: `Written on ${today}.` }] }, project.id);
    const dated = (await publicationPreview(getCR(cr.id))).fingerprint;
    expect(dated).not.toBe(first);
    // The draft it merges into changing (an unrelated statement) needs a new approval.
    const working = await ontologyStore.working(project);
    await ontologyStore.commitWorking(project, await OntologyGraph.fromTurtle(`${await working.toTurtle()}\n<https://w3id.org/odi/volunteering#EighthUnrelated> a <http://www.w3.org/2002/07/owl#Class> .\n`), 'Unrelated', { name: 'Concord' });
    const rebased = (await publicationPreview(getCR(cr.id))).fingerprint;
    expect(rebased).not.toBe(dated);
    const { user } = await editor('Eighth date editor');
    await expect(approvePublication(getCR(cr.id), user, dated)).rejects.toMatchObject({ status: 409 });
    // Tomorrow, the same request on the same draft is the same approval: only generated dates moved.
    const { clock } = await import('../src/clock.js');
    clock.advance(24 * 60 * 60 * 1000);
    try {
      expect((await publicationPreview(getCR(cr.id))).fingerprint).toBe(rebased);
    } finally {
      clock.advance(-24 * 60 * 60 * 1000);
    }
  });

  it('sends a revision the request as written, with nothing rewritten (eighth review)', async () => {
    const { llm } = await import('../src/llm/provider.js');
    const { vi } = await import('vitest');
    const seen: string[] = [];
    const real = llm.json.bind(llm);
    const spy = vi.spyOn(llm, 'json').mockImplementation(async (call) => {
      if (call.task === 'revise') seen.push(call.messages.map((m) => String(m.content)).join('\n'));
      return real(call);
    });
    try {
      const { cr, tester } = await drafted('SecretPilotEight', [{ op: 'addClass', localName: 'EighthRevised', label: 'eighth revised', definition: 'x' }]);
      // Its title names the use case it came from: the model is sent it as it is.
      put('changeRequests', { ...getCR(cr.id), title: 'For Use case SecretPilotEight' }, cr.ontologyId);
      await revise(getCR(cr.id), tester, 'Tidy it');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain('For Use case SecretPilotEight');
    } finally {
      spy.mockRestore();
    }
  });

  it('highlights what looks private for the editor, without deciding anything', async () => {
    const mac = await createUser({ name: 'MacDonald Seven', provider: 'github', subject: 'seventh-mac' });
    const project = findProject('volunteering')!;
    const uc = createUseCase(project, mac, { source: 'chat', status: 'ready', sections: { name: 'SecretPilotSeven' } });
    const cr = await synthesise(project, mac, [uc.id]);
    put('changeRequests', { ...getCR(cr.id), title: 'For SecretPilotSeven', ops: [{ op: 'addClass', localName: 'SECRETPILOTSEVENRECORD', label: 'record', definition: 'Asked for by MacDonald Seven.' }] }, project.id);
    const preview = await publicationPreview(getCR(cr.id));
    expect(preview.hints).toEqual(expect.arrayContaining([{ where: 'the title', kind: 'use case title' }]));
    expect(preview.statements.filter((st) => st.hint).map((st) => st.hint)).toEqual(expect.arrayContaining(['use case title', 'name']));
    // Only signed-in users see what a request would publish.
    expect((await request(app).get(`/api/change-requests/${cr.id}/publication`)).status).toBe(401);
  });
});

describe('versions published before approval existed', () => {
  const NS = 'https://w3id.org/odi/volunteering#';
  const steward = async (name: string) => {
    const agent = request.agent(app);
    const { body } = await agent.post('/api/auth/demo').send({ name, role: 'steward' });
    return { agent, id: body.user.id as string };
  };
  const legacy = async () => {
    const project = findProject('volunteering')!;
    // As an older version left it: published without approvals, with model-written text naming a person.
    const working = await ontologyStore.working(project);
    const dirty = await OntologyGraph.fromTurtle(`${await working.toTurtle()}\n<${NS}LegacyRecord> a <http://www.w3.org/2002/07/owl#Class> ; <http://www.w3.org/2004/02/skos/core#definition> "Raised by Legacy Hold Person in the LEGACY_HOLD_PILOT." .\n`);
    await ontologyStore.commitWorking(project, dirty, 'Older merge', { name: 'Concord' });
    const tester = await createUser({ name: 'Legacy Hold Person', provider: 'github', subject: 'legacy-hold' });
    createUseCase(project, tester, { source: 'chat', status: 'ready', sections: { name: 'LEGACY_HOLD_PILOT' } });
    const { updateProject } = await import('../src/services/ontologies.js');
    updateProject({ ...project, publishedWithApproval: undefined });
    const { remove } = await import('../src/db.js');
    remove('kv', `public-hold:${project.id}`);
    fs.rmSync(path.join(config.dataDir, 'public-pages.json'), { force: true });
    await refreshReleasePages();
    return project;
  };

  /** A merged change waiting to be released, so a release can be drafted. */
  const drafted8 = async (project: { id: string }) => {
    const n = Math.random().toString(36).slice(2, 8);
    const author = await createUser({ name: `Eighth author ${n}`, provider: 'github', subject: `eighth-${n}` });
    const cr = {
      id: `cr_eighth_${n}`,
      number: 9000 + Math.floor(Math.random() * 999),
      ontologyId: project.id,
      title: 'Eighth plain change',
      description: '',
      kind: 'change',
      origin: { type: 'direct' },
      authorId: author.id,
      ops: [],
      status: 'merged',
      classification: { level: 'patch' },
      timeline: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      statusSince: new Date().toISOString(),
    } as unknown as ChangeRequest;
    put('changeRequests', cr, project.id);
    return cr;
  };

  it('holds every version an ontology had, page and downloads alike, until a steward approves exactly what it publishes', async () => {
    const project = await legacy();
    expect(holdOf(project)?.versions).toEqual(['draft', ...ontologyStore.versions(project)]);
    for (const url of ['/def/volunteering', '/def/volunteering/draft', '/def/volunteering/draft.ttl', '/def/volunteering/1.0.0.jsonld', '/def/volunteering/draft.js', '/def/volunteering/1.0.0.tgz']) {
      const res = await request(app).get(url);
      expect(res.status, url).toBe(503);
      expect(res.text, url).not.toContain('Legacy Hold Person');
      expect(res.text, url).toMatch(/being reviewed/);
    }
    // Anonymous callers, contributors and editors can't see or approve what's held.
    expect((await request(app).get(`/api/ontologies/${project.id}/public-holds`)).status).toBe(401);
    const editor = request.agent(app);
    await editor.post('/api/auth/demo').send({ name: 'Hold editor', role: 'editor' });
    expect((await editor.get(`/api/ontologies/${project.id}/public-holds`)).status).toBe(403);
    // A steward sees each held version, with what looks private highlighted, and its whole Turtle.
    const { agent } = await steward('Hold steward');
    const holds = (await agent.get(`/api/ontologies/${project.id}/public-holds`)).body as PublicHoldReview[];
    const draft = holds.find((h) => h.version === 'draft')!;
    expect(draft.hints).toEqual(expect.arrayContaining([expect.objectContaining({ subject: `${NS}LegacyRecord`, kind: 'name' })]));
    expect(draft.turtle).toContain('Legacy Hold Person');
    // Nothing is edited automatically: it's all still there for the steward to judge.
    expect(ontologyStore.readWorkingText(project)).toContain('Legacy Hold Person');
    // A release is approved as it is.
    const release = holds.find((h) => h.version === '1.0.0')!;
    expect((await agent.post(`/api/ontologies/${project.id}/public-holds/1.0.0/approve`).send({ fingerprint: release.fingerprint })).status).toBe(200);
    expect((await request(app).get('/def/volunteering/1.0.0')).status).toBe(200);
    expect((await request(app).get('/def/volunteering/draft')).status).toBe(503);
  });

  it('approves only what the steward reviewed: the draft changing in between needs a new review', async () => {
    const project = await legacy();
    const { agent } = await steward('Hold checker');
    const seen = ((await agent.get(`/api/ontologies/${project.id}/public-holds`)).body as { version: string; fingerprint: string }[]).find((h) => h.version === 'draft')!;
    // The steward fixes the draft with an ordinary change: what they reviewed is no longer what would be published.
    const working = await ontologyStore.working(project);
    const fixed = await OntologyGraph.fromTurtle((await working.toTurtle()).replace(/"Raised by Legacy Hold Person in the LEGACY_HOLD_PILOT\."/, '"A record from an older pilot."'));
    await ontologyStore.commitWorking(project, fixed, 'Fix the legacy definition', { name: 'Concord' });
    expect((await agent.post(`/api/ontologies/${project.id}/public-holds/draft/approve`).send({ fingerprint: seen.fingerprint })).status).toBe(409);
    expect((await request(app).get('/def/volunteering/draft')).status).toBe(503);
    const now = ((await agent.get(`/api/ontologies/${project.id}/public-holds`)).body as { version: string; fingerprint: string }[]).find((h) => h.version === 'draft')!;
    expect((await agent.post(`/api/ontologies/${project.id}/public-holds/draft/approve`).send({ fingerprint: now.fingerprint })).status).toBe(200);
    const page = await request(app).get('/def/volunteering/draft.ttl');
    expect(page.status).toBe(200);
    expect(page.text).toContain('A record from an older pilot.');
    expect(page.text).not.toContain('Legacy Hold Person');
  });

  it('holds once, survives a restart part way, and leaves ontologies made under the approval rules alone', async () => {
    const project = await legacy();
    const versions = holdOf(project)!.versions;
    // Startup again: nothing changes, and a hold that was written before the ontology was marked is the same hold.
    await refreshReleasePages();
    expect(holdOf(project)!.versions).toEqual(versions);
    const { updateProject } = await import('../src/services/ontologies.js');
    updateProject({ ...findProject('volunteering')!, publishedWithApproval: undefined });
    await refreshReleasePages();
    expect(holdOf(project)!.versions).toEqual(versions);
    // A new ontology is never held.
    const owner = await createUser({ name: 'New Owner', provider: 'github', subject: 'hold-new' });
    const fresh = await createProject({ title: 'Fresh vocab', description: '', prefix: 'fv' }, owner);
    await refreshReleasePages();
    expect(holdOf(fresh)).toBeUndefined();
    expect((await request(app).get(`/def/${fresh.slug}`)).status).toBe(200);
  });

  it('holds a release made from a draft that is still held', async () => {
    const project = await legacy();
    const { holdReleaseIfDraftHeld } = await import('../src/public/holds.js');
    holdReleaseIfDraftHeld(project, '9.0.0');
    expect(holdOf(project)!.versions).toContain('9.0.0');
  });

  it('withholds what is held from every anonymous read, not just /def (eighth review)', async () => {
    const project = await legacy();
    const id = project.id;
    const sha = ontologyStore.head(project);
    const anon = [
      request(app).get(`/api/ontologies/${id}/view`),
      request(app).get(`/api/ontologies/${id}/view?ref=1.0.0`),
      request(app).get(`/api/ontologies/${id}/terms/${encodeURIComponent(`${NS}LegacyRecord`)}`),
      request(app).get(`/api/ontologies/${id}/search?q=LegacyRecord`),
      request(app).get(`/api/ontologies/${id}/source`),
      request(app).get(`/api/ontologies/${id}/source?ref=1.0.0`),
      request(app).get(`/api/ontologies/${id}/source?ref=${sha}`),
      request(app).post(`/api/ontologies/${id}/sparql`).send({ query: 'SELECT ?o WHERE { ?s ?p ?o }' }),
      request(app).post(`/api/ontologies/${id}/sparql`).send({ query: 'SELECT ?o WHERE { ?s ?p ?o }', ref: '1.0.0' }),
      request(app).get('/def/volunteering/LegacyRecord'),
    ];
    for (const [i, res] of (await Promise.all(anon)).entries()) {
      expect([404, 503], String(i)).toContain(res.status);
      expect(res.text, String(i)).not.toContain('Legacy Hold Person');
      expect(res.text, String(i)).not.toContain('LegacyRecord"');
    }
    // Signed-in people still read it all.
    const { agent } = await steward('Eighth reader');
    expect((await agent.get(`/api/ontologies/${id}/source`)).text).toContain('Legacy Hold Person');
    for (const h of (await agent.get(`/api/ontologies/${id}/public-holds`)).body as PublicHoldReview[])
      expect((await agent.post(`/api/ontologies/${id}/public-holds/${h.version}/approve`).send({ fingerprint: h.fingerprint })).status).toBe(200);
    expect((await request(app).get(`/api/ontologies/${id}/source`)).text).toContain('Legacy Hold Person');
    // Once approved, the public reads only published versions: nothing else a ref might name.
    for (const ref of [sha, '../..', '../../volunteering']) expect((await request(app).get(`/api/ontologies/${id}/source?ref=${encodeURIComponent(ref)}`)).status, ref).toBe(404);
  });

  it('holds everything of an older ontology whose hold record was never written (eighth review)', async () => {
    const project = await legacy();
    const { updateProject } = await import('../src/services/ontologies.js');
    const { remove } = await import('../src/db.js');
    // As if writing the hold failed at startup: not marked, and no record.
    remove('kv', `public-hold:${project.id}`);
    updateProject({ ...findProject('volunteering')!, publishedWithApproval: undefined });
    expect((await request(app).get('/def/volunteering/draft.ttl')).status).toBe(503);
    expect((await request(app).get('/def/volunteering/1.0.0')).status).toBe(503);
    expect((await request(app).get(`/api/ontologies/${project.id}/source`)).status).toBe(503);
    // A steward can still review and approve each version, which writes the record.
    const { agent } = await steward('Eighth fail-closed steward');
    const holds = (await agent.get(`/api/ontologies/${project.id}/public-holds`)).body as PublicHoldReview[];
    expect(holds.map((h) => h.version)).toEqual(['draft', ...ontologyStore.versions(project)]);
    const rel = holds.find((h) => h.version === '1.0.0')!;
    expect((await agent.post(`/api/ontologies/${project.id}/public-holds/1.0.0/approve`).send({ fingerprint: rel.fingerprint })).status).toBe(200);
    expect((await request(app).get('/def/volunteering/1.0.0')).status).toBe(200);
    expect((await request(app).get('/def/volunteering/draft.ttl')).status).toBe(503);
  });

  it('shows the steward everything the fingerprint covers: Turtle, release notes and the use case snapshot (eighth review)', async () => {
    const project = await legacy();
    const { list } = await import('../src/db.js');
    const release = list<{ id: string; version: string; notes: string }>('releases', project.id).find((r) => r.version === '1.0.0')!;
    put('releases', { ...release, notes: `${release.notes}\nThanks to NOTES_ONLY_NAME.` }, project.id);
    const before = ontologyStore.releaseFile(project, '1.0.0', 'requirements.json') ?? '';
    storeReleaseFiles('1.0.0', { 'requirements.json': before.replace(/\}\s*$/, ', "note": "SNAPSHOT_ONLY_NAME" }') || '{ "note": "SNAPSHOT_ONLY_NAME" }' }, project);
    try {
      const { agent } = await steward('Eighth full-content steward');
      const rel = ((await agent.get(`/api/ontologies/${project.id}/public-holds`)).body as PublicHoldReview[]).find((h) => h.version === '1.0.0')!;
      expect(rel.notes).toContain('NOTES_ONLY_NAME');
      expect(rel.snapshot).toContain('SNAPSHOT_ONLY_NAME');
      expect(rel.turtle).toContain('@prefix');
    } finally {
      storeReleaseFiles('1.0.0', { 'requirements.json': before || null }, project);
      put('releases', release, project.id);
    }
  });

  it('still lists every other held version when one release can’t be read (eighth review)', async () => {
    const project = await legacy();
    const good = ontologyStore.releaseFile(project, '1.0.0', 'ontology.ttl')!;
    storeReleaseFiles('1.0.0', { 'ontology.ttl': '@prefix broken <nope' }, project);
    try {
      const { agent } = await steward('Eighth malformed steward');
      const res = await agent.get(`/api/ontologies/${project.id}/public-holds`);
      expect(res.status).toBe(200);
      const holds = res.body as PublicHoldReview[];
      expect(holds.find((h) => h.version === '1.0.0')!.error).toMatch(/couldn’t be read/);
      expect(holds.find((h) => h.version === '1.0.0')!.turtle).toBe('@prefix broken <nope');
      const draft = holds.find((h) => h.version === 'draft')!;
      expect(draft.error).toBeUndefined();
      expect(draft.statements).toBeGreaterThan(0);
    } finally {
      storeReleaseFiles('1.0.0', { 'ontology.ttl': good }, project);
    }
  });

  it('publishes no release of a draft that changed while it was being prepared (eighth review)', async () => {
    const project = await legacy();
    const { vi } = await import('vitest');
    const { setRoles } = await import('../src/services/ontologies.js');
    const owner = await createUser({ name: 'Eighth race owner', provider: 'github', subject: 'eighth-race' });
    setRoles(project.id, owner.id, ['owner', 'steward']);
    const merged = await drafted8(project);
    void merged;
    const release = await draftRelease(findProject('volunteering')!, owner);
    // Hold the release at its write, after it captured draft A.
    const real = ontologyStore.writeRelease.bind(ontologyStore);
    let letGo!: () => void;
    const gate = new Promise<void>((r) => (letGo = r));
    const spy = vi.spyOn(ontologyStore, 'writeRelease').mockImplementation(async (...args) => {
      await gate;
      return real(...args);
    });
    try {
      const publishing = publishRelease((await import('../src/db.js')).get('releases', release.id)!, owner).then(
        () => 'published',
        (e: { status?: number }) => e.status,
      );
      await new Promise((r) => setTimeout(r, 50));
      // Meanwhile the owner fixes the draft (B) and approves exactly B.
      const working = await ontologyStore.working(project);
      const fixed = await OntologyGraph.fromTurtle((await working.toTurtle()).replace(/"Raised by Legacy Hold Person in the LEGACY_HOLD_PILOT\."/, '"A fixed definition."'));
      await ontologyStore.commitWorking(project, fixed, 'Fix', { name: 'Concord' });
      const { agent } = await steward('Eighth race steward');
      const b = ((await agent.get(`/api/ontologies/${project.id}/public-holds`)).body as PublicHoldReview[]).find((h) => h.version === 'draft')!;
      expect((await agent.post(`/api/ontologies/${project.id}/public-holds/draft/approve`).send({ fingerprint: b.fingerprint })).status).toBe(200);
      letGo();
      expect(await publishing).toBe(409);
    } finally {
      spy.mockRestore();
    }
    // Draft B stands, and nothing of A was released.
    expect(ontologyStore.readWorkingText(project)).toContain('A fixed definition.');
    expect(ontologyStore.versions(project)).not.toContain(release.version);
    const page = await request(app).get('/def/volunteering/draft.ttl');
    expect(page.status).toBe(200);
    expect(page.text).not.toContain('Legacy Hold Person');
  });

  it('pushes nothing to GitHub while a version is held (eighth review)', async () => {
    const project = await legacy();
    const { vi } = await import('vitest');
    const { setRoles, updateProject } = await import('../src/services/ontologies.js');
    const owner = await createUser({ name: 'Eighth push owner', provider: 'github', subject: 'eighth-push' });
    setRoles(project.id, owner.id, ['owner', 'steward']);
    updateProject({ ...findProject('volunteering')!, github: { repo: 'example/volunteering' } as never });
    const saved = config.github.publishToken;
    (config.github as { publishToken?: string }).publishToken = 'test-token-not-real';
    const push = vi.spyOn(ontologyStore, 'push').mockImplementation(() => undefined);
    try {
      await drafted8(project);
      const release = await draftRelease(findProject('volunteering')!, owner);
      const published = await publishRelease((await import('../src/db.js')).get('releases', release.id)!, owner);
      expect(published.status).toBe('published');
      expect(holdOf(findProject('volunteering')!)!.versions).toContain(published.version);
      expect(push).not.toHaveBeenCalled();
      expect(published.githubUrl).toBeUndefined();
    } finally {
      push.mockRestore();
      (config.github as { publishToken?: string }).publishToken = saved;
      updateProject({ ...findProject('volunteering')!, github: undefined });
    }
  });

  it('reviews the release notes the public page shows, not a rejected attempt at the same version (ninth review)', async () => {
    // Used to: review and fingerprint the first record for 1.0.0, a rejected attempt, while the page showed the published one.
    const project = await legacy();
    const { list, remove } = await import('../src/db.js');
    const published = list<Release>('releases', project.id).find((r) => r.version === '1.0.0' && r.status === 'published')!;
    remove('releases', published.id);
    put('releases', { ...published, id: 'rel_ninth_rejected', status: 'rejected', notes: 'Harmless notes from an attempt that was rejected.' }, project.id);
    put('releases', { ...published, notes: `${published.notes}\nThanks to PUBLIC_NOTES_PRIVATE_NAME.` }, project.id);
    try {
      const { agent } = await steward('Ninth notes steward');
      const review = () => agent.get(`/api/ontologies/${project.id}/public-holds`).then((r) => (r.body as PublicHoldReview[]).find((h) => h.version === '1.0.0')!);
      const seen = await review();
      expect(seen.notes).toContain('PUBLIC_NOTES_PRIVATE_NAME');
      expect(seen.notes).not.toContain('Harmless notes');
      // Editing the published notes after the review changes what approval covers.
      put('releases', { ...published, notes: 'Notes changed after the review.' }, project.id);
      expect((await agent.post(`/api/ontologies/${project.id}/public-holds/1.0.0/approve`).send({ fingerprint: seen.fingerprint })).status).toBe(409);
      expect((await review()).notes).toBe('Notes changed after the review.');
    } finally {
      remove('releases', 'rel_ninth_rejected');
      put('releases', published, project.id);
    }
  });

  it('never pushes an older ontology’s history to GitHub, even once every version is approved (ninth review)', async () => {
    // Used to: push main once the holds were cleared, carrying the unapproved draft it was repaired from.
    const project = await legacy();
    const { vi } = await import('vitest');
    const { setRoles, updateProject } = await import('../src/services/ontologies.js');
    const owner = await createUser({ name: 'Ninth push owner', provider: 'github', subject: 'ninth-push' });
    setRoles(project.id, owner.id, ['owner', 'steward']);
    // Repair the draft, then approve every held version.
    const working = await ontologyStore.working(project);
    await ontologyStore.commitWorking(project, await OntologyGraph.fromTurtle((await working.toTurtle()).replace(/"Raised by Legacy Hold Person in the LEGACY_HOLD_PILOT\."/, '"Repaired."')), 'Repair', { name: 'Concord' });
    const { agent } = await steward('Ninth push steward');
    for (const h of (await agent.get(`/api/ontologies/${project.id}/public-holds`)).body as PublicHoldReview[])
      expect((await agent.post(`/api/ontologies/${project.id}/public-holds/${h.version}/approve`).send({ fingerprint: h.fingerprint })).status).toBe(200);
    updateProject({ ...findProject('volunteering')!, github: { repo: 'example/volunteering' } as never });
    const saved = config.github.publishToken;
    (config.github as { publishToken?: string }).publishToken = 'test-token-not-real';
    const push = vi.spyOn(ontologyStore, 'push').mockImplementation(() => undefined);
    try {
      await drafted8(project);
      const published = await publishRelease((await import('../src/db.js')).get('releases', (await draftRelease(findProject('volunteering')!, owner)).id)!, owner);
      expect(published.status).toBe('published');
      expect(push).not.toHaveBeenCalled();
      // An ontology made under the approval rules is pushed as before.
      const fresh = await createProject({ title: 'Ninth pushed vocab', description: '', prefix: 'npv' }, owner);
      updateProject({ ...fresh, github: { repo: 'example/ninth' } as never });
      await drafted8(fresh);
      await publishRelease((await import('../src/db.js')).get('releases', (await draftRelease(findProject(fresh.slug)!, owner)).id)!, owner);
      expect(push).toHaveBeenCalledTimes(1);
    } finally {
      push.mockRestore();
      (config.github as { publishToken?: string }).publishToken = saved;
      updateProject({ ...findProject('volunteering')!, github: undefined });
    }
  });

  it('gives signed-out callers no counts or health from a working draft that is held (ninth review)', async () => {
    // Used to: report the held draft's class count and validation health in the ontology summaries.
    const project = await legacy();
    const anonymous = async () => {
      const one = (await request(app).get(`/api/ontologies/${project.id}`)).body as OntologySummary;
      const all = ((await request(app).get('/api/ontologies')).body as OntologySummary[]).find((o) => o.id === project.id)!;
      return [one, all];
    };
    for (const s of await anonymous()) {
      expect(s.stats.classes).toBeUndefined();
      expect(s.stats.properties).toBeUndefined();
      expect(s.stats.individuals).toBeUndefined();
      expect(s.health).toBeUndefined();
      expect(s.stats.releases).toBeGreaterThan(0);
    }
    // Signed in, everything is there; and once the draft is approved, the public sees the counts again.
    const { agent } = await steward('Ninth summary steward');
    expect(((await agent.get(`/api/ontologies/${project.id}`)).body as OntologySummary).stats.classes).toBeGreaterThan(0);
    const draft = ((await agent.get(`/api/ontologies/${project.id}/public-holds`)).body as PublicHoldReview[]).find((h) => h.version === 'draft')!;
    expect((await agent.post(`/api/ontologies/${project.id}/public-holds/draft/approve`).send({ fingerprint: draft.fingerprint })).status).toBe(200);
    for (const s of await anonymous()) expect(s.stats.classes).toBeGreaterThan(0);
  });

  it('decides on a held draft before reading it for a signed-out summary, so a draft replaced meanwhile isn’t counted (tenth review)', async () => {
    // Used to: read held draft A, wait for validation, then check the hold after B had been approved, and show A's counts.
    const project = await legacy();
    const { vi } = await import('vitest');
    // B: the draft with the private class taken out, so its counts differ from A's.
    const a = await OntologyGraph.fromTurtle(ontologyStore.readWorkingText(project));
    const repaired = await OntologyGraph.fromTurtle(ontologyStore.readWorkingText(project));
    repaired.store.removeQuads(repaired.store.getQuads(null, null, null, null).filter((q) => q.subject.value.endsWith('#LegacyRecord')));
    const repairedTurtle = await repaired.toTurtle();
    const countB = repaired.view().classes.length;
    expect(countB).toBe(a.view().classes.length - 1);
    for (const url of [`/api/ontologies/${project.id}`, '/api/ontologies']) {
      const fresh = await legacy();
      // The summary's first read of the draft (A, for its counts) goes through; its next one (for validation)
      // waits until the repair B is approved.
      const real = ontologyStore.working.bind(ontologyStore);
      let letGo!: () => void;
      const gate = new Promise<void>((r) => (letGo = r));
      let reads = 0;
      const spy = vi.spyOn(ontologyStore, 'working').mockImplementation(async (p) => {
        if (reads++ > 0) await gate;
        return real(p);
      });
      try {
        const pending = request(app).get(url).then((r) => r);
        await new Promise((r) => setTimeout(r, 50));
        await ontologyStore.commitWorking(fresh, await OntologyGraph.fromTurtle(repairedTurtle), 'Repair', { name: 'Concord' });
        const { agent } = await steward(`Tenth summary steward ${url.length}`);
        const b = ((await agent.get(`/api/ontologies/${fresh.id}/public-holds`)).body as PublicHoldReview[]).find((h) => h.version === 'draft')!;
        expect((await agent.post(`/api/ontologies/${fresh.id}/public-holds/draft/approve`).send({ fingerprint: b.fingerprint })).status).toBe(200);
        letGo();
        const body = (await pending).body as OntologySummary | OntologySummary[];
        const s = Array.isArray(body) ? body.find((o) => o.id === fresh.id)! : body;
        // Either nothing from the draft (it was held when asked), or B's counts: never A's.
        if (s.stats.classes !== undefined) expect(s.stats.classes, url).toBe(countB);
        expect(s.stats.classes, url).toBeUndefined();
      } finally {
        letGo();
        spy.mockRestore();
      }
    }
  });

  it('shows names on WebID profiles only to signed-in users', async () => {
    const tester = await createUser({ name: 'WebID Person', provider: 'github', subject: 'webid-names' });
    const anon = (await request(app).get(`/people/${tester.id}`)).text;
    expect(anon).toContain('solid:oidcIssuer');
    expect(anon).not.toContain('WebID Person');
    const agent = request.agent(app);
    await agent.post('/api/auth/demo').send({ name: 'WebID reader', role: 'contributor' });
    expect((await agent.get(`/people/${tester.id}`)).text).toContain('WebID Person');
  });
});
