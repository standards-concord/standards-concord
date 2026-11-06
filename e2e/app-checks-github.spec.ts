import { createHmac } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { workflowYaml } from '../packages/shared/src/workflowYaml';
import { test, expect, expectNoCrash, settle, signIn, demoOntology, uniq } from './fixtures';

/**
 * Connecting an app through the Concord GitHub App instead of a token: install it on the app's
 * repository (the stand-in GitHub in e2e/github-stub.mjs sends the browser straight back), let
 * Concord open the pull request that adds the workflow, and have runs sign in with GitHub's own
 * proof. The stand-in checks the App's JWTs and the permissions each token asks for.
 */

const STUB = `http://localhost:${process.env.E2E_GITHUB_STUB_PORT ?? 8799}`;
// The test-only secret playwright.config.ts gives the server (GITHUB_APP_WEBHOOK_SECRET).
const WEBHOOK_SECRET = 'e2e-only-github-app-webhook-secret';

interface StubApp {
  dispatches: { repo: string; workflow: string; ref: string }[];
  tokenRequests: { repoIds: string[]; permissions: Record<string, string> }[];
  revoked: string[];
  installations: { id: string; repos: string[] }[];
  repos: { id: string; full_name: string; files: Record<string, Record<string, string>>; pulls: { number: number; head: string; state: string }[] }[];
}
const stub = async (request: APIRequestContext) => (await (await request.get(`${STUB}/__app`)).json()) as StubApp;
const nextInstall = async (request: APIRequestContext, repos: string[], readOnly: string[] = []) => (await (await request.post(`${STUB}/__app/next-install`, { data: { repos, readOnly } })).json()) as { repos: { full_name: string; id: string }[] };
const oidcFor = async (request: APIRequestContext, claims: Record<string, string>) => ((await (await request.get(`${STUB}/__oidc/token?${new URLSearchParams(claims)}`)).json()) as { value: string }).value;

