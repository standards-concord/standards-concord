import request from 'supertest';
import { exampleFiles } from '@concord/core';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Release, UseCase, User } from '@concord/shared';
import { createApp } from '../src/app.js';
import { openDb, put } from '../src/db.js';
import { clock } from '../src/clock.js';
import { newId } from '../src/ids.js';
import { createProject, findProject } from '../src/services/ontologies.js';
import { ontologyStore } from '../src/services/ontologyStore.js';
import { publishRelease } from '../src/services/releases.js';
import { createUseCase, setVisibility, withdrawUseCase } from '../src/services/useCases.js';
import { createUser } from '../src/services/users.js';
import { seedDemo } from '../src/services/simulation.js';
import { examplesFor, liveExamples } from '../src/public/examples.js';
import { renderOntologyPage } from '../src/public/render.js';
import { pageInput, refreshReleasePages } from '../src/public/routes.js';

const app = createApp();
const NS = 'https://example.org/worked#';
const seedTurtle = `@prefix ex: <${NS}> . @prefix owl: <http://www.w3.org/2002/07/owl#> . ex:standard a owl:Ontology . ex:Record a owl:Class . ex:name a owl:DatatypeProperty .`;
let owner: User;
beforeAll(async () => {
  await openDb();
  owner = await createUser({ name: 'Examples author', provider: 'github', subject: 'examples-author' });
});

async function setup() {
  const project = await createProject({ title: newId('Examples'), description: '', prefix: 'ex', seedTurtle }, owner);
  const add = (visibility: UseCase['visibility'], name: string, status: UseCase['status'] = 'triage') => createUseCase(project, owner, {
    visibility, status, source: 'form', sections: { name },
    competencyQuestions: [{ id: newId('cq'), question: `${name} question`, sparql: 'SELECT ?name WHERE { ?s ex:name ?name }', exampleData: `@prefix ex: <${NS}> . <https://example.org/${name}> a ex:Record ; ex:name "${name} answer" .`, exampleAnswer: `${name} answer`, status: 'untested' }],
  });
  const visible = await add('public', 'Public');
  await add('group', 'GROUP_SECRET');
  await add('private', 'PRIVATE_SECRET');
  await add('public', 'DRAFT_SECRET', 'draft');
  await add('public', 'ARCHIVED_SECRET', 'archived');
  const withdrawn = await add('public', 'WITHDRAWN_SECRET');
  await withdrawUseCase(withdrawn, owner);
  return { project, visible, add };
}

async function release(project: Awaited<ReturnType<typeof createProject>>) {
  const now = clock.iso();
  const r: Release = { id: newId('rel'), ontologyId: project.id, version: '1.0.0', level: 'major', status: 'draft', changeRequestIds: [], notes: 'First release.', notesBy: owner.id, versionIRI: `${project.ontologyIRI}/1.0.0`, createdBy: owner.id, createdAt: now, statusSince: now };
  await put('releases', r, project.id);
  return publishRelease(r, owner);
}

function safe(text: string) {
  for (const hidden of ['GROUP_SECRET', 'PRIVATE_SECRET', 'DRAFT_SECRET', 'ARCHIVED_SECRET', 'WITHDRAWN_SECRET']) expect(text).not.toContain(hidden);
}

