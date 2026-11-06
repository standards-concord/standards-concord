import { expect, signIn, test, type Page } from './fixtures';

/**
 * Going back to a section you have already opened shows what it showed last time at once, while
 * the current list loads in the background. What is kept belongs to the account that loaded it:
 * after signing out, the next account waits for its own copy.
 */

const changesNav = (page: Page) => page.getByRole('navigation', { name: 'Changes pages' });
const CHANGE_REQUESTS = /\/api\/ontologies\/[^/]+\/change-requests(\?|$)/;

/** Holds every change-request list request until the returned function is called; counts them. */
async function holdChangeRequests(page: Page) {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  const seen = { count: 0 };
  await page.route(CHANGE_REQUESTS, async (route) => {
    seen.count++;
    await held;
    await route.continue();
  });
  return { release, seen };
}

test.describe('Sections you have opened', () => {
  test('show their list at once when you come back, and refresh it in the background', async ({ page }) => {
    await signIn(page, { name: 'E2E instant sections', role: 'editor' });
    await page.goto('/o/volunteering/changes');
    const firstRow = page.getByRole('main').getByRole('listitem').first();
    await expect(firstRow).toBeVisible();
    const rowText = (await firstRow.textContent()) ?? '';
    await changesNav(page).getByRole('link', { name: 'Releases', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Releases' })).toBeVisible();

    // The server is slow to answer: the list is there anyway, from last time.
    const { release, seen } = await holdChangeRequests(page);
    await changesNav(page).getByRole('link', { name: 'Change requests', exact: true }).click();
    await expect(page.getByRole('main').getByRole('listitem').first()).toHaveText(rowText);
    await expect(page.getByRole('main').getByRole('status').filter({ hasText: 'Loading…' })).toHaveCount(0);
    // ...and it still asked for the current list.
    await expect.poll(() => seen.count).toBeGreaterThan(0);
    release();
    await expect(page.getByRole('main').getByRole('listitem').first()).toBeVisible();
  });

  test('are not shown from the last account after signing out', async ({ page }) => {
    await signIn(page, { name: 'E2E instant first account', role: 'editor' });
    await page.goto('/o/volunteering/changes');
    await expect(page.getByRole('main').getByRole('listitem').first()).toBeVisible();
    // Sign out from the account menu, without reloading the page, and come back as someone else.
    await page.getByRole('button', { name: /E2E instant first account/ }).click();
    await page.getByRole('navigation', { name: 'Account' }).getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    const { release } = await holdChangeRequests(page);
    await page.getByRole('button', { name: 'Try the demo' }).click();
    await expect(page).not.toHaveURL(/\/login/);
    // Signed in again as someone else, back to the list in the same page (see issue #100 for why not while signed out).
    await page.evaluate(() => {
      history.pushState({}, '', '/o/volunteering/changes');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page).toHaveURL(/\/o\/volunteering\/changes$/);
    // The new account's list hasn't come yet, so nothing is shown but the loading state.
    await expect(page.getByRole('main').getByRole('status').filter({ hasText: 'Loading…' })).toBeVisible();
    await expect(page.getByRole('main').getByRole('listitem')).toHaveCount(0);
    release();
    await expect(page.getByRole('main').getByRole('listitem').first()).toBeVisible();
  });
});
