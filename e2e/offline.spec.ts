import { expect, expectNoCrash, signIn, test, type Page } from './fixtures';

/**
 * Offline reading: what you have opened is saved on this device, so Concord shows it again after a
 * reload with no connection (and, in the production build, opens with no connection at all), with a
 * notice saying you are offline. What is saved belongs to the account that opened it: signing out
 * wipes it, and the next account never sees it.
 */

const OFFLINE = /Failed to load resource|ERR_INTERNET_DISCONNECTED/;
const main = (page: Page) => page.getByRole('main');
const changesNav = (page: Page) => page.getByRole('navigation', { name: 'Changes pages' });
const offlineNotice = (page: Page) => page.getByRole('status').filter({ hasText: 'You’re offline' });

/** The keys this device has saved (IndexedDB), as the app stores them: account first. */
function savedKeys(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const req = indexedDB.open('concord-offline', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kept');
        req.onsuccess = () => {
          const get = req.result.transaction('kept').objectStore('kept').getAllKeys();
          get.onsuccess = () => {
            resolve(get.result.map(String));
            req.result.close();
          };
        };
        req.onerror = () => resolve([]);
      }),
  );
}

/** Opens Change requests and then Releases, and waits until this device has saved both lists. */
async function openTwoSections(page: Page) {
  await page.goto('/o/volunteering/changes');
  const firstRow = main(page).getByRole('listitem').first();
  await expect(firstRow).toBeVisible();
  const rowText = (await firstRow.textContent()) ?? '';
  await changesNav(page).getByRole('link', { name: 'Releases', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Releases' })).toBeVisible();
  await expect.poll(async () => (await savedKeys(page)).filter((k) => /\|(changeRequests|releases)\|/.test(k)).length).toBeGreaterThanOrEqual(2);
  return rowText;
}

test.describe('Offline reading', () => {
  test('sections you have opened show again after a reload with no connection, with a notice', async ({ page, consoleGuard }) => {
    consoleGuard.allow(OFFLINE);
    await signIn(page, { name: 'E2E offline reader', role: 'editor' });
    const rowText = await openTwoSections(page);
    await expect(offlineNotice(page)).toHaveCount(0);

    // The connection goes, and the page is opened again.
    await page.route('**/api/**', (route) => route.abort('internetdisconnected'));
    await page.reload();
    await expect(offlineNotice(page)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Releases' })).toBeVisible();
    await changesNav(page).getByRole('link', { name: 'Change requests', exact: true }).click();
    await expect(main(page).getByRole('listitem').first()).toHaveText(rowText);
    await expectNoCrash(page);

    // Back online: the notice goes once the server answers again.
    await page.unroute('**/api/**');
    await changesNav(page).getByRole('link', { name: 'Releases', exact: true }).click();
    await expect(offlineNotice(page)).toHaveCount(0);
  });

  test('signing out wipes what this device saved', async ({ page }) => {
    await signIn(page, { name: 'E2E offline sign out', role: 'reviewer' });
    await openTwoSections(page);
    expect(await page.evaluate(() => localStorage.getItem('concord.offline.session'))).toContain('E2E offline sign out');
    await page.getByRole('button', { name: /E2E offline sign out/ }).click();
    await page.getByRole('navigation', { name: 'Account' }).getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    await expect.poll(() => savedKeys(page)).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem('concord.offline.session'))).toBeNull();
  });

  test('the next account on this device never sees what another saved', async ({ page, consoleGuard }) => {
    consoleGuard.allow(OFFLINE);
    const first = await signIn(page, { name: 'E2E offline first', role: 'editor' });
    await openTwoSections(page);
    // Someone else signs in on the same browser without signing out first.
    const second = await signIn(page, { name: 'E2E offline second', role: 'contributor' });
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    await page.route(/\/api\/ontologies\/[^/]+\/change-requests(\?|$)/, async (route) => {
      await held;
      await route.continue();
    });
    await page.goto('/o/volunteering/changes');
    await expect(main(page).getByRole('status').filter({ hasText: 'Loading…' })).toBeVisible();
    await expect(main(page).getByRole('listitem')).toHaveCount(0);
    const keys = await savedKeys(page);
    expect(keys.some((k) => k.startsWith(`${first.user.id}|`))).toBe(false);
    release();
    await expect(main(page).getByRole('listitem').first()).toBeVisible();
    await expect.poll(async () => (await savedKeys(page)).some((k) => k.startsWith(`${second.user.id}|`))).toBe(true);
  });

  // Used to go wrong: with no connection, any data already on show was kept on show, so picking a format
  // never opened before went on showing the last format's text under the new format's name.
  test('with no connection, a format not opened before shows an error, never the last one’s text', async ({ page, consoleGuard }) => {
    consoleGuard.allow(OFFLINE);
    await signIn(page, { name: 'E2E offline formats', role: 'reviewer' });
    await page.goto('/o/volunteering/source?format=turtle');
    await expect(page.getByTestId('source-code')).toContainText('@prefix');
    await page.route('**/api/**', (route) => route.abort('internetdisconnected'));
    await page.getByLabel('Format', { exact: true }).selectOption({ label: 'JSON-LD' });
    await expect(page.getByText('Couldn’t load JSON-LD')).toBeVisible();
    await expect(page.getByTestId('source-code')).toHaveCount(0);
    // Turtle was opened before, so it is still there.
    await page.getByLabel('Format', { exact: true }).selectOption({ label: 'Turtle' });
    await expect(page.getByTestId('source-code')).toContainText('@prefix');
  });

  // Used to go wrong: signing out with no connection left the person on screen (and /login sent them
  // back), and the server's session, which couldn't be ended, signed them back in once online.
  test('signing out with no connection signs out at once, and stays signed out once back online', async ({ page, consoleGuard }) => {
    consoleGuard.allow(OFFLINE);
    await signIn(page, { name: 'E2E offline leaver', role: 'reviewer' });
    await openTwoSections(page);
    await page.route('**/api/**', (route) => route.abort('internetdisconnected'));
    await page.reload();
    await expect(offlineNotice(page)).toBeVisible();
    await page.getByRole('button', { name: /E2E offline leaver/ }).click();
    await page.getByRole('navigation', { name: 'Account' }).getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('button', { name: /E2E offline leaver/ })).toHaveCount(0);
    await expect.poll(() => savedKeys(page)).toEqual([]);
    // Back online: the server's session is ended, so opening Concord again asks to sign in.
    await page.unroute('**/api/**');
    await page.goto('/o/volunteering/changes');
    await expect(page).toHaveURL(/\/login/);
    const session = await (await page.request.get('/api/session')).json();
    expect(session.user).toBeUndefined();
  });

  test('a server outage behind the gateway counts as offline too', async ({ page, consoleGuard }) => {
    consoleGuard.allow(OFFLINE, /status of 502/);
    await signIn(page, { name: 'E2E offline outage', role: 'reviewer' });
    const rowText = await openTwoSections(page);
    await page.route('**/api/**', (route) => route.fulfill({ status: 502, body: '' }));
    await changesNav(page).getByRole('link', { name: 'Change requests', exact: true }).click();
    await expect(offlineNotice(page)).toBeVisible();
    await expect(main(page).getByRole('listitem').first()).toHaveText(rowText);
  });

  test('the app itself opens with no connection (production build)', async ({ browser, baseURL }) => {
    test.skip(process.env.E2E_MODE !== 'preview', 'only the production build has the service worker that keeps the app');
    // Its own browser window, with service workers on (the rest of the suite turns them off).
    const context = await browser.newContext({ baseURL, serviceWorkers: 'allow', viewport: { width: 1400, height: 950 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !OFFLINE.test(m.text()) && errors.push(m.text()));
    try {
      await signIn(page, { name: 'E2E offline app', role: 'reviewer' });
      const rowText = await openTwoSections(page);
      await page.evaluate(async () => {
        await navigator.serviceWorker.ready;
      });
      await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
      await expect.poll(() => page.evaluate(async () => (await caches.keys()).some((k) => k.startsWith('concord-app-')))).toBe(true);

      await context.setOffline(true);
      await page.reload();
      await expect(offlineNotice(page)).toBeVisible();
      await changesNav(page).getByRole('link', { name: 'Change requests', exact: true }).click();
      await expect(main(page).getByRole('listitem').first()).toHaveText(rowText);
      await expectNoCrash(page);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
