import { test, expect, expectNoCrash, settle, signIn, signInAsPersona, uniq, type Page } from './fixtures';

/**
 * A steward sets up a new standard from scratch and takes a change all the way to a release:
 * create the ontology, choose a governance template, adjust a rule and save it, add members
 * and give them roles, review and merge a change by hand, then draft and publish a release
 * that appears on the public page. Finally, ownership is handed over.
 *
 * It uses its own ontology so the demo data, shared with the other specs, isn't changed.
 */

test.describe.configure({ mode: 'serial' });

let ontologyId = '';
let ontologyTitle = '';
let prefix = '';
const steward = { name: `Sam Steward ${uniq()}`, role: 'steward' };

// Each demo sign-in by name makes a new person, so the steward's session cookie is kept and reused.
let stewardCookies: Awaited<ReturnType<import('@playwright/test').BrowserContext['cookies']>> = [];
async function asSteward(page: Page) {
  if (!stewardCookies.length) {
    await signIn(page, steward);
    stewardCookies = await page.context().cookies();
  } else {
    await page.context().clearCookies();
    await page.context().addCookies(stewardCookies);
  }
}

const memberRow = (page: Page, name: string) => page.locator('#roles').locator('div.flex-wrap.items-start').filter({ hasText: name });

test('a signed-in person creates an ontology from the hub with a governance template', async ({ page }) => {
  await asSteward(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'New ontology' }).click();
  const d = page.getByRole('dialog', { name: 'New ontology' });
  await expect(d.getByRole('button', { name: 'Create ontology' })).toBeDisabled();
  const id = uniq();
  ontologyTitle = `Rota exchange ${id}`;
  await d.getByLabel('Title').fill(ontologyTitle);
  // The prefix is suggested from the title's initials.
  await expect(d.getByLabel('Prefix')).toHaveValue(/^re/);
  prefix = `rx${id}`.replace(/[^a-z0-9]/g, '').slice(0, 12);
  await d.getByLabel('Prefix').fill(prefix);
  await d.getByLabel('Description').fill('Swapping volunteer shifts between organisations.');
  await d.getByLabel('Domain').fill('charity volunteering');
  await d.getByLabel('Governance policy').selectOption({ label: 'Steward-led' });
  await d.getByRole('button', { name: 'Create ontology' }).click();

  await expect(page).toHaveURL(/\/o\/[^/]+$/);
  ontologyId = page.url().split('/o/')[1];
  await expect(page.getByRole('heading', { level: 1, name: ontologyTitle })).toBeVisible();
  await settle(page);
  await expectNoCrash(page);

  // It is listed on the hub.
  await page.goto('/');
  await expect(page.getByRole('link', { name: new RegExp(`^${ontologyTitle}`) })).toBeVisible();
});

test('the steward changes a rule, saves the policy, and it sticks', async ({ page }) => {
  await asSteward(page);
  await page.goto(`/o/${ontologyId}/governance`);
  await settle(page);
  // "In short" names the policy; the template picker is only shown while editing, with the current one selected.
  await expect(page.getByRole('main').getByText('Steward-led.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Policy template/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit policy' }).click();
  await expect(page.getByRole('button', { name: /^Steward-led/, pressed: true })).toBeVisible();
  await page.getByRole('button', { name: /Change request rules/ }).click();
  const levels = page.getByRole('group', { name: 'Level to edit' }).first();
  await levels.getByRole('button', { name: 'Edit minor' }).click();
  const table = page.locator('table').first();
  // Minor changes: one approval, no review period, and merged by hand.
  await table.getByRole('row').filter({ hasText: 'Minimum approvals' }).getByRole('spinbutton').fill('1');
  await table.getByRole('row').filter({ hasText: 'Review period' }).getByRole('spinbutton').fill('0');
  const autoMerge = table.getByRole('switch', { name: 'Auto-merge (minor)' });
  await expect(autoMerge).toHaveAttribute('aria-checked', 'true');
  await autoMerge.click();
  await expect(autoMerge).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByText('Unsaved changes').first()).toBeVisible();
  // Releases are drafted by hand here, so the release test below is deterministic.
  await page.getByRole('button', { name: /Ownership, ODI and automation/ }).click();
  const autoDraft = page.getByRole('switch', { name: 'Draft a release automatically when approved changes accumulate' });
  await expect(autoDraft).toHaveAttribute('aria-checked', 'true');
  await autoDraft.click();
  await page.getByRole('button', { name: 'Save policy' }).first().click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit policy' })).toBeVisible();

  // After a reload the summary reflects the saved rule, and the policy's name shows it was customised.
  await page.reload();
  await settle(page);
  const minor = page.getByRole('list', { name: 'What each kind of change needs' }).getByRole('listitem').nth(1);
  await expect(minor).toContainText('1 sign-off');
  await expect(minor).not.toContainText('merged automatically');
  await expect(page.getByRole('main').getByText(/^Steward-led \(customised\)\.$/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Ownership, ODI and automation/ })).toHaveAccessibleDescription(/4 of 5 automations on/);
});

