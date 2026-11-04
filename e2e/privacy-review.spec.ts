import { test, expect, settle, signIn, demoOntology } from './fixtures';

/**
 * A change drafted from private use cases is held back before merging if it would publish a
 * use case title or a person's name; an editor can confirm it is fine. Statements an older
 * version published that way are withheld from the public page, and stewards can put them back.
 * The server side is covered in apps/server/test/public.test.ts; these check the screens.
 */
test.describe('privacy review', () => {
  let demo: { id: string; title: string };
  test.beforeAll(async ({ request }) => {
    demo = await demoOntology(request);
  });

  test('a held-back change says what it would publish, and an editor can confirm and merge it', async ({ page }) => {
    await signIn(page, { name: 'E2E Privacy Editor', role: 'editor' });
    const list = (await (await page.request.get(`/api/ontologies/${demo.id}/change-requests`)).json()) as { id: string }[];
    const id = list[0].id;
    let confirmed = 0;
    // Hold this request back, as the server does when a merge would publish something private.
    await page.route(`**/api/change-requests/${id}`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({
        response: res,
        json: confirmed
          ? { ...body, status: 'merged', privacyFindings: undefined }
          : { ...body, status: 'needs-work', privacyFindings: [{ where: 'name of SecretPilotRecord', kind: 'use case title' }, { where: 'the title', kind: 'name' }] },
      });
    });
    await page.route(`**/api/change-requests/${id}/confirm-nothing-private`, async (route) => {
      confirmed++;
      // The server answers with the merged request.
      const body = await (await page.request.get(`/api/change-requests/${id}`)).json();
      await route.fulfill({ json: { ...body, status: 'merged', privacyFindings: undefined } });
    });
    await page.goto(`/o/${demo.id}/changes/${id}`);
    await settle(page);
    const hold = page.getByTestId('privacy-hold');
    await expect(hold).toContainText('Held back');
    await expect(hold).toContainText('A use case title in name of SecretPilotRecord');
    await expect(hold).toContainText('A person’s name in the title');
    await hold.getByRole('button', { name: /Nothing here is private/ }).click();
    await expect.poll(() => confirmed).toBe(1);
    await expect(hold).toHaveCount(0);
  });

  test('contributors see why a change is held back but cannot confirm it', async ({ page }) => {
    await signIn(page, { name: 'E2E Privacy Contributor', role: 'contributor' });
    const list = (await (await page.request.get(`/api/ontologies/${demo.id}/change-requests`)).json()) as { id: string }[];
    const id = list[0].id;
    await page.route(`**/api/change-requests/${id}`, async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), status: 'needs-work', privacyFindings: [{ where: 'the title', kind: 'name' }] } });
    });
    await page.goto(`/o/${demo.id}/changes/${id}`);
    await settle(page);
    await expect(page.getByTestId('privacy-hold')).toContainText('A person’s name in the title');
    await expect(page.getByRole('button', { name: /Nothing here is private/ })).toHaveCount(0);
  });

  test('stewards review what was withheld from the public page, putting back or keeping out each statement', async ({ page }) => {
    await signIn(page, { name: 'E2E Privacy Steward', role: 'steward' });
    let items = [
      { id: 'wh_1', ontologyId: demo.id, version: 'working', subject: 'https://w3id.org/x#PilotRecord', predicate: 'http://purl.org/dc/terms/contributor', object: { value: 'Legacy Person' }, reason: 'credit', at: '2026-11-04T00:00:00Z' },
      { id: 'wh_2', ontologyId: demo.id, version: '1.0.0', subject: 'https://w3id.org/x#PilotRecord', predicate: 'http://www.w3.org/2000/01/rdf-schema#comment', object: { value: 'Raised in the Secret Pilot.' }, reason: 'use case title', at: '2026-11-04T00:00:00Z' },
    ];
    const calls: string[] = [];
    await page.route(`**/api/ontologies/${demo.id}/withheld`, (route) => route.fulfill({ json: items }));
    await page.route(`**/api/ontologies/${demo.id}/withheld/*/*`, async (route) => {
      const [wid, action] = new URL(route.request().url()).pathname.split('/').slice(-2);
      calls.push(`${action} ${wid}`);
      items = items.filter((i) => i.id !== wid);
      await route.fulfill({ json: { ok: true } });
    });
    await page.goto(`/o/${demo.id}/governance`);
    await settle(page);
    const section = page.locator('section[aria-labelledby="withheld-h"]');
    await expect(section).toContainText('Withheld from the public page (2)');
    await expect(section.locator('[data-withheld]').first()).toContainText('PilotRecord · contributor · working draft · a credit an old merge wrote');
    await expect(section.locator('[data-withheld]').nth(1)).toContainText('version 1.0.0 · names a use case');
    await section.locator('[data-withheld]').first().getByRole('button', { name: 'Put back' }).click();
    await expect(section).toContainText('Withheld from the public page (1)');
    // The row went away with the focused button: focus stays in the section.
    await expect(page.locator('#withheld-h')).toBeFocused();
    await section.getByRole('button', { name: 'Keep it out' }).click();
    await expect(section).toContainText('Nothing left to review');
    await expect(section.getByRole('status')).toHaveText('Kept off the public page.');
    await expect(page.locator('#withheld-h')).toBeFocused();
    expect(calls).toEqual(['restore wh_1', 'dismiss wh_2']);
  });

  test('members without the steward role are not shown the withheld list', async ({ page }) => {
    await signIn(page, { name: 'E2E Privacy Member', role: 'contributor' });
    let asked = false;
    await page.route(`**/api/ontologies/${demo.id}/withheld`, (route) => {
      asked = true;
      return route.fulfill({ status: 403, json: { error: 'no' } });
    });
    await page.goto(`/o/${demo.id}/governance`);
    await settle(page);
    await expect(page.locator('section[aria-labelledby="withheld-h"]')).toHaveCount(0);
    expect(asked).toBe(false);
  });
});
