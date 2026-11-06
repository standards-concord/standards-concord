import { test, expect, demoOntology, signIn } from './fixtures';

/**
 * Settings → Advanced features. Off by default, so tools most people won't need (the SPARQL
 * Query page) stay out of the navigation; turning it on brings them back. Nothing is locked
 * away: an advanced page still opens from a link (Jesse, 6 Nov 2026).
 */
test.describe('Advanced features', () => {
  test('Query is hidden from Explore until advanced features are turned on in Settings', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signIn(page, { name: 'Advanced tester', role: 'contributor' });
    const explore = page.getByRole('navigation', { name: 'Explore pages' });

    await page.goto(`/o/${demo.id}/browse`);
    await expect(explore.getByRole('link', { name: 'Browse', exact: true })).toBeVisible();
    await expect(explore.getByRole('link', { name: 'Query', exact: true })).toHaveCount(0);
    // Validate data stays: it's where people check their own data.
    await expect(explore.getByRole('link', { name: 'Validate data', exact: true })).toBeVisible();

    // A link straight to Query still opens it, and shows its tab while you're there.
    await page.goto(`/o/${demo.id}/query`);
    await expect(explore.getByRole('link', { name: 'Query', exact: true })).toHaveAttribute('aria-current', 'page');

    await page.goto('/settings');
    const toggle = page.getByRole('switch', { name: 'Show advanced features' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    await page.goto(`/o/${demo.id}/browse`);
    await expect(explore.getByRole('link', { name: 'Query', exact: true })).toBeVisible();
    // Remembered in this browser.
    await page.reload();
    await expect(explore.getByRole('link', { name: 'Query', exact: true })).toBeVisible();

    await page.goto('/settings');
    await page.getByRole('switch', { name: 'Show advanced features' }).click();
    await page.goto(`/o/${demo.id}/browse`);
    await expect(explore.getByRole('link', { name: 'Query', exact: true })).toHaveCount(0);
  });

  test('signed-out visitors get no Settings page, so no switch', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/settings');
    await expect(page.getByRole('switch', { name: 'Show advanced features' })).toHaveCount(0);
    await expect(page).not.toHaveURL(/\/settings$/);
  });
});