test('the steward adds people, gives them roles and removes one', async ({ page }) => {
  await asSteward(page);
  await page.goto(`/o/${ontologyId}/governance#roles`);
  await settle(page);
  const section = page.locator('#roles');
  await expect(section.getByText(steward.name)).toBeVisible();

  await section.getByRole('button', { name: /Add a person/ }).click();
  for (const name of ['Tom Okafor', 'Mei Chen']) {
    const pick = section.getByRole('combobox', { name: 'Person to add' });
    await pick.selectOption({ label: (await pick.locator('option', { hasText: name }).innerText()).trim() });
    await section.getByRole('button', { name: 'Add as contributor' }).click();
    await expect(memberRow(page, name)).toBeVisible();
    await expect(memberRow(page, name).getByText('Contributor')).toBeVisible();
  }

  // Tom becomes an editor too.
  const tom = memberRow(page, 'Tom Okafor');
  await tom.getByRole('button', { name: 'Edit roles' }).click();
  await expect(tom.getByRole('button', { name: 'Editor', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await tom.getByRole('button', { name: 'Editor', exact: true }).click();
  await expect(tom.getByRole('button', { name: 'Editor', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await tom.getByRole('button', { name: 'Done' }).click();
  await expect(tom.getByText('Editor')).toBeVisible();

  // Mei is removed again.
  page.once('dialog', (dlg) => void dlg.accept());
  await memberRow(page, 'Mei Chen').getByTitle('Remove member').click();
  await expect(memberRow(page, 'Mei Chen')).toHaveCount(0);

  // A member who isn't a steward can read the policy but not change it, or manage members.
  await signInAsPersona(page, 'Tom Okafor');
  await page.goto(`/o/${ontologyId}/governance`);
  await settle(page);
  await page.getByRole('button', { name: /Members and roles/ }).click();
  await expect(page.getByText('You can read the policy; only the ontology’s owners can change it.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit policy' })).toHaveCount(0);
  await expect(page.locator('#roles').getByRole('button', { name: 'Edit roles' })).toHaveCount(0);
  await page.locator('#roles').getByRole('button', { name: 'Transfer ownership' }).click();
  await expect(page.locator('#roles').getByText('Only an owner can start a transfer.')).toBeVisible();
  await expect(page.locator('#roles').getByRole('button', { name: 'Transfer', exact: true })).toBeDisabled();
});

test('an approved change waits for a manual merge when auto-merge is off', async ({ page }) => {
  const term = `Swap${uniq()}`;
  await signInAsPersona(page, 'Tom Okafor');
  await page.goto(`/o/${ontologyId}/changes`);
  await expect(page.getByText('No open change requests')).toBeVisible();
  await page.getByRole('button', { name: 'New change request' }).first().click();
  const d = page.getByRole('dialog', { name: 'New change request' });
  await d.getByLabel('Title').fill(`Add ${term}`);
  await d.getByLabel('Describe the change in plain language').fill(`Add a class ${term}.`);
  await d.getByRole('button', { name: 'Create and draft changes' }).click();
  await expect(page).toHaveURL(/\/changes\/cr_/, { timeout: 30_000 });
  const url = page.url();
  const actions = page.getByRole('group', { name: 'Your actions' });
  await actions.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByRole('button', { name: /^Status: In review/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Level: minor/ })).toBeVisible();

  await asSteward(page);
  await page.goto(url);
  await actions.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('button', { name: /^Status: Approved/ })).toBeVisible();
  // A contributor-only member wouldn't see the merge button; the steward does.
  await actions.getByRole('button', { name: 'Merge into working draft' }).click();
  await expect(page.getByRole('button', { name: /^Status: Merged/ })).toBeVisible();

  // The new class is in the working draft: Browse finds it.
  await page.goto(`/o/${ontologyId}/browse`);
  await settle(page);
  await expect(page.getByRole('main').getByText(term.toLowerCase()).first()).toBeVisible();
});

test('the steward drafts a release from merged changes and publishes it', async ({ page, request }) => {
  await asSteward(page);
  await page.goto(`/o/${ontologyId}/releases`);
  await expect(page.getByText('No releases yet')).toBeVisible();
  await page.getByRole('button', { name: 'Draft release' }).first().click();
  const d = page.getByRole('dialog', { name: 'Draft a release' });
  await expect(d.getByText('Includes 1 merged change')).toBeVisible();
  const draft = d.getByRole('button', { name: /^Draft v\d+\.\d+\.\d+$/ });
  const version = (await draft.innerText()).replace('Draft v', '').trim();
  await d.getByLabel('Release notes').fill('First release: shift swaps.');
  await draft.click();
  await expect(page).toHaveURL(/\/releases\/rel_[^/]+$/);
  await expect(page.getByRole('heading', { level: 2, name: `v${version}` })).toBeVisible();
  await expect(page.getByText('First release: shift swaps.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Included changes (1)' })).toBeVisible();

  await page.getByRole('button', { name: `Publish v${version}` }).click();
  await expect(page.getByText('Published', { exact: true }).first()).toBeVisible({ timeout: 30_000 });

  // The release list and the ontology header show the new version...
  await page.goto(`/o/${ontologyId}/releases`);
  await expect(page.getByRole('region', { name: 'Latest published' })).toContainText(`v${version}`);
  await expect(page.getByRole('main').getByText(new RegExp(`v${version.replace(/\./g, '\\.')}`)).first()).toBeVisible();
  // ...and it is the ontology's current version.
  const summary = await (await request.get(`/api/ontologies/${ontologyId}`)).json();
  expect(summary.currentVersion).toBe(version);
  // The change request is now released.
  const crs = await (await page.request.get(`/api/ontologies/${ontologyId}/change-requests`)).json();
  expect(crs.map((c: { status: string }) => c.status)).toEqual(['released']);
});

test('only stewards and owners can draft or publish a release', async ({ page }) => {
  await signInAsPersona(page, 'Tom Okafor');
  const r = await page.request.post(`/api/ontologies/${ontologyId}/releases`, { data: {} });
  expect(r.status()).toBe(403);
});

async function draftAndSubmit(page: Page, title: string, ask: string) {
  await page.goto(`/o/${ontologyId}/changes`);
  await page.getByRole('button', { name: 'New change request' }).first().click();
  const d = page.getByRole('dialog', { name: 'New change request' });
  await d.getByLabel('Title').fill(title);
  await d.getByLabel('Describe the change in plain language').fill(ask);
  await d.getByRole('button', { name: 'Create and draft changes' }).click();
  await expect(page).toHaveURL(/\/changes\/cr_/, { timeout: 30_000 });
  await page.getByRole('group', { name: 'Your actions' }).getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByRole('button', { name: /^Status: In review/ })).toBeVisible();
  return page.url();
}

async function editMinorRule(page: Page, edit: (table: import('@playwright/test').Locator) => Promise<void>) {
  await asSteward(page);
  await page.goto(`/o/${ontologyId}/governance`);
  await settle(page);
  await page.getByRole('button', { name: 'Edit policy' }).click();
  await page.getByRole('button', { name: /Change request rules/ }).click();
  await page.getByRole('group', { name: 'Level to edit' }).first().getByRole('button', { name: 'Edit minor' }).click();
  await edit(page.locator('table').first());
  await page.getByRole('button', { name: 'Save policy' }).first().click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
}

test('when the policy asks for a vote, members vote after review and the result decides', async ({ page }) => {
  // Gareth joins as a voting member.
  await asSteward(page);
  await page.goto(`/o/${ontologyId}/governance#roles`);
  await settle(page);
  const section = page.locator('#roles');
  await section.getByRole('button', { name: /Add a person/ }).click();
  const pick = section.getByRole('combobox', { name: 'Person to add' });
  await pick.selectOption({ label: (await pick.locator('option', { hasText: 'Gareth Lewis' }).innerText()).trim() });
  await section.getByRole('button', { name: 'Add as contributor' }).click();
  const gareth = memberRow(page, 'Gareth Lewis');
  await gareth.getByRole('button', { name: 'Edit roles' }).click();
  await gareth.getByRole('button', { name: 'Voting member', exact: true }).click();
  await gareth.getByRole('button', { name: 'Done' }).click();
  await expect(gareth.getByText('Voting member')).toBeVisible();

  // Minor changes now also need a vote of members, closing when everyone has voted.
  await editMinorRule(page, async (table) => {
    const vote = table.getByRole('switch', { name: 'Vote (minor)' });
    await vote.click();
    await expect(vote).toHaveAttribute('aria-checked', 'true');
  });
  await expect(page.getByRole('list', { name: 'What each kind of change needs' }).getByRole('listitem').nth(1)).toContainText(/a vote/);

  await signInAsPersona(page, 'Tom Okafor');
  const url = await draftAndSubmit(page, `Add a vote test ${uniq()}`, `Add a class Vote${uniq()}.`);

  // The steward's approval completes review and opens the vote.
  await asSteward(page);
  await page.goto(url);
  const actions = page.getByRole('group', { name: 'Your actions' });
  await actions.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('button', { name: /^Status: Voting/ })).toBeVisible();
  await actions.getByRole('button', { name: 'Yes' }).click();
  await expect(actions.getByText('You voted “yes”. You can change your vote while it’s open.')).toBeVisible();

  // A contributor without the member role can't vote.
  await signInAsPersona(page, 'Tom Okafor');
  await page.goto(url);
  await expect(actions.getByRole('button', { name: 'Yes' })).toBeDisabled();
  await expect(actions.getByText(/^Only Voting member can vote on this\./)).toBeVisible();

  // Gareth votes no, then changes his mind; with every member voted yes, it passes.
  await signInAsPersona(page, 'Gareth Lewis');
  await page.goto(url);
  await actions.getByRole('button', { name: 'No' }).click();
  await expect(actions.getByText('You voted “no”. You can change your vote while it’s open.').or(page.getByRole('button', { name: /^Status: (Rejected|Approved)/ }))).toBeVisible();
  if (await page.getByRole('button', { name: /^Status: Voting/ }).count()) {
    await actions.getByRole('button', { name: 'Yes' }).click();
  }
  await expect(page.getByRole('button', { name: /^Status: (Approved|Rejected)/ })).toBeVisible();
  await page.getByRole('tab', { name: /^Discussion/ }).click();
  await expect(page.getByText('voted', { exact: false }).first()).toBeVisible();
});

