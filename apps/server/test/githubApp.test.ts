import { createHmac, generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectedApp } from '@concord/shared';
// The same stand-in GitHub the browser tests use.
import { createGithubStub } from '../../../e2e/github-stub.mjs';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { get as getDoc, openDb, put } from '../src/db.js';
import type { AppDoc } from '../src/services/appChecks.js';
import { dispatchIfNeeded, nudgeRuns } from '../src/services/appGithub.js';
import { githubAppSettings, readState, signState } from '../src/services/githubApp.js';
import { seedDemo } from '../src/services/simulation.js';

const app = createApp();
type Agent = ReturnType<typeof request.agent>;
const keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const SECRET = 'unit-test-webhook-secret';
const stub = createGithubStub({ appId: '77', publicKey: keys.publicKey, clientId: 'Iv1.unit', clientSecret: 'unit-client-secret', callbackUrl: 'http://concord.test/api/github-app/setup' });
let base = '';
let demoId = '';
const ENV = ['GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_WEBHOOK_SECRET', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_API_URL', 'GITHUB_APP_WEB_URL', 'GITHUB_OIDC_ISSUER'];

interface StubState {
  dispatches: { repo: string }[];
  tokenRequests: { repoIds: string[]; permissions: Record<string, string> }[];
  revoked: string[];
  installations: { id: string; repos: string[] }[];
  repos: { id: string; full_name: string; files: Record<string, Record<string, string>>; pulls: { number: number; head: string }[] }[];
}
const state = async () => (await (await fetch(`${base}/__app`)).json()) as StubState;
const nextInstall = async (repos: string[]) => ((await (await fetch(`${base}/__app/next-install`, { method: 'POST', body: JSON.stringify({ repos }) })).json()) as { repos: { id: string }[] }).repos;
const oidc = async (claims: Record<string, string>) => ((await (await fetch(`${base}/__oidc/token?${new URLSearchParams(claims)}`)).json()) as { value: string }).value;

async function login(name: string, role = 'reviewer'): Promise<Agent> {
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/demo').send({ name, role })).status).toBe(200);
  return agent;
}
let n = 0;
async function newApp(agent: Agent, repo?: string): Promise<ConnectedApp> {
  const res = await agent.post(`/api/ontologies/${demoId}/apps`).send({ name: `App ${++n}`, repo });
  expect(res.status, res.text).toBe(201);
  return res.body as ConnectedApp;
}

/** Start installing as `agent`, go through the stand-in's install page, and come back to Concord's callback. */
async function install(agent: Agent, appId: string, tweak?: (q: URLSearchParams) => void, as: Agent = agent) {
  const started = await agent.post(`/api/apps/${appId}/github/install`);
  expect(started.status, started.text).toBe(200);
  const page = await fetch(started.body.url, { redirect: 'manual' });
  const back = new URL(page.headers.get('location')!);
  tweak?.(back.searchParams);
  const res = await as.get(`/api/github-app/setup?${back.searchParams}`);
  expect(res.status, res.text).toBe(303);
  return new URL(res.headers.location);
}

const doc = (id: string) => getDoc<AppDoc>('apps', id);

async function linked(agent: Agent, repo: string) {
  const [{ id: repoId }] = await nextInstall([repo]);
  const a = await newApp(agent, repo);
  const back = await install(agent, a.id);
  expect(back.searchParams.get('github'), back.toString()).toBe('connected');
  return { app: a, repoId, installationId: (await doc(a.id))!.github!.installationId };
}

function signed(event: string, payload: unknown, secret = SECRET) {
  const body = JSON.stringify(payload);
  return request(app)
    .post('/api/github-app/webhook')
    .set('content-type', 'application/json')
    .set('x-github-event', event)
    .set('x-hub-signature-256', `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`)
    .send(body);
}

beforeAll(async () => {
  base = await stub.listen();
  Object.assign(process.env, {
    GITHUB_APP_ID: '77',
    GITHUB_APP_SLUG: 'concord-unit',
    // Escaped newlines, as some env files need: the server reads both.
    GITHUB_APP_PRIVATE_KEY: keys.privateKey.replace(/\n/g, '\\n'),
    GITHUB_APP_WEBHOOK_SECRET: SECRET,
    GITHUB_APP_CLIENT_ID: 'Iv1.unit',
    GITHUB_APP_CLIENT_SECRET: 'unit-client-secret',
    GITHUB_APP_API_URL: base,
    GITHUB_APP_WEB_URL: base,
    GITHUB_OIDC_ISSUER: base,
  });
  await openDb();
  demoId = (await seedDemo())!.id;
});

afterAll(() => {
  stub.server.close();
  for (const k of ENV) delete process.env[k];
});

describe('the Concord GitHub App', () => {
  it('is off unless every setting is there, and reads the key raw, with escaped newlines, or base64', () => {
    expect(githubAppSettings()).toBeTruthy();
    const key = process.env.GITHUB_APP_PRIVATE_KEY;
    process.env.GITHUB_APP_PRIVATE_KEY = Buffer.from(keys.privateKey).toString('base64');
    expect(githubAppSettings()?.privateKey.asymmetricKeyType).toBe('rsa');
    process.env.GITHUB_APP_PRIVATE_KEY = 'not a key';
    expect(githubAppSettings()).toBeUndefined();
    process.env.GITHUB_APP_PRIVATE_KEY = key;
    delete process.env.GITHUB_APP_CLIENT_SECRET;
    expect(githubAppSettings()).toBeUndefined();
    process.env.GITHUB_APP_CLIENT_SECRET = 'unit-client-secret';
  });

  it('signs the install state, and refuses one that was changed or has expired', () => {
    const s = githubAppSettings()!;
    const st = signState(s, { a: 'app_1', o: 'ont_1', u: 'usr_1' });
    expect(readState(s, st)).toMatchObject({ a: 'app_1', o: 'ont_1', u: 'usr_1' });
    const [body, mac] = st.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), a: 'app_2' })).toString('base64url');
    expect(readState(s, `${forged}.${mac}`)).toBeUndefined();
    const old = Buffer.from(JSON.stringify({ a: 'app_1', o: 'ont_1', u: 'usr_1', e: Math.floor(Date.now() / 1000) - 1 })).toString('base64url');
    const oldMac = createHmac('sha256', s.clientSecret).update(`concord-github-app-state\n${old}`).digest('base64url');
    expect(readState(s, `${old}.${oldMac}`)).toBeUndefined();
  });

  it('links the repository the installer can see, pins its id, and revokes the installer’s token', async () => {
    const owner = await login('Linker');
    const { app: a, repoId } = await linked(owner, 'example/linked');
    const d = (await doc(a.id))!;
    expect(d.github).toMatchObject({ repo: 'example/linked', repoId });
    expect(d.repo).toBe('example/linked');
    expect((await state()).revoked.length).toBeGreaterThan(0);
    // What the page gets leaves out the installation and bookkeeping.
    const listed = ((await owner.get(`/api/ontologies/${demoId}/apps`)).body as ConnectedApp[]).find((x) => x.id === a.id)!;
    expect(Object.keys(listed.github!).sort()).toEqual(['linkedAt', 'repo']);
  });

  // An installation id in the redirect is just a number: it must be one the installer can see.
  it('won’t link an installation the installer can’t see, or finish for someone else', async () => {
    const owner = await login('Careful owner');
    await nextInstall(['example/mine']);
    const a = await newApp(owner, 'example/mine');
    const forged = await install(owner, a.id, (q) => q.set('installation_id', '1'));
    expect(forged.searchParams.get('github_error')).toMatch(/isn’t one your GitHub account can see/);
    expect((await doc(a.id))!.github).toBeUndefined();

    const other = await login('Someone else');
    const back = await install(owner, a.id, undefined, other);
    expect(back.searchParams.get('github_error')).toMatch(/signed in as someone else/);
    const noCode = await install(owner, a.id, (q) => q.delete('code'));
    expect(noCode.searchParams.get('github_error')).toMatch(/Request user authorization/);
    expect((await doc(a.id))!.github).toBeUndefined();
    // Only the app's owner can start connecting it.
    expect((await other.post(`/api/apps/${a.id}/github/install`)).status).toBe(403);
  });

  it('needs the app’s repository to be in the installation', async () => {
    const owner = await login('Wrong repo');
    await nextInstall(['example/not-this-one']);
    const a = await newApp(owner, 'example/this-one');
    const back = await install(owner, a.id);
    expect(back.searchParams.get('github_error')).toMatch(/doesn’t include example\/this-one/);
  });

  it('a run in the linked repository trades GitHub’s proof for a run token, once', async () => {
    const owner = await login('Runner');
    const { app: a } = await linked(owner, 'example/runner');
    const audience = `concord-app-check:${a.id}`;
    const proof = await oidc({ audience, repository: 'example/runner' });
    const res = await request(app).post('/api/app-checks/session').send({ app: a.id, oidc: proof });
    expect(res.status, res.text).toBe(200);
    expect(res.body.token).toMatch(/^cnr_/);
    expect((await request(app).get('/api/app-checks/pending').set('Authorization', `Bearer ${res.body.token}`)).status).toBe(200);
    // The same proof can't be used twice, nor one from another repository (by id, not name), nor one for another app.
    expect((await request(app).post('/api/app-checks/session').send({ app: a.id, oidc: proof })).status).toBe(400);
    expect((await request(app).post('/api/app-checks/session').send({ app: a.id, oidc: await oidc({ audience, repository: 'example/runner', repository_id: '5' }) })).status).toBe(403);
    expect((await request(app).post('/api/app-checks/session').send({ app: a.id, oidc: await oidc({ audience: 'concord-app-check:app_other', repository: 'example/runner' }) })).status).toBe(400);
    // An expired run token stops working.
    const d = (await doc(a.id))!;
    await put('apps', { ...d, runTokens: d.runTokens!.map((t) => ({ ...t, until: Date.now() - 1 })) }, d.ontologyId);
    expect((await request(app).get('/api/app-checks/pending').set('Authorization', `Bearer ${res.body.token}`)).status).toBe(401);
    // An app connected with only a token can't sign in this way.
    const plain = await newApp(owner, 'example/plain');
    expect((await request(app).post('/api/app-checks/session').send({ app: plain.id, oidc: await oidc({ audience: `concord-app-check:${plain.id}`, repository: 'example/plain' }) })).status).toBe(401);
  });

  it('starts one run for each new thing to test, with a token for just that repository and Actions', async () => {
    const owner = await login('Dispatcher');
    const { app: a, repoId } = await linked(owner, 'example/dispatch');
    // No workflow yet: GitHub refuses, Concord says why and waits before asking again.
    expect(await dispatchIfNeeded(a.id)).toBe('failed');
    expect((await doc(a.id))!.github!.lastDispatch).toMatchObject({ ok: false, message: expect.stringMatching(/no \.github\/workflows\/concord\.yml on main/) });
    expect(await dispatchIfNeeded(a.id)).toBe('skipped');

    // Concord opens the pull request; merging it and telling Concord starts a run.
    const pr = await owner.post(`/api/apps/${a.id}/github/workflow-pr`);
    expect(pr.status, pr.text).toBe(200);
    expect(pr.body.app.github.workflowPr.number).toBeGreaterThan(0);
    const again = await owner.post(`/api/apps/${a.id}/github/workflow-pr`);
    expect(again.body.app.github.workflowPr.number).toBe(pr.body.app.github.workflowPr.number);
    const onGithub = (await state()).repos.find((r) => r.full_name === 'example/dispatch')!;
    expect(onGithub.pulls).toHaveLength(1);
    expect(onGithub.files['concord/app-checks']['.github/workflows/concord.yml']).toContain(`app: "${a.id}"`);
    expect(onGithub.files['concord/app-checks']['.github/workflows/concord.yml']).toContain(`concord-url: "${config.webUrl}"`);
    await fetch(`${base}/__app/merge`, { method: 'POST', body: JSON.stringify({ repo: 'example/dispatch', number: pr.body.app.github.workflowPr.number }) });
    // Merged: there's nothing left to add.
    expect((await owner.post(`/api/apps/${a.id}/github/workflow-pr`)).body.alreadyThere).toBe(true);
    const installationId = (await doc(a.id))!.github!.installationId;
    const merged = await signed('pull_request', { action: 'closed', installation: { id: Number(installationId) }, repository: { id: Number(repoId) }, pull_request: { merged: true, head: { ref: 'concord/app-checks' } } });
    expect(merged.status, merged.text).toBe(200);
    const runs = async () => (await state()).dispatches.filter((d) => d.repo === 'example/dispatch').length;
    expect(await runs()).toBe(1);
    expect((await state()).tokenRequests.filter((t) => t.repoIds[0] === repoId).map((t) => t.permissions)).toContainEqual({ actions: 'write' });

    // Nothing new to test: no new run. Something new, but within two minutes of the last: wait.
    expect(await dispatchIfNeeded(a.id)).toBe('skipped');
    const d = (await doc(a.id))!;
    await put('apps', { ...d, github: { ...d.github!, fingerprint: 'something older' } }, d.ontologyId);
    expect(await dispatchIfNeeded(a.id)).toBe('skipped');
    // Two processes deciding at once start one run between them.
    const later = Date.now() + 3 * 60 * 1000;
    const both = await Promise.all([dispatchIfNeeded(a.id, later), dispatchIfNeeded(a.id, later)]);
    expect(both.sort()).toEqual(['skipped', 'started']);
    expect(await runs()).toBe(2);
  });

  it('proposing a change starts runs for apps connected through GitHub', async () => {
    const owner = await login('Proposer', 'editor');
    const { app: a } = await linked(owner, 'example/proposals');
    // The workflow is already there, and the last run was long enough ago.
    const d = (await doc(a.id))!;
    await put('apps', { ...d, github: { ...d.github!, fingerprint: 'old', dispatchAt: Date.now() - 10 * 60 * 1000 } }, d.ontologyId);
    // Put the workflow on main as merging the pull request would.
    const pr = await owner.post(`/api/apps/${a.id}/github/workflow-pr`);
    await fetch(`${base}/__app/merge`, { method: 'POST', body: JSON.stringify({ repo: 'example/proposals', number: pr.body.app.github.workflowPr.number }) });
    const before = (await state()).dispatches.filter((x) => x.repo === 'example/proposals').length;
    const created = await owner.post(`/api/ontologies/${demoId}/change-requests`).send({
      title: 'Note who to contact',
      description: 'People want a contact.',
      kind: 'feature',
      ops: [{ op: 'addDatatypeProperty', localName: 'contactNote', label: 'contact note', definition: 'A short note on who volunteers can contact about a volunteering opportunity and how.', domain: ['https://w3id.org/odi/volunteering#VolunteeringOpportunity'], range: ['http://www.w3.org/2001/XMLSchema#string'] }],
    });
    expect(created.status, created.text).toBe(201);
    expect((await owner.post(`/api/change-requests/${created.body.id}/submit`)).body.status).toBe('review');
    await expect.poll(async () => (await state()).dispatches.filter((x) => x.repo === 'example/proposals').length).toBe(before + 1);
    // nudgeRuns on its own finds nothing new.
    await nudgeRuns(demoId);
    expect((await state()).dispatches.filter((x) => x.repo === 'example/proposals').length).toBe(before + 1);
  });

  it('webhooks: only signed deliveries count; uninstalling, suspending or removing the repository act on the linked apps', async () => {
    const owner = await login('Webhooked');
    const one = await linked(owner, 'example/hook-one');
    expect((await signed('installation', { action: 'deleted', installation: { id: Number(one.installationId) } }, 'wrong')).status).toBe(401);
    expect((await request(app).post('/api/github-app/webhook').set('x-github-event', 'installation').send({ action: 'deleted', installation: { id: 1 } })).status).toBe(401);
    expect((await doc(one.app.id))!.github).toBeTruthy();

    expect((await signed('installation', { action: 'suspend', installation: { id: Number(one.installationId) } })).body).toEqual({ handled: true, apps: 1 });
    expect((await doc(one.app.id))!.github!.suspended).toBe(true);
    expect(await dispatchIfNeeded(one.app.id)).toBe('skipped');
    await signed('installation', { action: 'unsuspend', installation: { id: Number(one.installationId) } });
    expect((await doc(one.app.id))!.github!.suspended).toBeUndefined();

    expect((await signed('installation_repositories', { action: 'removed', installation: { id: Number(one.installationId) }, repositories_removed: [{ id: Number(one.repoId) }] })).body).toEqual({ handled: true, apps: 1 });
    expect((await doc(one.app.id))!.github).toBeUndefined();

    const two = await linked(owner, 'example/hook-two');
    expect((await signed('installation', { action: 'deleted', installation: { id: Number(two.installationId) } })).body).toEqual({ handled: true, apps: 1 });
    expect((await doc(two.app.id))!.github).toBeUndefined();
    expect((await signed('star', { action: 'created', installation: { id: 1 } })).body).toEqual({ handled: false, apps: 0 });
  });

  it('the owner can stop using GitHub; the app token keeps working', async () => {
    const owner = await login('Unlinker');
    const a = await newApp(owner, 'example/unlink');
    await nextInstall(['example/unlink']);
    await install(owner, a.id);
    const res = await owner.delete(`/api/apps/${a.id}/github`);
    expect(res.status, res.text).toBe(200);
    expect(res.body.github).toBeUndefined();
    expect((await request(app).get('/api/app-checks/pending').set('Authorization', `Bearer ${a.token}`)).status).toBe(200);
  });

  it('is off without its settings: the token route is all there is', async () => {
    const id = process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_ID;
    try {
      expect((await request(app).get('/api/github-app')).body).toEqual({ enabled: false });
      const owner = await login('No app here');
      const a = await newApp(owner);
      expect((await owner.post(`/api/apps/${a.id}/github/install`)).status).toBe(404);
      expect((await signed('installation', { action: 'deleted', installation: { id: 1 } })).status).toBe(404);
    } finally {
      process.env.GITHUB_APP_ID = id;
    }
    expect((await request(app).get('/api/github-app')).body).toEqual({ enabled: true, url: `${base}/apps/concord-unit` });
  });
});
