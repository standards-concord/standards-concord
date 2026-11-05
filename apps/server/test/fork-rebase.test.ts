import { applyChangeOps } from '@concord/core';
import type { ChangeOp } from '@concord/core/types';
import type { ChangeRequest, OntologyFork } from '@concord/shared';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { clock } from '../src/clock.js';
import { config } from '../src/config.js';
import { get, HttpError, list, openDb, put, putIf, withFence } from '../src/db.js';
import { addReview, createChangeRequest, getCR, merge, saveChangeRequest, triage, updateOps } from '../src/services/changeRequests.js';
import { llm } from '../src/llm/provider.js';
import { getUser } from '../src/services/users.js';
import { forkDetail, forkSummary, forTests } from '../src/services/forks.js';
import { findProject } from '../src/services/ontologies.js';
import { checkoutTestHooks, ontologyStore } from '../src/services/ontologyStore.js';
import { seedDemo, step } from '../src/services/simulation.js';

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
/** Fork details need a signed-in user, like the rest of the API's private reads. */
let reader: Agent;
async function newFork(name: string) {
  const res = await dev.post(API).send({ name });
  expect(res.status).toBe(201);
  return `${API}/${res.body.slug}`;
}

beforeAll(async () => {
  openDb();
  await seedDemo();
  dev = await login('contributor', 'Rebase Rae');
  reader = await login('reviewer', 'Reader Rhi');
});

describe('fork edits', () => {
  it('serialises concurrent edits, so neither is lost', async () => {
    const path = await newFork('Concurrent');
    const [a, b] = await Promise.all([
      dev.post(`${path}/edits`).send({ ops: [addClass('ConcurrentA', 'concurrent a')] }),
      dev.post(`${path}/edits`).send({ ops: [addClass('ConcurrentB', 'concurrent b')] }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const fork = (await reader.get(path)).body;
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

    const before = (await reader.get(path)).body;
    const sync = (await dev.post(`${path}/sync`)).body;
    expect(sync.synced).toBe(false);
    expect(sync.conflicts).toEqual([expect.objectContaining({ iri: `${VOL}Skill` })]);
    const after = (await reader.get(path)).body;
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
    const before = (await reader.get(path)).body;
    const sync = (await dev.post(`${path}/sync`)).body;
    expect(sync.synced).toBe(false);
    expect(sync.message).toMatch(/consistent/);
    expect(sync.conflicts[0].message).toMatch(/inconsistent/);
    expect((await reader.get(path)).body.head).toBe(before.head);
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

describe('second review', () => {
  const fork = async (path: string) => (await reader.get(path)).body;

  it('a slow read never writes back an old version of the fork', async () => {
    const path = await newFork('Stale reads');
    const stale = structuredClone(get<OntologyFork>('forks', (await fork(path)).id)!);
    await dev.post(`${path}/edits`).send({ ops: [addClass('AfterTheRead', 'after the read')] });
    await forkSummary(stale);
    await forkDetail(stale);
    const now = get<OntologyFork>('forks', stale.id)!;
    expect(now.revision).toBe(1);
    expect(now.ops).toHaveLength(1);
    expect(now.head).toBe(ontologyStore.forkHead(findProject('volunteering')!, now.slug));
  });

  it('an edit prepared before the fork changed elsewhere is refused, in git and in the database', async () => {
    const path = await newFork('Other process');
    const p = findProject('volunteering')!;
    const before = await fork(path);
    // Another server process moves the branch: this process's next edit must not build on the old head.
    const g = await ontologyStore.forkGraph(p, before.slug);
    await ontologyStore.commitFork(p, before.slug, g, 'Edit from another process', { name: 'Other', email: 'o@example.org' }, { expectedParent: before.head });
    const edit = await dev.post(`${path}/edits`).send({ ops: [addClass('LostEdit', 'lost edit')] });
    expect(edit.status).toBe(409);
    // And a database record changed elsewhere (closed, here) is not overwritten.
    const path2 = await newFork('Closed elsewhere');
    const rec = get<OntologyFork>('forks', (await fork(path2)).id)!;
    const closedElsewhere = { ...rec, status: 'closed' as const, head: 'f'.repeat(40) };
    put('forks', closedElsewhere, rec.ontologyId);
    expect((await dev.post(`${path2}/edits`).send({ ops: [addClass('NotAfterClose', 'not after close')] })).status).toBe(409);
  });

  it('closing moves the branch, so an edit prepared before the close fails, and closing twice is refused', async () => {
    const path = await newFork('Close race');
    const p = findProject('volunteering')!;
    const before = await fork(path);
    expect((await dev.post(`${path}/close`)).status).toBe(200);
    const g = await ontologyStore.forkGraph(p, before.slug);
    await expect(ontologyStore.commitFork(p, before.slug, g, 'Late edit', { name: 'Late', email: 'l@example.org' }, { expectedParent: before.head })).rejects.toThrow(/changed/);
    expect((await dev.post(`${path}/close`)).status).toBe(409);
    expect((await fork(path)).status).toBe('closed');
  });

  it('a removal that would drop an axiom upstream added is a conflict, not a silent loss', async () => {
    await upstream([addClass('DeleteAnchor', 'delete anchor')]);
    const path = await newFork('Removes the anchor');
    await dev.post(`${path}/edits`).send({ ops: [{ op: 'removeTerm', iri: `${VOL}DeleteAnchor` }] });
    await upstream([addClass('NewUpstreamChild', 'new upstream child', { subClassOf: [`${VOL}DeleteAnchor`] })]);
    const before = await fork(path);
    const sync = (await dev.post(`${path}/sync`)).body;
    expect(sync.synced).toBe(false);
    expect(sync.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ curie: expect.stringMatching(/NewUpstreamChild|DeleteAnchor/) })]));
    expect((await fork(path)).head).toBe(before.head);
  });

  it('upstream adding a subclass of a term the fork rewords is not a conflict', async () => {
    const path = await newFork('Rewords cause');
    await dev.post(`${path}/edits`).send({ ops: [{ op: 'updateAnnotations', iri: `${VOL}Cause`, set: { definition: 'A cause, as the fork words it.' } }] });
    await upstream([addClass('ClimateCause', 'climate cause', { subClassOf: [`${VOL}Cause`] })]);
    const sync = (await dev.post(`${path}/sync`)).body;
    expect(sync.conflicts).toEqual([]);
    expect(sync.synced).toBe(true);
    const ttl = (await request(app).get(`/def/volunteering/forks/${sync.fork.slug}.ttl`)).text;
    expect(ttl).toContain('vol:ClimateCause');
    expect(ttl).toContain('as the fork words it');
  });

  it('an import given as a CURIE, or an explicit source, is compared exactly', async () => {
    const path = await newFork('Import and source');
    await dev.post(`${path}/edits`).send({ ops: [{ op: 'addImport', iri: 'owl:' }] });
    await dev.post(`${path}/edits`).send({ ops: [{ op: 'updateAnnotations', iri: `${VOL}Location`, set: { source: ['https://example.org/places-register'] } }] });
    const check = (await dev.get(`${path}/check`)).body;
    expect(check.outcome).not.toMatch(/^switch-/);
    expect(check.fork.terms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ iri: 'import:http://www.w3.org/2002/07/owl#', upstream: 'not-proposed' }),
        expect.objectContaining({ curie: 'vol:Location', upstream: 'not-proposed' }),
      ]),
    );
  });

  it('an edit that was undone drops out, so it can not conflict later', async () => {
    const p = findProject('volunteering')!;
    const path = await newFork('Undone');
    const original = (await ontologyStore.forkGraph(p, (await fork(path)).slug)).term(`${VOL}AccessibilityFeature`)!.definition!;
    await dev.post(`${path}/edits`).send({ ops: [{ op: 'updateAnnotations', iri: `${VOL}AccessibilityFeature`, set: { definition: 'Temporarily reworded.' } }] });
    const undone = await dev.post(`${path}/edits`).send({ ops: [{ op: 'updateAnnotations', iri: `${VOL}AccessibilityFeature`, set: { definition: original } }] });
    expect(undone.body.fork.ops).toEqual([]);
    expect(undone.body.fork.terms).toEqual([]);
    await upstream([{ op: 'updateAnnotations', iri: `${VOL}AccessibilityFeature`, set: { definition: 'Reworded upstream.' } }]);
    const sync = (await dev.post(`${path}/sync`)).body;
    expect(sync.synced).toBe(true);
  });

  it('refuses fork changes when the full OWL reasoner is required but cannot run', async () => {
    const path = await newFork('No reasoner');
    const prev = { require: config.requireFullReasoner, python: process.env.CONCORD_PYTHON };
    config.requireFullReasoner = true;
    process.env.CONCORD_PYTHON = '/nonexistent/python';
    try {
      const edit = await dev.post(`${path}/edits`).send({ ops: [addClass('Unchecked', 'unchecked')] });
      expect(edit.status).toBe(503);
      expect(edit.body.error).toMatch(/reasoner/);
      expect((await fork(path)).revision).toBe(0);
    } finally {
      config.requireFullReasoner = prev.require;
      if (prev.python === undefined) delete process.env.CONCORD_PYTHON;
      else process.env.CONCORD_PYTHON = prev.python;
    }
    // Where the reasoner is optional, the edit goes through and says how it was checked.
    const edit = await dev.post(`${path}/edits`).send({ ops: [addClass('Checked', 'checked')] });
    expect(edit.status).toBe(200);
    expect(['owl', 'structural']).toContain(edit.body.validation.reasoner);
  });

  it('discards only the named header field, and asks before discarding other terms changed in the same edit', async () => {
    const path = await newFork('Discard scope');
    await dev.post(`${path}/edits`).send({ ops: [{ op: 'setMetadata', set: { title: 'Fork title', description: 'Fork description' } }] });
    const r = await dev.post(`${path}/discard`).send({ terms: ['meta:title'] });
    expect(r.status).toBe(200);
    expect(r.body.ops).toEqual([{ op: 'setMetadata', set: { description: 'Fork description' } }]);
    const ttl = (await request(app).get(`/def/volunteering/forks/${r.body.slug}.ttl`)).text;
    expect(ttl).toContain('Fork description');
    expect(ttl).not.toContain('Fork title');

    await dev.post(`${path}/edits`).send({ ops: [addClass('LeftOne', 'left one'), addClass('RightOne', 'right one')] });
    await dev.post(`${path}/edits`).send({ ops: [{ op: 'addDisjointness', classes: [`${VOL}LeftOne`, `${VOL}RightOne`] }] });
    const asks = await dev.post(`${path}/discard`).send({ terms: ['vol:LeftOne'] });
    expect(asks.status).toBe(409);
    expect(asks.body.error).toMatch(/vol:RightOne/);
  });
});

