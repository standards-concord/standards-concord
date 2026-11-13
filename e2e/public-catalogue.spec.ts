import AxeBuilder from '@axe-core/playwright';
import { test, expect, signIn, demoOntology, uniq } from './fixtures';

test('signed-out visitors discover standards from sign-in and return from a public page', async ({ page }) => {
  // Visitors used to reach only sign-in, with no way to discover any standard.
  const demo = await demoOntology(page.request);
  await page.goto('/login');
  const here = page.getByRole('region', { name: 'Standards here' });
  await expect(here.getByRole('link', { name: demo.title, exact: true })).toHaveAttribute('href', '/def/volunteering');
  await here.getByRole('link', { name: 'See all standards' }).click();
  await expect(page).toHaveURL(/\/def$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Standards on Concord' })).toBeVisible();
  const standard = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: demo.title, exact: true }) });
  await expect(standard).toContainText(/Version \d+\.\d+\.\d+, \d+ \w+ \d{4}/);
  await standard.getByRole('link', { name: demo.title, exact: true }).click();
  await expect(page).toHaveURL(/\/def\/volunteering$/);
  await page.getByRole('link', { name: 'All standards', exact: true }).click();
  await expect(page).toHaveURL(/\/def$/);
  await page.getByRole('link', { name: 'Sign in to Concord' }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test('the catalogue and trailing slash reach the server, are accessible and fit a phone', async ({ page }) => {
  // /def used to fall through to the app shell in the proxy and deployment rewrite.
  await demoOntology(page.request);
  for (const path of ['/def', '/def/']) {
    await page.goto(path);
    await expect(page).toHaveTitle('Standards on Concord');
    await expect(page.locator('meta[name="generator"]')).toHaveAttribute('content', /Concord public page/);
    await expect(page.getByRole('button', { name: 'New ontology' })).toHaveCount(0);
  }
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(result.violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole('link', { name: 'Sign in to Concord' }).focus();
  await expect(page.getByRole('link', { name: 'Sign in to Concord' })).toBeFocused();
});

test('the catalogue works without JavaScript', async ({ browser, baseURL, request }) => {
  const demo = await demoOntology(request);
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto('/def');
    await expect(page.getByRole('heading', { name: 'Standards on Concord' })).toBeVisible();
    await page.getByRole('link', { name: demo.title, exact: true }).click();
    await page.getByRole('link', { name: 'All standards', exact: true }).click();
    await expect(page).toHaveURL(/\/def$/);
  } finally {
    await context.close();
  }
});

test('a member finds the public list on the hub and visitors see a newly created draft', async ({ page }) => {
  await signIn(page, { name: `Catalogue member ${uniq()}`, role: 'member' });
  await page.goto('/');
  await expect(page.getByRole('main').getByRole('link', { name: 'Public list of standards' })).toHaveAttribute('href', '/def');
  await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Public list of standards' })).toHaveAttribute('href', '/def');
  await page.getByRole('button', { name: 'New ontology' }).click();
  const dialog = page.getByRole('dialog', { name: 'New ontology' });
  const title = `Catalogue draft ${uniq()}`;
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByLabel('Prefix').fill('catalogue');
  await dialog.getByLabel('Description').fill('An unreleased standard for the public catalogue.');
  await dialog.getByRole('button', { name: 'Create ontology' }).click();
  await expect(page).toHaveURL(/\/o\/[^/]+$/);
  await page.context().clearCookies();
  await page.goto('/def');
  const standard = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: title, exact: true }) });
  await expect(standard).toContainText('Draft, no published version yet');
  await expect(standard).toContainText('0 classes, 0 properties');
  await standard.getByRole('link', { name: title, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
});

test('sign-in lists at most five standards and keeps its catalogue link when loading fails', async ({ page, consoleGuard }) => {
  const titles = Array.from({ length: 7 }, (_, i) => `Listed standard ${i}`);
  let finishLoading!: () => void;
  const loading = new Promise<void>((resolve) => { finishLoading = resolve; });
  let requested!: () => void;
  const started = new Promise<void>((resolve) => { requested = resolve; });
  await page.route('**/api/ontologies', async (route) => {
    requested();
    await loading;
    await route.fulfill({ json: titles.map((title, i) => ({ id: `listed-${i}`, slug: `listed-${i}`, title })) });
  });
  await page.goto('/login');
  const here = page.getByRole('region', { name: 'Standards here' });
  await started;
  await expect(here).toHaveCount(0);
  finishLoading();
  await expect(here.getByRole('listitem')).toHaveCount(5);
  await expect(here.getByRole('link', { name: titles[0] })).toHaveAttribute('href', '/def/listed-0');
  await expect(here.getByRole('link', { name: titles[0] })).not.toHaveAttribute('target', '_blank');
  consoleGuard.allow(/Failed to load resource: the server responded with a status of 503/);
  await page.route('**/api/ontologies', (route) => route.fulfill({ status: 503, json: { error: 'Unavailable' } }));
  await page.reload();
  await expect(here.getByRole('link', { name: 'See all standards' })).toBeVisible();
  await expect(here.getByRole('list')).toHaveCount(0);
  await expect(here.getByRole('heading')).toHaveCount(0);
});

test('a tester follows "Try it" from the list of changes to the public catalogue', async ({ page }) => {
  // The list of changes linked server-rendered pages (/def and a standard's public page) through the app's
  // router, which has no such route, so "Try it" showed "Not found".
  await demoOntology(page.request);
  await page.goto('/alpha');
  const fold = page.getByRole('button', { name: /What’s new/ });
  await expect(async () => {
    if ((await fold.getAttribute('aria-expanded')) !== 'true') await fold.click();
    await expect(page.getByRole('region', { name: 'What’s changed' })).toBeVisible({ timeout: 1000 });
  }).toPass();
  const changed = page.getByRole('region', { name: 'What’s changed' });
  await changed.getByLabel('Last version you tested').selectOption('0.48.1');
  const all = changed.getByRole('button', { name: /^Show all \d+ changes$/ });
  if (await all.count()) await all.click();
  await changed.getByRole('link', { name: 'Try it: A public list of standards' }).click();
  await expect(page).toHaveURL(/\/def$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Standards on Concord' })).toBeVisible();
  await page.goBack();
  // The version picked is remembered; the longer list folds again after the reload.
  await expect(changed.getByRole('heading', { name: 'What’s changed since 0.48.1' })).toBeVisible();
  if (await all.count()) await all.click();
  await changed.getByRole('link', { name: 'Try it: Public pages list only the standard\'s own terms' }).click();
  await expect(page).toHaveURL(/\/def\/volunteering$/);
  await expect(page.locator('meta[name="generator"]')).toHaveAttribute('content', /Concord public page/);
});
