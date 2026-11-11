import fs from 'node:fs';
import { test, expect, signIn, uniq, type Page } from './fixtures';
import type { Route } from '@playwright/test';

const VOL = 'https://w3id.org/odi/volunteering#';
const TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const ENDPOINT = 'https://sparql.e2e.test/query';
const role = `<https://data.test/role> <${TYPE}> <${VOL}Role> .\n`;
const summary = (page: Page) => page.getByRole('region', { name: 'Endpoint sample', exact: true });
const report = (page: Page) => page.getByTestId('validation-report');
const fetchButton = (page: Page) => page.getByRole('button', { name: 'Fetch and check', exact: true });
const respond = (route: Route, body: string, extra = {}) => route.fulfill({ status: 200, contentType: 'application/n-triples', headers: { 'access-control-allow-origin': '*' }, body, ...extra });
const classOf = (route: Route) => new URLSearchParams(route.request().postData()!).get('query')!.match(/\?s a <([^>]+)>/)![1];

async function open(page: Page) {
  await page.goto('/o/volunteering/validate');
  await expect(page.getByTestId('validate-status')).toHaveText(/^Checked/);
  const disclosure = page.getByRole('button', { name: 'Check data in a SPARQL endpoint', exact: true });
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await disclosure.click();
  await page.getByLabel('Endpoint URL').fill(ENDPOINT);
}

