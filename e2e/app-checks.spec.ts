import { test, expect, expectNoCrash, settle, signIn, signInAsPersona, demoOntology, uniq } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { workflowYaml } from '../packages/shared/src/workflowYaml';

/**
 * App checks and autopilot: a member connects their app, its CI reports results against
 * proposed changes, and autopilot approves for them when the app passes.
 */

const VOL = 'https://w3id.org/odi/volunteering#';

async function changeByTitle(request: APIRequestContext, ontologyId: string, title: string) {
  const all = (await (await request.get(`/api/ontologies/${ontologyId}/change-requests`)).json()) as { id: string; title: string }[];
  const cr = all.find((c) => c.title === title);
  expect(cr, title).toBeTruthy();
  return cr!.id;
}

test.describe('app checks', () => {
  let demo: { id: string; title: string };
  test.beforeEach(async ({ request }) => {
    demo = await demoOntology(request);
  });

  test('the demo shows a connected app’s results and its autopilot approval', async ({ page }) => {
    await signIn(page, { name: 'Checks viewer', role: 'member' });
    const expenses = await changeByTitle(page.request, demo.id, 'Say whether an opportunity reimburses expenses');
    await page.goto(`/o/${demo.id}/changes/${expenses}?view=checks`);
    await settle(page);
    const card = page.locator('section').filter({ has: page.getByRole('heading', { name: 'App checks' }) });
    await expect(card.getByTestId('app-check').filter({ hasText: 'CharityBase volunteer export' })).toContainText('Passed');
    await expect(card).toContainText('Gareth Lewis’s app');
    // Gareth's approval in the timeline came from autopilot.
    await page.getByRole('tab', { name: /Discussion/ }).click();
    const timeline = page.locator('li').filter({ hasText: 'Gareth Lewis' }).filter({ hasText: 'Approved' });
    await expect(timeline.getByText('Autopilot', { exact: true })).toBeVisible();

    const major = await changeByTitle(page.request, demo.id, 'Allow only one location per session');
    await page.goto(`/o/${demo.id}/changes/${major}?view=checks`);
    await settle(page);
    const failed = page.getByTestId('app-check').filter({ hasText: 'CharityBase volunteer export' });
    await expect(failed).toContainText('Failed');
    await expect(failed).toContainText('expected 3 locations, got 1');
    await expectNoCrash(page);
  });

  test('owners and stewards can disconnect anyone’s app; other members can’t', async ({ page }) => {
    // A reviewer connects an app.
    await signIn(page, { name: `App owner ${uniq()}`, role: 'reviewer' });
    const name = `Disconnect me ${uniq()}`;
    const res = await page.request.post(`/api/ontologies/${demo.id}/apps`, { data: { name } });
    expect(res.status(), await res.text()).toBe(201);
    const { token } = (await res.json()) as { token: string };

    // Another member sees it, with no way to disconnect it.
    await signIn(page, { name: `Another member ${uniq()}`, role: 'reviewer' });
    await page.goto(`/o/${demo.id}/apps`);
    await settle(page);
    await expect(page.getByText(name)).toBeVisible();
    await expect(page.getByRole('button', { name: `Disconnect ${name}` })).toHaveCount(0);

    // The steward disconnects it, after confirming.
    await signInAsPersona(page, 'Priya Shah');
    await page.goto(`/o/${demo.id}/apps`);
    await settle(page);
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: `Disconnect ${name}` }).click();
    await expect(page.getByText(name)).toHaveCount(0);
    // Its token stops working, and it stays gone.
    expect((await page.request.get('/api/app-checks/pending', { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(401);
    await page.reload();
    await settle(page);
    await expect(page.getByRole('heading', { name: 'App checks', level: 2 })).toBeVisible();
    await expect(page.getByText(name)).toHaveCount(0);
  });

  test('connect an app, turn on autopilot, and see it approve when CI passes', async ({ page, context, request }) => {
    // An editor proposes a new term, so it is fresh for this test.
    await request.post('/api/auth/demo', { data: { name: 'Editor for app checks', role: 'editor' } });
    const created = await request.post(`/api/ontologies/${demo.id}/change-requests`, {
      data: {
        title: `Say whether an opportunity suits families ${Date.now()}`,
        description: 'Parents want to volunteer with their children.',
        kind: 'feature',
        ops: [
          {
            op: 'addDatatypeProperty',
            localName: `familyFriendly${Date.now()}`,
            label: 'family friendly',
            definition: 'Whether a volunteering opportunity welcomes volunteers who bring their children along, as stated by the organisation offering it.',
            domain: [`${VOL}VolunteeringOpportunity`],
            range: ['http://www.w3.org/2001/XMLSchema#boolean'],
          },
        ],
      },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const crId = ((await created.json()) as { id: string }).id;
    const submitted = await request.post(`/api/change-requests/${crId}/submit`);
    expect(((await submitted.json()) as { status: string }).status).toBe('review');

    // A reviewer (whose approvals count for minor changes) connects their app.
    await signIn(page, { name: 'Ravi Reviewer', role: 'reviewer' });
    await page.goto(`/o/${demo.id}/changes`);
    // Exactly the tab: change requests other tests opened may mention app checks in their titles.
    await page.getByRole('link', { name: 'App checks', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${demo.id}/apps$`));
    await expect(page.getByRole('heading', { name: 'App checks', level: 2 })).toBeVisible();
    await expect(page.getByText('CharityBase volunteer export')).toBeVisible();

    await page.getByLabel('App name').fill('Family finder');
    await page.getByLabel('GitHub repository (optional)').fill('example/family-finder');
    await page.getByRole('button', { name: 'Connect app' }).click();
    const token = (await page.getByTestId('app-token').innerText()).trim();
    expect(token).toMatch(/^cna_/);
    // From the action's public home, so repositories anywhere can use it.
    await expect(page.getByText('standards-concord/app-check@v1')).toBeVisible();
    // The workflow is syntax-highlighted as YAML: keys, strings and comments get their own colours.
    const workflow = page.getByRole('region', { name: 'Workflow file' });
    await expect(workflow).toHaveAttribute('data-language', 'yaml');
    // Highlighting must not change a character: what shows and what Copy copies are exactly the workflow.
    const expectedYaml = workflowYaml(new URL(page.url()).origin);
    expect(await workflow.evaluate((el) => el.textContent)).toBe(expectedYaml);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await workflow.locator('xpath=..').getByRole('button', { name: 'Copy' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expectedYaml);
    await expect(workflow.locator('.tok-attr', { hasText: /^jobs$/ })).toBeVisible();
    await expect(workflow.locator('.tok-string', { hasText: '*/30 * * * *' })).toBeVisible();
    await expect(workflow.locator('.tok-comment').first()).toBeVisible();
    await expect(page.getByRole('link', { name: /Create it in example\/family-finder/ })).toHaveAttribute('href', /github\.com\/example\/family-finder\/new\/main\?filename=/);
    await expect(page.getByRole('link', { name: /Open example\/family-finder’s secrets/ })).toBeVisible();

    const app = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Family finder' }) });
    await expect(app.getByText('Not run yet')).toBeVisible();
    await app.getByRole('switch').click();
    await expect(app.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    await expect(app.getByText('approves in review').first()).toBeVisible();
    await expect(app.getByRole('checkbox', { name: /Major/ })).not.toBeChecked();
    await expect(app.getByRole('checkbox', { name: /Minor/ })).toBeChecked();

    // The app's CI asks what to test and reports back, as the GitHub Action does.
    const auth = { Authorization: `Bearer ${token}` };
    const pending = await (await page.request.get('/api/app-checks/pending', { headers: auth })).json();
    const target = pending.targets.find((t: { changeRequestId: string }) => t.changeRequestId === crId);
    expect(target, 'the new change is listed for testing').toBeTruthy();
    const proposed = await page.request.get(target.source);
    expect(await proposed.text()).toContain('familyFriendly');
    const attempt = pending.attempt;
    await page.request.post('/api/app-checks', { headers: auth, data: { target: 'baseline', revision: pending.baseline.revision, attempt, outcome: 'passed' } });
    const unverified = await page.request.post('/api/app-checks', { headers: auth, data: { target: crId, revision: target.revision, attempt, outcome: 'passed' } });
    // With only the token (no proof from GitHub), the result shows but autopilot waits.
    expect((await unverified.json()).autopilot.message).toMatch(/verified run/);

    // The owner reports a run themselves, signed in, which counts like one GitHub vouches for.
    // This app's id, from its own run (other runs may have connected apps with the same name).
    const appId = (pending as { app: { id: string } }).app.id;
    const own = await (await page.request.get(`/api/app-checks/pending?all=1&appId=${appId}`)).json();
    await page.request.post('/api/app-checks', { data: { appId, target: 'baseline', revision: own.baseline.revision, attempt: own.attempt, outcome: 'passed' } });
    const res = await page.request.post('/api/app-checks', {
      data: { appId, target: crId, revision: target.revision, attempt: own.attempt, outcome: 'passed', runUrl: 'https://github.com/example/family-finder/actions/runs/7' },
    });
    expect((await res.json()).autopilot.action).toBe('approved');

    // The page picks up the new result when refreshed.
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(app.getByText('Passes the working draft')).toBeVisible();

    await page.goto(`/o/${demo.id}/changes/${crId}?view=checks`);
    await settle(page);
    const check = page.getByTestId('app-check').filter({ hasText: 'Family finder' });
    await expect(check).toContainText('Passed');
    await expect(check.getByRole('link', { name: /CI run/ })).toHaveAttribute('href', 'https://github.com/example/family-finder/actions/runs/7');
    await page.getByRole('tab', { name: /Discussion/ }).click();
    const approval = page.locator('li').filter({ hasText: 'Ravi Reviewer' }).filter({ hasText: 'Approved' });
    await expect(approval.getByText('Autopilot', { exact: true })).toBeVisible();
    await expect(page.getByText(/Approvals: 1\/2|1 more approval/).first()).toBeVisible();

    // A failure in the next (verified) run takes the approval back. It stays on record, marked withdrawn.
    const next = await (await page.request.get(`/api/app-checks/pending?all=1&appId=${appId}`)).json();
    await page.request.post('/api/app-checks', { data: { appId, target: 'baseline', revision: next.baseline.revision, attempt: next.attempt, outcome: 'passed' } });
    await page.request.post('/api/app-checks', { data: { appId, target: crId, revision: target.revision, attempt: next.attempt, outcome: 'failed', summary: '`npm test` exited with code 1.' } });
    await page.goto(`/o/${demo.id}/changes/${crId}?view=checks`);
    await settle(page);
    await expect(page.getByTestId('app-check').filter({ hasText: 'Family finder' })).toContainText('Failed');
    await page.getByRole('tab', { name: /Discussion/ }).click();
    await expect(page.getByText(/Autopilot withdrew Ravi Reviewer’s yes/)).toBeVisible();
    await expect(approval.getByText('Withdrawn', { exact: true })).toBeVisible();
    await expect(page.getByText(/Approvals: 0\/2|2 more approval/).first()).toBeVisible();
    await expectNoCrash(page);
  });

  test('a change nobody has tested invites people to connect an app', async ({ page }) => {
    await signIn(page, { name: 'Untested viewer', role: 'editor' });
    const created = await page.request.post(`/api/ontologies/${demo.id}/change-requests`, {
      data: {
        title: `Clarify session ${Date.now()}`,
        description: 'Wording only.',
        kind: 'editorial',
        ops: [{ op: 'updateAnnotations', iri: `${VOL}Session`, set: { comment: 'A session can be one-off or part of a series.' } }],
      },
    });
    const crId = ((await created.json()) as { id: string }).id;
    await page.request.post(`/api/change-requests/${crId}/submit`);
    await page.goto(`/o/${demo.id}/changes/${crId}?view=checks`);
    await settle(page);
    await expect(page.getByText('No app has tested this change yet.')).toBeVisible();
    await page.getByRole('link', { name: 'Connect your app' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${demo.id}/apps$`));
  });

  test('the governance policy has an autopilot switch', async ({ page }) => {
    await signIn(page, { name: 'Steward of autopilot', role: 'steward' });
    await page.goto(`/o/${demo.id}/governance`);
    await settle(page);
    await expect(page.getByText(/of 5 automations on/)).toBeVisible();
    await page.getByRole('button', { name: /Ownership, ODI and automation/ }).click();
    await expect(page.getByText(/On: autopilot/)).toBeVisible();
    await page.getByRole('button', { name: 'Edit policy' }).click();
    const sw = page.getByRole('switch', { name: /Autopilot: members can have Concord approve or vote yes/ });
    await expect(sw).toHaveAttribute('aria-checked', 'true');
  });

  test('the App checks page fits a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, { name: 'Phone tester', role: 'member' });
    await page.goto(`/o/${demo.id}/apps`);
    await settle(page);
    await expect(page.getByRole('heading', { name: 'App checks', level: 2 })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
