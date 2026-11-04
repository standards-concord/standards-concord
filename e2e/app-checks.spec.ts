import { test, expect, expectNoCrash, settle, signIn, demoOntology } from './fixtures';
import type { APIRequestContext } from '@playwright/test';

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

  test('the demo shows a connected app’s results and its autopilot approval', async ({ page, request }) => {
    await signIn(page, { name: 'Checks viewer', role: 'member' });
    const expenses = await changeByTitle(request, demo.id, 'Say whether an opportunity reimburses expenses');
    await page.goto(`/o/${demo.id}/changes/${expenses}`);
    await settle(page);
    const card = page.locator('section').filter({ has: page.getByRole('heading', { name: 'App checks' }) });
    await expect(card.getByTestId('app-check').filter({ hasText: 'CharityBase volunteer export' })).toContainText('Passed');
    await expect(card).toContainText('Gareth Lewis’s app');
    // Gareth's approval in the timeline came from autopilot.
    const timeline = page.locator('li').filter({ hasText: 'Gareth Lewis' }).filter({ hasText: 'Approved' });
    await expect(timeline.getByText('Autopilot', { exact: true })).toBeVisible();

    const major = await changeByTitle(request, demo.id, 'Allow only one location per session');
    await page.goto(`/o/${demo.id}/changes/${major}`);
    await settle(page);
    const failed = page.getByTestId('app-check').filter({ hasText: 'CharityBase volunteer export' });
    await expect(failed).toContainText('Failed');
    await expect(failed).toContainText('expected 3 locations, got 1');
    await expectNoCrash(page);
  });

  test('connect an app, turn on autopilot, and see it approve when CI passes', async ({ page, request }) => {
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
    await page.getByRole('link', { name: 'App checks' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${demo.id}/apps$`));
    await expect(page.getByRole('heading', { name: 'App checks', level: 2 })).toBeVisible();
    await expect(page.getByText('CharityBase volunteer export')).toBeVisible();

    await page.getByLabel('App name').fill('Family finder');
    await page.getByLabel('GitHub repository (optional)').fill('example/family-finder');
    await page.getByRole('button', { name: 'Connect app' }).click();
    const token = (await page.getByTestId('app-token').innerText()).trim();
    expect(token).toMatch(/^cna_/);
    await expect(page.getByText('jeswr/standards-concord/actions/app-check@main')).toBeVisible();
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
    const res = await page.request.post('/api/app-checks', {
      headers: auth,
      data: { target: crId, revision: target.revision, attempt, outcome: 'passed', runUrl: 'https://github.com/example/family-finder/actions/runs/7' },
    });
    expect((await res.json()).autopilot.action).toBe('approved');

    // The page picks up the new result when refreshed.
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(app.getByText('Passes the working draft')).toBeVisible();

    await page.goto(`/o/${demo.id}/changes/${crId}`);
    await settle(page);
    const check = page.getByTestId('app-check').filter({ hasText: 'Family finder' });
    await expect(check).toContainText('Passed');
    await expect(check.getByRole('link', { name: /CI run/ })).toHaveAttribute('href', 'https://github.com/example/family-finder/actions/runs/7');
    const approval = page.locator('li').filter({ hasText: 'Ravi Reviewer' }).filter({ hasText: 'Approved' });
    await expect(approval.getByText('Autopilot', { exact: true })).toBeVisible();
    await expect(page.getByText(/Approvals: 1\/2|1 more approval/).first()).toBeVisible();

    // A failure in the next CI run takes the approval back. It stays on record, marked withdrawn.
    const next = await (await page.request.get('/api/app-checks/pending?all=1', { headers: auth })).json();
    await page.request.post('/api/app-checks', { headers: auth, data: { target: 'baseline', revision: next.baseline.revision, attempt: next.attempt, outcome: 'passed' } });
    await page.request.post('/api/app-checks', { headers: auth, data: { target: crId, revision: target.revision, attempt: next.attempt, outcome: 'failed', summary: '`npm test` exited with code 1.' } });
    await page.reload();
    await settle(page);
    await expect(page.getByTestId('app-check').filter({ hasText: 'Family finder' })).toContainText('Failed');
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
    await page.goto(`/o/${demo.id}/changes/${crId}`);
    await settle(page);
    await expect(page.getByText('No app has tested this change yet.')).toBeVisible();
    await page.getByRole('link', { name: 'Connect your app' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${demo.id}/apps$`));
  });

  test('the governance policy has an autopilot switch', async ({ page }) => {
    await signIn(page, { name: 'Steward of autopilot', role: 'steward' });
    await page.goto(`/o/${demo.id}/governance`);
    await settle(page);
    await page.getByRole('button', { name: /Ownership, ODI and automation/ }).click();
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
