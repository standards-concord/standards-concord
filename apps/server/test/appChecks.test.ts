import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChangeRequestDetail, ConnectedApp, PendingAppChecks } from '@concord/shared';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { appForToken, report as reportResult } from '../src/services/appChecks.js';
import { getCR, merge, saveCR } from '../src/services/changeRequests.js';
import { getProject } from '../src/services/ontologies.js';
import { ontologyStore } from '../src/services/ontologyStore.js';
import { seedDemo } from '../src/services/simulation.js';

const app = createApp();
type Agent = ReturnType<typeof request.agent>;

async function login(role: string, name: string): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/demo').send({ name, role });
  expect(res.status).toBe(200);
  return agent;
}

const VOL = 'https://w3id.org/odi/volunteering#';
let demoId: string;
let minorId: string;
let seededMinorId: string;
let majorId: string;

const detail = async (id: string) => (await request(app).get(`/api/change-requests/${id}`)).body as ChangeRequestDetail;
const pending = async (token: string, all = false, commit?: string) => {
  const q = new URLSearchParams({ ...(all && { all: '1' }), ...(commit && { commit }) }).toString();
  const res = await request(app).get(`/api/app-checks/pending${q ? `?${q}` : ''}`).set('Authorization', `Bearer ${token}`);
  expect(res.status, res.text).toBe(200);
  return res.body as PendingAppChecks;
};
const report = (token: string, body: Record<string, unknown>) => request(app).post('/api/app-checks').set('Authorization', `Bearer ${token}`).send(body);

/** One CI run, as the GitHub Action makes it: ask what to test, then report with the run's attempt. */
async function ciRun(token: string) {
  const p = await pending(token, true);
  const revisionFor = (target: string) => (target === 'baseline' ? p.baseline.revision : (p.targets.find((t) => t.changeRequestId === target)?.revision ?? 'not-listed'));
  const post = async (target: string, outcome: string, extra: Record<string, unknown> = {}) => {
    // Like a GitHub run, the draft result names the app commit, unless a test says otherwise.
    const commit = target === 'baseline' && !('commit' in extra) ? { commit: 'app-main' } : {};
    const res = await report(token, { target, revision: revisionFor(target), attempt: p.attempt, outcome, ...commit, ...extra });
    expect(res.status, res.text).toBe(200);
    return res.body as { stale: boolean; replay?: boolean; check?: { outcome: string }; autopilot?: { action: string; message: string } };
  };
  return { p, post };
}

/** A CI run where the working draft passes and each listed change gets the given outcome. Returns the last reply. */
async function ci(token: string, results: Record<string, string>) {
  const run = await ciRun(token);
  await run.post('baseline', 'passed');
  let last;
  for (const [target, outcome] of Object.entries(results)) last = await run.post(target, outcome);
  return last!;
}

let crCount = 0;
/** A new minor change in review, so no app has tested it. */
async function freshCR(title: string, localName = `testNote${crCount + 1}`) {
  const author = await login('editor', `Author ${++crCount}`);
  const created = await author.post(`/api/ontologies/${demoId}/change-requests`).send({
    title,
    description: 'A change for the app check tests.',
    kind: 'feature',
    ops: [
      {
        op: 'addDatatypeProperty',
        localName,
        label: `test note ${crCount}`,
        definition: 'A short free-text note that the organisation offering a volunteering opportunity adds for volunteers, used here to test connected apps.',
        domain: [`${VOL}VolunteeringOpportunity`],
        range: ['http://www.w3.org/2001/XMLSchema#string'],
      },
    ],
  });
  expect(created.status, created.text).toBe(201);
  const submitted = await author.post(`/api/change-requests/${created.body.id}/submit`);
  expect(submitted.body.status).toBe('review');
  return created.body.id as string;
}

async function connect(agent: Agent, name: string, autopilot?: Record<string, unknown>) {
  const res = await agent.post(`/api/ontologies/${demoId}/apps`).send({ name, autopilot });
  expect(res.status, res.text).toBe(201);
  return res.body as ConnectedApp;
}

async function asOwner() {
  const owner = request.agent(app);
  const personas = (await request(app).get('/api/personas')).body as { id: string; name: string }[];
  await owner.post('/api/auth/demo').send({ userId: personas.find((p) => p.name === 'Priya Shah')!.id });
  return owner;
}

async function setPolicy(change: (policy: any) => void) {
  const owner = await asOwner();
  const policy = structuredClone((await owner.get(`/api/ontologies/${demoId}`)).body.governance);
  change(policy);
  const res = await owner.put(`/api/ontologies/${demoId}/governance`).send({ policy });
  expect(res.status, res.text).toBe(200);
}

const autopilotSays = (d: ChangeRequestDetail, userId: string) => [...d.reviews, ...d.votes].filter((x) => x.userId === userId && x.autopilot);
const standing = (d: ChangeRequestDetail, userId: string) => autopilotSays(d, userId).filter((x) => !x.withdrawnAt && x.autopilot!.revision === d.revision);

/** Move the working draft on, as merging another change would. */
function touchWorkingDraft() {
  const project = getProject(demoId);
  ontologyStore.commitWorkingText(project, `${ontologyStore.readWorkingText(project)}\n# touched by a test ${Date.now()}\n`, 'Touch', { name: 'Test' });
}

beforeAll(async () => {
  openDb();
  const demo = await seedDemo();
  demoId = demo!.id;
  const crs = (await request(app).get(`/api/ontologies/${demoId}/change-requests`)).body as { id: string; title: string }[];
  seededMinorId = crs.find((c) => c.title === 'Say whether an opportunity reimburses expenses')!.id;
  majorId = crs.find((c) => c.title === 'Allow only one location per session')!.id;
  // A fresh minor change of our own, so the demo's connected app hasn't tested it.
  const author = await login('editor', 'Editor Ada');
  const created = await author.post(`/api/ontologies/${demoId}/change-requests`).send({
    title: 'Describe how to reach an opportunity',
    description: 'Volunteers with access needs want to know how to get there.',
    kind: 'feature',
    ops: [
      {
        op: 'addDatatypeProperty',
        localName: 'accessNote',
        label: 'access note',
        definition: 'A short free-text description of how volunteers can reach the place where a volunteering opportunity happens, such as step-free routes or parking.',
        domain: [`${VOL}VolunteeringOpportunity`],
        range: ['http://www.w3.org/2001/XMLSchema#string'],
      },
    ],
  });
  expect(created.status, created.text).toBe(201);
  minorId = created.body.id;
  const submitted = await author.post(`/api/change-requests/${minorId}/submit`);
  expect(submitted.body.status).toBe('review');
});

