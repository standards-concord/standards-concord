import { test, expect, expectNoCrash, settle, signIn, demoOntology } from './fixtures';

/**
 * Every page of the app opens without crashing or logging errors, for a signed-in tester.
 * Feature specs (browse, query, formats, ...) test what each page does in depth.
 */

test('signing in from the login page lands on the walkthrough', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Try the demo' }).click();
  await expect(page).toHaveURL(/\/alpha$/);
  await expect(page.getByRole('heading', { name: 'Guided walkthrough' })).toBeVisible();
});

test('signed-out visitors are sent to the login page', async ({ page }) => {
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/login\?next=%2Fsettings/);
  await expect(page.getByRole('heading', { name: 'Welcome to Concord' })).toBeVisible();
});

test.describe('signed in', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, { name: 'E2E tester', role: 'steward' });
  });

  for (const path of ['/', '/settings', '/feedback', '/alpha']) {
    test(`page ${path} opens`, async ({ page }) => {
      await page.goto(path);
      await settle(page);
      await expectNoCrash(page);
      await expect(page.locator('main')).not.toBeEmpty();
    });
  }

  test('every ontology tab opens', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await page.goto(`/o/${demo.id}`);
    const tabs = page.getByRole('navigation', { name: 'Ontology sections' }).getByRole('link');
    await expect(tabs.first()).toBeVisible();
    const names = (await tabs.allInnerTexts()).map((t) => t.trim());
    expect(names).toEqual(expect.arrayContaining(['Overview', 'Browse', 'Formats', 'Query', 'Change requests', 'Releases', 'Governance']));
    for (const name of names) {
      await test.step(name, async () => {
        await page.getByRole('navigation', { name: 'Ontology sections' }).getByRole('link', { name, exact: true }).click();
        await settle(page);
        await expectNoCrash(page);
        await expect(page.getByRole('navigation', { name: 'Ontology sections' }).getByRole('link', { name, exact: true })).toHaveClass(/border-accent/);
      });
    }
  });

  test('detail pages linked from the ontology open', async ({ page, request }) => {
    const demo = await demoOntology(request);
    for (const [tab, pattern] of [
      ['changes', /\/changes\/[^/?]+$/],
      ['releases', /\/releases\/[^/?]+$/],
      ['use-cases', /\/use-cases\/[^/?]+$/],
      ['meetings', /\/meetings\/[^/?]+$/],
    ] as const) {
      await test.step(tab, async () => {
        await page.goto(`/o/${demo.id}/${tab}`);
        await settle(page);
        const hrefs = await page.locator('main a[href]').evaluateAll((as, src) => as.map((a) => a.getAttribute('href') ?? '').filter((h) => new RegExp(src).test(h)), pattern.source);
        test.info().annotations.push({ type: tab, description: `${hrefs.length} detail links` });
        for (const href of [...new Set(hrefs)].slice(0, 3)) {
          await page.goto(href);
          await settle(page);
          await expectNoCrash(page);
        }
      });
    }
  });

  test('unknown routes show the not-found page', async ({ page }) => {
    await page.goto('/definitely/not/a/page');
    await expect(page.getByText(/not found|doesn’t exist|does not exist/i).first()).toBeVisible();
  });
});