describe('third review', () => {
  const fork = async (path: string) => (await reader.get(path)).body;

  it('saves are an atomic compare-and-swap on the record version, and a lost save undoes its commit', async () => {
    const path = await newFork('Atomic save');
    const p = findProject('volunteering')!;
    const f = get<OntologyFork>('forks', (await fork(path)).id)!;
    const snapshot = { seq: f.seq };
    // Another process closes the fork after this one read it.
    expect(putIf('forks', { ...f, status: 'closed', seq: (f.seq ?? 0) + 1 }, 'seq', f.seq)).toBe(true);
    expect(putIf('forks', { ...f, status: 'active' }, 'seq', f.seq)).toBe(false);
    const before = ontologyStore.forkHead(p, f.slug);
    const graph = await ontologyStore.forkGraph(p, f.slug);
    await expect(
      forTests.commitAndSave(p, f, snapshot, () => ontologyStore.commitFork(p, f.slug, graph, 'Racing edit', { name: 'Racer', email: 'r@example.org' }, { expectedParent: before })),
    ).rejects.toThrow(/changed/);
    expect(ontologyStore.forkHead(p, f.slug)).toBe(before);
    expect(get<OntologyFork>('forks', f.id)!.status).toBe('closed');
  });

  it('two proposals at once open one change request', async () => {
    const path = await newFork('Double propose');
    await dev.post(`${path}/edits`).send({ ops: [addClass('ProposedOnce', 'proposed once')] });
    const [a, b] = await Promise.all([dev.post(`${path}/propose`).send({}), dev.post(`${path}/propose`).send({})]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.changeRequest.id).toBe(b.body.changeRequest.id);
    expect((await fork(path)).changeRequestIds).toHaveLength(1);
  });

  it('a header edit partly undone does not overwrite upstream on sync', async () => {
    const p = findProject('volunteering')!;
    const path = await newFork('Header undo');
    const title = (await ontologyStore.working(p)).metadata().title;
    await dev.post(`${path}/edits`).send({ ops: [{ op: 'setMetadata', set: { title: 'Temporary title', description: 'Fork description kept' } }] });
    await dev.post(`${path}/edits`).send({ ops: [{ op: 'setMetadata', set: { title } }] });
    expect((await fork(path)).ops).toEqual([{ op: 'setMetadata', set: { description: 'Fork description kept' } }]);
    await upstream([{ op: 'setMetadata', set: { title: 'Upstream title' } }]);
    const sync = (await dev.post(`${path}/sync`)).body;
    expect(sync.conflicts).toEqual([]);
    expect(sync.synced).toBe(true);
    const ttl = (await request(app).get(`/def/volunteering/forks/${sync.fork.slug}.ttl`)).text;
    expect(ttl).toContain('Upstream title');
    expect(ttl).not.toContain('Temporary title');
    expect(ttl).toContain('Fork description kept');
  });

  it('a requested source that looks like a stamp is still compared', async () => {
    const path = await newFork('Manual source');
    await dev.post(`${path}/edits`).send({ ops: [{ op: 'updateAnnotations', iri: `${VOL}Role`, set: { source: ['manual#42'] } }] });
    const check = (await dev.get(`${path}/check`)).body;
    expect(check.outcome).not.toMatch(/^switch-/);
    expect(check.fork.terms).toEqual([expect.objectContaining({ curie: 'vol:Role', upstream: 'not-proposed' })]);
  });

  it('sync reports the reasoner being down as an error, not as an inconsistency', async () => {
    const path = await newFork('Sync without reasoner');
    await dev.post(`${path}/edits`).send({ ops: [addClass('SyncNeedsReasoner', 'sync needs reasoner')] });
    await upstream([addClass('MeanwhileUpstream', 'meanwhile upstream')]);
    const prev = { require: config.requireFullReasoner, python: process.env.CONCORD_PYTHON };
    config.requireFullReasoner = true;
    process.env.CONCORD_PYTHON = '/nonexistent/python';
    try {
      const sync = await dev.post(`${path}/sync`);
      expect(sync.status).toBe(503);
    } finally {
      config.requireFullReasoner = prev.require;
      if (prev.python === undefined) delete process.env.CONCORD_PYTHON;
      else process.env.CONCORD_PYTHON = prev.python;
    }
  });

  it('discarding everything needs no extra confirmation', async () => {
    const path = await newFork('Discard all');
    await dev.post(`${path}/edits`).send({ ops: [addClass('GoneSoon', 'gone soon')] });
    const all = await dev.post(`${path}/discard`).send({ all: true });
    expect(all.status).toBe(200);
    expect(all.body.ops).toEqual([]);
  });

  it('an indirect conflict names the change to discard, and discarding it resolves the conflict', async () => {
    await upstream([addClass('SecondAnchor', 'second anchor')]);
    const path = await newFork('Indirect resolve');
    await dev.post(`${path}/edits`).send({ ops: [{ op: 'removeTerm', iri: `${VOL}SecondAnchor` }] });
    await upstream([addClass('SecondChild', 'second child', { subClassOf: [`${VOL}SecondAnchor`] })]);
    const sync = (await dev.post(`${path}/sync`)).body;
    const indirect = sync.conflicts.find((c: { curie: string }) => c.curie === 'vol:SecondChild');
    expect(indirect.discard).toEqual([`${VOL}SecondAnchor`]);
    expect(indirect.discardLabels).toEqual(['vol:SecondAnchor']);
    expect((await dev.post(`${path}/discard`).send({ terms: indirect.discard })).status).toBe(200);
    expect((await dev.post(`${path}/sync`)).body.synced).toBe(true);
  });

  it('migration advice covers code that fetches without an Accept header', async () => {
    const path = await newFork('Wildcard advice');
    await dev.post(`${path}/edits`).send({ ops: [addClass('WildcardTerm', 'wildcard term')] });
    await upstream([addClass('WildcardTerm', 'wildcard term')]);
    const check = (await dev.get(`${path}/check`)).body;
    expect(check.outcome).toBe('switch-to-draft');
    expect(check.steps.join(' ')).toMatch(/draft\.ttl/);
  });
});