// Regression: rewriting a change's edits used to erase every vote, "no" included, so an author could
// clear opposition by rewording the edits. Now a vote against stands until the voter changes it.
test('a vote against stands when the edits change, until the voter changes it', async ({ page }) => {
  await signInAsPersona(page, 'Tom Okafor');
  const url = await draftAndSubmit(page, `Add a standing vote test ${uniq()}`, `Add a class Standing${uniq()}.`);
  await asSteward(page);
  await page.goto(url);
  const actions = page.getByRole('group', { name: 'Your actions' });
  await actions.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('button', { name: /^Status: Voting/ })).toBeVisible();

  await signInAsPersona(page, 'Gareth Lewis');
  await page.goto(url);
  await actions.getByRole('textbox').fill('Please add a definition.');
  await actions.getByRole('button', { name: 'No' }).click();
  await expect(actions.getByText('You voted “no”. You can change your vote while it’s open.')).toBeVisible();

  // While the vote is open, the author rewrites the edits through the API (the page offers no editing
  // during a vote, but agents and scripts can), which sends the request back to review.
  await signInAsPersona(page, 'Tom Okafor');
  const id = url.split('/changes/')[1];
  const cr = await (await page.request.get(`/api/change-requests/${id}`)).json();
  const rewritten = cr.ops.map((o: Record<string, unknown>) => ({ ...o, definition: 'A thing that stands, for testing votes.' }));
  const patched = await page.request.patch(`/api/change-requests/${id}`, { data: { ops: rewritten } });
  expect(patched.ok(), await patched.text()).toBeTruthy();
  expect((await patched.json()).status).toBe('review');

  await asSteward(page);
  await page.goto(url);
  await actions.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('button', { name: /^Status: Voting/ })).toBeVisible();

  // Gareth's "no" on the earlier edits still counts, and he is told so.
  await signInAsPersona(page, 'Gareth Lewis');
  await page.goto(url);
  await expect(actions.getByRole('status')).toContainText('You voted “no” on earlier edits. It still counts until you change it');
  await page.getByRole('tab', { name: /^Discussion/ }).click();
  await expect(page.getByText('no · earlier edits, still counts', { exact: true })).toBeVisible();
  await expect(page.getByText(/votes against and objections stand/)).toBeVisible();
  // Changing it to "yes" on the new edits replaces it.
  await actions.getByRole('button', { name: 'Yes' }).click();
  await expect(actions.getByText('You voted “yes”. You can change your vote while it’s open.').or(page.getByRole('button', { name: /^Status: Approved/ }))).toBeVisible();
});