describe('the demo', () => {
  it('has a connected app whose autopilot approved one change and which breaks with another', async () => {
    const seeded = await detail(seededMinorId);
    const auto = seeded.reviews.find((r) => r.autopilot);
    expect(auto?.decision).toBe('approve');
    expect(auto?.autopilot?.apps[0].name).toBe('CharityBase volunteer export');
    expect(auto?.autopilot?.revision).toBe(seeded.revision);
    expect(seeded.appChecks?.[0]).toMatchObject({ outcome: 'passed', current: true });
    expect(seeded.status).toBe('review');
    const major = await detail(majorId);
    expect(major.appChecks?.[0]).toMatchObject({ outcome: 'failed', current: true });
    expect(major.reviews.some((r) => r.autopilot)).toBe(false);
  });
});

describe('connected apps', () => {
  let rae: Agent;
  let created: ConnectedApp;

  it('connects an app and shows its token only once', async () => {
    rae = await login('reviewer', 'Reviewer Rae');
    const res = await rae.post(`/api/ontologies/${demoId}/apps`).send({ name: 'Rota planner', repo: 'https://github.com/example/rota-planner.git' });
    expect(res.status, res.text).toBe(201);
    created = res.body;
    expect(created.token).toMatch(/^cna_/);
    expect(created.repo).toBe('example/rota-planner');
    expect(created.autopilot).toEqual({ enabled: false, levels: ['patch', 'minor'], onFailure: 'report' });
    const listed = (await rae.get(`/api/ontologies/${demoId}/apps`)).body as ConnectedApp[];
    const mine = listed.find((a) => a.id === created.id)!;
    expect(mine.token).toBeUndefined();
    expect(JSON.stringify(listed)).not.toContain('tokenHash');
    expect(mine.owner?.name).toBe('Reviewer Rae');
  });

  it('refuses CI calls without a valid app token', async () => {
    expect((await request(app).get('/api/app-checks/pending')).status).toBe(401);
    expect((await request(app).get('/api/app-checks/pending').set('Authorization', 'Bearer cna_nope')).status).toBe(401);
    expect((await report('cna_nope', { target: 'baseline', revision: 'x', attempt: 1, outcome: 'passed' })).status).toBe(401);
  });

  it('only lets the owner change the app', async () => {
    const other = await login('editor', 'Editor Ed');
    expect((await other.patch(`/api/apps/${created.id}`).send({ name: 'Mine now' })).status).toBe(403);
    expect((await other.delete(`/api/apps/${created.id}`)).status).toBe(403);
    expect((await rae.patch(`/api/apps/${created.id}`).send({ repo: 'not a repo' })).status).toBe(400);
  });

  it('lists open change requests to test, with the ontology each would produce', async () => {
    const p = await pending(created.token!);
    expect(p.attempt).toBeGreaterThan(0);
    expect((await pending(created.token!)).attempt).toBe(p.attempt + 1);
    expect(p.ontology.slug).toBe('volunteering');
    expect(p.baseline.source).toContain('ref=working');
    const minor = p.targets.find((t) => t.changeRequestId === minorId)!;
    expect(minor).toBeTruthy();
    expect(minor.level).toBe('minor');
    expect(minor.status).toBe('review');
    expect(p.targets.every((t) => ['review', 'voting', 'approved'].includes(t.status))).toBe(true);

    const proposed = await request(app).get(minor.source);
    expect(proposed.status).toBe(200);
    expect(proposed.headers['content-type']).toContain('text/turtle');
    expect(proposed.headers['x-concord-revision']).toBe(minor.revision);
    expect(proposed.text).toContain('accessNote');
    const working = await request(app).get(`${p.baseline.source}&format=turtle`);
    expect(working.text).not.toContain('accessNote');
    const jsonld = await request(app).get(`${minor.source}?format=jsonld`);
    expect(jsonld.headers['content-type']).toContain('application/ld+json');
    expect(JSON.parse(jsonld.text)).toBeTruthy();
  });

  it('records results on the change request without autopilot', async () => {
    const run = await ciRun(created.token!);
    expect((await run.post('baseline', 'passed', { commit: 'abc123' })).stale).toBe(false);
    const res = await run.post(minorId, 'passed', { runUrl: 'https://github.com/example/rota-planner/actions/runs/1', commit: 'abc123' });
    expect(res.autopilot!.action).toBe('none');
    const d = await detail(minorId);
    const check = d.appChecks!.find((c) => c.appId === created.id)!;
    expect(check).toMatchObject({ outcome: 'passed', current: true, attempt: run.p.attempt, runUrl: 'https://github.com/example/rota-planner/actions/runs/1' });
    expect(check.app.autopilot).toBe(false);
    expect(d.timeline.some((e) => e.type === 'app-check' && e.message.includes('Rota planner passed'))).toBe(true);
    expect(d.reviews.some((r) => r.autopilot)).toBe(false);
    // Tested at this revision by this app commit, so it drops off the list for runs of that commit.
    expect((await pending(created.token!, false, 'abc123')).targets.some((t) => t.changeRequestId === minorId)).toBe(false);
    // A run of another commit, or one that doesn't say, tests it again.
    expect((await pending(created.token!, false, 'def456')).targets.some((t) => t.changeRequestId === minorId)).toBe(true);
    expect((await pending(created.token!)).targets.some((t) => t.changeRequestId === minorId)).toBe(true);
    expect((await pending(created.token!, true)).targets.find((t) => t.changeRequestId === minorId)?.lastOutcome).toBe('passed');
  });

  it('ignores unsafe links and bad outcomes', async () => {
    const run = await ciRun(created.token!);
    await run.post('baseline', 'passed');
    const revision = run.p.targets.find((t) => t.changeRequestId === minorId)!.revision;
    expect((await report(created.token!, { target: minorId, revision, attempt: run.p.attempt, outcome: 'great' })).status).toBe(400);
    const res = await run.post(minorId, 'passed', { runUrl: 'javascript:alert(1)' });
    expect(res.check!.outcome).toBe('passed');
    expect((await detail(minorId)).appChecks!.find((c) => c.appId === created.id)!.runUrl).toBeUndefined();
  });

  it('keeps the newest run’s result when results arrive late or twice', async () => {
    const older = await ciRun(created.token!);
    const newer = await ciRun(created.token!);
    await older.post('baseline', 'passed');
    await newer.post('baseline', 'passed');
    const revision = newer.p.targets.find((t) => t.changeRequestId === minorId)!.revision;
    expect((await report(created.token!, { target: minorId, revision, outcome: 'passed' })).status, 'attempt is required').toBe(400);
    expect((await report(created.token!, { target: minorId, revision, attempt: newer.p.attempt + 50, outcome: 'passed' })).status, 'attempt must have been issued').toBe(400);
    expect((await report(created.token!, { target: minorId, revision: 'never-given', attempt: newer.p.attempt, outcome: 'passed' })).status, 'a run reports only what it was asked').toBe(400);

    expect((await newer.post(minorId, 'failed')).stale).toBe(false);
    const events = (await detail(minorId)).timeline.length;
    // A slow older run reports a pass after the newer run's failure: ignored.
    const late = await older.post(minorId, 'passed');
    expect(late.stale).toBe(true);
    expect(late.autopilot).toBeUndefined();
    // The newer run's result arrives again (a retried request): nothing changes.
    expect((await newer.post(minorId, 'failed')).replay).toBe(true);
    // The same run can't change its mind.
    expect((await report(created.token!, { target: minorId, revision, attempt: newer.p.attempt, outcome: 'passed' })).status).toBe(409);
    const d = await detail(minorId);
    expect(d.appChecks!.find((c) => c.appId === created.id)!.outcome).toBe('failed');
    expect(d.timeline.length).toBe(events);
    // A later run's pass does count.
    expect((await ci(created.token!, { [minorId]: 'passed' })).stale).toBe(false);
    expect((await detail(minorId)).appChecks!.find((c) => c.appId === created.id)!.outcome).toBe('passed');
  });

  it('ignores a result for a version of the change that has since moved on', async () => {
    const run = await ciRun(created.token!);
    await run.post('baseline', 'passed');
    touchWorkingDraft();
    const res = await run.post(minorId, 'failed');
    expect(res.stale).toBe(true);
    expect((await detail(minorId)).appChecks!.find((c) => c.appId === created.id)!.outcome).toBe('passed');
  });

  it('replaces the token and deletes the app', async () => {
    const rotated = (await rae.post(`/api/apps/${created.id}/token`)).body as ConnectedApp;
    expect(rotated.token).toMatch(/^cna_/);
    expect((await request(app).get('/api/app-checks/pending').set('Authorization', `Bearer ${created.token}`)).status).toBe(401);
    await pending(rotated.token!);
    expect((await rae.delete(`/api/apps/${created.id}`)).status).toBe(204);
    expect((await request(app).get('/api/app-checks/pending').set('Authorization', `Bearer ${rotated.token}`)).status).toBe(401);
    expect((await detail(minorId)).appChecks!.some((c) => c.appId === created.id)).toBe(false);
  });
});

