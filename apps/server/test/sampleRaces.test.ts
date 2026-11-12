import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_VOCABULARIES, type OntologyProject, type Release } from '@concord/shared';
import { list, openDb } from '../src/db.js';
import { createProject } from '../src/services/ontologies.js';
import { ontologyStore } from '../src/services/ontologyStore.js';
import { seedSamples } from '../src/services/samples.js';
import * as simulation from '../src/services/simulation.js';
import * as pages from '../src/public/routes.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
beforeAll(async () => { await openDb(); });
beforeEach(async () => { await ontologyStore.wipe(); });

describe('sample creation races on the selected ontology store', () => {
  it('reserves sample names for ordinary titles, and atomically refuses competing explicit slugs before store writes', async () => {
    const owner = (await simulation.ensurePersonas()).get('priya')!;
    const ordinary = await createProject({ title: 'FOAF', prefix: 'my', description: '' }, owner);
    expect(ordinary.slug).toBe('foaf-2');
    const init = vi.spyOn(ontologyStore, 'init');
    try {
      const results = await Promise.allSettled([
        createProject({ title: 'First', slug: 'foaf', prefix: 'first', description: '' }, owner),
        createProject({ title: 'Second', slug: 'foaf', prefix: 'second', description: '' }, owner),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
      expect(init).toHaveBeenCalledOnce();
      expect((await list<OntologyProject>('ontologies')).filter((p) => p.slug === 'foaf')).toHaveLength(1);
    } finally { init.mockRestore(); }
  });

  it('keeps a user graph when creation lands between samples in the seeder pending list', async () => {
    const paused = deferred(), resume = deferred();
    const original = simulation.bootstrapRelease;
    let stopped = false;
    const release = vi.spyOn(simulation, 'bootstrapRelease').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (!stopped) { stopped = true; paused.resolve(); await resume.promise; }
      return result;
    });
    const seeding = seedSamples();
    try {
      await paused.promise;
      const owner = (await simulation.ensurePersonas()).get('priya')!;
      const user = await createProject({ title: 'My FOAF graph', slug: 'foaf', prefix: 'mine', namespace: 'https://example.org/my-graph#', description: 'Keep my own graph' }, owner);
      const before = await ontologyStore.readWorkingText(user);
      const head = await ontologyStore.head(user);
      resume.resolve();
      expect(await seeding).toHaveLength(8);
      const projects = await list<OntologyProject>('ontologies');
      for (const { slug } of SAMPLE_VOCABULARIES) expect(projects.filter((p) => p.slug === slug)).toHaveLength(1);
      expect(projects.find((p) => p.slug === 'foaf')).toEqual(user);
      expect(await ontologyStore.head(user)).toBe(head);
      expect(await ontologyStore.readWorkingText(user)).toBe(before);
      expect(await list<Release>('releases', user.id)).toEqual([]);
    } finally { resume.resolve(); await seeding; release.mockRestore(); }
  });

  it('fences a seed paused before publication when reset wipes its lease and reseeds', async () => {
    const paused = deferred(), resume = deferred();
    const original = pages.releasePageFiles;
    let stopped = false;
    const render = vi.spyOn(pages, 'releasePageFiles').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (!stopped) { stopped = true; paused.resolve(); await resume.promise; }
      return result;
    });
    const staleSeed = seedSamples();
    try {
      await paused.promise;
      const staleIds = (await list<OntologyProject>('ontologies')).map((p) => p.id);
      await simulation.resetAll();
      const projects = await list<OntologyProject>('ontologies');
      const releases = await list<Release>('releases');
      const objects = await list('gitObjects');
      resume.resolve();
      expect(await staleSeed).toEqual([]);
      expect(await list<OntologyProject>('ontologies')).toEqual(projects);
      expect(await list<Release>('releases')).toEqual(releases);
      expect(await list('gitObjects')).toEqual(objects);
      expect(projects.filter((p) => p.sample)).toHaveLength(9);
      expect(projects.every((p) => !staleIds.includes(p.id))).toBe(true);
      for (const { slug } of SAMPLE_VOCABULARIES) expect(projects.filter((p) => p.slug === slug)).toHaveLength(1);
    } finally { resume.resolve(); await staleSeed; render.mockRestore(); }
  });
});
