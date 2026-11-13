import { applyChangeOps, fairCheck, owlReasoner, toWrapperClasses, type ChangeOp } from '@concord/core';
import { DataFactory } from 'n3';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SAMPLE_VOCABULARIES, type OntologyProject, type Release } from '@concord/shared';
import { list, openDb, put, remove } from '../src/db.js';
import { config } from '../src/config.js';
import { createProject, rolesFor } from '../src/services/ontologies.js';
import { ontologyStore } from '../src/services/ontologyStore.js';
import { seedSamples } from '../src/services/samples.js';
import { bootstrapRelease, resetAll } from '../src/services/simulation.js';
import { createChangeRequest } from '../src/services/changeRequests.js';
import { draftRelease, publishRelease } from '../src/services/releases.js';
import { createFork } from '../src/services/forks.js';
import { createFederation } from '../src/services/federations.js';
import { publishFederationRelease } from '../src/services/federationReleases.js';
import { getUser } from '../src/services/users.js';
import { defaultStartupTasks } from '../src/startup.js';
import { pageInput, releasePageFiles } from '../src/public/routes.js';

const samples = async () => (await list<OntologyProject>('ontologies')).filter((p) => p.sample);
beforeAll(async () => { await openDb(); });

describe('sample seeding through the selected ontology store', () => {
  it('leaves an interrupted initial demo repairable before creating samples', async () => {
    await put('kv', { id: 'demo-seed-state', state: 'seeding' });
    try {
      await expect(seedSamples()).rejects.toThrow('demo seed is unfinished');
      expect(await samples()).toEqual([]);
    } finally { await remove('kv', 'demo-seed-state'); }
  });
  it('creates ten once under concurrent callers, with attribution, ownership, README and public releases', async () => {
    const init = vi.spyOn(ontologyStore, 'init');
    const results = await Promise.all([seedSamples(), seedSamples()]);
    expect(results.flat()).toHaveLength(SAMPLE_VOCABULARIES.length);
    const all = await samples();
    expect(all.map((p) => p.slug).sort()).toEqual(SAMPLE_VOCABULARIES.map((s) => s.slug).sort());
    for (const p of all) {
      const definition = SAMPLE_VOCABULARIES.find((s) => s.slug === p.slug)!;
      expect(p).toMatchObject({ currentVersion: '1.0.0', namespace: definition.namespace, sample: { source: definition.source, licence: definition.licence } });
      expect(p.demo).toBeUndefined();
      expect(await rolesFor(p.id, p.ownerIds[0])).toEqual(expect.arrayContaining(['steward', 'owner']));
      const releases = await list<Release>('releases', p.id);
      expect(releases).toHaveLength(1);
      expect(releases[0]).toMatchObject({ status: 'published', notes: expect.stringContaining(definition.source) });
      const released = await ontologyStore.at(p, '1.0.0');
      const n = DataFactory.namedNode;
      const rights = released.store.getObjects(n(definition.source), n('http://purl.org/dc/terms/rights'), null).map((t) => t.value);
      if (definition.copyrightNotice) {
        expect(rights).toContain(definition.copyrightNotice);
        expect(rights).toContain(fs.readFileSync(path.join(config.repoRoot, 'docs/licences/W3C-20150513.md'), 'utf8'));
      }
      expect(releases[0].versionIRI).toBe(`${config.publicUrl}/def/${p.slug}/1.0.0`);
      expect(new URL(releases[0].versionIRI).host).not.toBe(new URL(p.namespace).host);
      expect(releases[0].versionIRI).toBe(released.metadata().versionIRI);
      expect(fairCheck(released).checks.find((c) => c.id === 'F1-version-iri')?.message).toContain(releases[0].versionIRI);
      expect((await toWrapperClasses(released)).ontology.versionIRI).toBe(releases[0].versionIRI);
      expect(await owlReasoner(released)).toMatchObject({ available: true, checked: 'complete', consistent: true, unsatisfiable: [] });
      const page = await ontologyStore.readReleaseFile(p, '1.0.0', 'index.html');
      expect(page).toContain(`<dt>This version</dt><dd><a href="${releases[0].versionIRI}"><code>${releases[0].versionIRI}</code></a></dd>`);
      expect(page).toContain('About this sample');
      expect(page).toContain('checks flag some wording inherited from the original');
      expect(page).toContain('<summary>What the conversion changed</summary>');
      expect(page).not.toContain('href="#sample-conversion-changes"');
      expect(page).toContain(`href="${definition.licence.url}"`);
      expect(page).toContain(`href="${definition.source}"`);
      const readme = init.mock.calls.find(([project]) => project.id === p.id)![2];
      expect(readme).toContain(`[${definition.licence.name}](${definition.licence.url})`);
      expect(readme).toContain('[What the conversion changed](#conversion-changes)');
      expect(readme).not.toContain('Licence: CC BY 4.0');
      if (definition.licence.noticePath) {
        expect(page).toContain(`href="${definition.licence.noticePath}"`);
        expect(page).toContain(`href="${definition.licence.copyPath}"`);
        expect(readme).toContain(`${config.publicUrl}${definition.licence.noticePath}`);
        expect(readme).toContain(`${config.publicUrl}${definition.licence.copyPath}`);
      }
      if (definition.copyrightNotice) {
        expect(page).toContain(definition.copyrightNotice);
        expect(readme).toContain(definition.copyrightNotice);
      }
      if (definition.authors) for (const author of definition.authors) {
        expect(released.store.getObjects(n(definition.source), n('http://purl.org/dc/terms/creator'), null).map((t) => t.value)).toContain(author);
        expect(readme).toContain(author);
        expect(page).toContain(author);
      }
    }
    init.mockRestore();
  });

  it('creates none a second time, preserving an edited sample and its history byte for byte', async () => {
    const p = (await samples()).find((o) => o.slug === 'acl')!;
    p.description = 'Edited by its working group';
    await put('ontologies', p);
    const graph = await ontologyStore.working(p);
    graph.store.addQuad(DataFactory.namedNode(p.ontologyIRI), DataFactory.namedNode('http://www.w3.org/2000/01/rdf-schema#comment'), DataFactory.literal('An edit kept on reseeding'));
    await ontologyStore.commitWorking(p, graph, 'Working group edit', { name: 'Priya' });
    const head = await ontologyStore.head(p);
    const before = await ontologyStore.readWorkingText(p);
    expect(await seedSamples()).toEqual([]);
    expect((await samples()).find((o) => o.id === p.id)).toEqual(p);
    expect(await ontologyStore.head(p)).toBe(head);
    expect(await ontologyStore.readWorkingText(p)).toBe(before);
  });

  it('keeps a sample on Concord URLs when a normal release is drafted, re-versioned and published', async () => {
    const p = (await samples()).find((o) => o.slug === 'acl')!;
    const owner = (await getUser(p.ownerIds[0]))!;
    const previousUrl = config.publicUrl;
    const first = (await list<Release>('releases', p.id)).find((r) => r.version === '1.0.0')!;
    config.publicUrl = 'https://new.concord.example';
    try {
    // Queue merged edits as release fixtures; samples retain the source's inherited lint errors.
    const queueEdit = async (ops: ChangeOp[]) => {
      const cr = await createChangeRequest(p, owner, { title: 'Sample clarification', kind: 'editorial', origin: { type: 'direct' }, description: '', ops });
      const { graph } = applyChangeOps(await ontologyStore.working(p), ops);
      await ontologyStore.commitWorking(p, graph, 'Merged sample edit', { name: owner.name });
      await put('changeRequests', { ...cr, status: 'merged' }, p.id);
    };
    await queueEdit([{ op: 'updateAnnotations', iri: `${p.namespace}agent`, set: { definition: 'An agent that is granted access to the resource by this authorization.' } }]);
    const draft = await draftRelease(p, owner);
    expect(draft).toMatchObject({ version: '1.0.1', versionIRI: `${config.publicUrl}/def/acl/1.0.1` });
    await queueEdit([{ op: 'addClass', localName: 'SampleAgent', label: 'sample agent', definition: 'An agent used to demonstrate authorization in the Concord sample.' }]);
    const revised = await draftRelease(p, owner);
    expect(revised).toMatchObject({ id: draft.id, version: '1.1.0', versionIRI: `${config.publicUrl}/def/acl/1.1.0` });
    const release = await publishRelease(revised, owner);
    expect(release.status).toBe('published');
    expect((await list<Release>('releases', p.id)).find((r) => r.id === release.id)?.versionIRI).toBe(release.versionIRI);
    const released = await ontologyStore.at(p, release.version);
    expect(released.metadata()).toMatchObject({
      versionIRI: `${config.publicUrl}/def/acl/1.1.0`,
      priorVersion: first.versionIRI,
      backwardCompatibleWith: [first.versionIRI],
    });
    expect(new URL(released.metadata().versionIRI!).host).not.toBe(new URL(p.namespace).host);
    expect(await ontologyStore.readReleaseFile(p, release.version, 'index.html')).toContain(`<code>${release.versionIRI}</code>`);
    const historical = await pageInput(p, first.version, config.publicUrl);
    expect(historical.pageUrl).toBe(first.versionIRI);
    expect((await releasePageFiles(p, first, await ontologyStore.at(p, first.version)))['index.html']).toContain(`href="${first.versionIRI}"><code>${first.versionIRI}</code>`);
    } finally { config.publicUrl = previousUrl; }
  });

  it('uses Concord release IRIs in sample fork ancestry and federation member and import pins', async () => {
    const acl = (await samples()).find((p) => p.slug === 'acl')!;
    const vcard = (await samples()).find((p) => p.slug === 'vcard')!;
    const owner = (await getUser(acl.ownerIds[0]))!;
    const aclReleases = await list<Release>('releases', acl.id);
    const aclFirst = aclReleases.find((r) => r.version === '1.0.0')!;
    const aclLatest = aclReleases.find((r) => r.version === acl.currentVersion)!;
    const vcardFirst = (await list<Release>('releases', vcard.id)).find((r) => r.version === '1.0.0')!;
    const previousUrl = config.publicUrl;
    config.publicUrl = 'https://another.concord.example';
    try {
    const fork = await createFork(acl, owner, { name: 'Sample ancestry' });
    expect((await ontologyStore.graphAt(acl, fork.head)).metadata().priorVersion).toBe(aclLatest.versionIRI);
    const consumer = await createProject({ title: 'Sample importer', prefix: 'si', description: '' }, owner);
    const graph = await ontologyStore.working(consumer);
    graph.store.addQuad(DataFactory.namedNode(consumer.ontologyIRI), DataFactory.namedNode('http://www.w3.org/2002/07/owl#imports'), DataFactory.namedNode(aclFirst.versionIRI));
    await ontologyStore.commitWorking(consumer, graph, 'Import the sample release', { name: owner.name });
    await bootstrapRelease(consumer, owner, '1.0.0', 'Imports the sample.');
    const fed = await createFederation(owner, { title: 'Sample release pins', members: [{ ontologyId: vcard.id, version: '1.0.0' }, { ontologyId: consumer.id, version: '1.0.0' }] });
    const release = await publishFederationRelease(fed, owner, {});
    expect(release.pins).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'member', ontologyId: vcard.id, versionIRI: vcardFirst.versionIRI }),
      expect.objectContaining({ role: 'import', ontologyId: acl.id, versionIRI: aclFirst.versionIRI }),
    ]));
    expect(release.manifest).toContain(vcardFirst.versionIRI);
    expect(release.manifest).toContain(aclFirst.versionIRI);
    } finally { config.publicUrl = previousUrl; }
  });

  it('does not touch a pre-existing project whose slug is reserved for a sample', async () => {
    const p = (await samples())[0];
    const { sample: _sample, ...ordinary } = p;
    await put('ontologies', ordinary);
    expect(await seedSamples()).toEqual([]);
    expect((await list<OntologyProject>('ontologies')).find((o) => o.id === p.id)).toEqual(ordinary);
  });

  it('reset brings back all ten alongside the volunteering demo', async () => {
    const oldIds = (await samples()).map((p) => p.id);
    await resetAll();
    const all = await samples();
    expect(all).toHaveLength(SAMPLE_VOCABULARIES.length);
    expect(all.every((p) => !oldIds.includes(p.id))).toBe(true);
    expect((await list<OntologyProject>('ontologies')).find((p) => p.demo)?.slug).toBe('volunteering');
    expect(await seedSamples()).toEqual([]);
  });

  it('keeps ontology-based version IRIs for the non-sample demo, at bootstrap and normal publication', async () => {
    const p = (await list<OntologyProject>('ontologies')).find((p) => p.demo)!;
    const first = (await list<Release>('releases', p.id)).find((r) => r.version === '1.0.0')!;
    expect(first.versionIRI).toBe(`${p.ontologyIRI}/1.0.0`);
    expect((await ontologyStore.at(p, first.version)).metadata().versionIRI).toBe(first.versionIRI);
    const release = await publishRelease(await draftRelease(p, await getUser(p.ownerIds[0])), undefined);
    expect(release.versionIRI).toBe(`${p.ontologyIRI}/${release.version}`);
    expect((await ontologyStore.at(p, release.version)).metadata()).toMatchObject({ versionIRI: release.versionIRI, priorVersion: first.versionIRI });
  });

  it('seeds only in demo mode and registers the task beside demo-seed', async () => {
    expect((await defaultStartupTasks()).map((t) => t.name)).toEqual(expect.arrayContaining(['demo-seed', 'sample-seed']));
    const before = await samples();
    const prior = config.demoMode;
    config.demoMode = false;
    try {
      expect(await seedSamples()).toEqual([]);
      expect((await defaultStartupTasks()).map((t) => t.name)).not.toContain('sample-seed');
      expect(await samples()).toEqual(before);
    } finally { config.demoMode = prior; }
  });
});
