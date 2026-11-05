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
  // Testers can see which version they're testing.
  await expect(page.getByTestId('app-version')).toHaveText(/^Concord \d+\.\d+\.\d+$/);
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

  test('the Query tab loads sparq (WebAssembly), the query assistant answers, and Source is highlighted', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Try the demo' }).click();
    await expect(page).toHaveURL(/\/alpha$/);
    const ontologies = (await (await page.request.get('/api/ontologies')).json()) as { id: string; demo?: boolean }[];
    const demo = ontologies.find((o) => o.demo) ?? ontologies[0];
    const wasm = page.waitForResponse((r) => r.url().endsWith('.wasm'));
    await page.goto(`/o/${demo.id}/query`);
    expect((await wasm).headers()['content-type']).toContain('application/wasm');
    await expect(page.getByTestId('sparq-ready')).toHaveText(/triples loaded|Ontology loaded/, { timeout: 30_000 });
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByTestId('query-results')).toContainText(/\d+ rows?/);
    // The query assistant answers through the backend, and its query runs here when asked.
    await page.getByTestId('query-suggestions').getByRole('button').first().click();
    await expect(page.getByTestId('query-chat').getByTestId('chat-message-assistant')).toHaveCount(2, { timeout: 60_000 });
    await expect(page.getByLabel('Run against')).toHaveValue(/data|ontology/);
    // It runs only once the person presses Run.
    await page.getByTestId('query-run-prompt').getByRole('button', { name: 'Run this query' }).click();
    await expect(page.getByTestId('query-results')).toContainText(/\d+ rows?/);
    await page.goto(`/o/${demo.id}/source?format=turtle`);
    await expect(page.getByTestId('source-code').locator('.tok-iri').first()).toBeVisible();
  });

  test('the public ontology page and content negotiation work through Vercel', async ({ page, request }) => {
    await page.goto('/def/volunteering');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/Volunteering/i);
    await expect(page.getByRole('tablist', { name: 'Sections' })).toBeVisible();
    await page.getByRole('tab', { name: /Use cases and requirements/ }).click();
    await expect(page.getByRole('heading', { name: 'Use cases', exact: true })).toBeVisible();
    const ttl = await request.get('/def/volunteering', { headers: { Accept: 'text/turtle' } });
    expect(ttl.headers()['content-type']).toContain('text/turtle');
    expect(await ttl.text()).toContain('owl:Ontology');
  });

  test('POST to the ontology IRI validates data through Vercel, and the SHACL profile returns the shapes', async ({ request }) => {
    const res = await request.post('/def/volunteering', {
      headers: { 'Content-Type': 'text/turtle' },
      data: '<https://example.org/o> a <https://w3id.org/odi/volunteering#VolunteeringOpportunity> .',
    });
    expect(res.status(), await res.text()).toBe(200);
    const report = await res.json();
    expect(report.conforms).toBe(false);
    expect(report.results.length).toBeGreaterThan(0);
    const shapes = await request.get('/def/volunteering', { headers: { 'Accept-Profile': '<http://www.w3.org/ns/shacl#>' } });
    expect(await shapes.text()).toContain('sh:NodeShape');
  });
});
