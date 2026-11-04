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
const toggle = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const moreOptions = (page: Page) => page.getByTestId('builder-options').locator('summary').click();

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
    await expect(toggle(page, 'Visual builder')).toHaveAttribute('aria-pressed', 'true');
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
    await page.getByText('The SPARQL this builds').click();
    await expect(page.getByText('The SPARQL this builds').locator('..').locator('..')).toContainText('?offeredBy rdfs:label ?offeredBy_label');

    await run(page);
    await expect(results(page)).toContainText('Northvale Food Bank');
    // Builder results use readable headings, and show missing values as a dash.
    await expect(results(page).locator('th')).toHaveText(['volunteering opportunity', 'title', 'offered by', 'offered by › label']);

    // Filter the title: a filtered property becomes required.
    const title = page.getByTestId('builder-step').filter({ hasText: 'title' }).first();
    await title.getByLabel('Filter', { exact: true }).selectOption('contains');
    await title.getByLabel('Filter value').fill('PARK');
    await expect(title.getByRole('switch', { name: 'Keep records without it' })).toBeDisabled();
    await run(page);
    await expect(results(page)).toContainText('1 row');
    await expect(results(page)).toContainText('Park clean-up');
    await expect(results(page)).not.toContainText('Saturday');

    // Hide a column.
    await page.getByTestId('builder-step').filter({ hasText: 'offered by' }).first().getByRole('switch', { name: 'Show in results' }).first().click();
    await run(page);
    await expect(results(page).locator('th')).toHaveText(['volunteering opportunity', 'title', 'offered by › label']);

    // Remove the filter, sort descending, then count.
    await title.getByLabel('Filter', { exact: true }).selectOption('');
    await moreOptions(page);
    await page.getByLabel('Sort by').selectOption({ label: 'title' });
    await page.getByRole('switch', { name: 'Descending' }).click();
    await run(page);
    await expect(results(page).locator('tbody tr').first()).toContainText('Saturday food bank shift');
    await page.getByRole('switch', { name: /Just count/ }).click();
    await run(page);
    await expect(results(page).locator('th')).toHaveText(['Number of volunteering opportunity records']);
    await expect(results(page).locator('tbody td')).toHaveText('2');

    // Removing a step removes it from the query.
    await page.getByRole('button', { name: 'Remove offered by' }).click();
    await expect(page.getByTestId('builder-step')).toHaveCount(1);
  });

  test('a filter on a linked thing only returns records that match it', async ({ page }) => {
    await page.getByLabel('Add a property', { exact: true }).selectOption({ label: 'offered by →' });
    const org = page.getByTestId('builder-step').filter({ hasText: 'offered by' }).first();
    await page.getByLabel('Add a property of offered by').selectOption({ label: 'label' });
    const name = page.getByTestId('builder-step').filter({ hasText: 'label' }).last();
    await name.getByLabel('Filter', { exact: true }).selectOption('contains');
    await name.getByLabel('Filter value').fill('nothing matches this');
    // The whole path to the condition is now required.
    await expect(org.getByRole('switch', { name: 'Keep records without it' }).first()).toBeDisabled();
    await run(page);
    await expect(results(page)).toContainText('0 rows');
    await name.getByLabel('Filter value').fill('northvale');
    await run(page);
    await expect(results(page)).toContainText('2 rows');
  });

  test('changing the question marks the old answer as stale', async ({ page }) => {
    await run(page);
    await expect(results(page)).toContainText('2 rows');
    await expect(page.getByTestId('result-stale')).toHaveCount(0);
    await page.getByLabel('Add a property', { exact: true }).selectOption({ label: 'minimum age' });
    await expect(page.getByTestId('result-stale')).toBeVisible();
    await page.getByTestId('result-stale').getByRole('button', { name: 'Run again' }).click();
    await expect(page.getByTestId('result-stale')).toHaveCount(0);
    await expect(results(page).locator('th')).toContainText(['minimum age']);

    // The SHACL report goes stale when the data changes.
    await toggle(page, 'Check data').click();
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(page.getByTestId('shacl-report')).toBeVisible();
    await page.getByTestId('data-editor').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText('\n# edited\n');
    await expect(page.getByTestId('report-stale')).toBeVisible();
  });

  test('drafts survive leaving the page', async ({ page }) => {
    await page.getByLabel('Add a property', { exact: true }).selectOption({ label: 'minimum age' });
    await toggle(page, 'SPARQL').click();
    await setEditor(page, 'sparql-editor', 'SELECT ?x WHERE { ?x a ?y } LIMIT 1');
    const url = page.url();
    await page.getByRole('link', { name: 'Source & export', exact: true }).click();
    await page.goto(url);
    await expect(page.getByTestId('sparql-editor')).toContainText('SELECT ?x WHERE { ?x a ?y } LIMIT 1');
    await toggle(page, 'Visual builder').click();
    await expect(page.getByTestId('builder-step').filter({ hasText: 'minimum age' })).toHaveCount(1);
    // Start over sits with the builder's controls, not inside the generated code.
    await page.getByTestId('query-builder').getByRole('button', { name: 'Start over' }).click();
    await expect(page.getByTestId('builder-step').filter({ hasText: 'minimum age' })).toHaveCount(0);
  });

  test('a restored SPARQL draft keeps its dataset', async ({ page }) => {
    await page.getByText('The SPARQL this builds').click();
    await page.getByRole('button', { name: 'Edit as SPARQL' }).click();
    await expect(page.getByLabel('Run against')).toHaveValue('data');
    const url = page.url();
    await page.getByRole('link', { name: 'Source & export', exact: true }).click();
    await page.goto(url);
    await expect(page.getByLabel('Run against')).toHaveValue('data');
    await run(page);
    await expect(results(page)).toContainText('Park clean-up');
  });

  test('each ontology keeps its own drafts, even when the page is reused', async ({ page }) => {
    const draftA = 'SELECT ?a WHERE { ?a ?b ?c } # draft A';
    await toggle(page, 'SPARQL').click();
    await setEditor(page, 'sparql-editor', draftA);
    const a = new URL(page.url()).pathname;
    const created = await page.request.post('/api/ontologies', { data: { title: `E2E second ${Date.now()}`, prefix: 'sec', description: 'Second ontology for draft isolation' } });
    expect(created.ok(), await created.text()).toBeTruthy();
    const b = (await created.json()) as { id: string };
    // Client-side navigation to the other ontology's Query page, so React may reuse the component.
    await page.evaluate((to) => {
      history.pushState(null, '', to);
      dispatchEvent(new PopStateEvent('popstate'));
    }, `/o/${b.id}/query?mode=sparql`);
    await expect(page).toHaveURL(new RegExp(`/o/${b.id}/query`));
    const editor = page.getByTestId('sparql-editor');
    await expect(editor).not.toContainText('draft A');
    await setEditor(page, 'sparql-editor', 'SELECT ?b WHERE { ?b ?p ?o } # draft B');
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${a}`));
    await expect(editor).toContainText('draft A');
    const stored = await page.evaluate(([idA, idB]) => [localStorage.getItem(`concord.query.${idA}.sparql`), localStorage.getItem(`concord.query.${idB}.sparql`)], [a.split('/')[2], b.id]);
    expect(stored[0]).toContain('draft A');
    expect(stored[1]).toContain('draft B');
  });

  test('requiring a nested property requires the path to it', async ({ page }) => {
    await page.getByLabel('Add a property', { exact: true }).selectOption({ label: 'offered by →' });
    await page.getByLabel('Add a property of offered by').selectOption({ label: 'label' });
    const org = page.getByTestId('builder-step').filter({ hasText: 'offered by' }).first();
    const name = page.getByTestId('builder-step').filter({ hasText: 'label' }).last();
    await name.getByRole('switch', { name: 'Keep records without it' }).click();
    // The label's own control stays editable; the relationship above it is now required.
    await expect(name.getByRole('switch', { name: 'Keep records without it' })).toBeEnabled();
    await expect(org.getByRole('switch', { name: 'Keep records without it' }).first()).toBeDisabled();
    await page.getByText('The SPARQL this builds').click();
    await expect(page.getByText('The SPARQL this builds').locator('..').locator('..')).not.toContainText('OPTIONAL {\n    ?volunteeringOpportunity vol:offeredBy');
    // Sorting names each column by its path.
    await moreOptions(page);
    await expect(page.getByLabel('Sort by').locator('option', { hasText: 'offered by › label' })).toHaveCount(1);
  });

  test('the query shows which data it runs over, with a shortcut to edit it', async ({ page }) => {
    await expect(page.getByTestId('dataset-summary')).toContainText(/Runs over the ontology plus \d+ sample records/);
    await page.getByTestId('dataset-summary').getByRole('button', { name: 'Edit sample data' }).click();
    await expect(toggle(page, 'Check data')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('data-editor')).toBeVisible();
  });

  test('the builder hands its query to the SPARQL editor', async ({ page }) => {
    await page.getByText('The SPARQL this builds').click();
    await page.getByRole('button', { name: 'Edit as SPARQL' }).click();
    await expect(page).toHaveURL(/mode=sparql/);
    await expect(page.getByTestId('sparql-editor')).toContainText('a/rdfs:subClassOf* vol:VolunteeringOpportunity');
    await expect(page.getByLabel('Run against')).toHaveValue('data');
    await run(page);
    await expect(results(page)).toContainText('Park clean-up');
  });

  test('the SPARQL editor highlights, autocompletes and runs with Ctrl/⌘-Enter', async ({ page }) => {
    await toggle(page, 'SPARQL').click();
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

    // Accepting a term whose prefix isn't declared adds the declaration, and labels find terms too.
    await setEditor(page, 'sparql-editor', 'SELECT * WHERE { ?x a volunteering');
    await page.keyboard.press('Control+Space');
    const byLabel = page.locator('.cm-tooltip-autocomplete li', { hasText: 'volunteering opportunity → vol:VolunteeringOpportunity' });
    await expect(byLabel).toBeVisible();
    await byLabel.click();
    await expect(editor).toContainText('PREFIX vol: <https://w3id.org/odi/volunteering#>');
    await expect(editor).toContainText('?x a vol:VolunteeringOpportunity');

    // A commented-out or differently cased declaration doesn't count; a conflicting one gets the full IRI.
    for (const [doc, expected] of [
      ['# PREFIX vol: <https://w3id.org/odi/volunteering#>\nSELECT * WHERE { ?x a volunteering', 'PREFIX vol: <https://w3id.org/odi/volunteering#>\n#'],
      ['PREFIX VOL: <https://other.example/>\nSELECT * WHERE { ?x a volunteering', 'PREFIX vol: <https://w3id.org/odi/volunteering#>\nPREFIX VOL:'],
      ['PREFIX vol: <https://other.example/>\nSELECT * WHERE { ?x a volunteering', '?x a <https://w3id.org/odi/volunteering#VolunteeringOpportunity>'],
    ]) {
      await setEditor(page, 'sparql-editor', doc);
      await page.keyboard.press('Control+Space');
      await byLabel.click();
      expect(await editor.evaluate((el) => (el as HTMLElement).innerText.replace(/\u00a0/g, ' '))).toContain(expected);
    }
  });

  test('every query form: ASK, CONSTRUCT, examples and errors', async ({ page }) => {
    await toggle(page, 'SPARQL').click();

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
    await toggle(page, 'Check data').click();
    await expect(page).toHaveURL(/view=check/);
    await expect(page.getByTestId('query-builder')).toHaveCount(0);
    const data = page.getByTestId('data-editor');
    await expect(data.locator('.tok-meta', { hasText: '@prefix' }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    const report = page.getByTestId('shacl-report');
    await expect(report).toContainText(/\d+ problems?/);
    await expect(report).toContainText('saturday-shift');

    // Switching away and back keeps the report.
    await toggle(page, 'Query ontology').click();
    await toggle(page, 'Check data').click();
    await expect(report).toContainText('saturday-shift');

    // Editing the data changes what the builder finds.
    await data.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText('\nex:extra a vol:VolunteeringOpportunity ; vol:title "Library reading buddy" .\n');
    await toggle(page, 'Query ontology').click();
    await run(page);
    await expect(results(page)).toContainText('3 rows');
    await expect(results(page)).toContainText('Library reading buddy');
  });
  test('long results are paginated', async ({ page }) => {
    await toggle(page, 'SPARQL').click();
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
