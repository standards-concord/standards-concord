import { spawn } from 'node:child_process';
import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChangeRequestDetail, ConnectedApp, PendingAppChecks } from '@concord/shared';
import { createApp } from '../src/app.js';
import { get as getDoc, insertOnce, openDb } from '../src/db.js';
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

/** Change requests are read signed in, as testers do. */
let reader: Agent;
const detail = async (id: string) => (await reader.get(`/api/change-requests/${id}`)).body as ChangeRequestDetail;
const pending = async (token: string, all = false, commit?: string) => {
  const q = new URLSearchParams({ ...(all && { all: '1' }), ...(commit && { commit }) }).toString();
  const res = await request(app).get(`/api/app-checks/pending${q ? `?${q}` : ''}`).set('Authorization', `Bearer ${token}`);
  expect(res.status, res.text).toBe(200);
  return res.body as PendingAppChecks;
};
/*
 * GitHub's side of verified runs: a signing key, its JWKS, and the id-token endpoint a GitHub
 * job calls, served locally. Concord is pointed at it with GITHUB_OIDC_ISSUER.
 */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
let issuer = '';
/** Key ids the stand-in publishes (all the same key), and a gate that holds its key list back. */
const kids = new Set(['test-key']);
let jwksGate: Promise<void> | undefined;
let jwksRequested: (() => void) | undefined;
/**
 * Start a report whose proof is signed with a key Concord hasn't seen, so it fetches the keys
 * again, and hold the keys back until `release` is called.
 */
function heldProof(appId: string, repository: string, sha: string) {
  const kid = `held-${kids.size}`;
  kids.add(kid);
  let release!: () => void;
  jwksGate = new Promise<void>((r) => (release = r));
  const requested = new Promise<void>((r) => (jwksRequested = r));
  const oidc = mintOidc({ aud: `concord-app-check:${appId}`, repository, sha }, { kid });
  return {
    oidc,
    requested,
    release: () => {
      jwksGate = undefined;
      jwksRequested = undefined;
      release();
    },
  };
}
function mintOidc(claims: Record<string, unknown>, opts: { key?: typeof privateKey; kid?: string } = {}) {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const h = enc({ alg: 'RS256', typ: 'JWT', kid: opts.kid ?? 'test-key' });
  const repository = (claims.repository as string | undefined) ?? 'example/app';
  const body = enc({
    iss: issuer,
    iat: now,
    nbf: now,
    exp: now + 300,
    jti: randomUUID(),
    run_id: 1,
    event_name: 'schedule',
    repository_id: repoIdOf(repository),
    job_workflow_ref: `${repository}/.github/workflows/concord.yml@refs/heads/main`,
    ...claims,
  });
  return `${h}.${body}.${createSign('RSA-SHA256').update(`${h}.${body}`).sign(opts.key ?? privateKey).toString('base64url')}`;
}
/** GitHub's numeric id for a repository: stable per name here. */
const repoIdOf = (repository: string) => [...repository].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 2_000_000_000, 7);
const oidcFor = (appId: string, repository: string, sha: string) => mintOidc({ aud: `concord-app-check:${appId}`, repository, sha });
/** Apps the tests connected with a repository, by token, so their CI runs come with GitHub's proof. */
const repos = new Map<string, { appId: string; repo: string }>();
/** The run key each verified run's draft result was answered with, by token and attempt. */
const runKeys = new Map<string, string>();

const report = async (token: string, body: Record<string, unknown>) => {
  const known = repos.get(token);
  const key = `${token}#${body.attempt}`;
  // Like a GitHub job with id-token: write, the draft result carries proof of the run (GitHub's
  // tokens always name the commit, so a run without one isn't vouched for), and the change
  // results carry the key that proof earned.
  const extra =
    body.target === 'baseline'
      ? !('oidc' in body) && known && typeof body.commit === 'string'
        ? { oidc: oidcFor(known.appId, known.repo, body.commit) }
        : {}
      : !('runKey' in body) && runKeys.has(key)
        ? { runKey: runKeys.get(key) }
        : {};
  const res = await request(app).post('/api/app-checks').set('Authorization', `Bearer ${token}`).send({ ...body, ...extra });
  if (body.target === 'baseline' && res.body?.runKey) runKeys.set(key, res.body.runKey);
  return res;
};

