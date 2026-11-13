import type { Page } from '@playwright/test';
import { test, expect, demoOntology, personas, settle, signIn, uniq } from './fixtures';

async function fresh(page: Page) {
  await signIn(page, { name: `First steps ${uniq()}`, role: 'steward' });
  const r = await page.request.post('/api/ontologies', { data: { title: `First steps ${uniq()}`, prefix: 'fs', description: 'A standard for the first steps tests.', governanceTemplate: 'steward-led' } });
  expect(r.ok()).toBeTruthy();
  return r.json();
}

for (const width of [1400, 390]) {
  test(`an empty Diagram stays at 100 percent without SVG errors at ${width}px`, async ({ page }) => {
    // Empty drawings used to fit infinite bounds, log an SVG error and show 2% zoom.
    await page.setViewportSize({ width, height: 950 });
    const o = await fresh(page);
    await page.goto(`/o/${o.id}/browse?view=diagram`);
    await settle(page);
    await expect(page.getByLabel('Zoom 100 percent', { exact: true })).toBeVisible();
    await expect(page.getByText('No classes yet. Use Propose changes to draw the first ones.')).toBeVisible();
    for (const name of ['Zoom in', 'Zoom out', 'Fit to view', 'Download as SVG', 'Download as PNG']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name, exact: true })).toHaveAttribute('title', 'No classes to draw yet.');
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test(`empty Browse explains how to add the first terms at ${width}px`, async ({ page }) => {
    // A fresh ontology used to say "No classes match" and "Pick a term", with no next step.
    await page.setViewportSize({ width, height: 950 });
    const o = await fresh(page);
    await page.goto(`/o/${o.id}/browse`);
    await expect(page.getByText('No classes yet.', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No terms yet', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Search terms', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole('link', { name: 'Describe a use case', exact: true })).toHaveAttribute('href', `/o/${o.id}/use-cases`);
    await page.getByRole('link', { name: 'propose a change in plain language', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'New change request', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

const steps = (page: Page) => page.getByRole('region', { name: 'First steps', exact: true });

test('a new steward has four steps to do, useful links and neutral address checks', async ({ page }) => {
  const o = await fresh(page);
  await page.goto(`/o/${o.id}`);
  const list = steps(page).getByRole('list', { name: 'First steps' });
  await expect(list.getByRole('listitem')).toHaveCount(4);
  await expect(list.getByText('To do', { exact: true })).toHaveCount(4);
  await expect(steps(page)).toContainText(`Decisions follow the ${o.governance.name} policy.`);
  for (const [name, path] of [['Describe a use case', 'use-cases'], ['Members and roles', 'governance#roles'], ['Releases', 'releases']]) {
    await steps(page).getByRole('link', { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${o.id}/${path}$`));
    await page.getByRole('link', { name: 'Overview', exact: true }).click();
  }
  await expect(page.getByText('Checked once the first version is published.', { exact: true })).toHaveCount(2);
  for (const row of await page.getByRole('listitem').filter({ hasText: 'Checked once the first version is published.' }).all()) {
    await expect(row.getByRole('img', { name: /^Not checked/ })).toHaveCount(1);
    await expect(row.getByRole('img', { name: /^Fails/ })).toHaveCount(0);
  }
  const validation = await (await page.request.get(`/api/ontologies/${o.id}/validation`)).json();
  const total = validation.fair.checks.filter((c: { status: string }) => c.status !== 'not-checked').length;
  const passed = validation.fair.checks.filter((c: { passed: boolean }) => c.passed).length;
  await expect(page.getByRole('button', { name: /^FAIR checks/ })).toContainText(`${passed} of ${total} pass`);
  await steps(page).getByRole('link', { name: 'Propose a change', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'New change request', exact: true })).toBeVisible();
  await expect(page).toHaveURL(`/o/${o.id}/changes`);
  await page.reload();
  await settle(page);
  await expect(page.getByRole('dialog', { name: 'New change request', exact: true })).toHaveCount(0);
});

test('steps tick themselves as a use case, a change request and another member arrive', async ({ page }) => {
  const o = await fresh(page);
  await page.goto(`/o/${o.id}`);
  await steps(page).getByRole('link', { name: 'Describe a use case', exact: true }).click();
  await page.getByRole('button', { name: 'Describe a use case', exact: true }).first().click();
  await expect(page).toHaveURL(/\/interview\/int_/);
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(steps(page).getByRole('listitem').nth(0).getByText('Done', { exact: true })).toHaveCount(1);
  await steps(page).getByRole('link', { name: 'Propose a change', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New change request', exact: true });
  const term = `First${uniq()}`;
  await dialog.getByLabel('Title').fill(`Add ${term}`);
  await dialog.getByLabel('Describe the change in plain language').fill(`Add a class ${term}.`);
  await dialog.getByRole('button', { name: 'Create and draft changes' }).click();
  await expect(page).toHaveURL(/\/changes\/cr_/);
  const crId = page.url().split('/changes/')[1];
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(steps(page).getByRole('listitem').nth(1).getByText('Done', { exact: true })).toHaveCount(1);
  const person = (await personas(page.request)).find((p) => p.name === 'Tom Okafor')!;
  const added = await page.request.put(`/api/ontologies/${o.id}/members/${person.id}`, { data: { roles: ['contributor'] } });
  expect(added.ok()).toBeTruthy();
  await page.getByRole('link', { name: 'Governance', exact: true }).first().click();
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(steps(page).getByRole('listitem').nth(2).getByText('Done', { exact: true })).toHaveCount(1);
  await expect(steps(page).getByText('Done', { exact: true })).toHaveCount(3);
  expect((await page.request.post(`/api/change-requests/${crId}/withdraw`, { data: {} })).ok()).toBeTruthy();
  await page.reload();
  await expect(steps(page).getByRole('listitem').nth(1).getByText('To do', { exact: true })).toHaveCount(1);
});

test('hiding steps is remembered for this account and ontology and can be undone', async ({ page }) => {
  const o = await fresh(page);
  const ownerCookies = await page.context().cookies();
  await page.setViewportSize({ width: 390, height: 950 });
  await page.goto(`/o/${o.id}`);
  await expect(steps(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await steps(page).getByRole('button', { name: 'Hide these steps' }).click();
  await expect(steps(page)).toHaveCount(0);
  await page.reload();
  await settle(page);
  await expect(steps(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Ontology details', exact: true }).click();
  await page.getByRole('button', { name: 'Show first steps', exact: true }).click();
  await expect(steps(page)).toBeVisible();
  await page.getByRole('button', { name: 'Hide these steps' }).click();
  const second = await page.request.post('/api/ontologies', { data: { title: `Other steps ${uniq()}`, prefix: 'os' } });
  expect(second.ok()).toBeTruthy();
  const other = await second.json();
  await page.goto(`/o/${other.id}`);
  await expect(steps(page)).toBeVisible();
  const editor = await signIn(page, { name: `Steps editor ${uniq()}`, role: 'editor' });
  const editorCookies = await page.context().cookies();
  await page.context().clearCookies();
  await page.context().addCookies(ownerCookies);
  expect((await page.request.put(`/api/ontologies/${o.id}/members/${editor.user.id}`, { data: { roles: ['editor'] } })).ok()).toBeTruthy();
  await page.context().clearCookies();
  await page.context().addCookies(editorCookies);
  await page.goto(`/o/${o.id}`);
  await expect(steps(page)).toBeVisible();
});

test('contributors and signed-out visitors have no first steps; the released demo has none', async ({ page }) => {
  const o = await fresh(page);
  const ownerCookies = await page.context().cookies();
  const contributor = await signIn(page, { name: `First contributor ${uniq()}`, role: 'contributor' });
  const contributorCookies = await page.context().cookies();
  await page.context().clearCookies();
  await page.context().addCookies(ownerCookies);
  expect((await page.request.put(`/api/ontologies/${o.id}/members/${contributor.user.id}`, { data: { roles: ['contributor'] } })).ok()).toBeTruthy();
  await page.context().clearCookies();
  await page.context().addCookies(contributorCookies);
  await page.goto(`/o/${o.id}`);
  await settle(page);
  await expect(steps(page)).toHaveCount(0);
  // Proposing remains available to contributors, including the new deep link.
  await page.goto(`/o/${o.id}/changes?new=1`);
  await expect(page.getByRole('dialog', { name: 'New change request', exact: true })).toBeVisible();
  await page.context().clearCookies();
  await page.context().addCookies(ownerCookies);
  const demo = await demoOntology(page.request);
  await page.goto(`/o/${demo.id}`);
  await settle(page);
  await expect(steps(page)).toHaveCount(0);
  await page.request.post('/api/auth/logout', { data: {} });
  await page.goto(`/o/${o.id}`);
  await settle(page);
  await expect(steps(page)).toHaveCount(0);
  await page.goto(`/o/${o.id}/changes?new=1`);
  await expect(page).toHaveURL(/\/login\?next=/);
  await expect(page.getByRole('dialog', { name: 'New change request', exact: true })).toHaveCount(0);
});

test('a draft release keeps the steps and publishing the first release removes them', async ({ page }) => {
  test.setTimeout(120_000);
  const o = await fresh(page);
  const ownerCookies = await page.context().cookies();
  const policy = structuredClone(o.governance);
  Object.assign(policy.changes.minor, { approverRoles: ['steward', 'owner'], minApprovals: 1, reviewPeriodDays: 0, autoMerge: false });
  delete policy.changes.minor.vote;
  Object.assign(policy.automation, { autoDraftRelease: false, appAutopilot: false });
  expect((await page.request.put(`/api/ontologies/${o.id}/governance`, { data: { policy } })).ok()).toBeTruthy();
  await signIn(page, { name: `First author ${uniq()}`, role: 'contributor' });
  const created = await page.request.post(`/api/ontologies/${o.id}/change-requests`, { data: {
    title: `First terms ${uniq()}`, description: 'The first class.', submit: true,
    ops: [{ op: 'addClass', localName: `First${uniq()}`, label: `first term ${uniq()}`, definition: 'A thing described by this standard.' }],
  } });
  expect(created.ok()).toBeTruthy();
  const cr = await created.json();
  await page.context().clearCookies();
  await page.context().addCookies(ownerCookies);
  await page.goto(`/o/${o.id}/changes/${cr.id}`);
  const actions = page.getByRole('group', { name: 'Your actions' });
  await actions.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Status: Approved/ })).toBeVisible();
  await actions.getByRole('button', { name: 'Merge into working draft' }).click();
  await expect(page.getByRole('button', { name: /^Status: Merged/ })).toBeVisible();
  await page.goto(`/o/${o.id}/releases`);
  await page.getByRole('button', { name: 'Draft release', exact: true }).first().click();
  await page.getByRole('dialog', { name: 'Draft a release', exact: true }).getByRole('button', { name: /^Draft v/ }).click();
  await expect(page).toHaveURL(/\/releases\/rel_/);
  const releaseUrl = page.url();
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(steps(page)).toBeVisible();
  await page.goto(releaseUrl);
  await page.getByRole('button', { name: /^Publish v/ }).click();
  await expect(page.getByText('Published', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await settle(page);
  await expect(steps(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Ontology details', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Show first steps', exact: true })).toHaveCount(0);
});