describe('autopilot', () => {
  it('approves for the owner when turned on, and withdraws when the app fails', async () => {
    const crId = await freshCR('Autopilot approves and withdraws');
    const kit = await login('reviewer', 'Reviewer Kit');
    const a = await connect(kit, 'Kit’s app');
    await ci(a.token!, { [crId]: 'passed' });
    expect((await detail(crId)).reviews.some((r) => r.autopilot)).toBe(false);

    const res = await kit.patch(`/api/apps/${a.id}`).send({ autopilot: { enabled: true } });
    expect(res.status, res.text).toBe(200);
    let d = await detail(crId);
    const approval = d.reviews.find((r) => r.autopilot && r.decision === 'approve');
    expect(approval, 'autopilot approved on turning it on').toBeTruthy();
    expect(approval!.autopilot!.apps[0].name).toBe('Kit’s app');
    expect(approval!.comment).toMatch(/Autopilot: Kit’s app passed/);
    expect(d.governance.approvals).toBe(1);

    const fail = await ci(a.token!, { [crId]: 'failed' });
    expect(fail.autopilot!.action).toBe('withdrew');
    d = await detail(crId);
    // The approval stays on record, marked withdrawn, and no longer counts.
    const withdrawn = d.reviews.find((r) => r.id === approval!.id)!;
    expect(withdrawn.withdrawnAt).toBeTruthy();
    expect(d.governance.approvals).toBe(0);
    expect(d.timeline.some((e) => e.message.includes('Autopilot withdrew Reviewer Kit’s yes'))).toBe(true);

    expect((await ci(a.token!, { [crId]: 'passed' })).autopilot!.action).toBe('approved');
    // Passing again does nothing new.
    expect((await ci(a.token!, { [crId]: 'passed' })).autopilot!.action).toBe('none');
    d = await detail(crId);
    expect(standing(d, withdrawn.userId).length).toBe(1);
    expect(d.governance.approvals).toBe(1);
  });

  it('stops counting an approval once the working draft moves on, until the app tests again', async () => {
    const crId = await freshCR('Autopilot approvals lapse');
    const lee = await login('reviewer', 'Reviewer Lee');
    const a = await connect(lee, 'Lee’s app', { enabled: true });
    expect((await ci(a.token!, { [crId]: 'passed' })).autopilot!.action).toBe('approved');
    const before = await detail(crId);
    expect(before.governance.approvals).toBe(1);
    const human = await login('reviewer', 'Reviewer Human');
    await human.post(`/api/change-requests/${crId}/reviews`).send({ decision: 'approve' });
    expect((await detail(crId)).governance.approvals).toBe(2);

    const oldRun = await ciRun(a.token!);
    await oldRun.post('baseline', 'passed');
    touchWorkingDraft();
    // A run that started before the draft moved can't bring the approval back.
    expect((await oldRun.post(crId, 'passed')).stale).toBe(true);
    const after = await detail(crId);
    expect(after.revision).not.toBe(before.revision);
    // The person's own approval still counts; autopilot's was for a version that no longer exists.
    expect(after.governance.approvals).toBe(1);
    expect((await pending(a.token!)).targets.some((t) => t.changeRequestId === crId)).toBe(true);
    // The App checks page shows the baseline result as out of date.
    const listed = (await lee.get(`/api/ontologies/${demoId}/apps`)).body as ConnectedApp[];
    expect(listed.find((x) => x.id === a.id)!.baseline).toMatchObject({ outcome: 'passed', current: false });
    // A run against the new working draft brings it back.
    expect((await ci(a.token!, { [crId]: 'passed' })).autopilot!.action).toBe('approved');
    expect((await detail(crId)).governance.approvals).toBe(2);
  });

  it('waits for all of the owner’s autopilot apps, including one connected later', async () => {
    const crId = await freshCR('Autopilot waits for every app');
    const mo = await login('reviewer', 'Reviewer Mo');
    const a = await connect(mo, 'App A', { enabled: true });
    expect((await ci(a.token!, { [crId]: 'passed' })).autopilot!.action).toBe('approved');
    // A second app with autopilot: the yes waits for it.
    const b = await connect(mo, 'App B', { enabled: true });
    let d = await detail(crId);
    expect(d.governance.approvals).toBe(0);
    expect(d.timeline.some((e) => /Autopilot withdrew Reviewer Mo’s yes: waiting for App B/.test(e.message))).toBe(true);
    const run = await ciRun(b.token!);
    await run.post('baseline', 'passed');
    expect((await run.post(crId, 'passed')).autopilot!.action).toBe('approved');
    d = await detail(crId);
    expect(d.reviews.find((r) => !r.withdrawnAt && r.autopilot?.apps.length === 2)).toBeTruthy();
  });

  it('withdraws when an app errors, fails the working draft, is turned off or deleted, or the policy turns autopilot off', async () => {
    const crId = await freshCR('Autopilot withdraws when it loses its footing');
    const nia = await login('reviewer', 'Reviewer Nia');
    const a = await connect(nia, 'Nia’s app', { enabled: true });
    const approvals = async () => (await detail(crId)).governance.approvals;
    const pass = async () => {
      await ci(a.token!, { [crId]: 'passed' });
      expect(await approvals()).toBe(1);
    };
    await pass();
    // The app couldn't run against the change.
    expect((await ci(a.token!, { [crId]: 'error' })).autopilot!.action).toBe('withdrew');
    expect(await approvals()).toBe(0);
    await pass();
    // The app now fails the working draft itself.
    await (await ciRun(a.token!)).post('baseline', 'failed');
    expect(await approvals()).toBe(0);
    await pass();
    // Autopilot turned off.
    await nia.patch(`/api/apps/${a.id}`).send({ autopilot: { enabled: false } });
    expect(await approvals()).toBe(0);
    await nia.patch(`/api/apps/${a.id}`).send({ autopilot: { enabled: true } });
    expect(await approvals()).toBe(1);
    // The ontology's policy turns autopilot off.
    await setPolicy((p) => (p.automation.appAutopilot = false));
    expect(await approvals()).toBe(0);
    expect((await ci(a.token!, { [crId]: 'passed' })).autopilot!.message).toMatch(/turned off/);
    await setPolicy((p) => (p.automation.appAutopilot = true));
    expect(await approvals()).toBe(1);
    // The app is deleted.
    expect((await nia.delete(`/api/apps/${a.id}`)).status).toBe(204);
    expect(await approvals()).toBe(0);
    const d = await detail(crId);
    expect(d.reviews.filter((r) => r.autopilot && !r.withdrawnAt && r.autopilot.revision === d.revision)).toHaveLength(0);
  });

  it('replaces an approval when one of the apps behind it is removed', async () => {
    const crId = await freshCR('Autopilot after an app is removed');
    const ray = await login('reviewer', 'Reviewer Ray');
    const a = await connect(ray, 'Ray’s first app', { enabled: true });
    const b = await connect(ray, 'Ray’s second app', { enabled: true });
    await ci(a.token!, { [crId]: 'passed' });
    expect((await ci(b.token!, { [crId]: 'passed' })).autopilot!.action).toBe('approved');
    let d = await detail(crId);
    expect(d.governance.approvals).toBe(1);
    expect(d.reviews.find((r) => r.autopilot && !r.withdrawnAt)!.autopilot!.apps).toHaveLength(2);
    expect((await ray.delete(`/api/apps/${b.id}`)).status).toBe(204);
    d = await detail(crId);
    // The remaining app still passes, so autopilot approves again on its strength alone.
    expect(d.governance.approvals).toBe(1);
    const standingNow = d.reviews.filter((r) => r.autopilot && !r.withdrawnAt).at(-1)!;
    expect(standingNow.autopilot!.apps.map((x) => x.name)).toEqual(['Ray’s first app']);
    expect((await ci(a.token!, { [crId]: 'passed' })).autopilot!.action).toBe('none');
    expect((await detail(crId)).governance.approvals).toBe(1);
  });

  it('doesn’t bring back a result from before the app broke', async () => {
    const crId = await freshCR('Autopilot and old results');
    const sky = await login('reviewer', 'Reviewer Sky');
    const a = await connect(sky, 'Sky’s app', { enabled: true });
    expect((await ci(a.token!, { [crId]: 'passed' })).autopilot!.action).toBe('approved');
    // The app breaks against the working draft, then a new version of it is fixed.
    const broken = await ciRun(a.token!);
    await broken.post('baseline', 'failed', { commit: 'v2' });
    expect((await detail(crId)).governance.approvals).toBe(0);
    const fixed = await ciRun(a.token!);
    await fixed.post('baseline', 'passed', { commit: 'v3' });
    // The pass from before the break is for another version of the app: it doesn't count, and
    // the change is listed for testing again.
    const waiting = await detail(crId);
    expect(waiting.governance.approvals).toBe(0);
    // Shown as out of date, not as a current pass.
    expect(waiting.appChecks!.find((c) => c.appId === a.id)).toMatchObject({ outcome: 'passed', current: false });
    expect((await pending(a.token!)).targets.some((t) => t.changeRequestId === crId)).toBe(true);
    expect((await ci(a.token!, { [crId]: 'passed' })).autopilot!.action).toBe('approved');
    expect((await detail(crId)).governance.approvals).toBe(1);
  });

  it('never pairs a change result with a working draft result from another version of the app', async () => {
    const crId = await freshCR('Autopilot and app versions');
    const tam = await login('reviewer', 'Reviewer Tam');
    const a = await connect(tam, 'Tam’s app', { enabled: true });
    // Run 1, commit A: passes the draft, fails the change.
    const run1 = await ciRun(a.token!);
    await run1.post('baseline', 'passed', { commit: 'A' });
    await run1.post(crId, 'failed');
    // Run 2 starts for commit B; run 3, still on commit A, finishes first.
    const run2 = await ciRun(a.token!);
    const run3 = await ciRun(a.token!);
    await run3.post('baseline', 'passed', { commit: 'A' });
    // Run 2's draft result is older than run 3's, and its pass on the change is from commit B.
    expect((await run2.post('baseline', 'passed', { commit: 'B' })).stale).toBe(true);
    await run2.post(crId, 'passed');
    let d = await detail(crId);
    expect(d.governance.approvals).toBe(0);
    expect(d.appChecks!.find((c) => c.appId === a.id)).toMatchObject({ outcome: 'passed', current: false });
    expect((await pending(a.token!)).targets.some((t) => t.changeRequestId === crId)).toBe(true);
    // A change result can't come before the run's draft result, or claim another commit.
    const run4 = await ciRun(a.token!);
    expect((await report(a.token!, { target: crId, revision: run4.p.targets.find((t) => t.changeRequestId === crId)!.revision, attempt: run4.p.attempt, outcome: 'passed' })).status).toBe(409);
    await run4.post('baseline', 'passed', { commit: 'A' });
    expect((await report(a.token!, { target: crId, revision: run4.p.targets.find((t) => t.changeRequestId === crId)!.revision, attempt: run4.p.attempt, outcome: 'passed', commit: 'B' })).status).toBe(400);
    // A whole run on commit A that passes counts.
    expect((await run4.post(crId, 'passed')).autopilot!.action).toBe('approved');
    d = await detail(crId);
    expect(d.governance.approvals).toBe(1);
    expect(d.appChecks!.find((c) => c.appId === a.id)).toMatchObject({ outcome: 'passed', current: true });
  });

  it('without an app commit, counts change results only from the run whose draft result is in force', async () => {
    const crId = await freshCR('Autopilot without app commits');
    const uma = await login('reviewer', 'Reviewer Uma');
    const a = await connect(uma, 'Uma’s app', { enabled: true });
    const run1 = await ciRun(a.token!);
    await run1.post('baseline', 'passed', { commit: undefined });
    await run1.post(crId, 'failed');
    // Two overlapping runs; both pass the draft, the later one last.
    const run2 = await ciRun(a.token!);
    const run3 = await ciRun(a.token!);
    expect((await run2.post('baseline', 'passed', { commit: undefined })).stale).toBe(false);
    expect((await run3.post('baseline', 'passed', { commit: undefined })).stale).toBe(false);
    // Run 2's pass on the change might be from another version of the app: it doesn't count.
    await run2.post(crId, 'passed');
    let d = await detail(crId);
    expect(d.governance.approvals).toBe(0);
    expect(d.appChecks!.find((c) => c.appId === a.id)).toMatchObject({ outcome: 'passed', current: false });
    // Run 3's does.
    expect((await run3.post(crId, 'passed')).autopilot!.action).toBe('approved');
    d = await detail(crId);
    expect(d.governance.approvals).toBe(1);
    // Once the next run, without a commit, reports the draft, the change has to be tested again.
    const run4 = await ciRun(a.token!);
    await run4.post('baseline', 'passed', { commit: undefined });
    expect((await detail(crId)).governance.approvals).toBe(0);
    expect((await pending(a.token!)).targets.some((t) => t.changeRequestId === crId)).toBe(true);
  });

  it('a run whose draft result voids earlier results is told to test those changes again', async () => {
    const crId = await freshCR('Autopilot after overlapping draft results');
    const val = await login('reviewer', 'Reviewer Val');
    const a = await connect(val, 'Val’s app', { enabled: true });
    expect((await ci(a.token!, { [crId]: 'passed' })).autopilot!.action).toBe('approved');
    // Runs 2 and 3 start for the same commit, so the change isn't on their lists.
    const run2 = await pending(a.token!, false, 'app-main');
    const run3 = await pending(a.token!, false, 'app-main');
    expect(run2.targets.some((t) => t.changeRequestId === crId)).toBe(false);
    expect(run3.targets.some((t) => t.changeRequestId === crId)).toBe(false);
    // Run 2 fails the draft; run 3 then passes it, which starts a new passing streak.
    await report(a.token!, { target: 'baseline', revision: run2.baseline.revision, attempt: run2.attempt, outcome: 'failed', commit: 'app-main' });
    expect((await detail(crId)).governance.approvals).toBe(0);
    const reply = (await report(a.token!, { target: 'baseline', revision: run3.baseline.revision, attempt: run3.attempt, outcome: 'passed', commit: 'app-main' })).body;
    // So run 3 is told to test the change after all, and can.
    const again = (reply.targets as { changeRequestId: string; revision: string }[]).find((t) => t.changeRequestId === crId);
    expect(again, 'the change is to be tested again').toBeTruthy();
    const res = await report(a.token!, { target: crId, revision: again!.revision, attempt: run3.attempt, outcome: 'passed' });
    expect(res.body.autopilot.action).toBe('approved');
    expect((await detail(crId)).governance.approvals).toBe(1);
  });

  it('never overrides what the person said themselves', async () => {
    const crId = await freshCR('Autopilot leaves people alone');
    const ola = await login('reviewer', 'Reviewer Ola');
    const a = await connect(ola, 'Ola’s app', { enabled: true });
    expect((await ci(a.token!, { [crId]: 'passed' })).autopilot!.action).toBe('approved');
    await ola.post(`/api/change-requests/${crId}/reviews`).send({ decision: 'object', comment: 'I would rather model this as a class.' });
    const res = await ci(a.token!, { [crId]: 'failed' });
    expect(res.autopilot!.message).toMatch(/themselves/);
    const d = await detail(crId);
    expect(d.reviews.filter((r) => r.userId === d.reviews.find((x) => x.decision === 'object')!.userId).map((r) => r.decision)).toEqual(['approve', 'object']);
  });

  it('votes in a vote, only for allowed levels; never for someone who objected; takes a no back without reviving an older yes', async () => {
    // Before the vote opens, a member objects in review.
    const obi = await login('reviewer', 'Member Obi');
    await obi.post(`/api/change-requests/${majorId}/reviews`).send({ decision: 'object', comment: 'Some sessions really are at several sites.' });
    const obiApp = await connect(obi, 'Obi’s app', { enabled: true, levels: ['patch', 'minor', 'major'] });

    // Open the vote on the breaking change: its review period ends.
    const steward = await login('steward', 'Steward Sam');
    await steward.post('/api/simulation/clock').send({ advanceDays: 4 });
    let d = await detail(majorId);
    expect(d.status).toBe('voting');
    expect(d.classification?.level).toBe('major');

    // Obi objected, so autopilot doesn't vote yes for them even though their app passes.
    expect((await ci(obiApp.token!, { [majorId]: 'passed' })).autopilot!.message).toMatch(/themselves/);
    d = await detail(majorId);
    expect(d.votes.some((v) => v.autopilot && v.userId === d.reviews.find((r) => r.decision === 'object' && r.comment?.includes('several sites'))!.userId)).toBe(false);

    // Someone without a vote with an opposing app that fails: autopilot says nothing for them
    // (and doesn't stop anyone else's autopilot).
    const cora = await login('contributor', 'Contributor Cora');
    const coraApp = await connect(cora, 'Cora’s app', { enabled: true, levels: ['patch', 'minor', 'major'], onFailure: 'oppose' });
    const coraRes = await ci(coraApp.token!, { [majorId]: 'failed' });
    expect(coraRes.autopilot!.action).toBe('none');
    expect(coraRes.autopilot!.message).toMatch(/doesn’t vote/);

    // A member whose autopilot votes yes, then objects themselves: the yes stops counting.
    const una = await login('reviewer', 'Member Una');
    const unaApp = await connect(una, 'Una’s app', { enabled: true, levels: ['patch', 'minor', 'major'] });
    expect((await ci(unaApp.token!, { [majorId]: 'passed' })).autopilot!.action).toBe('voted-yes');
    const withUna = (await detail(majorId)).governance.vote!;
    await una.post(`/api/change-requests/${majorId}/reviews`).send({ decision: 'object', comment: 'On reflection, no.' });
    d = await detail(majorId);
    expect(d.governance.vote!.cast).toBe(withUna.cast - 1);
    expect(d.governance.vote!.yes).toBe(withUna.yes - 1);
    expect(d.votes.find((v) => v.autopilot?.apps[0].name === 'Una’s app')!.withdrawnAt).toBeTruthy();
    expect((await ci(unaApp.token!, { [majorId]: 'passed' })).autopilot!.message).toMatch(/themselves/);
    expect((await detail(majorId)).governance.vote!.yes).toBe(withUna.yes - 1);

    const gee = await login('reviewer', 'Member Gee');
    const map = await connect(gee, 'Map export', { enabled: true, onFailure: 'oppose' });
    expect((await ci(map.token!, { [majorId]: 'passed' })).autopilot!.message).toMatch(/isn’t on for major/);

    await gee.patch(`/api/apps/${map.id}`).send({ autopilot: { levels: ['patch', 'minor', 'major'] } });
    d = await detail(majorId);
    const geeId = d.votes.find((v) => v.autopilot?.apps[0].name === 'Map export')!.userId;
    expect(standing(d, geeId).map((v) => (v as { choice: string }).choice)).toEqual(['yes']);
    const yesCount = d.governance.vote!.yes;
    const cast = d.governance.vote!.cast;

    expect((await ci(map.token!, { [majorId]: 'failed' })).autopilot!.action).toBe('voted-no');
    d = await detail(majorId);
    expect(standing(d, geeId).at(-1)).toMatchObject({ choice: 'no' });
    expect(d.governance.vote!.yes).toBe(yesCount - 1);
    expect(d.governance.vote!.no).toBeGreaterThanOrEqual(1);

    // The app now fails the working draft too: its failure says nothing, so the no is taken
    // back, and the yes before it does not come back.
    await (await ciRun(map.token!)).post('baseline', 'failed');
    d = await detail(majorId);
    expect(d.votes.filter((v) => v.userId === geeId).every((v) => v.withdrawnAt || v.choice === 'yes')).toBe(true);
    expect(d.governance.vote!.cast).toBe(cast - 1);
    expect(d.governance.vote!.yes).toBe(yesCount - 1);
    expect(d.timeline.some((e) => e.message.startsWith('Autopilot withdrew Member Gee’s no'))).toBe(true);
  });

  describe('between approval and merge', () => {
    let crId: string;
    let pat: Agent;
    let token: string;

    beforeAll(async () => {
      // Merging by hand, so an approved change waits.
      await setPolicy((p) => (p.changes.minor.autoMerge = false));
      crId = await freshCR('Autopilot between approval and merge');
      const steward = await login('steward', 'Steward Clock');
      await steward.post('/api/simulation/clock').send({ advanceDays: 8 });
      const human = await login('reviewer', 'Reviewer Vic');
      await human.post(`/api/change-requests/${crId}/reviews`).send({ decision: 'approve' });
      pat = await login('reviewer', 'Reviewer Pat');
      token = (await connect(pat, 'Pat’s app', { enabled: true })).token!;
    });
    afterAll(async () => {
      await setPolicy((p) => (p.changes.minor.autoMerge = true));
    });

    it('keeps testing an approved change, and a failure sends it back to review', async () => {
      expect((await ci(token, { [crId]: 'passed' })).autopilot!.action).toBe('approved');
      let d = await detail(crId);
      expect(d.status).toBe('approved');
      expect(d.approvedFrom).toBe('review');
      const listed = (await pending(token, true)).targets.find((t) => t.changeRequestId === crId);
      expect(listed?.status).toBe('approved');

      expect((await ci(token, { [crId]: 'failed' })).autopilot!.action).toBe('withdrew');
      d = await detail(crId);
      expect(d.status).toBe('review');
      expect(d.timeline.some((e) => e.message.includes('back in review: the approval no longer holds'))).toBe(true);
    });

    it('a failure that arrives while the merge is being prepared stops it', async () => {
      expect((await ci(token, { [crId]: 'passed' })).autopilot!.action).toBe('approved');
      expect((await detail(crId)).status).toBe('approved');
      const project = getProject(demoId);
      const head = ontologyStore.head(project);
      const run = await pending(token, true);
      await report(token, { target: 'baseline', revision: run.baseline.revision, attempt: run.attempt, outcome: 'passed', commit: 'app-main' });
      const revision = run.targets.find((t) => t.changeRequestId === crId)!.revision;

      // Start the merge, and before it can commit, the app's failure comes in.
      const merging = merge(getCR(crId), undefined);
      const reporting = reportResult(appForToken(`Bearer ${token}`), { target: crId, revision, attempt: run.attempt, outcome: 'failed' });
      const merged = await merging;
      await reporting;
      expect(merged.status).toBe('review');
      expect(ontologyStore.head(project)).toBe(head);
      expect((await detail(crId)).status).toBe('review');
    });

    it('a working draft failure that arrives while the merge is being prepared stops it', async () => {
      expect((await ci(token, { [crId]: 'passed' })).autopilot!.action).toBe('approved');
      expect((await detail(crId)).status).toBe('approved');
      const project = getProject(demoId);
      const head = ontologyStore.head(project);
      const run = await pending(token, true);
      const merging = merge(getCR(crId), undefined);
      const reporting = reportResult(appForToken(`Bearer ${token}`), { target: 'baseline', revision: run.baseline.revision, attempt: run.attempt, outcome: 'failed' });
      const merged = await merging;
      await reporting;
      expect(merged.status).toBe('review');
      expect(ontologyStore.head(project)).toBe(head);
      // Fixed again for the next test.
      await ci(token, { [crId]: 'passed' });
    });

    it('never merges edits other than the ones it is about to commit', async () => {
      await ci(token, { [crId]: 'passed' });
      expect((await detail(crId)).status).toBe('approved');
      const project = getProject(demoId);
      const merging = merge(getCR(crId), undefined);
      // While the merge is prepared, the request's edits change (still marked approved).
      const changed = getCR(crId);
      const op = changed.ops[0] as { localName: string };
      changed.ops = [{ ...op, localName: 'swappedInMidMerge' } as never];
      changed.opsUpdatedAt = new Date(Date.parse(changed.opsUpdatedAt ?? changed.createdAt) + 1000).toISOString();
      saveCR(changed);
      const merged = await merging;
      const text = ontologyStore.readWorkingText(project);
      // Either it merged exactly the new edits, or it stopped; never the old edits under the new ones.
      if (merged.status === 'merged') {
        expect(text).toContain('swappedInMidMerge');
        expect(text).not.toContain(op.localName);
      } else {
        expect(text).not.toContain(op.localName);
        expect(merged.status).toBe('review');
      }
    });
  });

  it('asks again after the change is edited', async () => {
    const crId = await freshCR('Autopilot after an edit');
    const quinn = await login('reviewer', 'Reviewer Quinn');
    const a = await connect(quinn, 'Quinn’s app');
    await ci(a.token!, { [crId]: 'passed' });
    const before = (await pending(a.token!, true)).targets.find((t) => t.changeRequestId === crId)!;
    const editor = await login('editor', 'Editor Ivy');
    const cr = await detail(crId);
    const ops = [...cr.ops, { op: 'updateAnnotations', iri: `${VOL}${(cr.ops[0] as { localName: string }).localName}`, set: { comment: 'Keep it short.' } }];
    const res = await editor.patch(`/api/change-requests/${crId}`).send({ ops });
    expect(res.status, res.text).toBe(200);
    const after = (await pending(a.token!)).targets.find((t) => t.changeRequestId === crId);
    expect(after, 'listed again for testing').toBeTruthy();
    expect(after!.revision).not.toBe(before.revision);
    expect((await detail(crId)).appChecks!.find((c) => c.appId === a.id)!.current).toBe(false);
  });
});

