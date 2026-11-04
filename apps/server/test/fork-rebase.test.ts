import { applyChangeOps } from '@concord/core';
import type { ChangeOp } from '@concord/core/types';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { findProject } from '../src/services/ontologies.js';
import { ontologyStore } from '../src/services/ontologyStore.js';
import { seedDemo } from '../src/services/simulation.js';

/**
 * How forks behave when upstream moves: concurrent edits, conflicts, syncs
 * that would be inconsistent, closed forks, and migration only when upstream
 * has exactly what the fork has.
 */

const app = createApp();
type Agent = ReturnType<typeof request.agent>;
const VOL = 'https://w3id.org/odi/volunteering#';
const API = '/api/ontologies/volunteering/forks';

async function login(role: string, name: string): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/demo').send({ name, role });
  expect(res.status).toBe(200);
  return agent;
}

/** Commit straight to the main ontology, as a merged change request would. */
async function upstream(ops: ChangeOp[], message = 'Upstream change') {
  const p = findProject('volunteering')!;
  const g = applyChangeOps(await ontologyStore.working(p), ops, { author: 'Steward', date: '2026-11-04' }).graph;
  await ontologyStore.commitWorking(p, g, message, { name: 'Steward', email: 'steward@example.org' });
}

const addClass = (localName: string, label: string, extra: Partial<Extract<ChangeOp, { op: 'addClass' }>> = {}): ChangeOp => ({
  op: 'addClass',
  localName,
  label,
  definition: `A ${label}, used in tests of fork rebasing.`,
  ...extra,
});

let dev: Agent;
async function newFork(name: string) {
  const res = await dev.post(API).send({ name });
  expect(res.status).toBe(201);
  return `${API}/${res.body.slug}`;
}

beforeAll(async () => {
  openDb();
  await seedDemo();
  dev = await login('contributor', 'Rebase Rae');
});

