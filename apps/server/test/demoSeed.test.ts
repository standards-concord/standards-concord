import type { ActivityItem, OntologyProject, UseCase, User } from '@concord/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { get, list, openDb, put, remove } from '../src/db.js';
import { createProject } from '../src/services/ontologies.js';
import { DEMO_SLUG, seedDemo } from '../src/services/simulation.js';
import { createUser } from '../src/services/users.js';
import { clock } from '../src/clock.js';

/**
 * Review r1 of step 5: seeding the demo took an existing demo ontology as a finished seed, but most of the seed is
 * written after the ontology. A function stopped part way (Vercel) left a partial demo that every later start-up
 * took as done. The seed now records that it is under way, and a seed cut short is cleared and run again. Review r2:
 * clearing it emptied the whole database (accounts, feedback, the import marker); now only the unfinished demo goes.
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
    // Future activity was reported in the demo. The seed advances 17 of its 21 shifted days;
    // keep its entire history before the shared clock, which seeding must never advance.
    const activity = await list<ActivityItem>('activity', first!.id);
    expect(activity.length).toBeGreaterThan(0);
    expect(activity.every((a) => Date.parse(a.at) < clock.now().getTime())).toBe(true);
    expect(clock.offsetMs).toBe(0);
  });

  it('clears a seed cut short and seeds the demo again, whole', async () => {
    const before = await demo();
    const useCases = (await list<UseCase>('useCases', before!.id)).length;
    expect(useCases).toBeGreaterThan(0);
    // As a function stopped part way would leave it: the ontology there, the rest of the seed missing.
    for (const u of (await list<UseCase>('useCases', before!.id)).slice(1)) await remove('useCases', u.id);
    await put('kv', { id: 'demo-seed-state', state: 'seeding' });
    // Review r2 of step 5: clearing used to wipe the whole database. Saved meanwhile, and all kept now:
    const someone = await createUser({ name: 'Signed in meanwhile', provider: 'demo', subject: 'seed-meanwhile' });
    await put('feedback', { id: 'fb-meanwhile', testerId: someone.id, createdAt: new Date().toISOString(), answers: {} });
    await put('privateFiles', { id: `${someone.id}/notes.txt`, body: 'mine' });
    await put('kv', { id: 'ontology-import', verifiedAt: 'kept' });
    await put('kv', { id: 'lease:startup', holder: 'another instance', until: Date.now() + 60_000 });
    const personas = (await list<User>('users')).filter((u) => u.simulated).map((u) => u.id).sort();
    // Review r3 of step 5: reviews and votes are kept under a change request's or release's id, not the
    // ontology's, so they were left behind, orphaned, when the unfinished demo was cleared.
    const parents = [...(await list<{ id: string }>('changeRequests', before!.id)), ...(await list<{ id: string }>('releases', before!.id))].map((d) => d.id);
    const children = async () => (await Promise.all(parents.flatMap((p) => [list<{ id: string }>('reviews', p), list<{ id: string }>('votes', p)]))).flat();
    expect((await children()).length).toBeGreaterThan(0);

    const again = await seedDemo();
    expect(again?.id).not.toBe(before?.id);
    expect((await list<UseCase>('useCases', again!.id)).length).toBe(useCases);
    expect(await list<UseCase>('useCases', before!.id)).toEqual([]);
    expect((await list<UseCase>('useCases')).filter((u) => u.ontologyId === before!.id)).toEqual([]);
    expect((await list<OntologyProject>('ontologies')).filter((o) => o.slug === DEMO_SLUG)).toHaveLength(1);
    expect(await get('kv', 'demo-seed-state')).toMatchObject({ state: 'done' });
    expect(await children()).toEqual([]);
    expect(await get('users', someone.id)).toBeTruthy();
    expect(await get('feedback', 'fb-meanwhile')).toBeTruthy();
    expect(await get('privateFiles', `${someone.id}/notes.txt`)).toBeTruthy();
    expect(await get('kv', 'ontology-import')).toMatchObject({ verifiedAt: 'kept' });
    expect(await get('kv', 'lease:startup')).toMatchObject({ holder: 'another instance' });
    // The personas are reused, not made again.
    expect((await list<User>('users')).filter((u) => u.simulated).map((u) => u.id).sort()).toEqual(personas);
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
