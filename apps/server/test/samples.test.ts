import { owlReasoner } from '@concord/core';
import { DataFactory } from 'n3';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SAMPLE_VOCABULARIES, type OntologyProject, type Release } from '@concord/shared';
import { list, openDb, put, remove } from '../src/db.js';
import { config } from '../src/config.js';
import { rolesFor } from '../src/services/ontologies.js';
import { ontologyStore } from '../src/services/ontologyStore.js';
import { seedSamples } from '../src/services/samples.js';
import { resetAll } from '../src/services/simulation.js';
import { defaultStartupTasks } from '../src/startup.js';

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
  it('creates nine once under concurrent callers, with attribution, ownership, README and public releases', async () => {
    const init = vi.spyOn(ontologyStore, 'init');
    const results = await Promise.all([seedSamples(), seedSamples()]);
    expect(results.flat()).toHaveLength(9);
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
      expect(releases[0].versionIRI).toBe(released.metadata().versionIRI);
      expect(await owlReasoner(released)).toMatchObject({ available: true, checked: 'complete', consistent: true, unsatisfiable: [] });
      const page = await ontologyStore.readReleaseFile(p, '1.0.0', 'index.html');
      expect(page).toContain('About this sample');
      expect(page).toContain(`href="${definition.licence.url}"`);
      expect(page).toContain(`href="${definition.source}"`);
      const readme = init.mock.calls.find(([project]) => project.id === p.id)![2];
      expect(readme).toContain(`[${definition.licence.name}](${definition.licence.url})`);
      expect(readme).toContain('[What the conversion changed](#conversion-changes)');
      expect(readme).not.toContain('Licence: CC BY 4.0');
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

  it('does not touch a pre-existing project whose slug is reserved for a sample', async () => {
    const p = (await samples())[0];
    const { sample: _sample, ...ordinary } = p;
    await put('ontologies', ordinary);
    expect(await seedSamples()).toEqual([]);
    expect((await list<OntologyProject>('ontologies')).find((o) => o.id === p.id)).toEqual(ordinary);
  });

  it('reset brings back all nine alongside the volunteering demo', async () => {
    const oldIds = (await samples()).map((p) => p.id);
    await resetAll();
    const all = await samples();
    expect(all).toHaveLength(9);
    expect(all.every((p) => !oldIds.includes(p.id))).toBe(true);
    expect((await list<OntologyProject>('ontologies')).find((p) => p.demo)?.slug).toBe('volunteering');
    expect(await seedSamples()).toEqual([]);
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
