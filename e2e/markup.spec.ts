import { test, expect, settle, signIn, demoOntology } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Interactive elements must not nest: a button inside a link (or a link inside a button) is invalid HTML,
 * gives two tab stops for one action, and is announced inconsistently. Links that look like buttons use
 * LinkButton / AnchorButton instead.
 */
const nested = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('a button, a a, button a, button button, a [role=button], [role=button] a')].map((el) => {
      const outer = el.parentElement?.closest('a, button, [role=button]');
      return `${outer?.tagName.toLowerCase()} "${outer?.textContent?.trim().slice(0, 40)}" > ${el.tagName.toLowerCase()}`;
    }),
  );

test.describe('no nested interactive elements', () => {
  test('signed-out pages', async ({ page, consoleGuard }) => {
    // The consent page with an unknown client and the not-found page both look things up that don't exist.
    consoleGuard.allow(/status of 404/);
    for (const path of ['/login', '/connect', '/appearance', '/alpha', '/oauth/authorize?client_id=x', '/no-such-page']) {
      await page.goto(path);
      await settle(page);
      expect(await nested(page), path).toEqual([]);
    }
  });

  test('signed-in pages, the walkthrough guide and the feedback thank-you', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signIn(page, { name: 'Markup tester', role: 'steward' });
    const releases = (await (await page.request.get(`/api/ontologies/${demo.id}/releases`)).json()) as { id: string }[];
    const paths = ['/', '/settings', '/connect', '/feedback', `/o/${demo.id}`, `/o/${demo.id}/source`, `/o/${demo.id}/releases`, `/o/${demo.id}/governance`, `/o/${demo.id}/connect`];
    if (releases[0]) paths.push(`/o/${demo.id}/releases/${releases[0].id}`);
    for (const path of paths) {
      await page.goto(path);
      await settle(page);
      expect(await nested(page), path).toEqual([]);
    }
    // The account menu and the floating guide, which add their own links.
    await page.goto(`/o/${demo.id}`);
    await settle(page);
    await page.locator('.app-user-button').click();
    expect(await nested(page), 'account menu').toEqual([]);
  });

  test('links styled as buttons are single links with the button look', async ({ page }) => {
    await page.goto('/');
    await settle(page);
    const signInLink = page.getByRole('banner').getByRole('link', { name: 'Sign in' });
    if (await signInLink.count()) {
      await expect(signInLink.locator('button')).toHaveCount(0);
      await expect(signInLink).toHaveClass(/rounded-lg/);
    }
    await page.goto('/no-such-page');
    await settle(page);
    const back = page.getByRole('main').getByRole('link').first();
    await expect(back.locator('button')).toHaveCount(0);
  });
});
