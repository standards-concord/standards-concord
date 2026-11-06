import { test, expect, demoOntology, settle, signIn, signInAsPersona, uniq } from './fixtures';

/**
 * Section A of the "geeky features" list (Jesse, 6 Nov 2026): details about how Concord works
 * inside come off the main path, while everything a person acts on stays.
 */
test.describe('fewer under-the-hood details', () => {
  test('the overview health says "Quality checks", hides style suggestions unless Advanced features is on, and repeats nothing in its details', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signInAsPersona(page, 'Tom Okafor');
    const v = (await (await page.request.get(`/api/ontologies/${demo.id}/validation?ref=working`)).json()) as { lint: { severity: string; message: string; code: string }[] };
    const suggestion = v.lint.find((i) => i.severity === 'info');
    await page.goto(`/o/${demo.id}`);
    await settle(page);
    const health = page.locator('#health');
    await expect(health.getByRole('group', { name: 'Health summary' })).toContainText('Quality checks');
    await expect(health).not.toContainText(/Lint|suggestion/);
    const quality = health.getByRole('button', { name: /Quality checks/ });
    if ((await quality.getAttribute('aria-expanded')) !== 'true') await quality.click();
    if (suggestion) await expect(health.getByText(suggestion.message, { exact: true })).toHaveCount(0);

    // With Advanced features on, suggestions are listed again.
    await page.goto('/settings');
    await page.getByRole('switch', { name: 'Show advanced features' }).click();
    await page.goto(`/o/${demo.id}`);
    await settle(page);
    if (suggestion) {
      await expect(health.getByRole('button', { name: /Quality checks/ })).toContainText(/suggestion/);
      if ((await quality.getAttribute('aria-expanded')) !== 'true') await quality.click();
      const more = health.getByRole('button', { name: /^Suggestions/ });
      if (await more.count()) await more.click();
      await expect(health.getByText(suggestion.message, { exact: true }).first()).toBeVisible();
      // Its rule code is on the icon's hover.
      await expect(health.getByRole('img', { name: new RegExp(`^Suggestion\\. ${suggestion.code}`) }).first()).toHaveAttribute('title', new RegExp(`^${suggestion.code}`));
    }

    // The ontology's IRI is in its details only, not under the title on every page.
    await expect(page.locator('.ontology-header')).not.toContainText(/https?:\/\//);
    await page.getByRole('button', { name: /Ontology details/ }).click();
    const about = page.getByRole('region', { name: 'About this ontology' });
    await expect(about.getByText('Ontology IRI', { exact: true })).toBeVisible();
    await expect(about.getByText('Current version', { exact: true })).toHaveCount(0);
  });

  // Hiding the SPARQL keeps a reviewer's view short; it is not an access rule (group members still
  // receive it from the API, see apps/server/test/privacy.test.ts). So these check what is shown.
  test('only editors are shown a competency question’s SPARQL test and results on the overview', async ({ page, request }) => {
    const demo = await demoOntology(request);
    const open = async () => {
      await page.goto(`/o/${demo.id}`);
      await settle(page);
      const cqs = page.locator('#health').getByRole('button', { name: /Competency questions/ });
      if ((await cqs.getAttribute('aria-expanded')) !== 'true') await cqs.click();
      return page.locator('#health');
    };
    await signInAsPersona(page, 'Tom Okafor');
    const v = (await (await page.request.get(`/api/ontologies/${demo.id}/validation?ref=working`)).json()) as { competencyQuestions: { question: string; sparql?: string }[] };
    // The demo ships use cases with tested questions; without them this test would prove nothing.
    expect(v.competencyQuestions.length).toBeGreaterThan(0);
    const first = v.competencyQuestions[0].question;

    // A reviewer sees each question and whether it can be answered, and nothing to open.
    await signInAsPersona(page, 'Mei Chen');
    let health = await open();
    await expect(health.getByRole('img', { name: /^(Answerable|Not answerable)$/ })).toHaveCount(v.competencyQuestions.length);
    await expect(health.getByText(first, { exact: true })).toBeVisible();
    await expect(health.getByRole('button', { name: first })).toHaveCount(0);
    await expect(health.locator('pre, code').filter({ hasText: /SELECT|ASK/i })).toHaveCount(0);

    // An editor can open one to its test.
    await signInAsPersona(page, 'Tom Okafor');
    health = await open();
    await health.getByRole('button', { name: first }).click();
    await expect(health.locator('pre, code').filter({ hasText: /SELECT|ASK/i }).first()).toBeVisible();
  });

  test('a use case shows its questions’ SPARQL tests to editors only', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signInAsPersona(page, 'Tom Okafor');
    const ucs = (await (await page.request.get(`/api/ontologies/${demo.id}/use-cases`)).json()) as { id: string; competencyQuestions: { question: string; sparql?: string }[] }[];
    const uc = ucs.find((u) => u.competencyQuestions.some((q) => q.sparql));
    expect(uc, 'a demo use case with a drafted SPARQL test').toBeTruthy();
    const q = uc!.competencyQuestions.find((x) => x.sparql)!;
    const toggle = (title: RegExp) => page.getByRole('button', { name: new RegExp(`^${title.source} for “${q.question.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}”`) });

    await page.goto(`/o/${demo.id}/use-cases/${uc!.id}`);
    await settle(page);
    await toggle(/Example answer, terms and test/).click();
    await expect(page.getByText('SPARQL test', { exact: true }).first()).toBeVisible();

    // A reviewer gets the question, its example and terms, without the test.
    await signInAsPersona(page, 'Mei Chen');
    await page.goto(`/o/${demo.id}/use-cases/${uc!.id}`);
    await settle(page);
    await expect(page.getByText(q.question, { exact: true })).toBeVisible();
    await expect(toggle(/Example answer, terms and test/)).toHaveCount(0);
    const detail = toggle(/Example answer and terms/);
    if (await detail.count()) await detail.click();
    await expect(page.getByText('SPARQL test', { exact: true })).toHaveCount(0);
  });

  test('a change request says where it came from and what kind it is only when that is not the default, and its AI analysis doesn’t restate the edits', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signInAsPersona(page, 'Mei Chen');
    const crs = (await (await page.request.get(`/api/ontologies/${demo.id}/change-requests`)).json()) as { id: string; origin: { type: string }; kind: string; title: string }[];
    const plain = crs.find((c) => c.origin.type === 'direct' && c.kind === 'feature');
    test.skip(!plain, 'no directly proposed feature in the demo');
    await page.goto(`/o/${demo.id}/changes/${plain!.id}`);
    await settle(page);
    const header = page.getByRole('heading', { name: plain!.title }).locator('xpath=ancestor::div[2]');
    await expect(header).not.toContainText('Proposed directly');
    await expect(header).not.toContainText(/\bFeature\b/);
    // The analysis sits under the description, before the edits, with its rationale one click away.
    const analysis = page.getByRole('heading', { name: 'AI analysis' });
    if (await analysis.count()) {
      const proposed = page.getByRole('heading', { name: /^Proposed changes/ });
      expect((await analysis.boundingBox())!.y).toBeLessThan((await proposed.boundingBox())!.y);
      await expect(page.getByRole('button', { name: /Rationale and risks/ })).toBeVisible();
    }
    // Approval details is a plain toggle: what's needed is already said above it.
    await expect(page.getByRole('button', { name: 'Approval details', exact: true })).toBeVisible();

    const other = crs.find((c) => c.kind !== 'feature' || c.origin.type !== 'direct');
    if (other) {
      await page.goto(`/o/${demo.id}/changes/${other.id}`);
      await settle(page);
      const h = page.getByRole('heading', { name: other.title }).locator('xpath=ancestor::div[2]');
      if (other.kind !== 'feature') await expect(h).toContainText(other.kind.charAt(0).toUpperCase() + other.kind.slice(1));
      if (other.origin.type === 'chat') await expect(h).toContainText('From an interview');
    }
  });

  test('a fork page shows its version where you use it, two formats up front, and no MCP tool names', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signIn(page, { name: `Fork reader ${uniq()}`, role: 'contributor' });
    const name = `Shifts ${uniq()}`;
    const r = await page.request.post(`/api/ontologies/${demo.id}/forks`, { data: { name, purpose: 'Testing the fork page' } });
    expect(r.ok(), await r.text()).toBeTruthy();
    const fork = (await r.json()) as { slug: string; version: string };
    await page.goto(`/o/${demo.id}/forks/${fork.slug}`);
    await settle(page);
    await expect(page.locator('main')).not.toContainText(/[a-z]+_forks?\b/);
    const use = page.getByRole('heading', { name: 'Use it in your application' }).locator('xpath=..');
    await expect(use).toContainText(`Version ${fork.version}`);
    const formats = page.getByRole('list', { name: 'Formats' });
    await expect(formats.getByRole('link')).toHaveText(['Turtle', 'JSON-LD']);
    await formats.getByRole('button', { name: 'More formats' }).click();
    await expect(formats.getByRole('link', { name: 'RDF/XML' })).toBeVisible();
    await expect(formats.getByRole('button', { name: 'More formats' })).toHaveCount(0);
  });

  test('Source & export keeps Turtle, JSON-LD and SHACL up front and the rest under More formats', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signInAsPersona(page, 'Aisha Rahman');
    await page.goto(`/o/${demo.id}/source`);
    const select = page.getByLabel('Format');
    await expect(select.locator('option').first()).toBeAttached();
    const texts = (sel: string) => select.locator(sel).evaluateAll((els) => els.map((e) => e.textContent?.trim()));
    expect(await texts(':scope > option')).toEqual(['Turtle', 'JSON-LD', 'SHACL']);
    expect(await texts('optgroup[label="More formats"] > option')).toEqual(['RDF/XML', 'N-Triples', 'Manchester', 'LinkML', 'SHACLC', 'Classes']);
    await select.selectOption({ label: 'RDF/XML' });
    await expect(page.getByTestId('source-code')).toContainText('rdf:RDF');
  });

  test('a published release, Settings and Appearance carry no repository or internal details', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signInAsPersona(page, 'Priya Shah');
    const releases = (await (await page.request.get(`/api/ontologies/${demo.id}/releases`)).json()) as { id: string; status: string }[];
    const published = releases.find((r) => r.status === 'published');
    if (published) {
      await page.goto(`/o/${demo.id}/releases/${published.id}`);
      await settle(page);
      await expect(page.locator('main')).not.toContainText('USE_CASES.md');
    }
    // A demo account's sign-in is "Demo account", not its internal id.
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Ways to sign in' })).toBeVisible();
    await expect(page.getByText('Demo account', { exact: true })).toBeVisible();
    await expect(page.locator('main')).not.toContainText('persona:');
    await expect(page.locator('main')).not.toContainText('runs without a Solid server');
    await page.goto('/appearance');
    await expect(page.locator('main')).not.toContainText('?look=');
  });
});
