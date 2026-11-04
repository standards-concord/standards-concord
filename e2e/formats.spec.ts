import { test, expect, settle, signIn, demoOntology } from './fixtures';

/**
 * The Formats tab: every serialisation renders in a highlighted code view,
 * with the right grammar, and can be searched, copied and downloaded.
 */

const FORMATS = [
  { tab: 'Turtle', id: 'turtle', language: 'turtle', text: '@prefix vol:', tokens: ['tok-meta', 'tok-iri', 'tok-prefix', 'tok-name', 'tok-keyword', 'tok-string'] },
  { tab: 'RDF/XML', id: 'rdfxml', language: 'xml', text: '<rdf:RDF', tokens: ['tok-tag', 'tok-attr', 'tok-string'] },
  { tab: 'JSON-LD', id: 'jsonld', language: 'json', text: '"@context"', tokens: ['tok-attr', 'tok-string'] },
  { tab: 'N-Triples', id: 'ntriples', language: 'ntriples', text: '<http://www.w3.org/1999/02/22-rdf-syntax-ns#type>', tokens: ['tok-iri', 'tok-punct'] },
  { tab: 'Manchester', id: 'manchester', language: 'manchester', text: 'Prefix:', tokens: ['tok-meta', 'tok-iri', 'tok-name'] },
  { tab: 'LinkML', id: 'linkml', language: 'yaml', text: 'classes:', tokens: ['tok-attr'] },
  { tab: 'SHACL', id: 'shacl', language: 'turtle', text: '@prefix sh:', tokens: ['tok-meta', 'tok-iri', 'tok-name'] },
] as const;

test.describe('Formats tab', () => {
  let ontologyId: string;
  test.beforeEach(async ({ page, request }) => {
    await signIn(page, { name: 'E2E formats', role: 'editor' });
    ontologyId = (await demoOntology(request)).id;
  });

  for (const f of FORMATS) {
    test(`${f.tab} is highlighted as ${f.language}`, async ({ page }) => {
      await page.goto(`/o/${ontologyId}/source`);
      await page.getByRole('tablist', { name: 'Format' }).getByRole('tab', { name: f.tab, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`format=${f.id}`));
      const code = page.getByTestId('source-code');
      await expect(code).toBeVisible();
      await expect(code).toContainText(f.text);
      await expect(code).toHaveAttribute('data-language', f.language);
      for (const cls of f.tokens) await expect(code.locator(`.${cls}`).first(), `a .${cls} token`).toBeVisible();
      // Read-only: typing must not change the source.
      await code.click();
      await page.keyboard.type('zzz');
      await expect(code).not.toContainText('zzz');
    });
  }

  test('search, folding, copy and download work', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`/o/${ontologyId}/source?format=turtle`);
    const code = page.getByTestId('source-code');
    await expect(code).toContainText('@prefix');

    // Ctrl/⌘-F opens CodeMirror's search panel inside the view.
    await code.click();
    await page.keyboard.press('ControlOrMeta+f');
    const search = page.getByRole('textbox', { name: 'Find' });
    await expect(search).toBeVisible();
    await search.pressSequentially('VolunteeringOpportunity');
    await page.keyboard.press('Enter');
    await expect(page.locator('.cm-searchMatch').first()).toBeVisible();
    await page.keyboard.press('Escape');

    // Subject blocks fold from the gutter.
    const lines = await page.locator('.cm-line').count();
    await page.locator('.cm-foldGutter [title="Fold line"]').first().click();
    await expect(page.locator('.cm-foldPlaceholder').first()).toBeVisible();
    expect(await page.locator('.cm-line').count()).toBeLessThan(lines);

    await page.getByRole('button', { name: /copy/i }).first().click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('@prefix');

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download' }).click();
    expect((await download).suggestedFilename()).toMatch(/\.ttl$/);
  });

  test('a published release renders too', async ({ page, request }) => {
    const releases = (await (await page.request.get(`/api/ontologies/${ontologyId}/releases`)).json()) as { version: string; status: string }[];
    const published = releases.find((r) => r.status === 'published');
    test.skip(!published, 'no published release in the demo data');
    await page.goto(`/o/${ontologyId}/source?format=manchester&ref=${published!.version}`);
    await settle(page);
    await expect(page.getByTestId('source-code')).toContainText(`Ontology: <https://w3id.org/odi/volunteering> <https://w3id.org/odi/volunteering/${published!.version}>`);
  });
});
