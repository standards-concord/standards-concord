import { createHash } from 'node:crypto';
import type { OntologyProject, User } from '@concord/shared';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { get, list, openDb, put } from '../src/db.js';
import { createProject } from '../src/services/ontologies.js';
import { PERSONAS } from '../src/services/personas.js';
import { DEMO_DESCRIPTION, DEMO_SLUG, refreshPersonaProfiles, retireDemoDescriptions, seedDemo } from '../src/services/simulation.js';
import { defaultStartupTasks } from '../src/startup.js';
import { createUser } from '../src/services/users.js';

/**
 * The seed only creates the simulated people and the demo ontology, so when their wording changed in code a server
 * seeded earlier kept serving the old wording (in GET /api/personas, the session, the public catalogue). The
 * `demo-wording` start-up task now brings their profiles and a retired seed description up to date. The wording
 * here is stand-in text: the retired descriptions are known to the code only by their hashes.
 */
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const demo = async () => (await list<OntologyProject>('ontologies')).find((o) => o.demo && o.slug === DEMO_SLUG)!;
const personaUser = async (key: string) => (await list<User>('users')).find((u) => u.simulated && u.providers.some((p) => p.subject === `persona:${key}`))!;

// The demo ontology is shared with later test files: put its description back even when a test fails.
const restore: OntologyProject[] = [];
beforeAll(async () => {
  await openDb();
  await seedDemo();
});
afterEach(async () => {
  for (const d of restore.splice(0)) await put('ontologies', { ...d, description: DEMO_DESCRIPTION });
});

describe('bringing the demo’s wording up to date', () => {
  it('gives simulated people the profile text in personas.ts, keeping everything else about them', async () => {
    const priya = await personaUser('priya');
    const daniel = await personaUser('daniel');
    await put('users', { ...priya, persona: 'Older wording for this person.', avatarUrl: '/avatars/kept.svg' });
    await put('users', { ...daniel, organisation: 'An older organisation' });

    expect(await refreshPersonaProfiles()).toBe(2);
    const spec = (key: string) => PERSONAS.find((p) => p.key === key)!;
    expect(await get<User>('users', priya.id)).toMatchObject({
      id: priya.id,
      name: priya.name,
      persona: spec('priya').persona,
      organisation: spec('priya').organisation,
      avatarUrl: '/avatars/kept.svg',
      providers: priya.providers,
      simulated: true,
    });
    expect(await get<User>('users', daniel.id)).toMatchObject({ persona: spec('daniel').persona, organisation: spec('daniel').organisation });
    // Nothing left to change: a second run (every start on the VM) writes nothing.
    expect(await refreshPersonaProfiles()).toBe(0);
  });

  it('leaves people who are not simulated alone, even with a persona’s name and sign-in, and other simulated people too', async () => {
    const spec = PERSONAS[0];
    const lookalike = await createUser({ name: spec.name, organisation: 'Their own organisation', provider: 'demo', subject: `lookalike-${Date.now()}` });
    // Not simulated, though it carries a persona's sign-in: it must not be taken for the persona.
    await put('users', { ...lookalike, providers: [{ provider: 'demo', subject: `persona:${spec.key}` }] });
    const visitor = await createUser({ name: `Simulated visitor ${Date.now()}`, organisation: 'Somewhere', provider: 'demo', subject: `visitor-${Date.now()}` });
    await put('users', { ...visitor, simulated: true });
    await refreshPersonaProfiles();
    expect(await get<User>('users', lookalike.id)).toMatchObject({ organisation: 'Their own organisation' });
    expect((await get<User>('users', lookalike.id))?.persona).toBeUndefined();
    expect(await get<User>('users', visitor.id)).toMatchObject({ organisation: 'Somewhere' });
    await put('users', { ...lookalike, providers: lookalike.providers });
  });

  it('replaces a retired seed description of the demo ontology, and only that', async () => {
    const retiredText = `Older seeded description ${Date.now()}.`;
    const retired = new Set([sha256(retiredText)]);
    const d = await demo();
    restore.push(d);
    await put('ontologies', { ...d, description: retiredText });
    const owner = await createUser({ name: 'Wording Test Owner', provider: 'demo', subject: `wording-owner-${Date.now()}` });
    const other = await createProject({ title: 'Not the demo', description: retiredText, prefix: 'notdemo', domain: 'tests', governanceTemplate: 'working-group' } as never, owner);

    expect(await retireDemoDescriptions(retired)).toBe(1);
    const after = await get<OntologyProject>('ontologies', d.id);
    expect(after?.description).toBe(DEMO_DESCRIPTION);
    expect(after?.title).toBe(d.title);
    expect(after?.governance).toEqual(d.governance);
    // Another ontology with the same text is someone else's to describe.
    expect((await get<OntologyProject>('ontologies', other.id))?.description).toBe(retiredText);
    expect(await retireDemoDescriptions(retired)).toBe(0);
  });

  it('leaves a demo description a steward has edited', async () => {
    const d = await demo();
    restore.push(d);
    const edited = `A steward’s own description ${Date.now()}.`;
    await put('ontologies', { ...d, description: edited });
    expect(await retireDemoDescriptions(new Set([sha256(`Older seeded description.`)]))).toBe(0);
    expect((await get<OntologyProject>('ontologies', d.id))?.description).toBe(edited);
  });

  it('runs at start-up after the demo seed, and the personas list then shows the current wording', async () => {
    const tasks = await defaultStartupTasks();
    const names = tasks.map((t) => t.name);
    expect(names.indexOf('demo-wording')).toBeGreaterThan(names.indexOf('demo-seed'));
    expect(names.indexOf('demo-seed')).toBeGreaterThanOrEqual(0);

    const tom = await personaUser('tom');
    await put('users', { ...tom, persona: 'Older wording for Tom.' });
    await tasks.find((t) => t.name === 'demo-wording')!.run();

    const res = await request(createApp()).get('/api/personas');
    expect(res.status).toBe(200);
    for (const spec of PERSONAS) {
      const shown = (res.body as { key: string; persona: string; organisation: string }[]).find((p) => p.key === spec.key);
      expect(shown).toMatchObject({ persona: spec.persona, organisation: spec.organisation });
    }
  });
});