/** Deliver a webhook as GitHub would, signed with the App's webhook secret. */
async function webhook(request: APIRequestContext, event: string, payload: unknown, secret = WEBHOOK_SECRET) {
  const body = JSON.stringify(payload);
  return request.post('/api/github-app/webhook', {
    headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` },
    data: body,
  });
}

/** Connect an app on the page as the signed-in person; returns its id. */
async function connectApp(page: Page, ontologyId: string, name: string, repo?: string) {
  await page.goto(`/o/${ontologyId}/apps`);
  await settle(page);
  await page.getByLabel('App name').fill(name);
  if (repo) await page.getByLabel('GitHub repository (optional)').fill(repo);
  const created = page.waitForResponse((r) => r.url().endsWith(`/api/ontologies/${ontologyId}/apps`) && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Connect app' }).click();
  return ((await (await created).json()) as { id: string }).id;
}

const card = (page: Page, name: string) => page.locator('section').filter({ has: page.getByRole('heading', { name }) });

test.describe('app checks through the Concord GitHub App', () => {
  let demo: { id: string; title: string };
  test.beforeEach(async ({ request }) => {
    demo = await demoOntology(request);
  });

  test('connect through GitHub, let Concord open the workflow pull request, and runs sign in without a token', async ({ page }) => {
    const repo = `example/finder-${uniq()}`;
    const [{ id: repoId }] = (await nextInstall(page.request, [repo])).repos;
    await signIn(page, { name: `GitHub app owner ${uniq()}`, role: 'reviewer' });
    const name = `Finder ${uniq()}`;
    const appId = await connectApp(page, demo.id, name, repo);

    // The token route is still there, folded away under the recommended one.
    const app = card(page, name);
    await expect(app.getByText('Or use a token and add the workflow yourself')).toBeVisible();
    await app.getByRole('button', { name: 'Connect with GitHub' }).click();

    // Installed on GitHub and straight back, linked to the repository the installer could see.
    await expect(page).toHaveURL(new RegExp(`/o/${demo.id}/apps\\?github=connected`));
    await expect(page.getByRole('status')).toContainText(`Connected ${name} through GitHub`);
    await expect(app).toContainText('connected through GitHub');
    // The installer's one-time sign-in was used for that one check, then revoked.
    expect((await stub(page.request)).revoked.length).toBeGreaterThan(0);

    // The workflow names the app and has no secret.
    const expected = workflowYaml(new URL(page.url()).origin, { app: appId });
    const workflow = app.getByRole('region', { name: 'Workflow file' });
    expect(await workflow.evaluate((el) => el.textContent)).toBe(expected);
    expect(expected).not.toContain('secrets.');

    // Before the workflow is there, Concord can't start a run, and says why.
    await app.getByRole('button', { name: 'Start a run now' }).click();
    await expect(app.getByTestId('last-dispatch')).toContainText(`There’s no .github/workflows/concord.yml on main yet`);

    // Concord opens the pull request, with a token for just this repository and what the step needs.
    await app.getByRole('button', { name: 'Open a pull request that adds it' }).click();
    await expect(app.getByRole('link', { name: /Pull request #\d+ adds it/ })).toBeVisible();
    let gh = await stub(page.request);
    const onGithub = gh.repos.find((r) => r.full_name === repo)!;
    expect(onGithub.files['concord/app-checks']['.github/workflows/concord.yml']).toBe(expected);
    const pr = onGithub.pulls.find((p) => p.head === 'concord/app-checks')!;
    expect(gh.tokenRequests.at(-1)).toEqual({ installationId: expect.any(String), repoIds: [repoId], permissions: { contents: 'write', pull_requests: 'write', workflows: 'write' } });

    // The pull request is merged: GitHub tells Concord, and Concord starts a run straight away.
    await page.request.post(`${STUB}/__app/merge`, { data: { repo, number: pr.number } });
    const installationId = gh.installations.find((i) => i.repos.includes(repo))!.id;
    const merged = await webhook(page.request, 'pull_request', { action: 'closed', installation: { id: Number(installationId) }, repository: { id: Number(repoId) }, pull_request: { number: pr.number, merged: true, merge_commit_sha: `merge-${uniq()}`, head: { ref: 'concord/app-checks' } } });
    expect(merged.status(), await merged.text()).toBe(200);
    await expect.poll(async () => (await stub(page.request)).dispatches.filter((d) => d.repo === repo).length).toBeGreaterThan(0);
    gh = await stub(page.request);
    expect(gh.dispatches.filter((d) => d.repo === repo).at(-1)).toMatchObject({ workflow: 'concord.yml', ref: 'main' });
    expect(gh.tokenRequests.some((t) => t.repoIds[0] === repoId && JSON.stringify(t.permissions) === JSON.stringify({ actions: 'write' }))).toBe(true);

    // The run signs in with GitHub's proof that it runs in that repository, and reports a verified result.
    const audience = `concord-app-check:${appId}`;
    const session = await page.request.post('/api/app-checks/session', { data: { app: appId, oidc: await oidcFor(page.request, { audience, repository: repo }) } });
    expect(session.status(), await session.text()).toBe(200);
    const { token } = (await session.json()) as { token: string };
    expect(token).toMatch(/^cnr_/);
    const auth = { Authorization: `Bearer ${token}` };
    const pending = await page.request.get('/api/app-checks/pending?commit=f00dfeed', { headers: auth });
    expect(pending.status(), await pending.text()).toBe(200);
    const run = (await pending.json()) as { attempt: number; app: { id: string }; baseline: { revision: string } };
    expect(run.app.id).toBe(appId);
    const reported = await page.request.post('/api/app-checks', {
      headers: auth,
      data: { target: 'baseline', revision: run.baseline.revision, attempt: run.attempt, outcome: 'passed', commit: 'f00dfeed', oidc: await oidcFor(page.request, { audience, repository: repo }) },
    });
    expect(reported.status(), await reported.text()).toBe(200);
    expect(((await reported.json()) as { verified?: boolean }).verified).toBe(true);
    await page.reload();
    await settle(page);
    await expect(card(page, name).getByText('Passes the working draft')).toBeVisible();

    // A run in some other repository can't sign in as this app.
    const other = await page.request.post('/api/app-checks/session', { data: { app: appId, oidc: await oidcFor(page.request, { audience, repository: 'example/someone-else', repository_id: '1' }) } });
    expect(other.status()).toBe(403);
    await expectNoCrash(page);
  });

  test('only the app’s owner can connect it through GitHub; other members see that it is', async ({ page }) => {
    const repo = `example/shared-${uniq()}`;
    await nextInstall(page.request, [repo]);
    await signIn(page, { name: `Connector ${uniq()}`, role: 'reviewer' });
    const name = `Shared ${uniq()}`;
    const appId = await connectApp(page, demo.id, name, repo);
    await card(page, name).getByRole('button', { name: 'Connect with GitHub' }).click();
    await expect(page.getByRole('status')).toContainText('through GitHub');

    await signIn(page, { name: `Other member ${uniq()}`, role: 'reviewer' });
    await page.goto(`/o/${demo.id}/apps`);
    await settle(page);
    const row = page.getByRole('listitem').filter({ hasText: name });
    await expect(row.getByText('Connected with GitHub')).toBeVisible();
    await expect(row.getByRole('button', { name: /Connect with GitHub|Open a pull request|Start a run now/ })).toHaveCount(0);
    for (const path of ['install', 'workflow-pr', 'run']) expect((await page.request.post(`/api/apps/${appId}/github/${path}`)).status(), path).toBe(403);
    expect((await page.request.delete(`/api/apps/${appId}/github`)).status()).toBe(403);
    await expectNoCrash(page);
  });

  test('an installation covering several repositories needs the app’s repository set first', async ({ page }) => {
    await nextInstall(page.request, [`example/one-${uniq()}`, `example/two-${uniq()}`]);
    await signIn(page, { name: `Many repos ${uniq()}`, role: 'reviewer' });
    const name = `No repo ${uniq()}`;
    await connectApp(page, demo.id, name);
    await card(page, name).getByRole('button', { name: 'Connect with GitHub' }).click();
    await expect(page.getByRole('status')).toContainText('covers several repositories');
    await expect(card(page, name)).not.toContainText('connected through GitHub');
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByRole('status')).toHaveCount(0);
    await expectNoCrash(page);
  });

  test('someone who can only read the repository on GitHub can’t connect it', async ({ page }) => {
    const repo = `example/read-only-${uniq()}`;
    await nextInstall(page.request, [repo], [repo]);
    await signIn(page, { name: `Reader ${uniq()}`, role: 'reviewer' });
    const name = `Read only ${uniq()}`;
    await connectApp(page, demo.id, name, repo);
    await card(page, name).getByRole('button', { name: 'Connect with GitHub' }).click();
    await expect(page.getByRole('status')).toContainText(`You can see ${repo} on GitHub but can’t push to it`);
    await expect(card(page, name)).not.toContainText('connected through GitHub');
    await expect(card(page, name).getByRole('button', { name: 'Open a pull request that adds it' })).toHaveCount(0);
    await expectNoCrash(page);
  });

  test('uninstalling the Concord app on GitHub disconnects the app, and unsigned deliveries are refused', async ({ page }) => {
    const repo = `example/gone-${uniq()}`;
    const [{ id: repoId }] = (await nextInstall(page.request, [repo])).repos;
    await signIn(page, { name: `Uninstaller ${uniq()}`, role: 'reviewer' });
    const name = `Gone ${uniq()}`;
    const appId = await connectApp(page, demo.id, name, repo);
    await card(page, name).getByRole('button', { name: 'Connect with GitHub' }).click();
    await expect(card(page, name)).toContainText('connected through GitHub');
    const installationId = Number((await stub(page.request)).installations.find((i) => i.repos.includes(repo))!.id);

    // Someone without the webhook secret can't disconnect it.
    expect((await webhook(page.request, 'installation', { action: 'deleted', installation: { id: installationId } }, 'not-the-secret')).status()).toBe(401);
    await page.reload();
    await expect(card(page, name)).toContainText('connected through GitHub');

    const gone = await webhook(page.request, 'installation', { action: 'deleted', installation: { id: installationId }, repositories: [{ id: Number(repoId) }] });
    expect(gone.status(), await gone.text()).toBe(200);
    await page.reload();
    await settle(page);
    await expect(card(page, name)).not.toContainText('connected through GitHub');
    await expect(card(page, name).getByRole('button', { name: 'Connect with GitHub' })).toBeVisible();
    // Its runs can't sign in with GitHub's proof any more.
    const session = await page.request.post('/api/app-checks/session', { data: { app: appId, oidc: await oidcFor(page.request, { audience: `concord-app-check:${appId}`, repository: repo }) } });
    expect(session.status()).toBe(401);
    await expectNoCrash(page);
  });
});
