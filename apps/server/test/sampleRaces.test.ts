import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_VOCABULARIES, type OntologyProject, type Release } from '@concord/shared';
import { get, list, openDb } from '../src/db.js';
import { createProject } from '../src/services/ontologies.js';
import { ontologyStore } from '../src/services/ontologyStore.js';
import { seedSamples } from '../src/services/samples.js';
import * as simulation from '../src/services/simulation.js';
import * as pages from '../src/public/routes.js';
import * as users from '../src/services/users.js';
import * as db from '../src/db.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
beforeAll(async () => { await openDb(); });
beforeEach(async () => { await ontologyStore.wipe(); });

describe('sample creation races on the selected ontology store', () => {
  it('also discards initialization when the creation transaction fails after its callback', async () => {
    const owner = (await simulation.ensurePersonas()).get('priya')!;
    const input = { title: 'Retry transaction', slug: 'retry-transaction', prefix: 'retry', description: '' };
    const init = vi.spyOn(ontologyStore, 'init');
    const realTransaction = db.transaction;
    const transaction = vi.spyOn(db, 'transaction').mockImplementationOnce(async (fn) => realTransaction(async () => {
      await fn();
      throw new Error('commit failed');
    }));
    try {
      await expect(createProject(input, owner)).rejects.toThrow('commit failed');
      expect(init).toHaveResolved();
      expect(await get('ontologies', init.mock.calls[0][0].id)).toBeUndefined();
      const retry = await createProject(input, owner);
      expect(await ontologyStore.log(retry)).toHaveLength(1);
    } finally { init.mockRestore(); transaction.mockRestore(); }
  });

  it('discards initialization if activity creation fails, so the same slug can be retried with fresh history', async () => {
    const owner = (await simulation.ensurePersonas()).get('priya')!;
    const input = { title: 'Retry creation', slug: 'retry-creation', prefix: 'retry', description: 'A clean retry' };
    const init = vi.spyOn(ontologyStore, 'init');
    const activity = vi.spyOn(users, 'logActivity').mockRejectedValueOnce(new Error('activity insert failed'));
    try {
      await expect(createProject(input, owner)).rejects.toThrow('activity insert failed');
      expect(init).toHaveResolved();
      const failed = init.mock.calls[0][0];
      expect(await get('ontologies', failed.id)).toBeUndefined();
      expect(await list('memberships', failed.id)).toEqual([]);
      expect(await get('kv', `draft-head:${failed.slug}`)).toBeUndefined();
      await expect(ontologyStore.head(failed)).rejects.toThrow();
      const retry = await createProject(input, owner);
      expect(retry.id).not.toBe(failed.id);
      expect(await ontologyStore.log(retry)).toHaveLength(1);
      expect((await ontologyStore.working(retry)).metadata().title).toBe(input.title);
    } finally { init.mockRestore(); activity.mockRestore(); }
  });

  it('cleans up when initialisation itself fails part way, so the same slug can be retried', async () => {
    // Review r3: a failure inside init (after files were written, before its last row) skipped clean-up.
    const owner = (await simulation.ensurePersonas()).get('priya')!;
    const input = { title: 'Retry init', slug: 'retry-init', prefix: 'retry', description: '' };
    const realInit = ontologyStore.init.bind(ontologyStore);
    const init = vi.spyOn(ontologyStore, 'init').mockImplementationOnce(async (...args: Parameters<typeof ontologyStore.init>) => {
      await realInit(...args);
      throw new Error('draft head insert failed');
    });
    try {
      await expect(createProject(input, owner)).rejects.toThrow('draft head insert failed');
      const retry = await createProject(input, owner);
      expect(await ontologyStore.log(retry)).toHaveLength(1);
      expect((await ontologyStore.working(retry)).metadata().title).toBe(input.title);
    } finally { init.mockRestore(); }
  });

  it('never inherits an orphaned history left under a free slug', async () => {
    // Review r3: if clean-up never ran, the next creator with that slug inherited the failed creation's history.
    const owner = (await simulation.ensurePersonas()).get('priya')!;
    const orphan = { id: 'ont_orphan', slug: 'orphaned-slug' } as OntologyProject;
    await ontologyStore.init(orphan, '@prefix owl: <http://www.w3.org/2002/07/owl#> .\n<https://example.org/orphan> a owl:Ontology .\n', '# Orphan\n');
    const created = await createProject({ title: 'Fresh start', slug: 'orphaned-slug', prefix: 'fresh', description: '' }, owner);
    expect(await ontologyStore.log(created)).toHaveLength(1);
    expect((await ontologyStore.working(created)).metadata().title).toBe('Fresh start');
  });

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
      expect(await seeding).toHaveLength(SAMPLE_VOCABULARIES.length - 1);
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
      expect(projects.filter((p) => p.sample)).toHaveLength(SAMPLE_VOCABULARIES.length);
      expect(projects.every((p) => !staleIds.includes(p.id))).toBe(true);
      for (const { slug } of SAMPLE_VOCABULARIES) expect(projects.filter((p) => p.slug === slug)).toHaveLength(1);
    } finally { resume.resolve(); await staleSeed; render.mockRestore(); }
  });
});