describe('fourth review', () => {
  const fork = async (path: string) => (await reader.get(path)).body;

  it('a proposal in progress elsewhere holds the fork until it finishes or its lease runs out', async () => {
    const path = await newFork('Lease');
    await dev.post(`${path}/edits`).send({ ops: [addClass('LeasedTerm', 'leased term')] });
    const f = get<OntologyFork>('forks', (await fork(path)).id)!;
    // Another server process has started proposing the fork.
    expect(putIf('forks', { ...f, proposing: { until: Date.now() + 60_000 }, seq: (f.seq ?? 0) + 1 }, 'seq', f.seq)).toBe(true);
    for (const [route, body] of [
      ['edits', { ops: [addClass('WhileProposing', 'while proposing')] }],
      ['propose', {}],
      ['sync', {}],
      ['discard', { all: true }],
      ['close', {}],
    ] as const) {
      const res = await dev.post(`${path}/${route}`).send(body);
      expect(res.status, route).toBe(409);
      expect(res.body.error, route).toMatch(/being proposed/);
    }
    // That process stopped without finishing: once the lease has run out the fork is usable again.
    const held = get<OntologyFork>('forks', f.id)!;
    expect(putIf('forks', { ...held, proposing: { until: Date.now() - 1 }, seq: (held.seq ?? 0) + 1 }, 'seq', held.seq)).toBe(true);
    expect((await dev.post(`${path}/edits`).send({ ops: [addClass('AfterLease', 'after lease')] })).status).toBe(200);
    const proposed = await dev.post(`${path}/propose`).send({});
    expect(proposed.status).toBe(200);
    expect(get<OntologyFork>('forks', f.id)!.proposing).toBeUndefined();
  });

  it.each([
    ['issued', '2026-01-01', '2026-02-02'],
    ['backwardCompatibleWith', 'https://w3id.org/odi/volunteering/0.9.0', 'https://w3id.org/odi/volunteering/0.8.0'],
    ['incompatibleWith', 'https://w3id.org/odi/volunteering/0.7.0', 'https://w3id.org/odi/volunteering/0.6.0'],
  ])('competing edits to the header field %s conflict on sync', async (field, mine, theirs) => {
    const path = await newFork(`Header ${field}`);
    const set = (v: string) => ({ [field]: field === 'issued' ? v : [v] });
    expect((await dev.post(`${path}/edits`).send({ ops: [{ op: 'setMetadata', set: set(mine) }] })).status).toBe(200);
    await upstream([{ op: 'setMetadata', set: set(theirs) } as ChangeOp]);
    const sync = (await dev.post(`${path}/sync`)).body;
    expect(sync.synced).toBe(false);
    expect(sync.conflicts).toEqual([expect.objectContaining({ iri: `meta:${field}` })]);
  });

  it('fields the fork stamps itself cannot be edited on a fork', async () => {
    const path = await newFork('Own version');
    const res = await dev.post(`${path}/edits`).send({ ops: [{ op: 'setMetadata', set: { versionInfo: '9.9.9' } }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/versionInfo/);
  });

  it('a source naming a real change request is generated only where that request created the term', async () => {
    const p = findProject('volunteering')!;
    const open = list<{ number: number; status: string }>('changeRequests', p.id).find((cr) => !['merged', 'released'].includes(cr.status));
    expect(open).toBeDefined();
    const path = await newFork('Cites a request');
    await dev.post(`${path}/edits`).send({ ops: [{ op: 'updateAnnotations', iri: `${VOL}Role`, set: { source: [`volunteering#${open!.number}`] } }] });
    expect((await fork(path)).ops).toHaveLength(1);
    await upstream([addClass('UnrelatedMeanwhile', 'unrelated meanwhile')]);
    const check = (await dev.get(`${path}/check`)).body;
    expect(check.outcome).not.toMatch(/^switch-/);
    expect(check.fork.terms).toEqual([expect.objectContaining({ curie: 'vol:Role', upstream: 'not-proposed' })]);
  });

  it('discarding everything also drops header-only edits', async () => {
    const p = findProject('volunteering')!;
    const issued = (await ontologyStore.working(p)).metadata().issued;
    const path = await newFork('Discard header too');
    await dev.post(`${path}/edits`).send({ ops: [addClass('WithHeader', 'with header'), { op: 'setMetadata', set: { issued: '2026-03-03' } }] });
    const all = await dev.post(`${path}/discard`).send({ all: true });
    expect(all.status).toBe(200);
    expect(all.body.ops).toEqual([]);
    const f = get<OntologyFork>('forks', all.body.id)!;
    expect((await ontologyStore.forkGraph(p, f.slug)).metadata().issued).toEqual(issued);
    expect((await dev.post(`${path}/discard`).send({ all: true })).body.error).toMatch(/no changes to discard/);
  });

  it('does not recommend a release that lacks draft terms the fork was created with', async () => {
    await upstream([addClass('InheritedKept', 'inherited kept'), addClass('InheritedRemoved', 'inherited removed')]);
    const path = await newFork('Inherited content');
    await dev.post(`${path}/edits`).send({ ops: [{ op: 'removeTerm', iri: `${VOL}InheritedRemoved` }] });
    const check = (await dev.get(`${path}/check`)).body;
    expect(check.outcome).not.toBe('switch-to-release');
    expect(check.replace.map((r: { to: string }) => r.to).join(' ')).not.toMatch(/1\.0\.0/);
    expect(check.message).toMatch(/InheritedKept/);
  });
});

describe('fifth review', () => {
  const fork = async (path: string) => (await reader.get(path)).body;
  const record = async (path: string) => get<OntologyFork>('forks', (await fork(path)).id)!;
  /** Change the stored fork as another server process would (a conditional save). */
  const elsewhere = (f: OntologyFork, patch: Partial<OntologyFork>) => {
    const next = { ...f, ...patch, seq: (f.seq ?? 0) + 1 };
    expect(putIf('forks', next, 'seq', f.seq)).toBe(true);
    return next;
  };

  it('a proposal that lost its lease cannot write over a newer proposal', async () => {
    const path = await newFork('Fenced');
    await dev.post(`${path}/edits`).send({ ops: [addClass('FencedOne', 'fenced one')] });
    const f = await record(path);
    // Process A takes the lease, then stalls past its expiry.
    const a = elsewhere(f, { proposing: { until: Date.now() - 1 } });
    // Process B proposes meanwhile, with an extra edit.
    await dev.post(`${path}/edits`).send({ ops: [addClass('FencedTwo', 'fenced two')] });
    const b = await dev.post(`${path}/propose`).send({ title: 'B’s proposal' });
    expect(b.status).toBe(200);
    const crId = b.body.changeRequest.id;
    expect(getCR(crId).ops).toHaveLength(2);
    // A wakes up and writes its (older) edits to the request: refused, and nothing changes.
    const fence = () => {
      if (get<OntologyFork>('forks', f.id)?.seq !== a.seq) throw new HttpError(409, 'lost the lease');
    };
    const owner = getUser(f.ownerId)!;
    await expect(withFence(fence, () => updateOps(getCR(crId), owner, { ops: [addClass('FencedOne', 'fenced one')], title: 'A’s proposal' }))).rejects.toThrow(/lost the lease/);
    expect(getCR(crId).ops).toHaveLength(2);
    expect(getCR(crId).title).toBe('B’s proposal');
  });

  it('proposing again after an interrupted proposal picks up its request instead of opening another', async () => {
    const path = await newFork('Interrupted');
    await dev.post(`${path}/edits`).send({ ops: [addClass('Interrupted', 'interrupted')] });
    const f = await record(path);
    const p = findProject('volunteering')!;
    // The proposing process created and submitted the request, then stopped before recording it.
    const orphan = await createChangeRequest(p, getUser(f.ownerId)!, { title: 'Interrupted', description: 'x', kind: 'feature', origin: { type: 'fork', forkId: f.id, forkSlug: f.slug }, ops: f.ops, submit: true });
    expect((await fork(path)).changeRequestIds).toEqual([orphan.id]);
    const again = await dev.post(`${path}/propose`).send({});
    expect(again.status).toBe(200);
    expect(again.body.changeRequest.id).toBe(orphan.id);
    const open = list<{ status: string; origin: { forkId?: string } }>('changeRequests', p.id).filter((cr) => cr.origin.forkId === f.id && cr.status !== 'withdrawn');
    expect(open).toHaveLength(1);
  });

  it('stored edits to fields the fork stamps itself never reach a proposal', async () => {
    const path = await newFork('Legacy setter');
    await dev.post(`${path}/edits`).send({ ops: [addClass('LegacySetter', 'legacy setter')] });
    const f = await record(path);
    // Stored before such edits were refused.
    elsewhere(f, { ops: [...f.ops, { op: 'setMetadata', set: { versionInfo: '9.9.9', priorVersion: 'https://example.org/x', modified: '2020-01-01', versionIRI: 'https://example.org/y' } }] });
    const proposed = await dev.post(`${path}/propose`).send({});
    expect(proposed.status).toBe(200);
    expect(JSON.stringify(getCR(proposed.body.changeRequest.id).ops)).not.toMatch(/versionInfo|priorVersion|modified|versionIRI/);
  });

  it('discarding everything also drops stored edits that have nothing to compare', async () => {
    const path = await newFork('Discard legacy');
    await dev.post(`${path}/edits`).send({ ops: [addClass('DiscardLegacy', 'discard legacy')] });
    const f = await record(path);
    elsewhere(f, { ops: [...f.ops, { op: 'setMetadata', set: { versionInfo: '9.9.9' } }] });
    const all = await dev.post(`${path}/discard`).send({ all: true });
    expect(all.status).toBe(200);
    expect(all.body.ops).toEqual([]);
  });

  it('a requested source spelled like the fork’s own provenance is compared', async () => {
    const path = await newFork('Own tag');
    const slug = path.split('/').at(-1);
    await dev.post(`${path}/edits`).send({ ops: [addClass('OwnTag', 'own tag', { source: [`volunteering fork ${slug}`] })] });
    await upstream([addClass('OwnTag', 'own tag')]);
    const sync = (await dev.post(`${path}/sync`)).body;
    expect(sync.synced).toBe(false);
    expect(sync.conflicts).toEqual([expect.objectContaining({ curie: 'vol:OwnTag' })]);
  });

  it('a source re-added after upstream removed it is still an edit', async () => {
    const p = findProject('volunteering')!;
    await upstream([addClass('ReSourced', 'resourced', { source: ['volunteering#1'] })]);
    await upstream([{ op: 'updateAnnotations', iri: `${VOL}ReSourced`, set: { source: [] } }]);
    expect((await ontologyStore.working(p)).term(`${VOL}ReSourced`)!.source ?? []).toEqual([]);
    const path = await newFork('Re-source');
    const res = await dev.post(`${path}/edits`).send({ ops: [{ op: 'updateAnnotations', iri: `${VOL}ReSourced`, set: { source: ['volunteering#1'] } }] });
    expect(res.status).toBe(200);
    expect((await fork(path)).ops).toHaveLength(1);
  });

  it('generated provenance follows a rename: the same add-then-rename upstream has landed', async () => {
    const path = await newFork('Rename provenance');
    const ops: ChangeOp[] = [addClass('BeforeRename', 'renamed term'), { op: 'renameTerm', iri: `${VOL}BeforeRename`, newLocalName: 'AfterRename' }];
    expect((await dev.post(`${path}/edits`).send({ ops })).status).toBe(200);
    // Upstream merges the same edits through a change request, which stamps its own provenance.
    const p = findProject('volunteering')!;
    // Same day as the fork's edit: a rename records its date, so a rename on another day is different content.
    const g = applyChangeOps(await ontologyStore.working(p), ops, { author: 'Steward', date: clock.iso().slice(0, 10), provenance: 'volunteering#999' }).graph;
    await ontologyStore.commitWorking(p, g, 'Merge the same edits', { name: 'Steward', email: 'steward@example.org' });
    const sync = (await dev.post(`${path}/sync`)).body;
    expect(sync.conflicts).toEqual([]);
    expect(sync.synced).toBe(true);
    expect((await dev.get(`${path}/check`)).body.outcome).toBe('switch-to-draft');
  });

  it('does not recommend a target that lacks an inherited term upstream has since removed', async () => {
    await upstream([addClass('InheritedThenDeleted', 'inherited then deleted')]);
    const path = await newFork('Inherited deleted');
    await dev.post(`${path}/edits`).send({ ops: [addClass('LandsLater', 'lands later')] });
    await upstream([addClass('LandsLater', 'lands later'), { op: 'removeTerm', iri: `${VOL}InheritedThenDeleted` }]);
    const check = (await dev.get(`${path}/check`)).body;
    expect(check.outcome).not.toMatch(/^switch-/);
    expect(check.message).toMatch(/InheritedThenDeleted/);
    // After syncing, the fork no longer has it either, and switching is safe.
    expect((await dev.post(`${path}/sync`)).body.synced).toBe(true);
    expect((await dev.get(`${path}/check`)).body.outcome).toBe('switch-to-draft');
  });
});

describe('sixth review', () => {
  const fork = async (path: string) => (await reader.get(path)).body;
  const record = async (path: string) => get<OntologyFork>('forks', (await fork(path)).id)!;
  const elsewhere = (f: OntologyFork, patch: Partial<OntologyFork>) => {
    const next = { ...f, ...patch, seq: (f.seq ?? 0) + 1 };
    expect(putIf('forks', next, 'seq', f.seq)).toBe(true);
    return next;
  };

  it.each([
    ['provenance', { op: 'updateAnnotations', iri: `${VOL}Role`, set: { mappings: { 'dcterms:provenance': ['urn:forged-record'] } } }],
    ['contributor', { op: 'updateAnnotations', iri: `${VOL}Role`, set: { mappings: { 'http://purl.org/dc/terms/contributor': ['urn:someone'] } } }],
  ])('edits cannot set recorded %s by hand', async (_, op) => {
    const path = await newFork(`Forge ${_}`);
    const res = await dev.post(`${path}/edits`).send({ ops: [op] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/recorded by Concord/);
  });

  it('discarding everything clears a fork whose only stored edit has nothing to replay', async () => {
    const path = await newFork('Legacy only');
    const f = await record(path);
    elsewhere(f, { ops: [{ op: 'setMetadata', set: { versionInfo: '9.9.9' } }] });
    const all = await dev.post(`${path}/discard`).send({ all: true });
    expect(all.status).toBe(200);
    expect(all.body.ops).toEqual([]);
    expect(get<OntologyFork>('forks', f.id)!.ops).toEqual([]);
  });

  it('a change request saved from an old copy is refused, whoever saves it', async () => {
    const path = await newFork('Request editor race');
    await dev.post(`${path}/edits`).send({ ops: [addClass('EditorRace', 'editor race')] });
    const crId = (await dev.post(`${path}/propose`).send({})).body.changeRequest.id;
    const stale = getCR(crId); // a slow writer (a proposal's triage, say) holds this copy
    // Someone edits the request through the ordinary request editor.
    const edited = await dev.patch(`/api/change-requests/${crId}`).send({ title: 'Edited in the request editor' });
    expect(edited.status).toBe(200);
    const owner = getUser(get<OntologyFork>('forks', (await fork(path)).id)!.ownerId)!;
    await expect(updateOps(stale, owner, { title: 'Stale title' })).rejects.toThrow(/changed by someone else/);
    expect(getCR(crId).title).toBe('Edited in the request editor');
  });

  it('the proposal fence refuses a proposal’s writes once the fork has moved on', async () => {
    const path = await newFork('Production fence');
    await dev.post(`${path}/edits`).send({ ops: [addClass('ProductionFence', 'production fence')] });
    const crId = (await dev.post(`${path}/propose`).send({})).body.changeRequest.id;
    const f = await record(path);
    const fence = forTests.proposalFence(f.id, { seq: f.seq });
    const owner = getUser(f.ownerId)!;
    elsewhere(f, {});
    await expect(withFence(fence, () => updateOps(getCR(crId), owner, { title: 'From a stalled proposal' }))).rejects.toThrow(/lost its hold/);
    expect(getCR(crId).title).not.toBe('From a stalled proposal');
  });
});

describe('seventh review', () => {
  const fork = async (path: string) => (await reader.get(path)).body;
  const record = async (path: string) => get<OntologyFork>('forks', (await fork(path)).id)!;
  const elsewhere = (f: OntologyFork, patch: Partial<OntologyFork>) => {
    const next = { ...f, ...patch, seq: (f.seq ?? 0) + 1 };
    expect(putIf('forks', next, 'seq', f.seq)).toBe(true);
    return next;
  };
  /** Runs `during` once, the first time a read of the draft happens while `when` holds. */
  async function interleave<T>(when: () => boolean, during: () => Promise<void> | void, fn: () => Promise<T>): Promise<T> {
    // Every read of the draft (working, and a merge's read at its exact base) goes through graphAt.
    const original = ontologyStore.graphAt;
    let done = false;
    ontologyStore.graphAt = async function (this: typeof ontologyStore, ...args: Parameters<typeof original>) {
      if (!done && when()) {
        done = true;
        await during();
      }
      return original.apply(this, args);
    };
    try {
      return await fn();
    } finally {
      ontologyStore.graphAt = original;
    }
  }
  const proposeFrom = async (name: string, localName: string) => {
    const path = await newFork(name);
    await dev.post(`${path}/edits`).send({ ops: [addClass(localName, localName.toLowerCase())] });
    const crId = (await dev.post(`${path}/propose`).send({})).body.changeRequest.id as string;
    return { path, crId };
  };
  const approve = (id: string) => {
    const c = getCR(id);
    c.status = 'approved';
    saveChangeRequest(c);
  };

  it('a proposal that loses its lease mid-way writes nothing (the production fence)', async () => {
    const path = await newFork('Lease lost mid-way');
    await dev.post(`${path}/edits`).send({ ops: [addClass('LeaseLost', 'lease lost')] });
    const f = await record(path);
    const res = await interleave(
      () => !!get<OntologyFork>('forks', f.id)?.proposing,
      () => {
        // The lease runs out and another process changes the fork.
        elsewhere(get<OntologyFork>('forks', f.id)!, { proposing: undefined });
      },
      () => dev.post(`${path}/propose`).send({}),
    );
    expect(res.status).toBe(409);
    const p = findProject('volunteering')!;
    expect(list<{ origin: { forkId?: string } }>('changeRequests', p.id).filter((cr) => cr.origin.forkId === f.id)).toEqual([]);
  });

  it('a merge from an out-of-date copy of a request changes nothing', async () => {
    const p = findProject('volunteering')!;
    const { crId } = await proposeFrom('Stale merge', 'StaleMerge');
    approve(crId);
    const stale = getCR(crId);
    // Someone saves an edit to the request after the merge read it.
    const edited = getCR(crId);
    edited.title = 'Edited before the merge finished';
    saveChangeRequest(edited);
    const head = ontologyStore.head(p);
    await expect(merge(stale, undefined)).rejects.toThrow(/changed by someone else/);
    expect(ontologyStore.head(p)).toBe(head);
    expect((await ontologyStore.working(p)).term(`${VOL}StaleMerge`)).toBeUndefined();
    expect(getCR(crId).status).toBe('approved');
  });

  it('while a merge holds a request, other saves are refused, and the merge records exactly what it committed', async () => {
    const p = findProject('volunteering')!;
    const { crId } = await proposeFrom('Held merge', 'HeldMerge');
    approve(crId);
    const owner = getUser(getCR(crId).authorId)!;
    let refused: unknown;
    const merged = await interleave(
      () => !!getCR(crId).merging,
      async () => {
        refused = await updateOps(getCR(crId), owner, { ops: [addClass('Replacement', 'replacement')] }).catch((e: Error) => e);
      },
      () => merge(getCR(crId), undefined),
    );
    expect(String(refused)).toMatch(/being merged/);
    expect(merged.status).toBe('merged');
    expect(getCR(crId).merging).toBeUndefined();
    expect(JSON.stringify(getCR(crId).ops)).toMatch(/HeldMerge/);
    expect((await ontologyStore.working(p)).term(`${VOL}HeldMerge`)).toBeDefined();
    expect((await ontologyStore.working(p)).term(`${VOL}Replacement`)).toBeUndefined();
  });

  it('a merge whose draft moved underneath it commits nothing and gives the request back', async () => {
    const p = findProject('volunteering')!;
    const { crId } = await proposeFrom('Draft moved', 'DraftMoved');
    approve(crId);
    await expect(
      interleave(
        () => !!getCR(crId).merging,
        () => upstream([addClass('MovedUnderneath', 'moved underneath')]),
        () => merge(getCR(crId), undefined),
      ),
    ).rejects.toThrow(/working draft changed/);
    expect((await ontologyStore.working(p)).term(`${VOL}DraftMoved`)).toBeUndefined();
    expect(getCR(crId).merging).toBeUndefined();
    expect(getCR(crId).status).toBe('approved');
  });

  it.each([
    ['removing dcterms:provenance', { op: 'removeTerm', iri: 'http://purl.org/dc/terms/provenance' }],
    ['deprecating dcterms:contributor', { op: 'deprecate', iri: 'http://purl.org/dc/terms/contributor', reason: 'x' }],
    ['annotating dcterms:created', { op: 'updateAnnotations', iri: 'http://purl.org/dc/terms/created', set: { comment: 'x' } }],
  ])('edits cannot touch recorded provenance: %s', async (_, op) => {
    const path = await newFork(`Guard ${_}`);
    const res = await dev.post(`${path}/edits`).send({ ops: [op] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/recorded by Concord/);
  });

  it('header metadata is compared, and the header fields a fork stamps itself are refused', async () => {
    const path = await newFork('Header fields');
    expect((await dev.post(`${path}/edits`).send({ ops: [{ op: 'setMetadata', set: { modified: '2020-01-01' } }] })).status).toBe(400);
    const res = await dev.post(`${path}/edits`).send({ ops: [{ op: 'setMetadata', set: { contributors: ['Fork Contributor'] } }] });
    expect(res.status).toBe(200);
    expect(res.body.fork.terms).toEqual([expect.objectContaining({ iri: 'meta:contributors', upstream: 'not-proposed' })]);
  });

  it('a fork from before dcterms:provenance is refused, not converted', async () => {
    const path = await newFork('Legacy refused');
    elsewhere(await record(path), { provenanceFormat: undefined });
    const res = await dev.post(`${path}/edits`).send({ ops: [addClass('NotOnLegacy', 'not on legacy')] });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/earlier version of Concord/);
    expect((await request(app).get(`/def/volunteering/forks/${path.split('/').at(-1)}.ttl`)).status).toBe(200);
  });
});

/** Runs `during` once, the first time the draft is read (by any route) while `when` holds. */
async function interleave<T>(when: () => boolean, during: () => Promise<void> | void, fn: () => Promise<T>): Promise<T> {
  const originals = { working: ontologyStore.working, graphAt: ontologyStore.graphAt };
  let done = false;
  const hook = async () => {
    if (!done && when()) {
      done = true;
      await during();
    }
  };
  ontologyStore.working = async function (this: typeof ontologyStore, ...args: Parameters<typeof originals.working>) {
    await hook();
    return originals.working.apply(this, args);
  };
  ontologyStore.graphAt = async function (this: typeof ontologyStore, ...args: Parameters<typeof originals.graphAt>) {
    await hook();
    return originals.graphAt.apply(this, args);
  };
  try {
    return await fn();
  } finally {
    Object.assign(ontologyStore, originals);
  }
}

describe('eighth review', () => {
  const p = () => findProject('volunteering')!;
  const has = async (localName: string) => !!(await ontologyStore.working(p())).term(`${VOL}${localName}`);
  /** Replace a store method for the length of `fn`. */
  async function stubbed<K extends 'advanceWorking'>(key: K, impl: (original: (typeof ontologyStore)[K]) => (typeof ontologyStore)[K], fn: () => Promise<unknown>) {
    const original = ontologyStore[key];
    ontologyStore[key] = impl(original.bind(ontologyStore) as (typeof ontologyStore)[K]);
    try {
      return await fn();
    } finally {
      ontologyStore[key] = original;
    }
  }
  const proposeFrom = async (name: string, localName: string) => {
    const path = await newFork(name);
    await dev.post(`${path}/edits`).send({ ops: [addClass(localName, localName.toLowerCase())] });
    return (await dev.post(`${path}/propose`).send({})).body.changeRequest.id as string;
  };
  const approve = (id: string) => {
    const c = getCR(id);
    c.status = 'approved';
    saveChangeRequest(c);
  };
  const stop = () => {
    throw new Error('the merging process stopped');
  };

  it('a merge whose hold ran out commits nothing once the request has been edited', async () => {
    // Used to: the stalled merge resumed after someone replaced the edits, committed the old ones
    // (the draft hadn't moved, so the branch update went through), and only then failed.
    const crId = await proposeFrom('Expired merge', 'ExpiredMerge');
    approve(crId);
    const head = ontologyStore.head(p());
    await expect(
      interleave(
        () => !!getCR(crId).merging,
        () => {
          const held = getCR(crId);
          expect(putIf('changeRequests', { ...held, merging: { ...held.merging!, until: Date.now() - 1 }, rev: held.rev! + 1 }, 'rev', held.rev)).toBe(true);
          const edited = getCR(crId);
          edited.ops = [addClass('ReplacedWhileStalled', 'replaced while stalled')];
          saveChangeRequest(edited);
        },
        () => merge(getCR(crId), undefined),
      ),
    ).rejects.toThrow(/changed by someone else/);
    expect(ontologyStore.head(p())).toBe(head);
    expect(await has('ExpiredMerge')).toBe(false);
    expect(JSON.stringify(getCR(crId).ops)).toMatch(/ReplacedWhileStalled/);
    expect(getCR(crId).merging).toBeUndefined();
  });

  it('reads the draft from its commit, so a checkout that lags behind loses nothing', async () => {
    // Used to: a merge read ontology.ttl from the checkout, which another process had not rewritten
    // yet after moving the branch, and committed a draft without that process's term.
    const before = ontologyStore.readWorkingText(p());
    await upstream([addClass('CommittedFirst', 'committed first')]);
    const checkout = nodePath.join(ontologyStore.dir(p()), 'ontology.ttl');
    fs.writeFileSync(checkout, before);
    const crId = await proposeFrom('Lagging checkout', 'MergedOnTop');
    approve(crId);
    expect((await merge(getCR(crId), undefined)).status).toBe('merged');
    expect(await has('CommittedFirst')).toBe(true);
    expect(await has('MergedOnTop')).toBe(true);
    // The merge brought the checkout up to the commit it made.
    expect(fs.readFileSync(checkout, 'utf8')).toBe(ontologyStore.readAt(p(), 'HEAD'));
  });

  it('a merge that stopped right after committing is recognised by the retry, not redone', async () => {
    // Used to: the request stayed approved with no mergedCommit, and the retry failed because the
    // term already existed, moving the request to needs-work.
    const crId = await proposeFrom('Stopped after commit', 'StoppedAfterCommit');
    approve(crId);
    await expect(stubbed('advanceWorking', (original) => (...args) => (original(...args), stop()), () => merge(getCR(crId), undefined))).rejects.toThrow(/stopped/);
    const stuck = getCR(crId);
    expect(stuck.status).toBe('approved');
    expect(stuck.merging?.commit).toBeTruthy();
    expect(await has('StoppedAfterCommit')).toBe(true);
    const head = ontologyStore.head(p());
    const done = await merge(getCR(crId), undefined);
    expect(done.status).toBe('merged');
    expect(done.mergedCommit).toBe(stuck.merging!.commit);
    expect(done.merging).toBeUndefined();
    expect(ontologyStore.head(p())).toBe(head);
  });

  it('a merge that stopped after deciding its commit is finished by the next save, which is then refused', async () => {
    const crId = await proposeFrom('Stopped before commit', 'StoppedBeforeCommit');
    approve(crId);
    await expect(stubbed('advanceWorking', () => stop, () => merge(getCR(crId), undefined))).rejects.toThrow(/stopped/);
    expect(await has('StoppedBeforeCommit')).toBe(false);
    const late = getCR(crId);
    late.title = 'An edit after the merge decided';
    expect(() => saveChangeRequest(late)).toThrow(/has just been merged/);
    expect(getCR(crId).status).toBe('merged');
    expect(getCR(crId).title).not.toBe('An edit after the merge decided');
    expect(await has('StoppedBeforeCommit')).toBe(true);
  });

  it('a decided merge whose draft moved first is given back, and the retry applies it to the new draft once', async () => {
    const crId = await proposeFrom('Decided then moved', 'DecidedThenMoved');
    approve(crId);
    await expect(stubbed('advanceWorking', () => stop, () => merge(getCR(crId), undefined))).rejects.toThrow(/stopped/);
    await upstream([addClass('MovedFirst', 'moved first')]);
    const done = await merge(getCR(crId), undefined);
    expect(done.status).toBe('merged');
    expect(await has('MovedFirst')).toBe(true);
    expect(await has('DecidedThenMoved')).toBe(true);
    expect(ontologyStore.inWorking(p(), done.mergedCommit!)).toBe(true);
  });

  it('tells the owner of a fork from an earlier version to recreate it, and offers no edits', async () => {
    // Used to: check_forks said keep using the fork and propose it, but proposing always failed.
    const path = await newFork('Legacy guidance');
    await dev.post(`${path}/edits`).send({ ops: [addClass('LegacyGuided', 'legacy guided')] });
    const id = (await reader.get(path)).body.id as string;
    const f = get<OntologyFork>('forks', id)!;
    expect(putIf('forks', { ...f, provenanceFormat: undefined, seq: (f.seq ?? 0) + 1 }, 'seq', f.seq)).toBe(true);
    const check = (await dev.get(`${path}/check`)).body;
    expect(check.outcome).toBe('recreate-fork');
    expect(check.steps.join(' ')).toMatch(/create_fork/);
    expect(check.steps.join(' ')).not.toMatch(/propose_fork|sync_fork/);
    expect((await dev.post(`${path}/close`).send({})).status).toBe(200);
  });
});

describe('ninth review', () => {
  const p = () => findProject('volunteering')!;
  const has = async (localName: string) => !!(await ontologyStore.working(p())).term(`${VOL}${localName}`);
  const dir = () => ontologyStore.dir(p());
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir(), encoding: 'utf8' }).trim();

  it('a checkout left behind by a stopped merge cannot erase the merge when release pages are refreshed', async () => {
    // Used to: a merge killed after moving the branch left the old checkout and index; the startup
    // page refresh committed that index and silently removed the merged term.
    const before = ontologyStore.head(p());
    await upstream([addClass('SurvivesRefresh', 'survives refresh')]);
    git('read-tree', '-u', '--reset', before);
    const version = ontologyStore.versions(p())[0];
    ontologyStore.updateReleaseFiles(p(), { [version]: { 'refresh-note.txt': `refreshed ${Date.now()}\n` } }, 'Refresh a release page');
    expect(await has('SurvivesRefresh')).toBe(true);
    expect(ontologyStore.releaseFile(p(), version, 'refresh-note.txt')).toMatch(/^refreshed/);
    // ...and the refresh brought the checkout back up to HEAD.
    expect(fs.readFileSync(nodePath.join(dir(), 'ontology.ttl'), 'utf8')).toBe(ontologyStore.readAt(p(), 'HEAD'));
  });

  it('a release whose draft moved while it was being written publishes nothing and keeps the merge', async () => {
    // Used to: the release checked HEAD, then committed the checkout unconditionally, so a merge
    // landing in between (its lock taken over by age) was overwritten.
    const project = p();
    const head = ontologyStore.head(project);
    const graph = await ontologyStore.working(project);
    const slow = Object.create(graph) as typeof graph;
    slow.toTurtle = async () => {
      await upstream([addClass('LandedDuringRelease', 'landed during release')]);
      return graph.toTurtle();
    };
    await expect(ontologyStore.writeRelease(project, '99.0.0', slow, {}, 'Should not publish', { name: 'Steward' }, { expectedHead: head })).rejects.toThrow(/changed while this release/);
    expect(await has('LandedDuringRelease')).toBe(true);
    expect(ontologyStore.versions(project)).not.toContain('99.0.0');
    expect(git('tag', '--list', 'v99.0.0')).toBe('');
  });

  describe('the checkout lock', () => {
    // Tenth review: the lock named only a process id (so a holder on another host, or a reused id,
    // looked alive or dead wrongly), a busy lock blocked the server for 15 seconds, and the
    // five-minute takeover was never tested.
    const lock = () => nodePath.join(dir(), '.git', 'concord-checkout.lock');
    const hold = (owner: string, ageMs: number) => {
      fs.rmSync(lock(), { recursive: true, force: true });
      fs.mkdirSync(lock());
      fs.writeFileSync(nodePath.join(lock(), 'owner'), owner);
      const at = new Date(Date.now() - ageMs);
      fs.utimesSync(lock(), at, at);
    };
    const owner = () => fs.readFileSync(nodePath.join(lock(), 'owner'), 'utf8');
    /** Move the checkout behind HEAD, so it shows whether an update ran. */
    const behind = async () => {
      const before = ontologyStore.head(p());
      // A label of its own each time: a shared one would make every later request fail lint.
      const n = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      await upstream([addClass(`Lock${n}`, `lock check ${n}`)]);
      git('read-tree', '-u', '--reset', before);
    };
    const current = () => fs.readFileSync(nodePath.join(dir(), 'ontology.ttl'), 'utf8') === ontologyStore.readAt(p(), 'HEAD');

    it.each([
      ['a live process on this host', () => `${os.hostname()}:${process.pid}:live`],
      ['a process on another host', () => 'another-host.example:1:remote'],
    ])('is left to %s, without holding the server up', async (_, name) => {
      await behind();
      hold(name(), 60_000);
      const started = Date.now();
      ontologyStore.syncCheckout(p());
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(owner()).toBe(name());
      expect(current()).toBe(false);
      fs.rmSync(lock(), { recursive: true, force: true });
    });

    it.each([
      ['a dead process on this host', () => `${os.hostname()}:2147483646:dead`, 60_000],
      ['anyone, once it is more than five minutes old', () => `${os.hostname()}:${process.pid}:stuck`, 6 * 60_000],
      ['a process on another host, once it is more than five minutes old', () => 'another-host.example:1:remote', 6 * 60_000],
    ])('is taken over from %s, and the checkout caught up', async (_, name, age) => {
      await behind();
      hold(name(), age);
      ontologyStore.syncCheckout(p());
      expect(fs.existsSync(lock())).toBe(false);
      expect(current()).toBe(true);
    });

    it('a holder taken over just before it writes does not leave its older checkout behind', async () => {
      // Used to: the displaced holder checked the lock, was taken over, then wrote the checkout for
      // the HEAD it had read, over the new holder's newer one, and stopped there.
      await behind();
      const project = p();
      const read = ontologyStore.head(project);
      const g = applyChangeOps(await ontologyStore.working(project), [addClass(`Newer${Date.now()}`, 'newer')], { date: '2026-11-05' }).graph;
      const newer = await ontologyStore.prepareWorkingCommit(project, g, 'Newer draft', { name: 'Steward' }, read);
      let fired = false;
      checkoutTestHooks.beforeWrite = () => {
        if (fired) return;
        fired = true;
        // Another process takes the lock over, moves main on, writes the newer checkout and lets go.
        fs.writeFileSync(nodePath.join(lock(), 'owner'), 'another-host.example:1:new-holder');
        git('update-ref', 'refs/heads/main', newer, read);
        git('read-tree', '-u', '--reset', newer);
        fs.rmSync(lock(), { recursive: true, force: true });
      };
      try {
        ontologyStore.syncCheckout(project);
      } finally {
        delete checkoutTestHooks.beforeWrite;
      }
      expect(fired).toBe(true);
      expect(ontologyStore.head(project)).toBe(newer);
      expect(current()).toBe(true);
      expect(fs.existsSync(lock())).toBe(false);
    });
  });
});

describe('saves that race a slow step', () => {
  const p = () => findProject('volunteering')!;
  const proposeFork = async (name: string, localName: string) => {
    const path = await newFork(name);
    await dev.post(`${path}/edits`).send({ ops: [addClass(localName, localName.toLowerCase())] });
    const res = await dev.post(`${path}/propose`).send({});
    expect(res.status).toBe(200);
    return { path, crId: res.body.changeRequest.id as string };
  };
  const commentOn = (crId: string, text: string) => {
    const cr = getCR(crId);
    return addReview(cr, getUser(cr.authorId)!, 'comment', text);
  };

  it('updating a proposal keeps a comment made while its edits were being re-checked', async () => {
    // Used to: re-proposing a fork re-checks the request's edits (slow) and then saved the copy it
    // started with, so a review or comment saved meanwhile (e.g. by a simulated member) made the
    // update fail with "changed by someone else" (seen in the e2e forks spec).
    const { path, crId } = await proposeFork('Commented while updating', 'CommentedWhileUpdating');
    await dev.post(`${path}/edits`).send({ ops: [addClass('CommentedLater', 'commented later')] });
    const res = await interleave(
      () => getCR(crId).ops.length === 2,
      async () => {
        await commentOn(crId, 'A comment while the edits were re-checked');
      },
      () => dev.post(`${path}/propose`).send({}),
    );
    expect(res.status).toBe(200);
    const cr = getCR(crId);
    expect(cr.ops).toHaveLength(2);
    expect(cr.timeline.some((e) => e.message.includes('A comment while the edits were re-checked'))).toBe(true);
    // The re-check describes the new edits.
    expect(cr.kgcl!.join('\n')).toContain('CommentedLater');
  });

  it('a re-check of edits that were replaced meanwhile does not put the old results back', async () => {
    const { crId } = await proposeFork('Replaced while re-checked', 'ReplacedWhileRechecked');
    const author = getUser(getCR(crId).authorId)!;
    await interleave(
      () => getCR(crId).ops.length === 2,
      async () => {
        await updateOps(getCR(crId), author, { ops: [addClass('ReplacementEdit', 'replacement edit')] });
      },
      () => updateOps(getCR(crId), author, { ops: [addClass('FirstEdit', 'first edit'), addClass('SecondEdit', 'second edit')] }),
    );
    const cr = getCR(crId);
    expect(cr.ops).toEqual([addClass('ReplacementEdit', 'replacement edit')]);
    expect(cr.kgcl!.join('\n')).toContain('ReplacementEdit');
    expect(cr.kgcl!.join('\n')).not.toContain('SecondEdit');
  });

  it('a simulated member reacting while someone else comments still has their say, and keeps the comment', async () => {
    // Used to: the member's reaction (an LLM call) took a while, and the review was then saved on the
    // copy read before it, so a comment saved meanwhile made the whole simulation step fail with a 409.
    const { crId } = await proposeFork('Commented during a reaction', 'CommentedDuringReaction');
    // Its own request is open for members to react to, whatever earlier tests left behind.
    expect(getCR(crId).status).toBe('review');
    const open = () => list<ChangeRequest>('changeRequests', p().id).filter((x) => ['review', 'voting'].includes(x.status));
    const reactions = (ids: string[]) => ids.reduce((n, id) => n + list('reviews', id).length + list('votes', id).length, 0);
    const ids = open().map((c) => c.id);
    const before = reactions(ids);
    const commented: string[] = [];
    const original = llm.json;
    llm.json = (async (...args: Parameters<typeof original>) => {
      if (!commented.length && args[0].task === 'persona') {
        for (const c of open()) {
          commented.push(c.id);
          await commentOn(c.id, `Commented on #${c.number} while a member was reacting`);
        }
      }
      return original(...args);
    }) as typeof original;
    try {
      await step(p().id, undefined, 50);
    } finally {
      llm.json = original;
    }
    expect(commented).toContain(crId);
    for (const id of commented) expect(getCR(id).timeline.some((e) => e.message.includes('while a member was reacting'))).toBe(true);
    // Members still reacted, on top of the comments.
    expect(reactions(ids)).toBeGreaterThan(before + commented.length);
  });

  it('an older re-check never replaces the results of a newer one made against a later draft', async () => {
    // Used to: a re-check retried after losing its save to a newer one put its own results back
    // because the edits were the same, though it had checked them against an older draft.
    const { crId } = await proposeFork('Older re-check', 'OlderRecheck');
    const original = ontologyStore.graphAt;
    let moved = false;
    // After the first re-check has read the draft: the draft moves (the class now exists upstream,
    // so the edit can no longer be applied) and a second re-check runs to completion.
    ontologyStore.graphAt = async function (this: typeof ontologyStore, ...args: Parameters<typeof original>) {
      const g = await original.apply(this, args);
      if (!moved) {
        moved = true;
        await upstream([addClass('OlderRecheck', 'older recheck added upstream')]);
        await triage(getCR(crId));
      }
      return g;
    };
    try {
      await triage(getCR(crId));
    } finally {
      ontologyStore.graphAt = original;
    }
    expect(moved).toBe(true);
    const cr = getCR(crId);
    // The newer check's result stands: against the current draft the edit can't be applied.
    expect(cr.validation?.passed).toBe(false);
    expect(cr.validation?.lint.some((l) => l.code === 'change-not-applicable')).toBe(true);
  });

  it('two overlapping simulation steps record each member reaction once', async () => {
    // Used to: whether a member had already reacted was checked before the slow LLM call, so a
    // second step that ran meanwhile recorded the same member's reaction a second time.
    const { crId } = await proposeFork('Overlapping steps', 'OverlappingSteps');
    // Members only react to requests in review.
    expect(getCR(crId).status).toBe('review');
    const original = llm.json;
    let nested = false;
    llm.json = (async (...args: Parameters<typeof original>) => {
      if (!nested && args[0].task === 'persona') {
        nested = true;
        await step(p().id, undefined, 50);
      }
      return original(...args);
    }) as typeof original;
    try {
      await step(p().id, undefined, 50);
    } finally {
      llm.json = original;
    }
    expect(nested).toBe(true);
    for (const cr of list<ChangeRequest>('changeRequests', p().id)) {
      const since = cr.opsUpdatedAt ?? '';
      for (const kind of ['reviews', 'votes'] as const) {
        const by = new Map<string, number>();
        for (const r of list<{ userId: string; at: string }>(kind, cr.id)) if (r.at >= since && r.userId !== cr.authorId) by.set(r.userId, (by.get(r.userId) ?? 0) + 1);
        expect([...by.values()].filter((n) => n > 1), `${kind} on #${cr.number}`).toEqual([]);
      }
    }
  });

  it('a review that cannot be saved leaves nothing behind', async () => {
    // Used to: the review was stored before the request's save was refused, so it counted towards
    // approval although the request never recorded it.
    const { crId } = await proposeFork('Stale review', 'StaleReview');
    const stale = getCR(crId);
    await commentOn(crId, 'Saved first');
    const before = list('reviews', crId).length;
    await expect(addReview(stale, getUser(stale.authorId)!, 'comment', 'Saved on an old copy')).rejects.toThrow(/changed by someone else/);
    expect(list('reviews', crId)).toHaveLength(before);
  });
});
