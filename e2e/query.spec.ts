import { test, expect, signIn, demoOntology, type Page } from './fixtures';

/**
 * The Query tab: sparq (WebAssembly) loads in the browser, the visual builder
 * builds and runs queries over the ontology plus sample data, the SPARQL editor
 * highlights, autocompletes and runs every query form, and SHACL checks run.
 */

async function setEditor(page: Page, testId: string, text: string) {
  await page.getByTestId(testId).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
}

const results = (page: Page) => page.getByTestId('query-results');
const run = (page: Page) => page.getByRole('button', { name: 'Run', exact: true }).click();

test.describe('Query tab', () => {
  test.beforeEach(async ({ page, request }) => {
    await signIn(page, { name: 'E2E query', role: 'editor' });
    const { id } = await demoOntology(request);
    const wasm = page.waitForResponse((r) => r.url().endsWith('.wasm'));
    await page.goto(`/o/${id}/query`);
    // The engine's .wasm must be served as WebAssembly, not the app's index.html
    // (the "expected magic word 00 61 73 6d" bug).
    const r = await wasm;
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toContain('application/wasm');
    await expect(page.getByTestId('sparq-ready')).toHaveText(/[\d,]+ triples loaded in \d+ ms/, { timeout: 30_000 });
    await expect(page.getByText(/magic word|WebAssembly.instantiate/)).toHaveCount(0);
  });

  test('the visual builder runs its starting query over the sample data', async ({ page }) => {
    await expect(page.getByRole('tab', { name: 'Visual builder' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByLabel('Class to find')).toHaveValue(/VolunteeringOpportunity$/);
    await expect(page.getByTestId('query-diagram')).toContainText('volunteering opportunity');
    await run(page);
    await expect(results(page)).toContainText('2 rows');
    await expect(results(page)).toContainText('Saturday food bank shift');
    await expect(results(page)).toContainText('Park clean-up');
  });

  test('following a relationship, filtering, sorting and counting', async ({ page }) => {
    await page.getByLabel('Add a property', { exact: true }).selectOption({ label: 'offered by →' });
    await page.getByLabel('Add a property of offered by').selectOption({ label: 'label' });
    await expect(page.getByTestId('builder-step')).toHaveCount(3);
    const diagram = page.getByTestId('query-diagram');
    await expect(diagram).toContainText('organisation');
    await expect(diagram).toContainText('?offeredBy_label');
    await expect(page.getByText('The SPARQL this builds').locator('..').locator('..')).toContainText('?offeredBy rdfs:label ?offeredBy_label');

    await run(page);
    await expect(results(page)).toContainText('Northvale Food Bank');
    await expect(results(page).locator('th')).toHaveText(['?volunteeringOpportunity', '?title', '?offeredBy', '?offeredBy_label']);

    // Filter the title: a filtered property becomes required.
    const title = page.getByTestId('builder-step').filter({ hasText: 'title' }).first();
    await title.getByLabel('Filter', { exact: true }).selectOption('contains');
    await title.getByLabel('Filter value').fill('PARK');
    await expect(title.getByRole('switch', { name: 'Optional' })).toBeDisabled();
    await run(page);
    await expect(results(page)).toContainText('1 row');
    await expect(results(page)).toContainText('Park clean-up');
    await expect(results(page)).not.toContainText('Saturday');

    // Hide a column.
    await page.getByTestId('builder-step').filter({ hasText: 'offered by' }).first().getByRole('switch', { name: 'Column' }).first().click();
    await run(page);
    await expect(results(page).locator('th')).toHaveText(['?volunteeringOpportunity', '?title', '?offeredBy_label']);

    // Remove the filter, sort descending, then count.
    await title.getByLabel('Filter', { exact: true }).selectOption('');
    await page.getByLabel('Sort by').selectOption({ label: '?title' });
    await page.getByRole('switch', { name: 'Descending' }).click();
    await run(page);
    await expect(results(page).locator('tbody tr').first()).toContainText('Saturday food bank shift');
    await page.getByRole('switch', { name: 'Count only' }).click();
    await run(page);
    await expect(results(page).locator('th')).toHaveText(['?count']);
    await expect(results(page).locator('tbody td')).toHaveText('2');

    // Removing a step removes it from the query.
    await page.getByRole('button', { name: 'Remove offered by' }).click();
    await expect(page.getByTestId('builder-step')).toHaveCount(1);
  });

  test('the builder hands its query to the SPARQL editor', async ({ page }) => {
    await page.getByRole('button', { name: 'Edit as SPARQL' }).click();
    await expect(page).toHaveURL(/mode=sparql/);
    await expect(page.getByTestId('sparql-editor')).toContainText('a/rdfs:subClassOf* vol:VolunteeringOpportunity');
    await expect(page.getByLabel('Run against')).toHaveValue('data');
    await run(page);
    await expect(results(page)).toContainText('Park clean-up');
  });

  test('the SPARQL editor highlights, autocompletes and runs with Ctrl/⌘-Enter', async ({ page }) => {
    await page.getByRole('tab', { name: 'SPARQL' }).click();
    const editor = page.getByTestId('sparql-editor');
    await expect(editor.locator('.tok-keyword', { hasText: 'SELECT' })).toBeVisible();
    await expect(editor.locator('.tok-variable').first()).toBeVisible();
    await expect(editor.locator('.tok-iri').first()).toBeVisible();

    // The default query lists the classes.
    await editor.click();
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(results(page)).toContainText('vol:VolunteeringOpportunity');
    expect(await results(page).locator('tbody tr').count()).toBeGreaterThan(5);

    // Autocomplete offers the ontology's terms with their labels.
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('\n# vol:Volunt');
    const option = page.locator('.cm-tooltip-autocomplete li', { hasText: 'vol:VolunteeringOpportunity' });
    await expect(option).toBeVisible();
    await expect(option).toContainText('volunteering opportunity');
    await option.click();
    await expect(editor).toContainText('# vol:VolunteeringOpportunity');
  });

  test('every query form: ASK, CONSTRUCT, examples and errors', async ({ page }) => {
    await page.getByRole('tab', { name: 'SPARQL' }).click();

    await page.getByLabel('Example queries').selectOption({ label: 'Does every class have a label?' });
    await run(page);
    await expect(page.getByTestId('query-answer')).toHaveText(/Answer: (yes|no)/);

    await setEditor(page, 'sparql-editor', 'PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>\nCONSTRUCT { ?c rdfs:label ?l } WHERE { ?c rdfs:label ?l } LIMIT 3');
    await run(page);
    await expect(page.getByTestId('query-graph')).toContainText('3 triples');

    await page.getByLabel('Example queries').selectOption({ label: 'Instances by type (sample data)' });
    await expect(page.getByLabel('Run against')).toHaveValue('data');
    await run(page);
    await expect(results(page)).toContainText('VolunteeringOpportunity');

    for (const ex of ['Class hierarchy', 'Relationships (object properties)', 'Attributes (datatype properties)', 'Terms missing a definition', 'Deprecated terms']) {
      await page.getByLabel('Example queries').selectOption({ label: ex });
      await run(page);
      await expect(results(page), ex).toBeVisible();
    }

    await setEditor(page, 'sparql-editor', 'SELECT ?x WHERE { ?x ?y }');
    await run(page);
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(results(page)).toHaveCount(0);
  });

  test('the sample data is highlighted and checked against SHACL', async ({ page }) => {
    // One workspace at a time: the data checker is behind "Check data".
    await expect(page.getByTestId('data-editor')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Check data' }).click();
    await expect(page).toHaveURL(/view=check/);
    await expect(page.getByTestId('query-builder')).toHaveCount(0);
    const data = page.getByTestId('data-editor');
    await expect(data.locator('.tok-meta', { hasText: '@prefix' }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Check' }).click();
    const report = page.getByTestId('shacl-report');
    await expect(report).toContainText(/\d+ problems?/);
    await expect(report).toContainText('saturday-shift');

    // Switching away and back keeps the report.
    await page.getByRole('tab', { name: 'Query ontology' }).click();
    await page.getByRole('tab', { name: 'Check data' }).click();
    await expect(report).toContainText('saturday-shift');

    // Editing the data changes what the builder finds.
    await data.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText('\nex:extra a vol:VolunteeringOpportunity ; vol:title "Library reading buddy" .\n');
    await page.getByRole('tab', { name: 'Query ontology' }).click();
    await run(page);
    await expect(results(page)).toContainText('3 rows');
    await expect(results(page)).toContainText('Library reading buddy');
  });
  test('long results are paginated', async ({ page }) => {
    await page.getByRole('tab', { name: 'SPARQL' }).click();
    await setEditor(page, 'sparql-editor', 'SELECT ?s ?p ?o WHERE { ?s ?p ?o }');
    await run(page);
    const table = results(page);
    await expect(table.locator('tbody tr')).toHaveCount(50);
    const pager = page.getByRole('navigation', { name: 'Result pages' });
    await expect(pager).toContainText(/1–50 of [\d,]+/);
    const first = await table.locator('tbody tr').first().innerText();
    await pager.getByRole('button', { name: 'Next page' }).click();
    await expect(pager).toContainText('51–100');
    expect(await table.locator('tbody tr').first().innerText()).not.toBe(first);
    await pager.getByRole('button', { name: 'Previous page' }).click();
    await expect(pager).toContainText('1–50');
  });
});