describe('public worked examples', () => {
  it('stores public answers with the release and removes withdrawn sources without rewriting history', async () => {
    const { project, visible } = await setup();
    await release(project);
    const snapshot = (await ontologyStore.readReleaseFile(project, '1.0.0', 'examples.json'))!;
    const recorded = JSON.parse(snapshot);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ source: visible.id, answered: true, exampleAnswer: 'Public answer', result: { rows: [{ name: 'Public answer' }] } });
    safe(snapshot);
    expect(await ontologyStore.readReleaseFile(project, '1.0.0', recorded[0].queryFile)).toBe(`${recorded[0].sparql}\n`);
    for (const path of ['../ontology.ttl', 'examples/../../ontology.ttl', '/ontology.ttl']) expect(await ontologyStore.readReleaseFile(project, '1.0.0', path)).toBeUndefined();
    const data = (await ontologyStore.readReleaseFile(project, '1.0.0', 'examples/data.ttl'))!;
    safe(data);
    expect(data).toContain('Public answer');
    const input = await pageInput(project, '1.0.0', 'http://localhost');
    expect(renderOntologyPage(input)).toContain('Public question');
    await withdrawUseCase(visible, owner);
    const withdrawn = await pageInput(project, '1.0.0', 'http://localhost');
    const html = renderOntologyPage(withdrawn);
    expect(html).not.toContain('Public question');
    expect(html).not.toContain('Public answer');
    expect(html).not.toContain('>Examples</a>');
    const served = exampleFiles(await examplesFor(project, '1.0.0', await ontologyStore.at(project, '1.0.0')));
    expect(JSON.parse(served['examples.json'])).toEqual([]);
    expect(served['examples/data.ttl'].trim()).toBe('');
    expect(served[recorded[0].queryFile]).toBeUndefined();
    expect(await ontologyStore.readReleaseFile(project, '1.0.0', 'examples.json')).toBe(snapshot);
  });

  it('keeps other sources and their original filenames when one source is withdrawn', async () => {
    const { project, visible, add } = await setup();
    const other = await add('public', 'Other');
    await release(project);
    const before = await examplesFor(project, '1.0.0', await ontologyStore.at(project, '1.0.0'));
    expect(before).toHaveLength(2);
    const kept = before.find((e) => e.source === other.id)!;
    await withdrawUseCase(visible, owner);
    const after = await examplesFor(project, '1.0.0', await ontologyStore.at(project, '1.0.0'));
    expect(after).toEqual([kept]);
    const files = exampleFiles(after);
    expect(files[kept.queryFile]).toBe(`${kept.sparql}\n`);
    expect(files['examples/data.ttl']).toContain('Other answer');
    expect(JSON.stringify(files)).not.toContain('Public answer');
    const html = renderOntologyPage(await pageInput(project, '1.0.0', 'http://localhost'));
    expect(html).toContain('Other question');
    expect(html).not.toContain('Public question');
  });

  it('reuses a draft by content and refreshes it when the question or graph changes', async () => {
    const { project, visible } = await setup();
    const graph = await ontologyStore.working(project);
    const initial = await liveExamples(project, graph);
    expect(await liveExamples(project, graph)).toBe(initial);
    expect(initial).toHaveLength(1);
    safe(JSON.stringify(initial));
    await put('useCases', { ...visible, competencyQuestions: visible.competencyQuestions.map((q) => ({ ...q, sparql: 'ASK { ?s a ex:NewClass }' })) }, project.id);
    const before = await liveExamples(project, graph);
    expect(before[0]).toMatchObject({ answered: false, result: { boolean: false } });
    const { OntologyGraph } = await import('@concord/core');
    const changed = await OntologyGraph.fromTurtle(`${await graph.toTurtle()}\n<https://example.org/new> a <${NS}NewClass> .`);
    const after = await liveExamples(project, changed);
    expect(after[0]).toMatchObject({ answered: true, result: { boolean: true } });
    expect(after[0].id).toBe(initial[0].id);
    const html = renderOntologyPage(await pageInput(project, 'draft', 'http://localhost', { graph: changed }));
    expect(html).toContain('Public question');
    expect(html).toContain('<p>Yes</p>');
    safe(html);
  });

  it('computes the draft live, invalidates on question edits and never publishes restricted questions', async () => {
    const { project, visible } = await setup();
    const root = `/def/${project.slug}/draft`;
    const page = await request(app).get(root);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Public question');
    expect(page.text).toContain('Public answer');
    safe(page.text);
    const first = await request(app).get(`${root}/examples.json`);
    expect(first.body).toHaveLength(1);
    expect(first.body[0]).toMatchObject({ source: visible.id, answered: true, result: { rows: [{ name: 'Public answer' }] } });
    safe(JSON.stringify(first.body));
    await put('useCases', { ...visible, competencyQuestions: visible.competencyQuestions.map((q) => ({ ...q, question: 'Edited public question' })) }, project.id);
    const edited = await request(app).get(root);
    expect(edited.text).toContain('Edited public question');
    expect(edited.text).not.toContain('>Public question<');
  });

  it('freezes files in a real release, serves every download and keeps release answers after later edits', async () => {
    const { project, visible } = await setup();
    await release(project);
    const stored = (await ontologyStore.readReleaseFile(project, '1.0.0', 'examples.json'))!;
    safe(stored);
    const examples = JSON.parse(stored);
    expect(examples).toHaveLength(1);
    const e = examples[0];
    expect(await ontologyStore.readReleaseFile(project, '1.0.0', e.queryFile)).toBe(`${e.sparql}\n`);
    const data = (await ontologyStore.readReleaseFile(project, '1.0.0', 'examples/data.ttl'))!;
    expect(data).toContain('Public answer');
    safe(data);
    const html = (await ontologyStore.readReleaseFile(project, '1.0.0', 'index.html'))!;
    expect(html).toContain(`href="${e.queryFile}"`);
    expect(html).toContain('href="examples/data.ttl"');
    await put('useCases', { ...visible, competencyQuestions: [] }, project.id);
    for (const path of ['', '/1.0.0']) {
      const page = await request(app).get(`/def/${project.slug}${path}`);
      expect(page.text).toContain('Public question');
      expect(page.text).toContain('Public answer');
      safe(page.text);
    }
    for (const [file, type] of [['examples.json', 'application/json'], [e.queryFile, 'application/sparql-query'], ['examples/data.ttl', 'text/turtle']]) {
      const res = await request(app).get(`/def/${project.slug}/1.0.0/${file}`).buffer(true);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain(type);
      expect(res.headers['cache-control']).toBe('no-cache');
      safe(res.text);
    }
    const graph = await ontologyStore.working(project);
    graph.prefixes.extra = 'https://extra.example/';
    await ontologyStore.commitWorking(project, graph, 'Change prefixes', { name: 'Concord' });
    expect((await request(app).get(`/def/${project.slug}/1.0.0/examples.json`)).body).toEqual(examples);
  });

  it.each(['withdraw', 'group', 'archive', 'draft'] as const)('removes a released source after %s from the page and all served files', async (change) => {
    const { project, visible } = await setup();
    await release(project);
    const frozen = (await ontologyStore.readReleaseFile(project, '1.0.0', 'examples.json'))!;
    const queryFile = JSON.parse(frozen)[0].queryFile;
    if (change === 'withdraw') await withdrawUseCase(visible, owner);
    else if (change === 'group') await setVisibility(visible, owner, 'group');
    else await put('useCases', { ...visible, status: change === 'archive' ? 'archived' : 'draft' }, project.id);
    for (const version of ['1.0.0', 'draft']) {
      const root = `/def/${project.slug}/${version}`;
      const page = await request(app).get(root);
      expect(page.text).not.toContain('Public question');
      expect(page.text).not.toContain('Public answer');
      expect(page.text).not.toContain('>Examples</a>');
      expect((await request(app).get(`${root}/examples.json`)).body).toEqual([]);
      expect((await request(app).get(`${root}/examples/data.ttl`)).text.trim()).toBe('');
      expect((await request(app).get(`${root}/${queryFile}`)).status).toBe(404);
    }
    expect(await ontologyStore.readReleaseFile(project, '1.0.0', 'examples.json')).toBe(frozen);
  });

  it('does not replace absent or corrupt release snapshots with live questions during refresh', async () => {
    const { project } = await setup();
    await release(project);
    for (const contents of [null, '{broken', '[{"question":"not a snapshot"}]']) {
      await ontologyStore.updateReleaseFiles(project, { '1.0.0': { 'examples.json': contents } }, 'Test snapshot');
      expect((await request(app).get(`/def/${project.slug}/1.0.0/examples.json`)).body).toEqual([]);
      await refreshReleasePages();
      {
        // The question and its example answer still appear with the use cases; what must not come back is an
        // Examples tab built from live questions.
        const page = (await request(app).get(`/def/${project.slug}/1.0.0`)).text;
        expect(page).not.toContain('>Examples</a>');
        expect(page).not.toContain('tab-examples');
      }
    }
  });

  it('keeps demo examples as seeded even after a tester edits the use case', async () => {
    await seedDemo();
    const project = (await findProject('volunteering'))!;
    const original = (await request(app).get('/def/volunteering/draft/examples.json')).body;
    expect(original.length).toBeGreaterThan(0);
    const { get } = await import('../src/db.js');
    const u = (await get<UseCase>('useCases', original[0].source))!;
    await put('useCases', { ...u, competencyQuestions: [{ ...u.competencyQuestions[0], question: 'TESTER_SECRET', exampleData: 'TESTER_SECRET' }] }, project.id);
    expect((await request(app).get('/def/volunteering/draft/examples.json')).body).toEqual(original);
  });
});
