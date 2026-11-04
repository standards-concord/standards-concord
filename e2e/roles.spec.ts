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
      await expect(page.getByRole('menu')).toContainText(`Trying Concord as: ${title}`);
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
      await expect(page.getByRole('button', { name: 'All sections' })).toHaveCount(0);
    }
  });

  test('other roles don’t see Governance, but “All sections” and direct links still reach it', async ({ page }) => {
    await signIn(page, { name: 'Voter', role: 'member' });
    await page.goto(`/o/${demo.id}`);
    await settle(page);
    expect(await sectionNames(page)).toEqual(['Overview', 'Explore', 'Requirements', 'Changes']);

    // "All sections" brings it back, and the choice is remembered.
    const toggle = page.getByRole('button', { name: 'All sections' });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle).toHaveAttribute('title', 'Also show: Governance');
    await toggle.click();
    expect(await sectionNames(page)).toEqual(['Overview', 'Explore', 'Requirements', 'Changes', 'Governance']);
    await page.reload();
    await settle(page);
    expect(await sectionNames(page)).toContain('Governance');
    await page.getByRole('navigation', { name: 'Ontology sections' }).getByRole('link', { name: 'Governance' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${demo.id}/governance$`));
    await expect(page.getByRole('heading', { name: 'Governance', exact: true, level: 2 })).toBeVisible();

    // "Fewer sections" goes back to the role's view.
    await page.getByRole('navigation', { name: 'Ontology sections' }).getByRole('link', { name: 'Overview' }).click();
    await page.getByRole('button', { name: 'Fewer sections' }).click();
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
});
