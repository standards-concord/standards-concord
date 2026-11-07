import { test, expect, settle, signIn, demoOntology } from './fixtures';

/**
 * Role-based views for alpha testers: the account menu says which role you're trying Concord as.
 * The ontology nav is the same for every role.
 */
test.describe('role-based views', () => {
  let demo: { id: string };
  test.beforeEach(async ({ request }) => {
    demo = await demoOntology(request);
  });
  const sectionNames = async (page: import('@playwright/test').Page) =>
    (await page.getByRole('navigation', { name: 'Ontology sections' }).getByRole('link').allInnerTexts()).map((t) => t.trim());

  for (const [role, title] of [
    ['steward', 'Ontology steward'],
    ['member', 'Voting member'],
    ['contributor', 'Domain expert / contributor'],
    ['odi', 'ODI oversight'],
    ['agent', 'Agent developer'],
  ] as const)
    test(`the account menu shows the role in brackets: ${title}`, async ({ page }) => {
      await signIn(page, { name: 'Role tester', role });
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`/o/${demo.id}`);
      await settle(page);
      const button = page.getByRole('button', { name: /Role tester/ });
      await expect(button).toContainText(`Role tester(${title})`);
      await button.click();
      await expect(page.getByRole('navigation', { name: 'Account' })).toContainText(`Trying Concord as: ${title}`);
    });

  test('on a phone the role is still part of the account button’s name', async ({ page }) => {
    await signIn(page, { name: 'Phone tester', role: 'member' });
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(`/o/${demo.id}`);
    await settle(page);
    await expect(page.getByRole('button', { name: /Phone tester.*\(Voting member\)/ })).toBeVisible();
  });

  // Governance used to be hidden from every role but owner, steward and ODI, behind a
  // "Show all sections (Governance)" toggle that testers found confusing. Every role now sees it.
  for (const role of ['steward', 'member', 'contributor', 'odi', 'agent'] as const)
    test(`Governance is always in the nav, with no "Show all sections" toggle: ${role}`, async ({ page }) => {
      await signIn(page, { name: `${role} tester`, role });
      await page.goto(`/o/${demo.id}`);
      await settle(page);
      expect(await sectionNames(page)).toEqual(['Overview', 'Explore', 'Requirements', 'Changes', 'Governance']);
      await expect(page.getByRole('button', { name: /Show all sections/ })).toHaveCount(0);
    });

  test('a voting member opens Governance from the nav and reads the policy', async ({ page }) => {
    await signIn(page, { name: 'Voter', role: 'member' });
    await page.goto(`/o/${demo.id}`);
    await settle(page);
    const nav = page.getByRole('navigation', { name: 'Ontology sections' });
    await nav.getByRole('link', { name: 'Governance' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${demo.id}/governance$`));
    await expect(nav.getByRole('link', { name: 'Governance' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: 'Governance', exact: true, level: 2 })).toBeVisible();
    // Reading the policy isn't editing it: only owners and stewards get Edit policy.
    await expect(page.getByRole('button', { name: /Edit policy/ })).toHaveCount(0);
  });

  test('the policy is also summarised where people review and vote', async ({ page }) => {
    await signIn(page, { name: 'Reader', role: 'member' });
    const crs = (await (await page.request.get(`/api/ontologies/${demo.id}/change-requests`)).json()) as { id: string }[];
    await page.goto(`/o/${demo.id}/changes/${crs[0].id}`);
    await settle(page);
    const glance = page.getByRole('button', { name: /How changes are decided/ });
    await expect(glance).toHaveAttribute('aria-expanded', 'false');
    await glance.click();
    const rules = page.getByRole('list', { name: 'What each kind of change needs' });
    await expect(rules.getByRole('listitem')).toHaveCount(3);
    await expect(page.getByRole('link', { name: 'Read the full policy' })).toHaveAttribute('href', `/o/${demo.id}/governance`);
    await page.getByRole('link', { name: 'Who holds which role' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${demo.id}/governance#roles$`));
    await expect(page.getByRole('button', { name: /Members and roles/ })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('button', { name: /Members and roles/ })).toBeFocused();

    // Readers can view the policy but not edit it, and the Overview says "View members" rather than "Manage".
    await expect(page.getByRole('button', { name: 'Edit policy' })).toHaveCount(0);
    await expect(page.getByText('You can read the policy; only the ontology’s owners can change it.')).toBeVisible();
    await page.goto(`/o/${demo.id}`);
    await settle(page);
    await expect(page.getByRole('link', { name: 'View members' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Manage', exact: true })).toHaveCount(0);
  });

  test('a release decision links the release rules too', async ({ page }) => {
    await signIn(page, { name: 'Release reader', role: 'contributor' });
    const releases = (await (await page.request.get(`/api/ontologies/${demo.id}/releases`)).json()) as { id: string }[];
    test.skip(!releases.length, 'the demo has no releases');
    await page.goto(`/o/${demo.id}/releases/${releases[0].id}`);
    await settle(page);
    const detail = (await (await page.request.get(`/api/releases/${releases[0].id}`)).json()) as { status: string; approvalSource: string };
    const decided = detail.status === 'published' || detail.status === 'rejected';
    // A decided release shows today's rules as "Current release policy", outside its own record.
    await page.getByRole('button', { name: decided ? /Current release policy/ : /How releases are decided/ }).click();
    await expect(page.getByRole('list', { name: 'What each kind of release needs' }).getByRole('listitem')).toHaveCount(3);
    if (decided && detail.approvalSource !== 'bootstrap') {
      const history = page.getByRole('button', { name: /How this was approved|Why this was rejected|checked against today’s policy/ });
      if ((await history.getAttribute('aria-expanded')) !== 'true') await history.click();
      // Inside, the read-only record shows straight away, with no second toggle.
      await expect(page.getByRole('button', { name: /Approval details/ })).toHaveCount(0);
      await expect(page.getByTestId('approval-record')).toBeVisible();
    }
  });

  test('only owners get Edit policy, matching what the server accepts', async ({ page }) => {
    // Editors run changes but can't change the policy.
    await signIn(page, { name: 'Editor tester', role: 'editor' });
    await page.goto(`/o/${demo.id}/governance`);
    await settle(page);
    await expect(page.getByRole('button', { name: 'Edit policy' })).toHaveCount(0);
    // A tester who picks steward also owns the demo, as the steward walkthrough tasks expect.
    await signIn(page, { name: 'Steward tester', role: 'steward' });
    await page.goto(`/o/${demo.id}/governance`);
    await settle(page);
    await expect(page.getByRole('button', { name: 'Edit policy' })).toBeVisible();
  });

  test('a steward who isn’t an owner sees Governance but can’t edit the policy, and the server agrees', async ({ page, request }) => {
    // Start as an editor, then have an owner make this person a steward only.
    const { user } = await signIn(page, { name: 'Pure steward', role: 'editor' });
    const owner = await request.post('/api/auth/demo', { data: { name: 'Owner tester', role: 'steward' } });
    expect(owner.ok()).toBeTruthy();
    const set = await request.put(`/api/ontologies/${demo.id}/members/${user.id}`, { data: { roles: ['steward', 'member'] } });
    expect(set.ok(), await set.text()).toBeTruthy();

    await page.goto(`/o/${demo.id}`);
    await settle(page);
    expect(await sectionNames(page)).toContain('Governance');
    await page.getByRole('navigation', { name: 'Ontology sections' }).getByRole('link', { name: 'Governance' }).click();
    await expect(page.getByRole('heading', { name: 'Governance', exact: true, level: 2 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit policy' })).toHaveCount(0);
    await expect(page.getByText('You can read the policy; only the ontology’s owners can change it.')).toBeVisible();
    // Stewards still manage members, so the Overview offers "Manage".
    await page.goto(`/o/${demo.id}`);
    await settle(page);
    await expect(page.getByRole('link', { name: 'Manage', exact: true })).toBeVisible();

    // The server refuses a policy change from them too.
    const o = (await (await page.request.get(`/api/ontologies/${demo.id}`)).json()) as { governance: unknown };
    const put = await page.request.put(`/api/ontologies/${demo.id}/governance`, { data: { policy: o.governance } });
    expect(put.status()).toBe(403);
  });

  test('the governance policy is one click from the Overview, in the section nav', async ({ page }) => {
    await signIn(page, { name: 'Policy finder', role: 'contributor' });
    await page.goto(`/o/${demo.id}`);
    await settle(page);
    // The line under the description used to name the policy too; now it gives just the counts, and the
    // section nav (shown to everyone) leads to the policy.
    await expect(page.getByTestId('overview-summary')).not.toContainText('run as');
    await page.getByRole('navigation', { name: 'Ontology sections' }).getByRole('link', { name: 'Governance' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${demo.id}/governance$`));
  });

  test('a published release says where its approval record comes from', async ({ page }) => {
    await signIn(page, { name: 'History reader', role: 'member' });
    const releases = (await (await page.request.get(`/api/ontologies/${demo.id}/releases`)).json()) as { id: string; version: string; status: string }[];
    const published = releases.filter((r) => r.status === 'published');
    test.skip(!published.length, 'the demo has no published releases');
    for (const r of published) {
      const detail = (await (await page.request.get(`/api/releases/${r.id}`)).json()) as { approvalSource: string };
      await page.goto(`/o/${demo.id}/releases/${r.id}`);
      await settle(page);
      const title = detail.approvalSource === 'current-policy' ? /Approval, checked against today’s policy/ : /How this was approved/;
      await page.getByRole('button', { name: title }).click();
      const note = page.getByTestId('approval-source');
      if (detail.approvalSource === 'bootstrap') await expect(note).toContainText('No approval rules applied to it');
      if (detail.approvalSource === 'recorded') await expect(note).toContainText('Later changes to the policy or members don’t change this record');
      if (detail.approvalSource === 'current-policy') await expect(note).toContainText('this applies today’s policy and members');
    }
  });
});
