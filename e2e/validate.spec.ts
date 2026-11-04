import fs from 'node:fs';
import { expect, expectNoCrash, signIn, test, type Page } from './fixtures';

/**
 * The validator: paste or upload RDF data and check it against the ontology's
 * SHACL shapes and terms, through the same POST to the ontology IRI that other
 * tools use. Also covers that API and SHACL by content negotiation, through
 * the web origin (the dev and preview proxies, like Vercel's).
 */

const VOL = 'https://w3id.org/odi/volunteering#';
const report = (page: Page) => page.getByTestId('validation-report');

async function setEditor(page: Page, text: string) {
  await page.getByTestId('validate-editor').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
}

test.describe('Validate data', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, { name: 'E2E validator', role: 'editor' });
  });

  test('is under Explore, and the example finds a missing value, a wrong type and a misspelt term', async ({ page }) => {
    await page.goto('/o/volunteering/browse');
    await page.getByRole('navigation', { name: 'Explore pages' }).getByRole('link', { name: 'Validate data' }).click();
    await expect(page).toHaveURL(/\/o\/volunteering\/validate$/);
    await expect(page.getByLabel('Version to validate against')).toHaveValue('1.0.0');
    await expect(page.getByRole('button', { name: 'Validate', exact: true })).toBeDisabled();

    await page.getByRole('button', { name: 'Try an example' }).click();
    await expect(page.getByLabel('Data format')).toContainText('Detect format (Turtle)');
    await page.getByRole('button', { name: 'Validate', exact: true }).click();

    await expect(report(page)).toBeVisible();
    await expect(page.getByTestId('validation-verdict')).toContainText(/\d+ violations?/);
    await expect(page.getByTestId('validation-verdict')).toContainText('1 term issue');
    const results = page.getByTestId('validation-results');
    await expect(results).toContainText('ex:saturday-shift');
    await expect(results).toContainText('vol:hasRole');
    await expect(results).toContainText('min count');
    await expect(results).toContainText('vol:minimumAge');
    await expect(results).toContainText('value "sixteen"');
    await expect(page.getByTestId('validation-terms')).toContainText('vol:sumary is used as a property but is not defined in the ontology. Did you mean vol:summary?');
    await expect(results).toContainText('VolunteeringOpportunityShape');
    await expectNoCrash(page);

    // Editing the data clears the stale report.
    await setEditor(page, '@prefix vol: <https://w3id.org/odi/volunteering#> .\n<https://example.org/r> a vol:Role .\n');
    await expect(report(page)).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(page.getByTestId('validation-verdict')).toContainText('Conforms to the shapes');
    await expect(page.getByTestId('validation-verdict')).toContainText('Every term is defined');
    await expect(page.getByTestId('validation-subtitle')).toHaveText('1 triple checked against v1.0.0');
  });

  test('uploads a file, validates against the draft and downloads both reports', async ({ page }, info) => {
    await page.goto('/o/volunteering/validate');
    const file = info.outputPath('opportunity.jsonld');
    fs.writeFileSync(
      file,
      JSON.stringify({
        '@context': { vol: VOL, ex: 'https://example.org/' },
        '@graph': [{ '@id': 'ex:opp', '@type': 'vol:VolunteeringOpportunity', 'vol:title': 'Beach clean' }],
      }),
    );
    await page.getByTestId('validate-file').setInputFiles(file);
    await expect(page.getByLabel('Data format')).toHaveValue('jsonld');
    await expect(page.getByTestId('validate-editor')).toContainText('Beach clean');

    await page.getByLabel('Version to validate against').selectOption('draft');
    await expect(page).toHaveURL(/version=draft/);
    await page.getByRole('button', { name: 'Validate', exact: true }).click();
    await expect(page.getByTestId('validation-subtitle')).toHaveText('2 triples checked against the working draft');
    await expect(page.getByTestId('validation-results')).toContainText('vol:offeredBy');

    const json = page.waitForEvent('download');
    await page.getByRole('button', { name: 'JSON', exact: true }).click();
    const jsonFile = await (await json).path();
    const parsed = JSON.parse(fs.readFileSync(jsonFile!, 'utf8'));
    expect(parsed).toMatchObject({ version: 'draft', conforms: false });

    const ttl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'SHACL report (Turtle)' }).click();
    const download = await ttl;
    expect(download.suggestedFilename()).toBe('volunteering-draft-report.ttl');
    const text = fs.readFileSync((await download.path())!, 'utf8');
    expect(text).toContain('sh:ValidationReport');
    expect(text).toContain('sh:conforms false');
  });

  test('drops an answer that arrives after the data or version changed', async ({ page }) => {
    await page.goto('/o/volunteering/validate');
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    await page.route('**/def/volunteering/**', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await held;
      await route.continue();
    });
    await page.getByRole('button', { name: 'Try an example' }).click();
    await page.getByRole('button', { name: 'Validate', exact: true }).click();
    // While that request is out, switch to the draft.
    await page.getByLabel('Version to validate against').selectOption('draft');
    release();
    await page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/def/volunteering/'));
    await expect(report(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Validate', exact: true })).toBeEnabled();
    await page.unroute('**/def/volunteering/**');

    // Validating again reports against the draft; changing the version clears that report, so downloads always match it.
    await page.getByRole('button', { name: 'Validate', exact: true }).click();
    await expect(page.getByTestId('validation-subtitle')).toContainText('the working draft');
    await page.getByLabel('Version to validate against').selectOption('1.0.0');
    await expect(report(page)).toHaveCount(0);
  });

  test('explains data it cannot read', async ({ page, consoleGuard }) => {
    consoleGuard.allow(/status of 400/);
    await page.goto('/o/volunteering/validate');
    await setEditor(page, '@prefix vol: <https://w3id.org/odi/volunteering#> .\nvol:x vol:y');
    await page.getByRole('button', { name: 'Validate', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Could not parse the data as Turtle' })).toBeVisible();
    await expect(report(page)).toHaveCount(0);
  });

  test('shows how to call the API at the ontology address', async ({ page, baseURL }) => {
    await page.goto('/o/volunteering/validate');
    await page.getByRole('button', { name: /Validate from your own code/ }).click();
    const examples = page.getByTestId('validate-api-example');
    await expect(examples.first()).toContainText(`curl -X POST ${baseURL}/def/volunteering/1.0.0`);
    await expect(examples.nth(2)).toContainText("Accept-Profile: <http://www.w3.org/ns/shacl#>");
    await page.getByRole('link', { name: 'connecting an agent' }).click();
    await expect(page).toHaveURL(/\/o\/volunteering\/connect$/);
  });
});

test.describe('Validation API at the ontology IRI', () => {
  test('POST validates through the site, and the SHACL profile returns the shapes', async ({ request }) => {
    const ok = await request.post('/def/volunteering', { headers: { 'Content-Type': 'text/turtle' }, data: `<https://example.org/r> a <${VOL}Role> .` });
    expect(ok.status()).toBe(200);
    expect(await ok.json()).toMatchObject({ conforms: true, valid: true, version: '1.0.0', triples: 1 });
    expect(ok.headers()['access-control-allow-origin']).toBe('*');

    const bad = await request.post('/def/volunteering/1.0.0', { headers: { 'Content-Type': 'text/turtle', Accept: 'text/turtle' }, data: `<https://example.org/o> a <${VOL}VolunteeringOpportunity> .` });
    expect(bad.headers()['content-type']).toContain('text/turtle');
    expect(await bad.text()).toContain('sh:MinCountConstraintComponent');

    const shapes = await request.get('/def/volunteering/1.0.0', { headers: { 'Accept-Profile': '<http://www.w3.org/ns/shacl#>' } });
    expect(shapes.headers()['content-profile']).toBe('<http://www.w3.org/ns/shacl#>');
    expect(await shapes.text()).toContain('sh:NodeShape');
  });

  test('the public page explains validation and links to the validator', async ({ page }) => {
    await page.goto('/def/volunteering/1.0.0');
    await page.getByRole('tab', { name: 'Download and cite' }).click();
    const section = page.locator('#validate');
    await expect(section.getByRole('heading', { name: 'Validate data' })).toBeVisible();
    await expect(section).toContainText('curl -X POST');
    await expect(section.getByRole('link', { name: 'upload a file in the validator' })).toHaveAttribute('href', /\/o\/volunteering\/validate\?version=1\.0\.0$/);
  });
});