/**
 * One CI run, as the GitHub Action makes it: ask what to test, then report with the run's attempt.
 * With `owner`, the app's owner makes the run signed in, without the token.
 */
async function ciRun(token: string, owner?: { agent: Agent; appId: string }) {
  const p = owner ? ((await owner.agent.get(`/api/app-checks/pending?all=1&appId=${owner.appId}`)).body as PendingAppChecks) : await pending(token, true);
  const revisionFor = (target: string) => (target === 'baseline' ? p.baseline.revision : (p.targets.find((t) => t.changeRequestId === target)?.revision ?? 'not-listed'));
  const post = async (target: string, outcome: string, extra: Record<string, unknown> = {}) => {
    // Like a GitHub run, the draft result names the app commit, unless a test says otherwise.
    const commit = target === 'baseline' && !('commit' in extra) ? { commit: 'app-main' } : {};
    const body = { target, revision: revisionFor(target), attempt: p.attempt, outcome, ...commit, ...extra };
    const res = owner ? await owner.agent.post('/api/app-checks').send({ appId: owner.appId, ...body }) : await report(token, body);
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

/** Connect an app with a GitHub repository, so its runs can be verified (see report()). */
async function connect(agent: Agent, name: string, autopilot?: Record<string, unknown>, repo = `example/app-${repos.size + 1}`) {
  const res = await agent.post(`/api/ontologies/${demoId}/apps`).send({ name, autopilot, repo });
  expect(res.status, res.text).toBe(201);
  const created = res.body as ConnectedApp;
  repos.set(created.token!, { appId: created.id, repo });
  return created;
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
  const stub = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://stub');
    if (u.pathname === '/.well-known/jwks') {
      // A test can hold the keys back, to land other changes while a report waits for them.
      jwksRequested?.();
      void (jwksGate ?? Promise.resolve()).then(() => res.end(JSON.stringify({ keys: [...kids].map((kid) => ({ ...jwk, kid })) })));
      return;
    }
    if (u.pathname === '/token') {
      if (req.headers.authorization !== 'Bearer gh-request-token') return res.writeHead(403).end();
      const sha = u.searchParams.get('sha');
      return res.end(JSON.stringify({ value: mintOidc({ aud: u.searchParams.get('audience'), repository: u.searchParams.get('repo'), ...(sha && { sha }) }) }));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  stub.unref();
  issuer = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  process.env.GITHUB_OIDC_ISSUER = issuer;
  openDb();
  const demo = await seedDemo();
  demoId = demo!.id;
  reader = await login('member', 'Reader of change requests');
  const crs = (await reader.get(`/api/ontologies/${demoId}/change-requests`)).body as { id: string; title: string }[];
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

    // Change requests aren't public, so neither is what they'd produce: the app's CI reads it with its token.
    expect((await request(app).get(minor.source)).status).toBe(401);
    expect((await request(app).get(minor.source).set('Authorization', 'Bearer cna_nope')).status).toBe(401);
    const proposed = await request(app).get(minor.source).set('Authorization', `Bearer ${created.token}`);
    expect(proposed.status).toBe(200);
    expect((await reader.get(minor.source)).status).toBe(200);
    // Only changes open for checks: not a draft, nor one that was withdrawn.
    const author = await login('editor', 'Author of a draft');
    const draft = (await author.post(`/api/ontologies/${demoId}/change-requests`).send({ title: 'A draft nobody has submitted', description: 'Not ready.', kind: 'editorial', ops: [{ op: 'updateAnnotations', iri: `${VOL}Session`, set: { comment: 'Draft wording.' } }] })).body;
    expect(draft.status).toBe('draft');
    expect((await request(app).get(`/api/change-requests/${draft.id}/proposed`).set('Authorization', `Bearer ${created.token}`)).status).toBe(404);
    expect((await author.get(`/api/change-requests/${draft.id}/proposed`)).status).toBe(200);
    await author.post(`/api/change-requests/${draft.id}/submit`);
    expect((await request(app).get(`/api/change-requests/${draft.id}/proposed`).set('Authorization', `Bearer ${created.token}`)).status).toBe(200);
    const withdrawn = await author.post(`/api/change-requests/${draft.id}/withdraw`);
    expect(withdrawn.status, withdrawn.text).toBe(200);
    expect((await request(app).get(`/api/change-requests/${draft.id}/proposed`).set('Authorization', `Bearer ${created.token}`)).status).toBe(404);
    expect(proposed.headers['content-type']).toContain('text/turtle');
    expect(proposed.headers['x-concord-revision']).toBe(minor.revision);
    expect(proposed.text).toContain('accessNote');
    const working = await request(app).get(`${p.baseline.source}&format=turtle`);
    expect(working.text).not.toContain('accessNote');
    const jsonld = await request(app).get(`${minor.source}?format=jsonld`).set('Authorization', `Bearer ${created.token}`);
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
    // GitHub's runs always name a commit, so a run without one is one Uma reports herself, signed in.
    const owner = { agent: uma, appId: a.id };
    const run1 = await ciRun(a.token!, owner);
    await run1.post('baseline', 'passed', { commit: undefined });
    await run1.post(crId, 'failed');
    // Two overlapping runs; both pass the draft, the later one last.
    const run2 = await ciRun(a.token!, owner);
    const run3 = await ciRun(a.token!, owner);
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
    const run4 = await ciRun(a.token!, owner);
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

  it('with a run limit, a steady stream of new changes never starves a change whose result stopped counting', async () => {
    const crId = await freshCR('Autopilot under a stream of new changes');
    const wes = await login('reviewer', 'Reviewer Wes');
    const a = await connect(wes, 'Wes’s app', { enabled: true });
    const commit = 'arrival-v1';
    /** One run that tests only the first change it's told to (max-changes = 1). */
    const limitedRun = async (outcome: 'passed' | 'failed' = 'passed') => {
      const p = await pending(a.token!, false, commit);
      const reply = (await report(a.token!, { target: 'baseline', revision: p.baseline.revision, attempt: p.attempt, outcome, commit })).body;
      if (outcome !== 'passed') return undefined;
      const first = (reply.targets as { changeRequestId: string; revision: string }[])[0];
      // The app passes this change; anything else couldn't be tested, so autopilot leaves it be.
      await report(a.token!, { target: first.changeRequestId, revision: first.revision, attempt: p.attempt, outcome: first.changeRequestId === crId ? 'passed' : 'error' });
      return first.changeRequestId;
    };
    // A first full run: the app passes the change (tested first), and autopilot approves it.
    const p1 = await pending(a.token!, false, commit);
    await report(a.token!, { target: 'baseline', revision: p1.baseline.revision, attempt: p1.attempt, outcome: 'passed', commit });
    for (const t of [p1.targets.find((t) => t.changeRequestId === crId)!, ...p1.targets.filter((t) => t.changeRequestId !== crId)])
      await report(a.token!, { target: t.changeRequestId, revision: t.revision, attempt: p1.attempt, outcome: t.changeRequestId === crId ? 'passed' : 'error' });
    expect((await detail(crId)).governance.approvals).toBe(1);
    // The app breaks on the working draft, so that approval stops counting.
    await limitedRun('failed');
    expect((await detail(crId)).governance.approvals).toBe(0);
    // New changes keep arriving, one before every run, and each run can test only one change.
    const tested: string[] = [];
    for (let i = 0; i < 4; i++) {
      await freshCR(`New arrival ${i + 1}`);
      tested.push((await limitedRun())!);
    }
    // The change that waited longest goes first, so its approval comes back.
    expect(tested[0]).toBe(crId);
    expect(new Set(tested).size, 'each run tests a different change').toBe(tested.length);
    expect((await detail(crId)).governance.approvals).toBe(1);
  });

  it('only acts on verified runs, so the app token alone can’t make it say yes', async () => {
    const crId = await freshCR('Autopilot needs verified runs');
    const xia = await login('reviewer', 'Reviewer Xia');
    const a = await connect(xia, 'Xia’s app', { enabled: true }, 'example/xia-app');
    // Whoever holds the token reports passes, but without GitHub's proof of the run.
    const run = await pending(a.token!, true, 'xia-v1');
    const base = await report(a.token!, { target: 'baseline', revision: run.baseline.revision, attempt: run.attempt, outcome: 'passed', commit: 'xia-v1', oidc: undefined });
    expect(base.body.verified).toBe(false);
    const target = run.targets.find((t) => t.changeRequestId === crId)!;
    const res = await report(a.token!, { target: crId, revision: target.revision, attempt: run.attempt, outcome: 'passed' });
    expect(res.body.autopilot.action).toBe('none');
    expect(res.body.autopilot.message).toMatch(/waiting for a verified run/i);
    let d = await detail(crId);
    expect(d.governance.approvals).toBe(0);
    expect(d.appChecks!.find((c) => c.appId === a.id)).toMatchObject({ outcome: 'passed', verified: false });

    // Proof that doesn't hold is refused outright.
    const bad = async (oidc: string, why: RegExp) => {
      const p = await pending(a.token!, true, 'xia-v1');
      const r = await report(a.token!, { target: 'baseline', revision: p.baseline.revision, attempt: p.attempt, outcome: 'passed', commit: 'xia-v1', oidc });
      expect(r.status, r.text).toBe(400);
      expect(r.body.error).toMatch(why);
    };
    await bad(oidcFor(a.id, 'attacker/fork', 'xia-v1'), /not this app’s repository/);
    await bad(oidcFor('app_other', 'example/xia-app', 'xia-v1'), /another audience/);
    await bad(oidcFor(a.id, 'example/xia-app', 'other-commit'), /tested commit other-commit/);
    await bad(mintOidc({ aud: `concord-app-check:${a.id}`, repository: 'example/xia-app', exp: Math.floor(Date.now() / 1000) - 600 }), /expired/);
    await bad(mintOidc({ aud: `concord-app-check:${a.id}`, repository: 'example/xia-app' }, { key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }), /signature/);
    await bad(mintOidc({ aud: `concord-app-check:${a.id}`, repository: 'example/xia-app', iss: 'https://evil.example' }), /issued by GitHub Actions/);
    await bad('not.a-token', /malformed/);
    const claims = { aud: `concord-app-check:${a.id}`, repository: 'example/xia-app', sha: 'xia-v1' };
    const now = Math.floor(Date.now() / 1000);
    await bad(mintOidc({ ...claims, sha: undefined }), /which commit ran/);
    await bad(mintOidc({ ...claims, event_name: 'pull_request_target' }), /pull_request_target aren’t accepted/);
    await bad(mintOidc({ ...claims, event_name: 'pull_request' }), /pull_request aren’t accepted/);
    await bad(mintOidc({ ...claims, job_workflow_ref: 'attacker/tools/.github/workflows/x.yml@refs/heads/main' }), /workflow isn’t in the app’s repository/);
    await bad(mintOidc({ ...claims, iat: now + 3600 }), /isn’t valid yet/);
    await bad(mintOidc({ ...claims, nbf: 'soon' }), /nbf claim must be a number/);
    await bad(mintOidc({ ...claims, exp: String(now + 300) }), /exp claim must be a number/);
    await bad(mintOidc({ ...claims, iat: undefined }), /iat claim must be a number/);
    await bad(mintOidc({ ...claims, exp: now + 86_400 }), /longer than GitHub issues them/);
    await bad(mintOidc({ ...claims, jti: undefined }), /has no id/);
    const once = oidcFor(a.id, 'example/xia-app', 'xia-v1');
    const p1 = await pending(a.token!, true, 'xia-v1');
    const first = { target: 'baseline', revision: p1.baseline.revision, attempt: p1.attempt, outcome: 'passed', commit: 'xia-v1', oidc: once };
    expect((await report(a.token!, first)).body.verified).toBe(true);
    // The same report retried with the same proof is fine (and gets a fresh run key); another run can't use it.
    const retried = await report(a.token!, first);
    expect(retried.body).toMatchObject({ replay: true, verified: true });
    expect(retried.body.runKey).toMatch(/^crk_/);
    await bad(once, /already used/);
    // Its use is on record in the database, so no other server process accepts it either.
    const jti = JSON.parse(Buffer.from(once.split('.')[1], 'base64url').toString()).jti;
    expect(getDoc('oidcTokens', `${issuer}#${jti}`)).toBeTruthy();
    const elsewhere = mintOidc(claims);
    const otherJti = JSON.parse(Buffer.from(elsewhere.split('.')[1], 'base64url').toString()).jti;
    insertOnce('oidcTokens', { id: `${issuer}#${otherJti}`, iss: issuer, jti: otherJti, exp: now + 300 });
    await bad(elsewhere, /already used/);
    // The repository's id is pinned by the first verified run: a re-created repository of the same name is refused.
    await bad(mintOidc({ ...claims, repository_id: 42 }), /isn’t the repository this app first ran from/);

    // A run GitHub vouches for counts.
    const ok = await ciRun(a.token!);
    expect((await ok.post('baseline', 'passed', { commit: 'xia-v1' })).stale).toBe(false);
    expect((await ok.post(crId, 'passed')).autopilot!.action).toBe('approved');
    d = await detail(crId);
    expect(d.governance.approvals).toBe(1);
    expect(d.appChecks!.find((c) => c.appId === a.id)).toMatchObject({ verified: true, current: true });

    // Later reports with the token alone can't undo what the verified run found.
    const later = await pending(a.token!, true, 'xia-v1');
    expect((await report(a.token!, { target: 'baseline', revision: later.baseline.revision, attempt: later.attempt, outcome: 'failed', commit: 'xia-v1', oidc: undefined })).body.stale).toBe(true);
    expect((await detail(crId)).governance.approvals).toBe(1);
    const fake = await pending(a.token!, true, 'xia-v1');
    await report(a.token!, { target: 'baseline', revision: fake.baseline.revision, attempt: fake.attempt, outcome: 'passed', commit: 'xia-v1', oidc: undefined });
    const failing = await report(a.token!, { target: crId, revision: fake.targets.find((t) => t.changeRequestId === crId)!.revision, attempt: fake.attempt, outcome: 'failed' });
    expect(failing.body.stale).toBe(true);
    d = await detail(crId);
    expect(d.governance.approvals).toBe(1);
    expect(d.appChecks!.find((c) => c.appId === a.id)).toMatchObject({ outcome: 'passed', verified: true });

    // Nor can it pass a change off as part of a verified run: the run's key is needed, and only
    // the caller with GitHub's proof got it.
    const crId2 = await freshCR('Autopilot and a forged result');
    const real = await pending(a.token!, true, 'xia-v1');
    const answer = await report(a.token!, { target: 'baseline', revision: real.baseline.revision, attempt: real.attempt, outcome: 'passed', commit: 'xia-v1' });
    expect(answer.body.verified).toBe(true);
    expect(answer.body.runKey).toMatch(/^crk_/);
    const revision2 = real.targets.find((t) => t.changeRequestId === crId2)!.revision;
    const forged = await report(a.token!, { target: crId2, revision: revision2, attempt: real.attempt, outcome: 'passed', runKey: undefined });
    expect(forged.body.autopilot.action).toBe('none');
    expect((await detail(crId2)).appChecks!.find((c) => c.appId === a.id)).toMatchObject({ verified: false });
    expect((await report(a.token!, { target: crId2, revision: revision2, attempt: real.attempt, outcome: 'passed', runKey: 'crk_guess' })).status).toBe(401);
    // The verified run's own result replaces the forged one.
    expect((await report(a.token!, { target: crId2, revision: revision2, attempt: real.attempt, outcome: 'passed' })).body.autopilot.action).toBe('approved');
  });

  it('counts results the app’s owner reports signed in, without the token', async () => {
    const crId = await freshCR('Autopilot from the owner’s own report');
    const yan = await login('reviewer', 'Reviewer Yan');
    const a = await connect(yan, 'Yan’s app', { enabled: true }, 'example/yan-app');
    const p = (await yan.get(`/api/app-checks/pending?all=1&appId=${a.id}`)).body as PendingAppChecks;
    expect((await yan.post('/api/app-checks').send({ appId: a.id, target: 'baseline', revision: p.baseline.revision, attempt: p.attempt, outcome: 'passed', commit: 'yan-v1' })).body.verified).toBe(true);
    const target = p.targets.find((t) => t.changeRequestId === crId)!;
    const res = await yan.post('/api/app-checks').send({ appId: a.id, target: crId, revision: target.revision, attempt: p.attempt, outcome: 'passed' });
    expect(res.body.autopilot.action).toBe('approved');
    // Nobody else can report for it that way.
    const zed = await login('reviewer', 'Reviewer Zed');
    expect((await zed.post('/api/app-checks').send({ appId: a.id, target: 'baseline', revision: p.baseline.revision, attempt: p.attempt, outcome: 'failed' })).status).toBe(403);
    expect((await request(app).post('/api/app-checks').send({ appId: a.id, target: 'baseline', revision: p.baseline.revision, attempt: p.attempt, outcome: 'failed' })).status).toBe(401);
  });

  describe('while GitHub’s proof is being checked', () => {
    /** A report whose proof waits on GitHub's keys, and the run it is for. */
    async function heldReport(token: string, appId: string, repo: string, outcome = 'passed') {
      const p = await pending(token, true, 'held-v1');
      const held = heldProof(appId, repo, 'held-v1');
      const reporting = report(token, { target: 'baseline', revision: p.baseline.revision, attempt: p.attempt, outcome, commit: 'held-v1', oidc: held.oidc });
      await held.requested;
      return { p, held, reporting };
    }

    it('a disconnected app stays disconnected', async () => {
      const eve = await login('reviewer', 'Reviewer Eve');
      const a = await connect(eve, 'Eve’s app', undefined, 'example/eve-app');
      const { held, reporting } = await heldReport(a.token!, a.id, 'example/eve-app');
      expect((await eve.delete(`/api/apps/${a.id}`)).status).toBe(204);
      held.release();
      expect((await reporting).status).toBe(401);
      expect((await request(app).get('/api/app-checks/pending').set('Authorization', `Bearer ${a.token}`)).status).toBe(401);
      expect((await eve.get(`/api/ontologies/${demoId}/apps`)).body.some((x: ConnectedApp) => x.id === a.id)).toBe(false);
    });

    it('a replaced token stays replaced', async () => {
      const fay = await login('reviewer', 'Reviewer Fay');
      const a = await connect(fay, 'Fay’s app', undefined, 'example/fay-app');
      const { held, reporting } = await heldReport(a.token!, a.id, 'example/fay-app');
      const rotated = (await fay.post(`/api/apps/${a.id}/token`)).body as ConnectedApp;
      held.release();
      expect((await reporting).status).toBe(401);
      expect((await request(app).get('/api/app-checks/pending').set('Authorization', `Bearer ${a.token}`)).status).toBe(401);
      expect((await request(app).get('/api/app-checks/pending').set('Authorization', `Bearer ${rotated.token}`)).status).toBe(200);
    });

    it('a newer result that lands meanwhile wins', async () => {
      const gus = await login('reviewer', 'Reviewer Gus');
      const a = await connect(gus, 'Gus’s app', undefined, 'example/gus-app');
      // An older run's pass waits on GitHub's keys while a newer run reports a failure.
      const { held, reporting } = await heldReport(a.token!, a.id, 'example/gus-app');
      const newer = await pending(a.token!, true, 'held-v1');
      expect((await report(a.token!, { target: 'baseline', revision: newer.baseline.revision, attempt: newer.attempt, outcome: 'failed', commit: 'held-v1' })).body.stale).toBe(false);
      held.release();
      expect((await reporting).body.stale).toBe(true);
      const apps = (await gus.get(`/api/ontologies/${demoId}/apps`)).body as ConnectedApp[];
      expect(apps.find((x) => x.id === a.id)!.baseline).toMatchObject({ outcome: 'failed', attempt: newer.attempt });
    });
  });

  it('stops an app working once its owner leaves the ontology, and lets owners and stewards disconnect any app', async () => {
    const crId = await freshCR('Autopilot when the owner leaves');
    const ann = await login('reviewer', 'Reviewer Ann');
    const a = await connect(ann, 'Ann’s app', { enabled: true });
    const target = (await pending(a.token!, true)).targets.find((t) => t.changeRequestId === crId)!;
    expect((await ci(a.token!, { [crId]: 'passed' })).autopilot!.action).toBe('approved');
    expect((await request(app).get(target.source).set('Authorization', `Bearer ${a.token}`)).status).toBe(200);

    const owner = await asOwner();
    const removed = await owner.delete(`/api/ontologies/${demoId}/members/${a.ownerId}`);
    expect(removed.status, removed.text).toBe(204);
    // Its token no longer works, for anything.
    expect((await request(app).get('/api/app-checks/pending').set('Authorization', `Bearer ${a.token}`)).status).toBe(401);
    expect((await request(app).get(target.source).set('Authorization', `Bearer ${a.token}`)).status).toBe(401);
    // And autopilot no longer speaks for them.
    expect(standing(await detail(crId), a.ownerId)).toHaveLength(0);

    // Someone else's app: a member can't disconnect it; an owner or steward can.
    const ben = await login('reviewer', 'Reviewer Ben');
    const b = await connect(ben, 'Ben’s app');
    const cal = await login('reviewer', 'Reviewer Cal');
    expect((await cal.delete(`/api/apps/${b.id}`)).status).toBe(403);
    expect((await cal.post(`/api/apps/${b.id}/token`)).status).toBe(403);
    const steward = await login('steward', 'Steward Dee');
    expect((await steward.post(`/api/apps/${b.id}/token`)).status).toBe(403);
    expect((await steward.delete(`/api/apps/${b.id}`)).status).toBe(204);
    expect((await request(app).get('/api/app-checks/pending').set('Authorization', `Bearer ${b.token}`)).status).toBe(401);
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
      const reporting = reportResult(appForToken(`Bearer ${token}`), { target: crId, revision, attempt: run.attempt, outcome: 'failed', runKey: runKeys.get(`${token}#${run.attempt}`) });
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
      // Reported by the app's owner, signed in, so it lands at once (GitHub's proof would take a moment to check).
      const reporter = appForToken(`Bearer ${token}`);
      const reporting = reportResult(reporter, { target: 'baseline', revision: run.baseline.revision, attempt: run.attempt, outcome: 'failed', commit: 'app-main' }, { trusted: true, ownerId: reporter.ownerId });
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
      // Room for every open change, however many earlier tests proposed.
      CONCORD_MAX_CHANGES: '100',
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

  it('without a commit, every run tests the open changes again; outside GitHub, autopilot doesn’t act on them', async () => {
    const crId = await freshCR('Autopilot with commit-less runs');
    const kai = await login('reviewer', 'Developer Kai');
    const created = (await kai.post(`/api/ontologies/${demoId}/apps`).send({ name: 'Commit-less app', repo: 'example/commit-less', autopilot: { enabled: true } })).body as ConnectedApp;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-app-'));
    const number = (await detail(crId)).number;
    const env = { CONCORD_APP_TOKEN: created.token!, CONCORD_TEST_COMMAND: `test "$CONCORD_TARGET" = baseline -o "$CONCORD_CHANGE_REQUEST" = ${number}`, CONCORD_MAX_CHANGES: '100' };
    const first = await runAction(dir, env);
    expect(first.out).toMatch(new RegExp(`#${number}: passed`));
    const second = await runAction(dir, env);
    expect(second.out).not.toMatch(/^0 change request\(s\) to test/m);
    expect(second.out).toMatch(new RegExp(`#${number}: passed`));
    const d = await detail(crId);
    expect(d.appChecks!.find((c) => c.appId === created.id)).toMatchObject({ outcome: 'passed', verified: false, current: true });
    expect(d.governance.approvals).toBe(0);
  }, 180_000);

  it('on GitHub with id-token: write, GitHub vouches for the run and autopilot acts on its results', async () => {
    const crId = await freshCR('Autopilot from a verified Action run');
    const lee = await login('reviewer', 'Developer Lee');
    const created = (await lee.post(`/api/ontologies/${demoId}/apps`).send({ name: 'Verified app', repo: 'example/verified', autopilot: { enabled: true } })).body as ConnectedApp;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-app-'));
    // The app passes only this change, so autopilot doesn't approve (and merge) any other.
    const number = (await detail(crId)).number;
    const env = {
      CONCORD_APP_TOKEN: created.token!,
      CONCORD_TEST_COMMAND: `test "$CONCORD_TARGET" = baseline -o "$CONCORD_CHANGE_REQUEST" = ${number}`,
      CONCORD_MAX_CHANGES: '100',
      GITHUB_SHA: 'verified-v1',
      // What a GitHub job with id-token: write is given, here served by the local stand-in.
      ACTIONS_ID_TOKEN_REQUEST_URL: `${issuer}/token?repo=example/verified&sha=verified-v1`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'gh-request-token',
    };
    const first = await runAction(dir, env);
    expect(first.out).toMatch(/GitHub vouched for this run/);
    let d = await detail(crId);
    expect(d.governance.approvals, first.out).toBe(1);
    expect(d.appChecks!.find((c) => c.appId === created.id)).toMatchObject({ verified: true, current: true });
    // The next run of the same commit has nothing new to test, and the yes stands.
    const second = await runAction(dir, env);
    expect(second.code, second.out).toBe(0);
    expect(second.out).not.toMatch(new RegExp(`#${number}:`));
    d = await detail(crId);
    expect(d.governance.approvals).toBe(1);
  }, 180_000);

  it('with a run limit, each run tests the changes that waited longest, so none are starved', async () => {
    const lin = await login('reviewer', 'Developer Lin');
    const created = (await lin.post(`/api/ontologies/${demoId}/apps`).send({ name: 'Limited app' })).body as ConnectedApp;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-app-'));
    const limit = 4;
    const env = { CONCORD_APP_TOKEN: created.token!, CONCORD_TEST_COMMAND: 'true', CONCORD_MAX_CHANGES: String(limit), CONCORD_COMMIT: 'limited-v1' };
    const open = (await pending(created.token!, true)).targets.length;
    expect(open).toBeGreaterThan(limit);
    const tested = new Set<string>();
    const runs = Math.ceil(open / limit);
    for (let i = 0; i < runs; i++) {
      const res = await runAction(dir, env);
      expect(res.code, res.out).toBe(0);
      const n = [...res.out.matchAll(/^#(\d+): passed/gm)].map((m) => m[1]);
      expect(n).toHaveLength(Math.min(limit, open - tested.size));
      for (const x of n) {
        expect(tested.has(x), `run ${i + 1} retested #${x}`).toBe(false);
        tested.add(x);
      }
    }
    expect(tested.size).toBe(open);
  }, 180_000);

  it('without a commit, stays within the run limit and fails the job if it had to leave changes out', async () => {
    const mo = await login('reviewer', 'Developer Mo');
    const created = (await mo.post(`/api/ontologies/${demoId}/apps`).send({ name: 'Commit-less limited app' })).body as ConnectedApp;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-app-'));
    const open = (await pending(created.token!, true)).targets.length;
    expect(open).toBeGreaterThan(2);
    const res = await runAction(dir, { CONCORD_APP_TOKEN: created.token!, CONCORD_TEST_COMMAND: 'true', CONCORD_MAX_CHANGES: '2' });
    expect(res.code, res.out).toBe(1);
    expect([...res.out.matchAll(/^#(\d+): passed/gm)]).toHaveLength(2);
    expect(res.out).toMatch(new RegExp(`No app commit is known.*${open - 2} of ${open} open change`));
  }, 180_000);

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
  }, 180_000);

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
