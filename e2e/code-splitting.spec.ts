import { expect, expectNoCrash, networkQuiet, signIn, test, uniq } from './fixtures';

test.describe('Route chunks', () => {
  test.skip(process.env.E2E_MODE !== 'preview', 'Vite serves source modules in dev; hashed route chunks only exist in the production build');

  test('sign-in skips heavy libraries and Source downloads its editor when opened', async ({ page }) => {
    // Previously sign-in downloaded every page, editor and diagram in the entry bundle.
    const scripts: string[] = [];
    page.on('request', (r) => { if (r.resourceType() === 'script') scripts.push(r.url()); });
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Design open standards together' })).toBeVisible();
    await networkQuiet(page);
    expect(scripts.filter((url) => /\/(?:Source|CodeEditor|codemirror|ClassDiagram|queryWorker|sparql|sparq|Browse)-/.test(url))).toEqual([]);
    await signIn(page, { name: `E2E chunks ${uniq()}`, role: 'editor' });
    await page.goto('/o/volunteering');
    await page.getByRole('navigation', { name: 'Ontology sections' }).getByRole('link', { name: 'Explore', exact: true }).click();
    await page.getByRole('link', { name: 'Source & export', exact: true }).click();
    await expect(page.getByTestId('source-code')).toContainText('@prefix');
    expect(scripts.some((url) => /\/Source-.*\.js$/.test(url))).toBe(true);
    expect(scripts.some((url) => /\/codemirror-.*\.js$/.test(url))).toBe(true);
    await expectNoCrash(page);
  });

  test('signed-out visitors cannot open a lazy ontology tab', async ({ page }) => {
    await page.goto('/o/volunteering/source');
    await expect(page).toHaveURL(/\/login\?next=/);
    await expect(page.getByTestId('source-code')).toHaveCount(0);
    await expectNoCrash(page);
  });

  test('a tab whose code is already downloaded opens with no blank page and no Loading', async ({ page }) => {
    // Hovering a tab downloads its code, so opening it must swap pages in one step. (A review predicted a blank
    // page and a Loading flash here when navigation did not run as a transition. Chromium showed neither either
    // way, so this guards the behaviour; the slow-tab test below is the one that fails without transitions.)
    await signIn(page, { name: `E2E prefetched tab ${uniq()}`, role: 'editor' });
    await page.mouse.move(0, 0);
    await page.goto('/o/volunteering/browse');
    await expect(page.getByRole('tree', { name: /Classes/ })).toBeVisible();
    await networkQuiet(page);
    const downloads: Promise<unknown>[] = [];
    page.on('response', (response) => {
      if (/\/assets\/.*\.js$/.test(response.url())) downloads.push(response.finished());
    });
    const source = page.getByRole('link', { name: 'Source & export', exact: true });
    const prefetched = page.waitForResponse('**/assets/Source-*.js');
    await source.hover();
    expect(await (await prefetched).finished()).toBeNull();
    // Vite may also request the editor and shared dependencies while evaluating Source.
    await networkQuiet(page);
    await Promise.all(downloads);
    await page.evaluate(() => {
      const seen = { blank: false, loading: false };
      const check = () => {
        // The ontology header stays either way: it is the page beneath it that went blank.
        if (!document.querySelector('.ontology-content')?.childElementCount) seen.blank = true;
        if ([...document.querySelectorAll('[role="status"]')].some((el) => el.textContent?.trim() === 'Loading…')) seen.loading = true;
      };
      new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
      Object.assign(window, { routePaint: seen });
      check();
    });
    await source.click();
    await expect(page.getByTestId('source-code')).toContainText('@prefix');
    expect(await page.evaluate(() => (window as typeof window & { routePaint: { blank: boolean; loading: boolean } }).routePaint)).toEqual({ blank: false, loading: false });
  });

  test('a slow tab keeps the current page and navigation visible with one polite Loading status', async ({ page }) => {
    // Disabling transitions used to replace Browse with an empty fallback while code downloaded.
    await signIn(page, { name: `E2E slow tab ${uniq()}`, role: 'editor' });
    await page.goto('/o/volunteering/browse');
    await networkQuiet(page);
    const tree = page.getByRole('tree', { name: /Classes/ });
    await expect(tree).toBeVisible();
    const title = page.getByRole('heading', { level: 1 }).first();
    await title.evaluate((el) => el.setAttribute('data-kept-layout', 'yes'));
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/assets/Source-*.js', async (route) => { await held; await route.continue(); });
    try {
      await page.getByRole('link', { name: 'Source & export', exact: true }).click();
      const loading = page.getByRole('status').filter({ hasText: /^\s*Loading…\s*$/ });
      await expect(loading).toHaveCount(1);
      await expect(loading).toBeVisible();
      await expect(loading).toHaveAttribute('aria-live', 'polite');
      await expect(tree).toBeVisible();
      await expect(title).toHaveAttribute('data-kept-layout', 'yes');
      await expect(page.getByRole('navigation', { name: 'Explore pages' })).toBeVisible();
      release();
      await expect(page.getByTestId('source-code')).toContainText('@prefix');
      await expect(loading).toHaveCount(0);
      await expect(title).toHaveAttribute('data-kept-layout', 'yes');
    } finally {
      release();
    }
  });

  test('going elsewhere while a tab is still downloading clears Loading, and coming back to that tab shows it again', async ({ page }) => {
    // The Loading bar used to stay until the abandoned tab's download ended, over a page that had already opened.
    await signIn(page, { name: `E2E abandoned tab ${uniq()}`, role: 'editor' });
    await page.goto('/o/volunteering/connect');
    await networkQuiet(page);
    await page.goto('/o/volunteering/browse');
    await networkQuiet(page);
    await expect(page.getByRole('tree', { name: /Classes/ })).toBeVisible();
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/assets/Source-*.js', async (route) => { await held; await route.continue(); });
    try {
      await page.getByRole('link', { name: 'Source & export', exact: true }).click();
      const loading = page.getByRole('status').filter({ hasText: /^\s*Loading…\s*$/ });
      await expect(loading).toHaveCount(1);
      // Connect an agent was opened above, so its code is already here.
      await page.getByRole('link', { name: 'Connect an agent', exact: true }).click();
      await expect(page).toHaveURL(/\/connect$/);
      await expect(page.getByRole('tree', { name: /Classes/ })).toHaveCount(0);
      await expect(loading).toHaveCount(0);
      // Choosing the first tab again while it is still downloading used to show no Loading at all: its
      // wait had been dropped for good, and React asks for a page's code only once.
      await page.getByRole('link', { name: 'Source & export', exact: true }).click();
      await expect(loading).toHaveCount(1);
      await expect(page.getByRole('heading', { name: 'Connect an agent' }).first()).toBeVisible();
      release();
      await expect(page.getByTestId('source-code')).toContainText('@prefix');
      await expect(loading).toHaveCount(0);
    } finally {
      release();
    }
  });

  test('a direct visit shows only its Suspense Loading status while page code waits', async ({ page }) => {
    // The new pending bar must not duplicate the first-load Suspense fallback.
    await signIn(page, { name: `E2E direct tab ${uniq()}`, role: 'reviewer' });
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/assets/Source-*.js', async (route) => { await held; await route.continue(); });
    try {
      const requested = page.waitForRequest('**/assets/Source-*.js');
      await page.goto('/o/volunteering/source', { waitUntil: 'domcontentloaded' });
      await requested;
      await expect(page.getByRole('navigation', { name: 'Ontology sections' })).toBeVisible();
      const loading = page.getByRole('status').filter({ hasText: /^\s*Loading…\s*$/ });
      await expect(loading).toHaveCount(1);
      await expect(loading).toBeVisible();
      await expect(page.getByRole('main').getByRole('status').filter({ hasText: /^\s*Loading…\s*$/ })).toHaveCount(1);
      await expect(loading).toHaveAttribute('aria-live', 'polite');
      release();
      await expect(page.getByTestId('source-code')).toContainText('@prefix');
      await expect(loading).toHaveCount(0);
    } finally {
      release();
    }
  });

  test('an online chunk failure reloads once per build and then offers Retry', async ({ page, consoleGuard }) => {
    consoleGuard.allow(/Failed to load resource.*ERR_FAILED/, /RouteChunkError: Could not download this page/);
    await signIn(page, { name: `E2E online chunk ${uniq()}`, role: 'editor' });
    await page.goto('/o/volunteering');
    await expect(page.getByRole('navigation', { name: 'Ontology sections' })).toBeVisible();
    const documents: string[] = [];
    page.on('request', (r) => { if (r.isNavigationRequest()) documents.push(r.url()); });
    await page.route('**/assets/Source-*.js', (route) => route.abort());
    await page.getByRole('navigation', { name: 'Ontology sections' }).getByRole('link', { name: 'Explore', exact: true }).click();
    await page.getByRole('link', { name: 'Source & export', exact: true }).click();
    await expect.poll(() => documents.length).toBe(1);
    await expect(page.getByText("This page isn't available offline yet. Reconnect and try again.")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Ontology sections' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Explore pages' })).toBeVisible();
    await networkQuiet(page);
    expect(documents).toHaveLength(1);
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('concord.chunkReload.')))).toHaveLength(1);
    await expectNoCrash(page);
  });

  test('a failed tab download offline keeps navigation visible and Retry recovers', async ({ page, consoleGuard }) => {
    // Previously a failed import escaped to the crash screen; the ontology header disappeared.
    consoleGuard.allow(/Failed to load resource.*(?:ERR_FAILED|ERR_INTERNET_DISCONNECTED)/, /RouteChunkError: Could not download this page/);
    await signIn(page, { name: `E2E chunk retry ${uniq()}`, role: 'reviewer' });
    await page.goto('/o/volunteering');
    await expect(page.getByRole('navigation', { name: 'Ontology sections' })).toBeVisible();
    await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }));
    let failed = false;
    await page.route('**/assets/Source-*.js', async (route) => {
      failed = true;
      await route.abort('internetdisconnected');
    }, { times: 1 });
    // Go through the UI without hovering Source first: a prefetch failure must also be retryable.
    await page.getByRole('navigation', { name: 'Ontology sections' }).getByRole('link', { name: 'Explore', exact: true }).click();
    await page.getByRole('link', { name: 'Source & export', exact: true }).click();
    await expect(page.getByText("This page isn't available offline yet. Reconnect and try again.")).toBeVisible();
    expect(failed).toBe(true);
    await expect(page.getByRole('navigation', { name: 'Ontology sections' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Explore pages' })).toBeVisible();
    await expectNoCrash(page);
    await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true }));
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByTestId('source-code')).toContainText('@prefix');
    await expectNoCrash(page);
  });

  test('an unopened tab opens offline after the worker has kept the app', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, serviceWorkers: 'allow' });
    const page = await context.newPage();
    const errors: string[] = [];
    const scripts: string[] = [];
    page.on('request', (r) => { if (r.resourceType() === 'script') scripts.push(r.url()); });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(m.text())) errors.push(m.text());
    });
    try {
      await signIn(page, { name: `E2E unopened tab ${uniq()}`, role: 'reviewer' });
      await page.goto('/o/volunteering');
      await expect(page.getByRole('navigation', { name: 'Ontology sections' })).toBeVisible();
      await page.evaluate(async () => { await navigator.serviceWorker.ready; });
      await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
      expect(scripts.some((url) => /\/Governance-.*\.js$/.test(url))).toBe(false);
      // Governance needs only the ontology already saved by Overview; its code was never opened.
      await context.setOffline(true);
      await page.getByRole('navigation', { name: 'Ontology sections' }).getByRole('link', { name: 'Governance', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Governance', exact: true })).toBeVisible();
      await expectNoCrash(page);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