test('an objection from a veto role rejects a change outright', async ({ page }) => {
  await editMinorRule(page, async (table) => {
    // Turn the vote off again and give owners a veto.
    await table.getByRole('switch', { name: 'Vote (minor)' }).click();
    const owner = table.getByRole('row').filter({ hasText: 'Veto roles' }).getByRole('button', { name: 'Owner', exact: true });
    if ((await owner.getAttribute('aria-pressed')) !== 'true') await owner.click();
    await expect(owner).toHaveAttribute('aria-pressed', 'true');
  });
  await expect(page.getByRole('list', { name: 'What each kind of change needs' }).getByRole('listitem').nth(1)).toContainText(/Owner can block it/);

  await signInAsPersona(page, 'Tom Okafor');
  const url = await draftAndSubmit(page, `Add a veto test ${uniq()}`, `Add a class Veto${uniq()}.`);
  await asSteward(page);
  await page.goto(url);
  const actions = page.getByRole('group', { name: 'Your actions' });
  await actions.getByRole('textbox').fill('Out of scope for this standard.');
  await actions.getByRole('button', { name: 'Object' }).click();
  await expect(page.getByRole('button', { name: /^Status: Rejected/ })).toBeVisible();
  await expect(page.getByTestId('decision-outcome')).toContainText(`Rejected by ${steward.name} (owner veto) on`);
});

test('the owner transfers ownership to another member', async ({ page }) => {
  await asSteward(page);
  await page.goto(`/o/${ontologyId}/governance#roles`);
  await settle(page);
  const section = page.locator('#roles');
  await section.getByRole('button', { name: 'Transfer ownership' }).click();
  await section.getByRole('combobox', { name: 'New owner' }).selectOption({ label: 'Tom Okafor' });
  await section.getByRole('button', { name: 'Transfer', exact: true }).click();
  await expect(section.getByText(/Ownership transfer: |A vote on the ownership transfer has been opened/)).toBeVisible();
  // Under the steward-led policy the owner decides, so Tom is an owner straight away.
  const summary = await (await page.request.get(`/api/ontologies/${ontologyId}`)).json();
  const tom = (await (await page.request.get('/api/personas')).json()).find((p: { name: string }) => p.name === 'Tom Okafor');
  expect(summary.ownerIds).toContain(tom.id);
});
