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
const pending = async (token: string, all = false) => {
  const res = await request(app).get(`/api/app-checks/pending${all ? '?all=1' : ''}`).set('Authorization', `Bearer ${token}`);
  expect(res.status, res.text).toBe(200);
  return res.body as PendingAppChecks;
};
const report = (token: string, body: Record<string, unknown>) => request(app).post('/api/app-checks').set('Authorization', `Bearer ${token}`).send(body);

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
    expect((await report('cna_nope', { target: 'baseline', revision: 'x', outcome: 'passed' })).status).toBe(401);
  });

  it('only lets the owner change the app', async () => {
    const other = await login('editor', 'Editor Ed');
    expect((await other.patch(`/api/apps/${created.id}`).send({ name: 'Mine now' })).status).toBe(403);
    expect((await other.delete(`/api/apps/${created.id}`)).status).toBe(403);
    expect((await rae.patch(`/api/apps/${created.id}`).send({ repo: 'not a repo' })).status).toBe(400);
  });

  it('lists open change requests to test, with the ontology each would produce', async () => {
    const p = await pending(created.token!);
    expect(p.ontology.slug).toBe('volunteering');
    expect(p.baseline.source).toContain('ref=working');
    const minor = p.targets.find((t) => t.changeRequestId === minorId)!;
    expect(minor).toBeTruthy();
    expect(minor.level).toBe('minor');
    expect(minor.status).toBe('review');
    expect(p.targets.every((t) => ['review', 'voting'].includes(t.status))).toBe(true);

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
    const p = await pending(created.token!);
    const minor = p.targets.find((t) => t.changeRequestId === minorId)!;
    expect((await report(created.token!, { target: 'baseline', revision: p.baseline.revision, outcome: 'passed' })).body.stale).toBe(false);
    const res = await report(created.token!, { target: minorId, revision: minor.revision, outcome: 'passed', runUrl: 'https://github.com/example/rota-planner/actions/runs/1', commit: 'abc123' });
    expect(res.status, res.text).toBe(200);
    expect(res.body.autopilot.action).toBe('none');
    const d = await detail(minorId);
    expect(d.revision).toBe(minor.revision);
    const check = d.appChecks!.find((c) => c.appId === created.id)!;
    expect(check).toMatchObject({ outcome: 'passed', current: true, runUrl: 'https://github.com/example/rota-planner/actions/runs/1' });
    expect(check.app.autopilot).toBe(false);
    expect(d.timeline.some((e) => e.type === 'app-check' && e.message.includes('Rota planner passed'))).toBe(true);
    expect(d.reviews.some((r) => r.autopilot)).toBe(false);
    // Tested at this revision, so it drops off the list.
    expect((await pending(created.token!)).targets.some((t) => t.changeRequestId === minorId)).toBe(false);
    expect((await pending(created.token!, true)).targets.find((t) => t.changeRequestId === minorId)?.lastOutcome).toBe('passed');
  });

  it('ignores unsafe links and bad outcomes', async () => {
    const p = await pending(created.token!, true);
    const minor = p.targets.find((t) => t.changeRequestId === minorId)!;
    expect((await report(created.token!, { target: minorId, revision: minor.revision, outcome: 'great' })).status).toBe(400);
    const res = await report(created.token!, { target: minorId, revision: minor.revision, outcome: 'passed', runUrl: 'javascript:alert(1)' });
    expect(res.body.check.runUrl).toBeUndefined();
  });

  it('approves for the owner when autopilot is turned on, and withdraws it when the app fails', async () => {
    const res = await rae.patch(`/api/apps/${created.id}`).send({ autopilot: { enabled: true } });
    expect(res.status, res.text).toBe(200);
    let d = await detail(minorId);
    const approval = d.reviews.find((r) => r.autopilot && r.decision === 'approve');
    expect(approval, 'autopilot approved on turning it on').toBeTruthy();
    expect(approval!.autopilot!.apps[0].name).toBe('Rota planner');
    expect(approval!.comment).toMatch(/Autopilot: Rota planner passed/);
    expect(d.governance.approvals).toBe(1);

    const revision = d.revision!;
    const fail = await report(created.token!, { target: minorId, revision, outcome: 'failed', summary: '`npm test` exited with code 1.' });
    expect(fail.body.autopilot.action).toBe('withdrew');
    d = await detail(minorId);
    expect(d.reviews.some((r) => r.autopilot)).toBe(false);
    expect(d.governance.approvals).toBe(0);
    expect(d.timeline.some((e) => e.message.includes('Autopilot withdrew'))).toBe(true);
    expect(d.appChecks!.find((c) => c.appId === created.id)!.outcome).toBe('failed');

    const again = await report(created.token!, { target: minorId, revision, outcome: 'passed' });
    expect(again.body.autopilot.action).toBe('approved');
    // Saying the same thing twice does nothing.
    expect((await report(created.token!, { target: minorId, revision, outcome: 'passed' })).body.autopilot.action).toBe('none');
    expect((await detail(minorId)).reviews.filter((r) => r.autopilot).length).toBe(1);
  });

  it('ignores results for an old revision of the change', async () => {
    const res = await report(created.token!, { target: minorId, revision: 'old-revision', outcome: 'failed' });
    expect(res.body.stale).toBe(true);
    expect(res.body.autopilot).toBeUndefined();
    const d = await detail(minorId);
    expect(d.appChecks!.find((c) => c.appId === created.id)!.outcome).toBe('passed');
    expect(d.reviews.filter((r) => r.autopilot).length).toBe(1);
  });

  it('never overrides what the person said themselves', async () => {
    await rae.post(`/api/change-requests/${minorId}/reviews`).send({ decision: 'object', comment: 'I would rather model this as a class of expense.' });
    const d = await detail(minorId);
    const res = await report(created.token!, { target: minorId, revision: d.revision, outcome: 'passed' });
    expect(res.body.autopilot.message).toMatch(/reviewed this change yourself/);
  });

  it('waits for all of the owner’s autopilot apps, and says nothing when the working draft already fails', async () => {
    const mo = await login('reviewer', 'Reviewer Mo');
    const a = (await mo.post(`/api/ontologies/${demoId}/apps`).send({ name: 'App A', autopilot: { enabled: true } })).body as ConnectedApp;
    const b = (await mo.post(`/api/ontologies/${demoId}/apps`).send({ name: 'App B', autopilot: { enabled: true } })).body as ConnectedApp;
    const p = await pending(a.token!);
    const minor = p.targets.find((t) => t.changeRequestId === minorId)!;
    const first = await report(a.token!, { target: minorId, revision: minor.revision, outcome: 'passed' });
    expect(first.body.autopilot.message).toMatch(/Waiting for all/);
    await report(b.token!, { target: 'baseline', revision: p.baseline.revision, outcome: 'failed' });
    const second = await report(b.token!, { target: minorId, revision: minor.revision, outcome: 'passed' });
    expect(second.body.autopilot.message).toMatch(/fails against the working draft/);
    await report(b.token!, { target: 'baseline', revision: p.baseline.revision, outcome: 'passed' });
    const d = await detail(minorId);
    expect(d.reviews.find((r) => r.autopilot && r.autopilot.apps.length === 2), 'approved once both passed and the baseline was fixed').toBeTruthy();
  });

  it('votes in a vote, only for the levels it is allowed, and can vote no', async () => {
    // Open the vote on the breaking change: its 14-day review period ends.
    const steward = await login('steward', 'Steward Sam');
    await steward.post('/api/simulation/clock').send({ advanceDays: 4 });
    let d = await detail(majorId);
    expect(d.status).toBe('voting');
    expect(d.classification?.level).toBe('major');

    const gee = await login('reviewer', 'Member Gee');
    const created2 = (await gee.post(`/api/ontologies/${demoId}/apps`).send({ name: 'Map export', autopilot: { enabled: true, onFailure: 'oppose' } })).body as ConnectedApp;
    const res = await report(created2.token!, { target: majorId, revision: d.revision, outcome: 'passed' });
    expect(res.body.autopilot.message).toMatch(/isn’t on for major/);

    await gee.patch(`/api/apps/${created2.id}`).send({ autopilot: { levels: ['patch', 'minor', 'major'] } });
    d = await detail(majorId);
    const yes = d.votes.find((v) => v.autopilot);
    expect(yes?.choice).toBe('yes');

    const no = await report(created2.token!, { target: majorId, revision: d.revision, outcome: 'failed' });
    expect(no.body.autopilot.action).toBe('voted-no');
    d = await detail(majorId);
    const mine = d.votes.filter((v) => v.autopilot);
    expect(mine.map((v) => v.choice)).toEqual(['no']);
    expect(d.governance.vote?.no).toBeGreaterThanOrEqual(1);
  });

  it('asks again after the change is edited', async () => {
    const editor = await login('editor', 'Editor Ivy');
    const before = (await pending(created.token!, true)).targets.find((t) => t.changeRequestId === minorId)!;
    const cr = await detail(minorId);
    const ops = [...cr.ops, { op: 'updateAnnotations', iri: `${VOL}accessNote`, set: { comment: 'Mention step-free access first.' } }];
    const res = await editor.patch(`/api/change-requests/${minorId}`).send({ ops });
    expect(res.status, res.text).toBe(200);
    const after = (await pending(created.token!)).targets.find((t) => t.changeRequestId === minorId);
    expect(after, 'listed again for testing').toBeTruthy();
    expect(after!.revision).not.toBe(before.revision);
    expect((await detail(minorId)).appChecks!.find((c) => c.appId === created.id)!.current).toBe(false);
  });

  it('respects a governance policy that turns autopilot off', async () => {
    const owner = request.agent(app);
    const personas = (await request(app).get('/api/personas')).body as { id: string; name: string }[];
    await owner.post('/api/auth/demo').send({ userId: personas.find((p) => p.name === 'Priya Shah')!.id });
    const o = (await owner.get(`/api/ontologies/${demoId}`)).body;
    const policy = { ...o.governance, automation: { ...o.governance.automation, appAutopilot: false } };
    expect((await owner.put(`/api/ontologies/${demoId}/governance`).send({ policy })).status).toBe(200);
    const d = await detail(minorId);
    const res = await report(created.token!, { target: minorId, revision: d.revision, outcome: 'passed' });
    expect(res.body.autopilot.message).toMatch(/turned off/);
    await owner.put(`/api/ontologies/${demoId}/governance`).send({ policy: { ...policy, automation: { ...policy.automation, appAutopilot: true } } });
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

    // A tiny "app" whose test breaks if any property, such as hasLocation, becomes functional.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-app-'));
    fs.mkdirSync(path.join(dir, 'data'));
    fs.writeFileSync(path.join(dir, 'data/volunteering.ttl'), '# vendored copy\n');
    fs.writeFileSync(
      path.join(dir, 'test.mjs'),
      `import fs from 'node:fs';
const ttl = fs.readFileSync('data/volunteering.ttl', 'utf8');
if (process.env.CONCORD_ONTOLOGY_FILE !== new URL('data/volunteering.ttl', 'file://' + process.cwd() + '/').pathname) throw new Error('CONCORD_ONTOLOGY_FILE should point at the vendored copy');
if (!ttl.includes('VolunteeringOpportunity')) throw new Error('ontology missing');
if (/FunctionalProperty/.test(ttl.split('hasLocation')[1]?.split(/\\.\\s*\\n/)[0] ?? '')) { console.error('one location per session breaks multi-site opportunities'); process.exit(1); }
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
    });
    expect(res.code, res.out).toBe(0);
    // The vendored copy is put back afterwards.
    expect(fs.readFileSync(path.join(dir, 'data/volunteering.ttl'), 'utf8')).toBe('# vendored copy\n');
    expect(fs.readFileSync(summary, 'utf8')).toMatch(/Working draft \|.*passed/);
    expect(fs.readFileSync(output, 'utf8')).toMatch(/checked=\d+/);

    const major = await detail(majorId);
    const majorCheck = major.appChecks!.find((c) => c.appId === created.id)!;
    expect(majorCheck.outcome, res.out).toBe('failed');
    expect(majorCheck.runUrl).toBe('https://github.com/example/single-site-map/actions/runs/42');
    expect(majorCheck.summary).toBe('`node test.mjs` exited with code 1.');
    const minor = await detail(minorId);
    expect(minor.appChecks!.find((c) => c.appId === created.id)!.outcome).toBe('passed');

    // Nothing new to test on the next run.
    const again = await runAction(dir, { CONCORD_APP_TOKEN: created.token!, CONCORD_TEST_COMMAND: 'node test.mjs', CONCORD_ONTOLOGY_PATH: 'data/volunteering.ttl' });
    expect(again.code, again.out).toBe(0);
    expect(again.out).toMatch(/0 change request\(s\) to test/);
  });

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

  it('explains a missing or wrong token', async () => {
    const res = await runAction(os.tmpdir(), { CONCORD_APP_TOKEN: 'cna_wrong', CONCORD_TEST_COMMAND: 'true' });
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/did not accept the app token/);
    const none = await runAction(os.tmpdir(), { CONCORD_TEST_COMMAND: 'true' });
    expect(none.out).toMatch(/starts with cna_/);
  });
});
