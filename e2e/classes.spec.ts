import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, signIn, demoOntology } from './fixtures';

/**
 * The generated JavaScript classes and SHACL compact syntax, at the ontology's
 * own URI. The key check imports the module in a real browser, as an app with
 * no build step would, and reads and writes RDF through the classes.
 */

const root = path.resolve(import.meta.dirname, '..');
const WRAPPER_DIST = path.join(root, 'packages/core/node_modules/@rdfjs/wrapper/dist');
const N3_BROWSER = path.join(root, 'packages/core/node_modules/n3/browser/n3.min.js');

/** Serve @rdfjs/wrapper from the local copy instead of the CDN, so the test is offline and deterministic. */
async function localWrapperCdn(page: Page) {
  await page.route(/^https:\/\/cdn\.jsdelivr\.net\/npm\/@rdfjs\/wrapper@[^/]+\/(.*)$/, async (route) => {
    const rest = /@rdfjs\/wrapper@[^/]+\/(.*)$/.exec(route.request().url())![1];
    const file = rest === '+esm' ? 'mod.js' : rest;
    const full = path.join(WRAPPER_DIST, file);
    if (!full.startsWith(WRAPPER_DIST) || !fs.existsSync(full)) return route.fulfill({ status: 404, body: 'not found' });
    await route.fulfill({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(full, 'utf8') });
  });
}

test.describe('Generated classes at the ontology URI', () => {
  test('a browser imports the classes from the version URL and works with RDF through them', async ({ page }) => {
    await localWrapperCdn(page);
    await page.goto('/def/volunteering/1.0.0');
    await page.addScriptTag({ path: N3_BROWSER });
    const result = await page.evaluate(async () => {
      const N3 = (window as any).N3;
      const mod = await import(/* @vite-ignore */ `${location.origin}/def/volunteering/1.0.0.js`);
      const store = new N3.Store(
        new N3.Parser().parse(`
          @prefix vol: <https://w3id.org/odi/volunteering#> .
          @prefix ex: <https://example.org/> .
          ex:park a vol:VolunteeringOpportunity ; vol:title "Saturday park clean-up" ; vol:hasRole ex:picker .
          ex:picker a vol:Role .
          ex:s1 a vol:Session ; vol:startDateTime "2026-11-07T10:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> .
        `),
      );
      const data = new mod.VolunteeringDataset(store, N3.DataFactory);
      const opps = [...data.volunteeringOpportunity];
      const session = [...data.session][0];
      session.placesAvailable = 12;
      const places = store.getQuads(null, N3.DataFactory.namedNode('https://w3id.org/odi/volunteering#placesAvailable'), null, null)[0].object;
      return {
        exports: Object.keys(mod).sort(),
        titles: opps.map((o: any) => [...o.title][0]),
        roles: opps.flatMap((o: any) => [...o.hasRole].map((r: any) => r.value)),
        start: session.startDateTime.toISOString(),
        places: [places.value, places.datatype.value],
        volunteerIsPerson: new mod.Volunteer('https://example.org/v', store, N3.DataFactory) instanceof mod.Person,
        version: mod.ontology.versionIRI,
      };
    });
    expect(result.exports).toEqual(expect.arrayContaining(['VolunteeringDataset', 'VolunteeringOpportunity', 'Volunteer', 'Person', 'Role', 'Session', 'ontology']));
    expect(result.titles).toEqual(['Saturday park clean-up']);
    expect(result.roles).toEqual(['https://example.org/picker']);
    expect(result.start).toBe('2026-11-07T10:00:00.000Z');
    expect(result.places).toEqual(['12', 'http://www.w3.org/2001/XMLSchema#nonNegativeInteger']);
    expect(result.volunteerIsPerson).toBe(true);
    expect(result.version).toBe('https://w3id.org/odi/volunteering/1.0.0');
  });

  test('the version URL answers JavaScript, TypeScript, SHACLC and an npm package by Accept or extension', async ({ request }) => {
    const js = await request.get('/def/volunteering/1.0.0', { headers: { Accept: 'text/javascript' } });
    expect(js.headers()['content-type']).toMatch(/^text\/javascript/);
    expect(js.headers()['access-control-allow-origin']).toBe('*');
    expect(await js.text()).toContain('class VolunteeringDataset extends DatasetWrapper');
    const ts = await request.get('/def/volunteering/1.0.0.d.ts');
    expect(await ts.text()).toContain('export declare class VolunteeringOpportunity');
    const shaclc = await request.get('/def/volunteering/1.0.0', { headers: { Accept: 'text/shaclc' } });
    expect(await shaclc.text()).toMatch(/shape volsh:SessionShape -> vol:Session/);
    const tgz = await request.get('/def/volunteering/1.0.0.tgz');
    expect(tgz.headers()['content-type']).toMatch(/application\/gzip/);
    expect((await tgz.body()).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
  });

  test('the public page shows how to import the classes', async ({ page }) => {
    await page.goto('/def/volunteering/1.0.0#tab-download');
    const section = page.locator('#sec-code');
    await expect(section.getByRole('heading', { name: 'Use in JavaScript and TypeScript' })).toBeVisible();
    await expect(section).toContainText('/def/volunteering/1.0.0.js');
    await expect(section).toContainText('npm install');
    await expect(section).toContainText('volunteering-ontology');
    await expect(page.locator('.downloads')).toContainText('SHACL compact syntax');
  });

  test('the Formats tab shows the classes with how to import them', async ({ page, request }) => {
    await signIn(page, { name: 'E2E classes', role: 'editor' });
    const { id } = await demoOntology(request);
    await page.goto(`/o/${id}/source?format=typescript`);
    await expect(page.getByTestId('source-code')).toContainText('const data = new VolunteeringDataset(dataset, factory)');
    const hint = page.getByTestId('classes-import');
    await expect(hint).toContainText('import { VolunteeringDataset } from');
    await expect(hint).toContainText('/def/volunteering/draft.js');
    await expect(hint).toContainText('npm install');
    // The link to the declarations works.
    const dts = await request.get(await hint.getByRole('link', { name: 'draft.d.ts' }).getAttribute('href').then((h) => h!));
    expect(await dts.text()).toContain('export declare class');
  });
});
