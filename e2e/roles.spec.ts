import { test, expect, settle, signIn, demoOntology } from './fixtures';

/**
 * Role-based views for alpha testers: the account menu says which role you're trying Concord as,
 * and the ontology nav shows the sections that role needs. Hidden sections are never locked away.
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

  test('stewards and ODI oversight see Governance in the nav', async ({ page }) => {
    for (const role of ['steward', 'odi']) {
      await signIn(page, { name: `${role} tester`, role });
      await page.goto(`/o/${demo.id}`);
      await settle(page);
      expect(await sectionNames(page)).toEqual(['Overview', 'Explore', 'Requirements', 'Changes', 'Governance']);
      await expect(page.getByRole('button', { name: /Show all sections/ })).toHaveCount(0);
    }
  });

  test('other roles don’t see Governance, but “All sections” and direct links still reach it', async ({ page }) => {
    await signIn(page, { name: 'Voter', role: 'member' });
    await page.goto(`/o/${demo.id}`);
    await settle(page);
    expect(await sectionNames(page)).toEqual(['Overview', 'Explore', 'Requirements', 'Changes']);

    // "Show all sections" names what it adds, brings it back, and is remembered.
    const toggle = page.getByRole('button', { name: 'Show all sections (Governance)' });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    // Focus moves to the section it revealed, which appears before the button.
    await expect(page.getByRole('navigation', { name: 'Ontology sections' }).getByRole('link', { name: 'Governance' })).toBeFocused();
    expect(await sectionNames(page)).toEqual(['Overview', 'Explore', 'Requirements', 'Changes', 'Governance']);
    await page.reload();
    await settle(page);
    expect(await sectionNames(page)).toContain('Governance');
    await page.getByRole('navigation', { name: 'Ontology sections' }).getByRole('link', { name: 'Governance' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${demo.id}/governance$`));
    await expect(page.getByRole('heading', { name: 'Governance', exact: true, level: 2 })).toBeVisible();

    // Pressing it again goes back to the role's view.
    await page.getByRole('navigation', { name: 'Ontology sections' }).getByRole('link', { name: 'Overview' }).click();
    await page.getByRole('button', { name: /Show all sections/ }).click();
    await expect(page.getByRole('button', { name: /Show all sections/ })).toHaveAttribute('aria-pressed', 'false');
    expect(await sectionNames(page)).toEqual(['Overview', 'Explore', 'Requirements', 'Changes']);

    // A link straight to Governance opens it, and the nav shows where you are.
    await page.goto(`/o/${demo.id}/governance`);
    await settle(page);
    const nav = page.getByRole('navigation', { name: 'Ontology sections' });
    await expect(nav.getByRole('link', { name: 'Governance' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: 'Governance', exact: true, level: 2 })).toBeVisible();
  });

  test('contributors and agent developers get the same focused nav', async ({ page }) => {
    for (const role of ['contributor', 'agent']) {
      await signIn(page, { name: `${role} tester`, role });
      await page.goto(`/o/${demo.id}`);
      await settle(page);
      expect(await sectionNames(page)).not.toContain('Governance');
    }
  });

  test('people without the Governance tab read the policy where they review and vote', async ({ page }) => {
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
    const approved = page.getByRole('button', { name: /How this was approved/ });
    // A published release shows today's rules as "Current release policy", outside its approval history.
    const glance = page.getByRole('button', { name: (await approved.count()) ? /Current release policy/ : /How releases are decided/ });
    await glance.click();
    await expect(page.getByRole('list', { name: 'What each kind of release needs' }).getByRole('listitem')).toHaveCount(3);
    const { approvalSource } = (await (await page.request.get(`/api/releases/${releases[0].id}`)).json()) as { approvalSource: string };
    if ((await approved.count()) && approvalSource !== 'bootstrap') {
      await approved.click();
      // Inside, the approval details show straight away, with no second toggle.
      await expect(page.getByRole('button', { name: /Approval details/ })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Approval details' })).toBeVisible();
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

  test('the Overview always shows a link to the governance policy', async ({ page }) => {
    await signIn(page, { name: 'Policy finder', role: 'contributor' });
    await page.goto(`/o/${demo.id}`);
    await settle(page);
    const line = page.getByTestId('policy-link');
    await expect(line).toBeVisible();
    await line.getByRole('link').click();
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