describe('the GitHub Action script', () => {
  let server: ReturnType<typeof app.listen>;
  let base: string;
  beforeAll(async () => {
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const runAction = (cwd: string, env: Record<string, string>) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const script = path.resolve(import.meta.dirname, '../../../actions/app-check/run.mjs');
      const child = spawn(process.execPath, [script], { cwd, env: { PATH: process.env.PATH!, CONCORD_URL: base, ...env } });
      let out = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (out += c));
      child.on('close', (code) => resolve({ code, out }));
    });

  it('tests an app against the working draft and each open change, and reports back', async () => {
    const gil = await login('reviewer', 'Developer Gil');
    const created = (await gil.post(`/api/ontologies/${demoId}/apps`).send({ name: 'Single-site map' })).body as ConnectedApp;

    const breaking = await freshCR('A change that breaks the map', 'breaksTheMap');
    const passing = await freshCR('A change the map is fine with');
    // A tiny "app" whose test breaks with one of the changes.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-app-'));
    fs.mkdirSync(path.join(dir, 'data'));
    fs.writeFileSync(path.join(dir, 'data/volunteering.ttl'), '# vendored copy\n');
    fs.writeFileSync(
      path.join(dir, 'test.mjs'),
      `import fs from 'node:fs';
const ttl = fs.readFileSync('data/volunteering.ttl', 'utf8');
if (process.env.CONCORD_ONTOLOGY_FILE !== new URL('data/volunteering.ttl', 'file://' + process.cwd() + '/').pathname) throw new Error('CONCORD_ONTOLOGY_FILE should point at the vendored copy');
if (!ttl.includes('VolunteeringOpportunity')) throw new Error('ontology missing');
if (ttl.includes('breaksTheMap')) { console.error('the map does not know breaksTheMap'); process.exit(1); }
console.log('ok', process.env.CONCORD_TARGET);
`,
    );
    const summary = path.join(dir, 'summary.md');
    const output = path.join(dir, 'output.txt');
    const res = await runAction(dir, {
      CONCORD_APP_TOKEN: created.token!,
      CONCORD_TEST_COMMAND: 'node test.mjs',
      CONCORD_ONTOLOGY_PATH: 'data/volunteering.ttl',
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_OUTPUT: output,
      GITHUB_RUN_ID: '42',
      GITHUB_REPOSITORY: 'example/single-site-map',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_SHA: 'map-v1',
    });
    expect(res.code, res.out).toBe(0);
    // The vendored copy is put back afterwards.
    expect(fs.readFileSync(path.join(dir, 'data/volunteering.ttl'), 'utf8')).toBe('# vendored copy\n');
    expect(fs.readFileSync(summary, 'utf8')).toMatch(/Working draft \|.*passed/);
    expect(fs.readFileSync(output, 'utf8')).toMatch(/checked=\d+/);

    const major = await detail(breaking);
    const majorCheck = major.appChecks!.find((c) => c.appId === created.id)!;
    expect(majorCheck.outcome, res.out).toBe('failed');
    expect(majorCheck.runUrl).toBe('https://github.com/example/single-site-map/actions/runs/42');
    expect(majorCheck.summary).toBe('`node test.mjs` exited with code 1.');
    const minor = await detail(passing);
    expect(minor.appChecks!.find((c) => c.appId === created.id)!.outcome).toBe('passed');

    // Nothing new to test on the next run.
    // Nothing new to test on the next run of the same app commit.
    const again = await runAction(dir, { CONCORD_APP_TOKEN: created.token!, CONCORD_TEST_COMMAND: 'node test.mjs', CONCORD_ONTOLOGY_PATH: 'data/volunteering.ttl', CONCORD_COMMIT: 'map-v1' });
    expect(again.code, again.out).toBe(0);
    expect(again.out).toMatch(/0 change request\(s\) to test/);

  });

  it('without a commit, every run tests the open changes again and autopilot’s yes stands', async () => {
    const crId = await freshCR('Autopilot with commit-less runs');
    const kai = await login('reviewer', 'Developer Kai');
    const created = (await kai.post(`/api/ontologies/${demoId}/apps`).send({ name: 'Commit-less app', autopilot: { enabled: true } })).body as ConnectedApp;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-app-'));
    // The app passes only this change, so autopilot doesn't approve (and merge) any other.
    const number = (await detail(crId)).number;
    const env = { CONCORD_APP_TOKEN: created.token!, CONCORD_TEST_COMMAND: `test "$CONCORD_TARGET" = baseline -o "$CONCORD_CHANGE_REQUEST" = ${number}`, CONCORD_MAX_CHANGES: '100' };
    const first = await runAction(dir, env);
    expect((await detail(crId)).governance.approvals, first.out).toBe(1);
    const second = await runAction(dir, env);
    expect(second.out).not.toMatch(/^0 change request\(s\) to test/m);
    expect(second.out).toMatch(new RegExp(`#${number}: passed`));
    expect((await detail(crId)).governance.approvals).toBe(1);
  }, 60_000);

  it('with a run limit, each run tests the changes that waited longest, so none are starved', async () => {
    const lin = await login('reviewer', 'Developer Lin');
    const created = (await lin.post(`/api/ontologies/${demoId}/apps`).send({ name: 'Limited app' })).body as ConnectedApp;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-app-'));
    const env = { CONCORD_APP_TOKEN: created.token!, CONCORD_TEST_COMMAND: 'true', CONCORD_MAX_CHANGES: '1', CONCORD_COMMIT: 'limited-v1' };
    const open = (await pending(created.token!, true)).targets.length;
    expect(open).toBeGreaterThan(2);
    const tested = new Set<string>();
    for (let i = 0; i < open; i++) {
      const res = await runAction(dir, env);
      expect(res.code, res.out).toBe(0);
      const n = [...res.out.matchAll(/^#(\d+): passed/gm)].map((m) => m[1]);
      expect(n).toHaveLength(1);
      expect(tested.has(n[0]), `run ${i + 1} retested #${n[0]}`).toBe(false);
      tested.add(n[0]);
    }
    expect(tested.size).toBe(open);
  }, 120_000);

  it('fails the job and skips the changes when the working draft already breaks the app', async () => {
    const hal = await login('reviewer', 'Developer Hal');
    const created = (await hal.post(`/api/ontologies/${demoId}/apps`).send({ name: 'Broken app' })).body as ConnectedApp;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-app-'));
    const res = await runAction(dir, { CONCORD_APP_TOKEN: created.token!, CONCORD_TEST_COMMAND: 'exit 3' });
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/fails against the current working draft/);
    const apps = (await hal.get(`/api/ontologies/${demoId}/apps`)).body as ConnectedApp[];
    expect(apps.find((a) => a.id === created.id)!.baseline?.outcome).toBe('failed');
    expect((await detail(minorId)).appChecks!.some((c) => c.appId === created.id)).toBe(false);
  });

  it('fails the job when a change could not be tested, and stops everything a timed-out test started', async () => {
    const ike = await login('reviewer', 'Developer Ike');
    const created = (await ike.post(`/api/ontologies/${demoId}/apps`).send({ name: 'Hanging app' })).body as ConnectedApp;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-app-'));
    // The working draft passes; for a change, the test starts a background process and hangs.
    fs.writeFileSync(
      path.join(dir, 'test.sh'),
      `if [ "$CONCORD_TARGET" = baseline ]; then exit 0; fi
node -e "setInterval(() => {}, 1000)" &
echo $! >> pids
node -e "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)" > /dev/null 2>&1 &
echo $! >> pids
wait
`,
    );
    const res = await runAction(dir, {
      CONCORD_APP_TOKEN: created.token!,
      CONCORD_TEST_COMMAND: 'sh test.sh',
      CONCORD_TIMEOUT_MINUTES: '0.005',
      CONCORD_MAX_CHANGES: '1',
      CONCORD_COMMIT: 'hanging-v1',
    });
    expect(res.code, res.out).toBe(1);
    expect(res.out).toMatch(/could not be tested/);
    expect(res.out).toMatch(/timed out after 0\.01 minutes/);
    const pids = fs.readFileSync(path.join(dir, 'pids'), 'utf8').trim().split('\n').map(Number);
    expect(pids.length).toBe(2);
    // Gone, or a zombie waiting to be reaped (the container's init may not reap promptly).
    const alive = (pid: number) => {
      try {
        return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 30 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 100));
    expect(pids.filter(alive), 'the background process should have been stopped').toEqual([]);
    const checks = (await Promise.all(((await pending(created.token!, true)).targets).map((t) => detail(t.changeRequestId)))).flatMap((d) => d.appChecks ?? []).filter((c) => c.appId === created.id);
    expect(checks.map((c) => c.outcome)).toEqual(['error']);
  }, 30_000);

  it('fails the job when the app fails the working draft, even if a newer run reported first', async () => {
    const jo = await login('reviewer', 'Developer Jo');
    const created = (await jo.post(`/api/ontologies/${demoId}/apps`).send({ name: 'Overtaken app' })).body as ConnectedApp;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-app-'));
    // While this run tests the draft, another run starts and reports a pass first; then this one fails.
    fs.writeFileSync(
      path.join(dir, 'test.mjs'),
      `const h = { Authorization: 'Bearer ' + process.env.OTHER_RUN_TOKEN, 'Content-Type': 'application/json' };
const p = await (await fetch(process.env.CONCORD_URL + '/api/app-checks/pending', { headers: h })).json();
await fetch(process.env.CONCORD_URL + '/api/app-checks', { method: 'POST', headers: h, body: JSON.stringify({ target: 'baseline', revision: p.baseline.revision, attempt: p.attempt, outcome: 'passed' }) });
process.exit(3);
`,
    );
    const res = await runAction(dir, { CONCORD_APP_TOKEN: created.token!, OTHER_RUN_TOKEN: created.token!, CONCORD_TEST_COMMAND: 'node test.mjs' });
    expect(res.code, res.out).toBe(1);
    expect(res.out).toMatch(/fails against the current working draft/);
  });

  it('explains a missing or wrong token', async () => {
    const res = await runAction(os.tmpdir(), { CONCORD_APP_TOKEN: 'cna_wrong', CONCORD_TEST_COMMAND: 'true' });
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/did not accept the app token/);
    const none = await runAction(os.tmpdir(), { CONCORD_TEST_COMMAND: 'true' });
    expect(none.out).toMatch(/starts with cna_/);
  });
});