describe('fork edits', () => {
  it('serialises concurrent edits, so neither is lost', async () => {
    const path = await newFork('Concurrent');
    const [a, b] = await Promise.all([
      dev.post(`${path}/edits`).send({ ops: [addClass('ConcurrentA', 'concurrent a')] }),
      dev.post(`${path}/edits`).send({ ops: [addClass('ConcurrentB', 'concurrent b')] }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const fork = (await request(app).get(path)).body;
    expect(fork.revision).toBe(2);
    expect(fork.ops).toHaveLength(2);
    expect(fork.history).toHaveLength(3);
    const ttl = (await request(app).get(`/def/volunteering/forks/${fork.slug}.ttl`)).text;
    expect(ttl).toContain('vol:ConcurrentA');
    expect(ttl).toContain('vol:ConcurrentB');
  });
});

describe('syncing with upstream', () => {
  it('reports a conflict when upstream changed the same term differently, and changes nothing', async () => {
    const path = await newFork('Skill wording');
    await dev.post(`${path}/edits`).send({ ops: [{ op: 'updateAnnotations', iri: `${VOL}Skill`, set: { definition: 'An ability a volunteer offers, as the fork words it.' } }] });
    await upstream([{ op: 'updateAnnotations', iri: `${VOL}Skill`, set: { definition: 'An ability a volunteer offers, as upstream words it.' } }]);

    const check = (await dev.get(`${path}/check`)).body;
    expect(check.outcome).toBe('resolve-conflicts');
    expect(check.conflicts).toEqual([expect.objectContaining({ curie: 'vol:Skill' })]);
    expect(check.fork.terms[0]).toMatchObject({ curie: 'vol:Skill', change: 'changed', upstream: 'diverged' });

    const before = (await request(app).get(path)).body;
    const sync = (await dev.post(`${path}/sync`)).body;
    expect(sync.synced).toBe(false);
    expect(sync.conflicts).toEqual([expect.objectContaining({ iri: `${VOL}Skill` })]);
    const after = (await request(app).get(path)).body;
    expect(after.head).toBe(before.head);
    expect(after.baseCommit).toBe(before.baseCommit);
    // Proposing a change that conflicts with the draft is refused too.
    const propose = await dev.post(`${path}/propose`).send({});
    expect(propose.status).toBe(409);
    expect(propose.body.error).toMatch(/vol:Skill/);

    // Resolve by discarding the fork's change, then sync.
    const discarded = await dev.post(`${path}/discard`).send({ terms: ['vol:Skill'] });
    expect(discarded.status).toBe(200);
    expect(discarded.body.ops).toHaveLength(0);
    const synced = (await dev.post(`${path}/sync`)).body;
    expect(synced.synced).toBe(true);
    const ttl = (await request(app).get(`/def/volunteering/forks/${after.slug}.ttl`)).text;
    expect(ttl).toContain('as upstream words it');
    expect(ttl).not.toContain('as the fork words it');
  });

  it('refuses a sync that would make the fork inconsistent', async () => {
    const path = await newFork('Example volunteers');
    // Each side is consistent on its own: a volunteer with a skill in the fork, and hasSkill's domain moved to organisations upstream.
    const edit = await dev.post(`${path}/edits`).send({
      ops: [
        { op: 'addIndividual', localName: 'firstAid', label: 'first aid', types: [`${VOL}Skill`] },
        { op: 'addIndividual', localName: 'exampleVolunteer', label: 'example volunteer', types: [`${VOL}Volunteer`], facts: { [`${VOL}hasSkill`]: [`${VOL}firstAid`] } },
      ],
    });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    await upstream([{ op: 'setDomainRange', iri: `${VOL}hasSkill`, domain: [`${VOL}Organisation`] }]);
    const before = (await request(app).get(path)).body;
    const sync = (await dev.post(`${path}/sync`)).body;
    expect(sync.synced).toBe(false);
    expect(sync.message).toMatch(/consistent/);
    expect(sync.conflicts[0].message).toMatch(/inconsistent/);
    expect((await request(app).get(path)).body.head).toBe(before.head);
  });

  it('drops edits that have landed, and only replays the rest on the new base', async () => {
    const path = await newFork('Partly upstream');
    await dev.post(`${path}/edits`).send({ ops: [addClass('LandsFirst', 'lands first')] });
    await dev.post(`${path}/edits`).send({ ops: [addClass('StillLocal', 'still local')] });
    await upstream([addClass('LandsFirst', 'lands first')]);
    const check = (await dev.get(`${path}/check`)).body;
    expect(check.outcome).toBe('sync-fork');
    expect(check.fork.terms).toEqual(
      expect.arrayContaining([expect.objectContaining({ curie: 'vol:LandsFirst', upstream: 'merged' }), expect.objectContaining({ curie: 'vol:StillLocal', upstream: 'not-proposed' })]),
    );
    const synced = (await dev.post(`${path}/sync`)).body;
    expect(synced.synced).toBe(true);
    expect(synced.fork.ops).toEqual([expect.objectContaining({ op: 'addClass', localName: 'StillLocal' })]);
    // Landed terms are still reported, so a later check can tell the app to switch.
    expect(synced.fork.terms).toEqual(expect.arrayContaining([expect.objectContaining({ curie: 'vol:LandsFirst', change: 'added', upstream: 'merged' })]));
    // Syncing again (after another upstream change) still works: old edits don't get replayed.
    await upstream([addClass('Unrelated', 'unrelated upstream class')]);
    expect((await dev.post(`${path}/sync`)).body.synced).toBe(true);
  });

  it('refuses to sync or edit a closed fork', async () => {
    const path = await newFork('Closed one');
    await upstream([addClass('AfterClosing', 'after closing')]);
    await dev.post(`${path}/close`);
    const sync = await dev.post(`${path}/sync`);
    expect(sync.status).toBe(409);
    const edit = await dev.post(`${path}/edits`).send({ ops: [addClass('NotAllowed', 'not allowed')] });
    expect(edit.status).toBe(409);
    expect((await dev.get(`${path}/check`)).body.outcome).toBe('fork-closed');
  });
});

describe('migration', () => {
  it('does not migrate when upstream has a different version of the term than the fork', async () => {
    const path = await newFork('Renamed in review');
    await dev.post(`${path}/edits`).send({ ops: [addClass('ShiftPattern', 'shift pattern')] });
    // Review renamed it before merging.
    await upstream([addClass('RotaPattern', 'shift pattern')]);
    const check = (await dev.get(`${path}/check`)).body;
    expect(check.outcome).not.toMatch(/^switch-/);
    expect(check.replace).toEqual([]);
    expect(check.fork.terms[0]).toMatchObject({ curie: 'vol:ShiftPattern', upstream: 'not-proposed' });
  });

  it('does not migrate when the fork changed a term again after proposing it', async () => {
    const path = await newFork('Edited after proposing');
    await dev.post(`${path}/edits`).send({ ops: [addClass('Rota', 'rota')] });
    await dev.post(`${path}/edits`).send({ ops: [{ op: 'updateAnnotations', iri: `${VOL}Rota`, set: { definition: 'A rota of shifts, as edited after proposing.' } }] });
    // Upstream merged only the first version of the term.
    await upstream([addClass('Rota', 'rota')]);
    const check = (await dev.get(`${path}/check`)).body;
    expect(check.outcome).not.toMatch(/^switch-/);
    expect(check.fork.terms[0].upstream).not.toBe('merged');
  });

  it('shows a term added after the others landed as still to propose', async () => {
    const path = await newFork('More after landing');
    await dev.post(`${path}/edits`).send({ ops: [addClass('FirstTerm', 'first term')] });
    await upstream([addClass('FirstTerm', 'first term')]);
    expect((await dev.get(`${path}/check`)).body.outcome).toBe('switch-to-draft');
    await dev.post(`${path}/edits`).send({ ops: [addClass('SecondTerm', 'second term')] });
    const check = (await dev.get(`${path}/check`)).body;
    expect(check.fork.status).toBe('active');
    expect(check.outcome).toBe('sync-fork');
    expect(check.fork.terms).toEqual(
      expect.arrayContaining([expect.objectContaining({ curie: 'vol:FirstTerm', upstream: 'merged' }), expect.objectContaining({ curie: 'vol:SecondTerm', upstream: 'not-proposed' })]),
    );
    expect(check.steps.join(' ')).toMatch(/propose/i);
  });

  it('every URL in a migration plan resolves', async () => {
    const path = await newFork('Resolvable');
    await dev.post(`${path}/edits`).send({ ops: [addClass('Resolvable', 'resolvable')] });
    await upstream([addClass('Resolvable', 'resolvable')]);
    const check = (await dev.get(`${path}/check`)).body;
    expect(check.outcome).toBe('switch-to-draft');
    expect(check.replace.length).toBeGreaterThan(1);
    for (const { to } of check.replace) {
      const res = await request(app).get(new URL(to).pathname);
      expect(res.status, to).toBe(200);
      expect(res.text, to).toMatch(/Resolvable/);
    }
    const released = await request(app).get('/def/volunteering/1.0.0.ttl');
    expect(released.status).toBe(200);
    expect(released.text).not.toContain('vol:Resolvable');
    expect((await request(app).get('/def/volunteering/latest').set('Accept', 'text/turtle')).status).toBe(200);
    expect((await request(app).get('/def/volunteering/9.9.9.ttl')).status).toBe(404);
    expect((await request(app).get('/def/volunteering/draft').set('Accept', 'text/html')).status).toBe(200);
  });
});
