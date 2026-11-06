import fs from 'node:fs';
import { expect, expectNoCrash, signIn, test, type Page } from './fixtures';

/**
 * The validator: paste or upload RDF data and check it against the ontology's
 * SHACL shapes and terms. The page checks in the browser (sparq in a Web
 * Worker), the same check as the POST to the ontology IRI that other tools use. Also covers that API and SHACL by content negotiation, through
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

  test('is under Explore, and starts with the sample data, checked: a missing value, a wrong type and a misspelt term', async ({ page }) => {
    await page.goto('/o/volunteering/browse');
    await page.getByRole('navigation', { name: 'Explore pages' }).getByRole('link', { name: 'Validate data' }).click();
    await expect(page).toHaveURL(/\/o\/volunteering\/validate$/);
    await expect(page.getByLabel('Version to validate against')).toHaveValue('1.0.0');
    // There is no Validate button: the data is checked as soon as there is any, and again on each change.
    await expect(page.getByRole('button', { name: 'Validate', exact: true })).toHaveCount(0);

    // The sample data (the records Query runs over; it used to be under Query → Check data) is there, and checked at once.
    await expect(page.getByTestId('validate-editor')).toContainText('Northvale Food Bank');
    await expect(page.getByLabel('Data format')).toContainText('Detect format (Turtle)');
    await expect(report(page)).toBeVisible();
    await expect(page.getByTestId('validation-verdict')).toContainText(/\d+ violations?/);
    await expect(page.getByTestId('validation-verdict')).toContainText('1 term issue');
    const results = page.getByRole('list', { name: 'Problems found' });
    await expect(results.getByRole('button', { name: /ex:saturday-shift requires at least 1 vol:hasRole, 0 found/ })).toBeVisible();
    const age = results.getByRole('button', { name: /Value "sixteen" is of type xsd:string but must be of type xsd:nonNegativeInteger/ });
    await expect(age).toContainText('Line 17');
    const typo = page.getByTestId('validation-terms').getByRole('button', { name: /vol:sumary is used as a property but is not defined in the ontology\. Did you mean vol:summary\?/ });
    await expect(typo).toContainText('Line 18');
    // Problems are underlined in the editor.
    await expect(page.getByTestId('validate-editor').locator('.cm-lintRange-error', { hasText: 'vol:sumary' })).toHaveCount(1);
    await expectNoCrash(page);
    // Reset to the sample is off until the data differs from it.
    await expect(page.getByRole('button', { name: 'Reset to the sample' })).toBeDisabled();

    // Editing the data checks it again in the background; the new report replaces the old one.
    await setEditor(page, '@prefix vol: <https://w3id.org/odi/volunteering#> .\n<https://example.org/r> a vol:Role .\n');
    await expect(page.getByTestId('validation-verdict')).toContainText('Conforms to the shapes');
    await expect(page.getByTestId('validate-status')).toHaveText(/^Checked in (<1|\d+) ms$/);
    await expect(page.getByTestId('validation-verdict')).toContainText('Every term is defined');
    await expect(page.getByTestId('validation-subtitle')).toHaveText('1 triple checked against v1.0.0');

    // The edit is kept, as the sample data Query runs over, until it's reset.
    await page.reload();
    await expect(page.getByTestId('validate-editor')).toContainText('<https://example.org/r> a vol:Role');
    await page.getByRole('button', { name: 'Reset to the sample' }).click();
    await expect(page.getByTestId('validate-editor')).toContainText('Northvale Food Bank');
    await expect(page.getByTestId('validation-verdict')).toContainText('1 term issue');
  });

  test('says when the report lists only the first 1,000 results, and counts them all', async ({ page }) => {
    await page.goto('/o/volunteering/validate');
    // 700 opportunities, each without a role or an organisation: 1,400 violations.
    const data = `@prefix vol: <${VOL}> .\n@prefix ex: <https://example.org/> .\n${Array.from({ length: 700 }, (_, i) => `ex:o${i} a vol:VolunteeringOpportunity ; vol:title "t" .`).join('\n')}\n`;
    await setEditor(page, data);
    await expect(page.getByTestId('validation-verdict')).toContainText('1,400 violations');
    await expect(page.getByTestId('validation-truncated')).toHaveText('The report lists the first 1,000 results and term issues. The counts above include them all.');
    await expectNoCrash(page);
  });

  test('counts every term issue and says when the list is cut short, with no shape results', async ({ page }) => {
    await page.goto('/o/volunteering/validate');
    // 1,200 properties in the ontology's namespace that it doesn't define: term errors only.
    const data = `@prefix vol: <${VOL}> .\n${Array.from({ length: 1200 }, (_, i) => `<https://example.org/x> vol:undefined${i} "v" .`).join('\n')}\n`;
    await setEditor(page, data);
    await expect(page.getByTestId('validation-verdict')).toContainText('1,200 term issues');
    await expect(page.getByTestId('validation-truncated')).toBeVisible();
    await expect(page.getByTestId('validation-terms').getByRole('listitem')).toHaveCount(1000);
    await expect(page.getByTestId('validation-results')).toHaveCount(0);
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
    // Hold the release's ontology download, which the in-browser check waits for.
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const releaseSource = /\/api\/ontologies\/[^/]+\/source\?.*ref=1\.0\.0/;
    await page.route(releaseSource, async (route) => {
      await held;
      await route.continue();
    });
    // The sample data is checked as soon as the page opens, and that check waits for the download.
    await page.goto('/o/volunteering/validate');
    await expect(page.getByTestId('validate-status')).toHaveText('Checking…');
    // While that check waits, switch to the draft: it is checked against the draft at once.
    await page.getByLabel('Version to validate against').selectOption('draft');
    await expect(page.getByTestId('validation-subtitle')).toContainText('the working draft');
    // The release's answer, arriving late, never replaces it.
    release();
    await page.waitForResponse((r) => releaseSource.test(r.url()));
    await page.waitForTimeout(300);
    await expect(page.getByTestId('validation-subtitle')).toContainText('the working draft');
    await page.unroute(releaseSource);

    // Back on the release, the draft's report stays only faded, with downloads off, until the new check answers.
    await page.getByLabel('Version to validate against').selectOption('1.0.0');
    await expect(page.getByTestId('validation-subtitle')).toHaveText(/checked against v1\.0\.0/);
    await expect(page.getByRole('button', { name: 'JSON', exact: true })).toBeEnabled();
  });

  // Used to go wrong (about 1 run in 10 on the production build): switching version first re-ran the old
  // version's check, and its answer, landing before the new check had started, marked the page as
  // checked, so the status said nothing while the draft was still being checked.
  test('while data is checked again, the old report is faded and can’t be downloaded', async ({ page }) => {
    await page.goto('/o/volunteering/validate');
    await expect(page.getByTestId('validate-status')).toHaveText(/^Checked in/);
    // Hold the worker's next answer by holding its ontology download for the draft.
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    await page.route(/\/api\/ontologies\/[^/]+\/source\?.*ref=working/, async (route) => {
      await held;
      await route.continue();
    });
    await page.getByLabel('Version to validate against').selectOption('draft');
    await expect(report(page)).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('button', { name: 'JSON', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'SHACL report (Turtle)' })).toBeDisabled();
    await expect(page.getByTestId('validate-status')).toHaveText('Checking…');
    release();
    await expect(page.getByTestId('validation-subtitle')).toContainText('the working draft');
    await expect(report(page)).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('button', { name: 'JSON', exact: true })).toBeEnabled();
  });

  test('checks the data in this browser: nothing is sent, and it works with the server gone', async ({ page, consoleGuard }) => {
    // The page used to POST the data to the server to check it. That also meant a version held for
    // privacy review (whose public reads answer 503 "being reviewed") couldn't be checked even by its
    // own working group: now only the signed-in ontology download is needed, and then nothing at all.
    consoleGuard.allow(/Failed to load resource|ERR_FAILED|ERR_INTERNET_DISCONNECTED/);
    await page.goto('/o/volunteering/validate');
    await expect(page.getByText('Your data is checked here in your browser as you type, and never leaves this device.')).toBeVisible();
    const marker = `private-${Date.now()}`;
    await setEditor(page, `@prefix vol: <${VOL}> .\n<https://example.org/${marker}> a vol:Role .\n`);
    // Give the version's ontology and shapes time to download, then cut the server off.
    await page.waitForLoadState('networkidle');
    const sent: string[] = [];
    await page.route('**/*', async (route) => {
      const r = route.request();
      if (r.method() !== 'GET' || (r.postData() ?? '').includes(marker) || r.url().includes(marker)) sent.push(`${r.method()} ${r.url()}`);
      if (r.url().includes('/api/') || r.url().includes('/def/')) return route.abort('internetdisconnected');
      return route.continue();
    });
    // Typing checks it again, with the server gone.
    await page.getByTestId('validate-editor').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText(`<https://example.org/${marker}-2> a vol:Role .\n`);
    await expect(page.getByTestId('validation-subtitle')).toHaveText('2 triples checked against v1.0.0');
    await expect(page.getByTestId('validation-verdict')).toContainText('Conforms to the shapes');
    // The Turtle report is written here too.
    const ttl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'SHACL report (Turtle)' }).click();
    expect(fs.readFileSync((await (await ttl).path())!, 'utf8')).toContain('sh:conforms true');
    expect(sent).toEqual([]);
  });

  test('a file still being read never shows the report for other data', async ({ page }, info) => {
    // Hold every File.text() until the test lets it go.
    await page.addInitScript(() => {
      const w = window as unknown as { releaseFileRead: () => void };
      let release: () => void = () => {};
      let held = new Promise<void>((r) => (release = r));
      w.releaseFileRead = () => {
        release();
        held = new Promise<void>((r) => (release = r));
      };
      const text = File.prototype.text;
      File.prototype.text = async function (this: File) {
        if (this.name.startsWith('held-')) await held;
        return text.call(this);
      };
    });
    await page.goto('/o/volunteering/validate');
    const big = info.outputPath('held-big.ttl');
    let body = '@prefix vol: <https://w3id.org/odi/volunteering#> .\n';
    for (let i = 0; body.length < 600 * 1024; i++) body += `<https://example.org/r${i}> a vol:Role .\n`;
    fs.writeFileSync(big, body);
    const status = page.getByTestId('validate-status');

    // While a large file is read, the sample data's report goes, and nothing is reported until the file is in.
    await expect(page.getByTestId('validation-verdict')).toContainText(/violation/);
    await page.getByTestId('validate-file').setInputFiles(big);
    await expect(report(page)).toHaveCount(0);
    await expect(status).toHaveText('Checking…');
    await page.evaluate(() => (window as unknown as { releaseFileRead: () => void }).releaseFileRead());
    await expect(page.getByTestId('validate-file-summary')).toContainText('held-big.ttl');
    // The file is checked as soon as it is in: its report, never the sample's.
    await expect(page.getByTestId('validation-verdict')).toContainText('Conforms to the shapes');
    await expect(page.getByTestId('validation-subtitle')).toContainText(/^[\d,]{6,} triples checked/);

    // Going back to the sample while a file is read keeps the sample.
    const small = info.outputPath('held-small.ttl');
    fs.writeFileSync(small, '<https://example.org/only-in-the-file> a <https://w3id.org/odi/volunteering#Role> .\n');
    await page.getByTestId('validate-file').setInputFiles(small);
    await expect(report(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Reset to the sample' }).click();
    await page.evaluate(() => (window as unknown as { releaseFileRead: () => void }).releaseFileRead());
    await expect(page.getByTestId('validate-editor')).toContainText('saturday-shift');
    await expect(page.getByTestId('validation-results')).toContainText('ex:saturday-shift');
    await expect(page.getByTestId('validate-editor')).not.toContainText('only-in-the-file');
  });

  // Used to go wrong: the version's ontology, once downloaded, was kept for the rest of the visit, even
  // after signing out, so the next account to sign in on this tab checked against it without the server
  // being asked whether they may read it (a version held for review is readable only by its group).
  test('after signing out, the next account downloads the ontology again', async ({ page }) => {
    await page.goto('/o/volunteering/validate');
    await expect(page.getByTestId('validate-status')).toHaveText(/^Checked in/);
    // Sign out from the account menu and in again as someone else, all without reloading the page.
    await page.getByRole('button', { name: /E2E validator/ }).click();
    await page.getByRole('navigation', { name: 'Account' }).getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    const downloads: string[] = [];
    page.on('request', (r) => {
      if (/\/api\/ontologies\/[^/]+\/source\?.*ref=1\.0\.0/.test(r.url())) downloads.push(r.url());
    });
    await page.getByRole('button', { name: 'Try the demo' }).click();
    await expect(page).not.toHaveURL(/\/login/);
    // Back to Validate data in the same page (the address bar would reload it and forget everything anyway).
    await page.evaluate(() => {
      history.pushState({}, '', '/o/volunteering/validate');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.getByTestId('validate-status')).toHaveText(/^Checked in/);
    expect(downloads.length).toBeGreaterThan(0);
  });

  // Used to go wrong: choosing "Turtle" when the format was already detected as Turtle dropped the
  // check under way and never started another, so the page said "Checking…" for good.
  test('choosing the format it already detected still checks', async ({ page }) => {
    await page.goto('/o/volunteering/validate?version=draft');
    await expect(page.getByTestId('validate-status')).toHaveText(/^Checked in/);
    // Hold the next check (it downloads the draft again) so the choice is made while it runs.
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    await page.route(/\/api\/ontologies\/[^/]+\/source\?.*ref=working/, async (route) => {
      await held;
      await route.continue();
    });
    await setEditor(page, `@prefix vol: <${VOL}> .\n<https://example.org/r> a vol:Role .\n`);
    await expect(page.getByTestId('validate-status')).toHaveText('Checking…');
    await page.getByLabel('Data format').selectOption('turtle');
    release();
    await expect(page.getByTestId('validate-status')).toHaveText(/^Checked in/);
    await expect(page.getByTestId('validation-verdict')).toContainText('Conforms to the shapes');
  });

  test('explains data it cannot read', async ({ page }) => {
    await page.goto('/o/volunteering/validate');
    await expect(page.getByTestId('validate-status')).toHaveText(/^Checked in/);
    // Half-typed Turtle: the syntax error is shown where it is, and the last report stays, faded, rather than vanishing.
    await setEditor(page, '@prefix vol: <https://w3id.org/odi/volunteering#> .\nvol:x vol:y');
    await expect(page.getByRole('list', { name: 'Problems in the Turtle' }).getByRole('button', { name: /Syntax error/ })).toContainText('Line 2');
    await expect(report(page)).toHaveAttribute('aria-busy', 'true');
    // Other formats say what's wrong as the check's error.
    await page.getByLabel('Data format').selectOption('jsonld');
    await expect(page.getByRole('alert')).toBeVisible();
  });

  // Used to go wrong: choosing a file over 5 MB showed why it was refused, then a check for the data
  // already there (set off by the choice, or still running from an edit) finished and cleared the message.
  test('a file over 5 MB is refused, and the message stays while a check finishes', async ({ page }) => {
    await page.goto('/o/volunteering/validate?version=draft');
    await expect(page.getByTestId('validate-status')).toHaveText(/^Checked in/);
    // Hold the next check (it downloads the draft again) so the file is refused while it runs.
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    await page.route(/\/api\/ontologies\/[^/]+\/source\?.*ref=working/, async (route) => {
      await held;
      await route.continue();
    });
    await setEditor(page, `@prefix vol: <${VOL}> .\n<https://example.org/r> a vol:Role .\n`);
    await expect(page.getByTestId('validate-status')).toHaveText('Checking…');
    const buffer = Buffer.alloc(5 * 1024 * 1024 + 1, ' ');
    await page.getByTestId('validate-file').setInputFiles({ name: 'too-big.ttl', mimeType: 'text/turtle', buffer });
    const refused = page.getByRole('alert').filter({ hasText: 'too-big.ttl is larger than 5 MB' });
    await expect(refused).toBeVisible();
    release();
    await expect(page.getByTestId('validate-status')).toHaveText(/^Checked in/);
    await expect(page.getByTestId('validation-verdict')).toContainText('Conforms to the shapes');
    await expect(refused).toBeVisible();
    // Editing the data again is moving on: the message goes.
    await setEditor(page, `@prefix vol: <${VOL}> .\n<https://example.org/r2> a vol:Role .\n`);
    await expect(refused).toHaveCount(0);
  });

  // Query used to have a "Check data" workspace beside Validate data. It's gone: Query links here to edit its sample data.
  test('Query has no Check data any more, and the old address opens the query workspace', async ({ page }) => {
    await page.goto('/o/volunteering/query?view=check');
    await expect(page.getByTestId('sparql-editor')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check data', exact: true })).toHaveCount(0);
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