function hold() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test.describe('Validate a SPARQL endpoint', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, { name: `Endpoint editor ${uniq()}`, role: 'editor' });
  });

  test('an editor fetches conforming and failing samples with one fixed form POST per version class', async ({ page, request }) => {
    const seen: { cls: string; query: string; method: string; contentType: string }[] = [];
    let failing = false;
    await page.route('https://sparql.e2e.test/**', async (route) => {
      const r = route.request();
      const cls = classOf(route);
      seen.push({ cls, query: new URLSearchParams(r.postData()!).get('query')!, method: r.method(), contentType: r.headers()['content-type'] });
      await respond(route, cls === `${VOL}${failing ? 'VolunteeringOpportunity' : 'Role'}` ? (failing ? `<https://data.test/shift> <${TYPE}> <${VOL}VolunteeringOpportunity> .\n` : role) : '');
    });
    await open(page);
    await page.getByLabel('Resources per class').selectOption('20');
    await page.getByLabel('Graph (optional)').fill('urn:graph:sample');
    await page.getByRole('button', { name: 'Show the queries', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Sample query', exact: true })).toContainText('LIMIT 20');
    await fetchButton(page).click();
    await expect(summary(page)).toContainText('Sample from sparql.e2e.test (1 triple from');
    await expect(page.getByTestId('validate-status')).toHaveText(/^Checked/);
    await expect(page.getByTestId('validation-verdict')).toContainText('Conforms to the shapes');
    await expect(page.getByTestId('validation-verdict')).toContainText('Every term is defined');
    expect(seen.length).toBeGreaterThan(1);
    expect(new Set(seen.map((s) => s.cls)).size).toBe(seen.length);
    for (const s of seen) {
      expect(s.method).toBe('POST');
      expect(s.contentType).toContain('application/x-www-form-urlencoded');
      expect(s.query).toContain('CONSTRUCT');
      expect(s.query).toContain('LIMIT 20');
      expect(s.query.match(/GRAPH <urn:graph:sample>/g)).toHaveLength(2);
    }
    // The same N-Triples document also works at this version's POST address.
    const api = await request.post('/def/volunteering/1.0.0', { headers: { 'Content-Type': 'application/n-triples' }, data: role });
    expect(api.ok()).toBeTruthy();
    expect(await api.json()).toMatchObject({ valid: true, triples: 1 });
    failing = true;
    await summary(page).getByRole('button', { name: 'Check again' }).click();
    await expect(page.getByTestId('validation-verdict')).toContainText(/violation/);
    await expect(page.getByTestId('validation-results')).toContainText('hasRole');
  });

  test('drift lists an undefined own term with its suggestion and classes with no instances', async ({ page }) => {
    await page.route('https://sparql.e2e.test/**', (route) => respond(route, classOf(route) === `${VOL}Role` ? role + `<https://data.test/role> <${VOL}sumary> "Typo" .\n<https://data.test/role> <https://outside.test/fine> "Fine" .\n` : ''));
    await open(page);
    await fetchButton(page).click();
    const drift = page.getByRole('region', { name: /How the sample uses/ });
    await expect(drift).toContainText("1 vol: term this version doesn’t define, likely a typo");
    await expect(drift).toContainText('vol:sumary');
    await expect(drift).toContainText(/\d+ of \d+ classes with no instances in the sample: vol:/);
    await drift.getByRole('button', { name: /^and \d+ more$/ }).click();
    await expect(drift).toContainText('vol:VolunteeringOpportunity');
    await expect(drift).not.toContainText('vol:Role,');
    // Its suggestion is in the report's Terms list, as for pasted data.
    await expect(report(page)).toContainText('Did you mean vol:summary?');
    await expect(drift).not.toContainText('outside.test');
  });

  test('Cancel stops a slow fetch and preserves the previous report', async ({ page }) => {
    const held = hold(); let requests = 0;
    await page.route('https://sparql.e2e.test/**', async (route) => { requests++; await held.promise; await respond(route, role); });
    await open(page);
    const old = await report(page).textContent();
    await fetchButton(page).click();
    await expect(page.getByText(/Fetching 0 of \d+ classes/)).toBeVisible();
    await expect.poll(() => requests).toBe(3);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    held.release();
    await expect(fetchButton(page)).toBeEnabled();
    await expect(summary(page)).toHaveCount(0);
    await expect(report(page)).toHaveText(old!);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('a CORS failure explains browser access and offers a copyable curl pipeline for this version', async ({ page, baseURL, consoleGuard }) => {
    // A real cross-origin refusal: Concord's own API server, on another port, sends no CORS headers here.
    // (A route fulfilled by Playwright skips the browser's CORS check, so it can't stand in for one.)
    const noCors = `http://localhost:${process.env.E2E_API_PORT ?? 8797}/api/e2e-no-cors`;
    consoleGuard.allow(
      /^Access to fetch at 'http:\/\/localhost:\d+\/api\/e2e-no-cors' from origin 'http:\/\/localhost:\d+' has been blocked by CORS policy: .*$/,
      /^Failed to load resource: net::ERR_FAILED$/,
    );
    await open(page);
    await page.getByLabel('Endpoint URL').fill(noCors);
    const old = await report(page).textContent();
    await fetchButton(page).click();
    await expect(page.getByRole('alert')).toContainText(/Your browser couldn't read localhost:\d+/);
    await expect(page.getByRole('alert')).toContainText('CORS');
    const fallback = page.getByRole('region', { name: 'Fetch and check with curl' });
    await expect(fallback).toContainText(noCors);
    await expect(fallback).toContainText(`${baseURL}/def/volunteering/1.0.0`);
    await expect(fallback).toContainText('--data-urlencode');
    await expect(fallback).toContainText('CONSTRUCT');
    await expect(fallback).toContainText('--data-binary @-');
    await expect(report(page)).toHaveText(old!);
    await expect(page.getByRole('region', { name: 'Endpoint sample' })).toHaveCount(0);
  });

  test('HTTP errors include status and body, and insecure remote URLs send no request', async ({ page, consoleGuard }) => {
    consoleGuard.allow(/^Failed to load resource: the server responded with a status of 400 \(Bad Request\)$/);
    let requests = 0;
    await page.route('https://sparql.e2e.test/**', (route) => { requests++; return respond(route, 'Store says this dataset is unavailable', { status: 400 }); });
    await open(page);
    await fetchButton(page).click();
    await expect(page.getByRole('alert')).toContainText('HTTP 400: Store says this dataset is unavailable');
    const before = requests;
    await page.getByLabel('Endpoint URL').fill('http://sparql.e2e.test/query');
    await fetchButton(page).click();
    await expect(page.getByRole('alert')).toContainText('Use HTTPS');
    expect(requests).toBe(before);
    await expect(summary(page)).toHaveCount(0);
  });

  test('a sample downloads as N-Triples, Remove restores shared data, and Open in editor copies it', async ({ page }) => {
    await page.route('https://sparql.e2e.test/**', (route) => respond(route, classOf(route) === `${VOL}Role` ? role : ''));
    await open(page);
    const old = await page.getByTestId('validate-editor').textContent();
    await fetchButton(page).click();
    await expect(summary(page)).toBeVisible();
    const downloaded = page.waitForEvent('download');
    await summary(page).getByRole('button', { name: 'Download', exact: true }).click();
    const file = await downloaded;
    expect(file.suggestedFilename()).toMatch(/\.nt$/);
    expect(fs.readFileSync((await file.path())!, 'utf8')).toContain(`${VOL}Role`);
    await summary(page).getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.getByTestId('validate-editor')).toHaveText(old!);
    await fetchButton(page).click();
    await summary(page).getByRole('button', { name: 'Open in editor' }).click();
    await expect(summary(page)).toHaveCount(0);
    await expect(page.getByTestId('validate-editor')).toContainText('https://data.test/role');
    await expect(page.getByTestId('validation-verdict')).toContainText('Conforms to the shapes');
    await page.reload();
    await expect(page.getByTestId('validate-editor')).toContainText('https://data.test/role');
  });

  test('Remove supersedes a refetch and a version change checks the same sample without refetching', async ({ page }) => {
    const held = hold(); let slow = false, requests = 0;
    await page.route('https://sparql.e2e.test/**', async (route) => {
      requests++; if (slow) await held.promise;
      await respond(route, classOf(route) === `${VOL}Role` ? role : '');
    });
    await open(page);
    await fetchButton(page).click();
    await expect(summary(page)).toBeVisible();
    const before = requests;
    await page.getByLabel('Version to validate against').selectOption('draft');
    await expect(summary(page)).toContainText('Fetched for v1.0.0');
    await expect(page.getByTestId('validation-subtitle')).toContainText('working draft');
    expect(requests).toBe(before);
    slow = true;
    await summary(page).getByRole('button', { name: 'Check again' }).click();
    await expect.poll(() => requests).toBe(before + 3);
    await summary(page).getByRole('button', { name: 'Remove', exact: true }).click();
    held.release();
    await expect(summary(page)).toHaveCount(0);
    await expect(page.getByTestId('validate-editor')).toContainText('saturday-shift');
    await expect(page.getByTestId('validation-verdict')).toContainText(/violation/);
  });

  test('version changes and data edits discard late fetches', async ({ page }) => {
    const held = hold(); let requests = 0;
    await page.route('https://sparql.e2e.test/**', async (route) => { requests++; await held.promise; await respond(route, role); });
    await open(page);
    await fetchButton(page).click();
    await expect.poll(() => requests).toBe(3);
    await page.getByLabel('Version to validate against').selectOption('draft');
    await expect(fetchButton(page)).toBeEnabled();
    await fetchButton(page).click();
    await expect.poll(() => requests).toBe(6);
    await page.getByRole('textbox', { name: 'Data to validate' }).fill('<urn:edited> <urn:p> "edited" .');
    held.release();
    await expect(summary(page)).toHaveCount(0);
    await expect(page.getByTestId('validate-editor')).toContainText('edited');
    await expect(page.getByTestId('validate-status')).toHaveText(/^Checked/);
  });

  test('uploading a file supersedes a fetch', async ({ page }) => {
    const held = hold(); let requests = 0;
    await page.route('https://sparql.e2e.test/**', async (route) => { requests++; await held.promise; await respond(route, role); });
    await open(page);
    await fetchButton(page).click();
    await expect.poll(() => requests).toBe(3);
    await page.getByLabel('Upload a data file').setInputFiles({ name: 'own.nt', mimeType: 'application/n-triples', buffer: Buffer.from('<urn:uploaded> <urn:p> "own" .') });
    held.release();
    await expect(page.getByTestId('validate-editor')).toContainText('urn:uploaded');
    await expect(summary(page)).toHaveCount(0);
    await expect(page.getByTestId('validate-status')).toHaveText(/^Checked/);
  });

  test('URL, graph and sample size survive reload, and signing out clears them and aborts a fetch', async ({ page }) => {
    const held = hold(); let requests = 0;
    await page.route('https://sparql.e2e.test/**', async (route) => { requests++; await held.promise; await respond(route, role); });
    await open(page);
    await page.getByLabel('Graph (optional)').fill('urn:graph:saved');
    await page.getByLabel('Resources per class').selectOption('200');
    await page.reload();
    await page.getByRole('button', { name: 'Check data in a SPARQL endpoint', exact: true }).click();
    await expect(page.getByLabel('Endpoint URL')).toHaveValue(ENDPOINT);
    await expect(page.getByLabel('Graph (optional)')).toHaveValue('urn:graph:saved');
    await expect(page.getByLabel('Resources per class')).toHaveValue('200');
    await fetchButton(page).click();
    await expect.poll(() => requests).toBe(3);
    await page.getByRole('button', { name: /Endpoint editor/ }).click();
    await page.getByRole('navigation', { name: 'Account' }).getByRole('button', { name: 'Sign out' }).click();
    held.release();
    await expect(page).toHaveURL(/\/login/);
    const saved = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('concord.query.') && k.endsWith('.endpoint')));
    expect(saved).toEqual([]);
  });
});

test('signed out, the endpoint checker follows Validate data access and sends you to sign in', async ({ page }) => {
  await page.goto('/o/volunteering/validate');
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('button', { name: 'Check data in a SPARQL endpoint' })).toHaveCount(0);
});
