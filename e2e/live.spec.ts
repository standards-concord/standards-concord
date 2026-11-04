import { test, expect, expectNoCrash, settle } from './fixtures';

/**
 * Smoke tests for the deployed site (LIVE_URL, default https://standards-concord.vercel.app).
 * Run with `pnpm test:e2e:live`. They only read, apart from a demo sign-in, so they are safe
 * to run against the shared demo that testers use.
 */

let backend: { ok: boolean; detail: string } | undefined;

test.beforeAll(async ({ request }) => {
  const r = await request.get('/healthz');
  backend = { ok: r.ok(), detail: `${r.status()} ${(await r.text()).slice(0, 200)}` };
});

test('the backend is connected', () => {
  expect(backend?.ok, `GET /healthz returned ${backend?.detail}`).toBe(true);
});

test('the walkthrough page loads', async ({ page }) => {
  await page.goto('/alpha');
  await expect(page.getByRole('heading', { name: 'Guided walkthrough' })).toBeVisible();
});

test.describe('with the backend', () => {
  test.beforeEach(() => test.skip(!backend?.ok, 'backend unavailable; see "the backend is connected"'));

  test('a tester can sign in and open every ontology tab', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Try the demo' }).click();
    await expect(page).toHaveURL(/\/alpha$/);
    const ontologies = (await (await page.request.get('/api/ontologies')).json()) as { id: string; demo?: boolean }[];
    const demo = ontologies.find((o) => o.demo) ?? ontologies[0];
    expect(demo).toBeTruthy();
    await page.goto(`/o/${demo.id}`);
    const nav = page.getByRole('navigation', { name: 'Ontology sections' });
    await expect(nav.getByRole('link').first()).toBeVisible();
    for (const name of (await nav.getByRole('link').allInnerTexts()).map((t) => t.trim())) {
      await test.step(name, async () => {
        await nav.getByRole('link', { name, exact: true }).click();
        await settle(page);
        await expectNoCrash(page);
      });
    }
  });

  test('the Query tab loads sparq (WebAssembly) and the Formats tab is highlighted', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Try the demo' }).click();
    await expect(page).toHaveURL(/\/alpha$/);
    const ontologies = (await (await page.request.get('/api/ontologies')).json()) as { id: string; demo?: boolean }[];
    const demo = ontologies.find((o) => o.demo) ?? ontologies[0];
    const wasm = page.waitForResponse((r) => r.url().endsWith('.wasm'));
    await page.goto(`/o/${demo.id}/query`);
    expect((await wasm).headers()['content-type']).toContain('application/wasm');
    await expect(page.getByTestId('sparq-ready')).toHaveText(/triples loaded/, { timeout: 30_000 });
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByTestId('query-results')).toContainText(/\d+ rows?/);
    await page.goto(`/o/${demo.id}/source?format=turtle`);
    await expect(page.getByTestId('source-code').locator('.tok-iri').first()).toBeVisible();
  });
});
