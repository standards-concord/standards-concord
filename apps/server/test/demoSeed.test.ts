import type { OntologyProject, UseCase } from '@concord/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { get, list, openDb, put, remove } from '../src/db.js';
import { createProject } from '../src/services/ontologies.js';
import { DEMO_SLUG, seedDemo } from '../src/services/simulation.js';
import { createUser } from '../src/services/users.js';

/**
 * Review r1 of step 5: seeding the demo took an existing demo ontology as a finished seed, but most of the seed is
 * written after the ontology. A function stopped part way (Vercel) left a partial demo that every later start-up
 * took as done. The seed now records that it is under way, and a seed cut short is cleared and run again.
 */
const demo = async () => (await list<OntologyProject>('ontologies')).find((o) => o.slug === DEMO_SLUG);

beforeAll(async () => {
  await openDb();
});

describe('seeding the demo', () => {
  it('seeds once, and a finished demo is left as it is', async () => {
    const first = await seedDemo();
    expect(first?.slug).toBe(DEMO_SLUG);
    expect(await get('kv', 'demo-seed-state')).toMatchObject({ state: 'done' });
    expect((await seedDemo())?.id).toBe(first?.id);
  });

  it('clears a seed cut short and seeds the demo again, whole', async () => {
    const before = await demo();
    const useCases = (await list<UseCase>('useCases', before!.id)).length;
    expect(useCases).toBeGreaterThan(0);
    // As a function stopped part way would leave it: the ontology there, the rest of the seed missing.
    for (const u of await list<UseCase>('useCases', before!.id)) await remove('useCases', u.id);
    await put('kv', { id: 'demo-seed-state', state: 'seeding' });
    const again = await seedDemo();
    expect(again?.id).not.toBe(before?.id);
    expect((await list<UseCase>('useCases', again!.id)).length).toBe(useCases);
    expect((await list<OntologyProject>('ontologies')).filter((o) => o.slug === DEMO_SLUG)).toHaveLength(1);
    expect(await get('kv', 'demo-seed-state')).toMatchObject({ state: 'done' });
  });

  it('clears nothing if other ontologies were added since, and says so', async () => {
    const owner = await createUser({ name: 'Seed Test Owner', provider: 'demo', subject: 'seed-owner' });
    const mine = await createProject({ title: 'Someone else’s ontology', description: 'Kept.', prefix: 'mine', domain: 'tests', governanceTemplate: 'working-group' } as never, owner);
    await put('kv', { id: 'demo-seed-state', state: 'seeding' });
    await expect(seedDemo()).rejects.toThrow(/cut short/);
    expect(await get('ontologies', mine.id)).toBeTruthy();
    expect(await demo()).toBeTruthy();
  });
});
