import { test, expect, settle, signIn, demoOntology } from './fixtures';

/**
 * A change drafted from use cases (which may be private) is published only as an editor
 * approved it, byte for byte; these run against the real server. Versions published before
 * approvals existed wait for a steward to approve exactly what each publishes.
 */
test.describe('privacy review', () => {
  let demo: { id: string; title: string };
  test.beforeAll(async ({ request }) => {
    demo = await demoOntology(request);
  });

  /** A real use case and a real request synthesised from it, through the API. */
  async function synthesised(page: import('@playwright/test').Page, name: string) {
    const interview = await (await page.request.post(`/api/ontologies/${demo.id}/interviews`, { data: {} })).json();
    const uc = await page.request.patch(`/api/use-cases/${interview.useCaseId}`, {
      data: { status: 'ready', sections: { name }, terms: [{ label: `${name} record`, kind: 'class', definition: `A record kept for ${name}.` }] },
    });
    expect(uc.ok(), await uc.text()).toBeTruthy();
    const cr = await page.request.post(`/api/ontologies/${demo.id}/synthesise`, { data: { useCaseIds: [interview.useCaseId] } });
    expect(cr.ok(), await cr.text()).toBeTruthy();
    return (await cr.json()) as { id: string; ops: { op: string; localName?: string }[] };
  }

  test('an editor sees exactly what a request drafted from use cases publishes, with private-looking text highlighted, and approves it', async ({ page }) => {
    await signIn(page, { name: 'E2E Publication Editor', role: 'editor' });
    const cr = await synthesised(page, 'Zephyr Pilot');
    await page.goto(`/o/${demo.id}/changes/${cr.id}`);
    await settle(page);
    const panel = page.getByTestId('publication');
    await expect(panel.locator('[data-statement]').first()).toBeVisible();
    // The use case's name is in what it would publish: highlighted for the editor, not rewritten.
    await expect(panel.locator('[data-statement][data-hint]').first()).toContainText(/Zephyr ?Pilot/i);
    await expect(panel.getByRole('note')).toContainText('may name a use case or a person');
    await panel.getByRole('button', { name: 'Approve exactly this for publishing' }).click();
    await expect(page.getByTestId('publication-approved')).toContainText('Approved by E2E Publication Editor');
    await expect(panel.getByRole('button', { name: 'Approve exactly this for publishing' })).toHaveCount(0);
    // The server kept that exact version.
    const stored = await (await page.request.get(`/api/change-requests/${cr.id}`)).json();
    const now = await (await page.request.get(`/api/change-requests/${cr.id}/publication`)).json();
    expect(stored.privacyCleared.fingerprint).toBe(now.fingerprint);
  });

  test('approving a version that changed since the editor looked is refused, and the new version is shown', async ({ page, consoleGuard }) => {
    consoleGuard.allow(/status of 409/);
    await signIn(page, { name: 'E2E Publication Checker', role: 'editor' });
    const cr = await synthesised(page, 'Quillon Study');
    await page.goto(`/o/${demo.id}/changes/${cr.id}`);
    await settle(page);
    const panel = page.getByTestId('publication');
    await expect(panel.locator('[data-statement]').first()).toBeVisible();
    // Someone changes the edits while the editor is reading.
    const changed = await page.request.patch(`/api/change-requests/${cr.id}`, {
      data: { ops: [{ op: 'addClass', localName: 'ChangedWhileReading', label: 'changed while reading', definition: 'Added after the editor looked.' }] },
    });
    expect(changed.ok(), await changed.text()).toBeTruthy();
    await panel.getByRole('button', { name: 'Approve exactly this for publishing' }).click();
    await expect(panel.getByRole('alert')).toContainText('changed after you reviewed it');
    await expect(panel).toContainText('Added after the editor looked.');
    expect((await (await page.request.get(`/api/change-requests/${cr.id}`)).json()).privacyCleared).toBeUndefined();
  });

  test('contributors see what a request publishes but cannot approve it', async ({ page }) => {
    await signIn(page, { name: 'E2E Publication Contributor', role: 'contributor' });
    const cr = await synthesised(page, 'Marlowe Trial');
    await page.goto(`/o/${demo.id}/changes/${cr.id}`);
    await settle(page);
    await expect(page.getByTestId('publication').locator('[data-statement]').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve exactly this for publishing' })).toHaveCount(0);
    expect((await page.request.post(`/api/change-requests/${cr.id}/approve-publication`, { data: { fingerprint: 'x' } })).status()).toBe(403);
  });

  // The server side (what is held, who can approve, fingerprints, nothing edited) is tested through HTTP in
  // apps/server/test/public.test.ts: an ontology from before approvals can't be made through this server's API,
  // since every ontology it creates publishes only approved changes. So these check the screen with its replies stubbed.
  test('stewards review versions published before approvals existed, and approve exactly what each publishes', async ({ page, consoleGuard }) => {
    consoleGuard.allow(/status of 409/);
    await signIn(page, { name: 'E2E Hold Steward', role: 'steward' });
    let holds = [
      { version: 'draft', fingerprint: 'fp-draft-1', statements: 120, hints: [{ subject: 'PilotRecord', predicate: 'definition', object: 'Raised by Legacy Person.', kind: 'name' }] },
      { version: '1.0.0', fingerprint: 'fp-release', statements: 100, hints: [] },
    ];
    const calls: string[] = [];
    await page.route(`**/api/ontologies/${demo.id}/public-holds`, (route) => route.fulfill({ json: holds }));
    await page.route(`**/api/ontologies/${demo.id}/public-holds/*/approve`, async (route) => {
      const version = new URL(route.request().url()).pathname.split('/').at(-2)!;
      const { fingerprint } = route.request().postDataJSON();
      calls.push(`${version} ${fingerprint}`);
      // The draft changed after it was shown: refused, and the new version comes back.
      if (version === 'draft' && fingerprint === 'fp-draft-1') {
        holds = holds.map((h) => (h.version === 'draft' ? { ...h, fingerprint: 'fp-draft-2', hints: [] } : h));
        return route.fulfill({ status: 409, json: { error: 'This version changed after you reviewed it. Review what it publishes again.' } });
      }
      holds = holds.filter((h) => h.version !== version);
      await route.fulfill({ json: { ok: true } });
    });
    await page.goto(`/o/${demo.id}/governance`);
    await settle(page);
    const section = page.locator('section[aria-labelledby="held-h"]');
    await expect(section).toContainText('Waiting for approval before they are public (2)');
    const draft = section.locator('[data-held="draft"]');
    await expect(draft.locator('[data-hint="name"]')).toContainText('Raised by Legacy Person.');
    await expect(draft.getByRole('link', { name: 'Read all of it (Turtle)' })).toHaveAttribute('href', `/api/ontologies/${demo.id}/public-holds/draft/turtle`);
    await draft.getByRole('button', { name: 'Approve exactly this for publishing' }).click();
    await expect(section.getByRole('alert')).toContainText('changed after you reviewed it');
    await expect(draft).toContainText('Nothing looks private');
    await draft.getByRole('button', { name: 'Approve exactly this for publishing' }).click();
    await expect(section).toContainText('Waiting for approval before they are public (1)');
    await expect(page.locator('#held-h')).toBeFocused();
    await expect(section.getByRole('status')).toHaveText('The working draft is published again.');
    await section.locator('[data-held="1.0.0"]').getByRole('button', { name: 'Approve exactly this for publishing' }).click();
    await expect(section).toContainText('Nothing is waiting for approval.');
    expect(calls).toEqual(['draft fp-draft-1', 'draft fp-draft-2', '1.0.0 fp-release']);
  });

  test('members without the steward role are not shown the versions waiting for approval', async ({ page }) => {
    await signIn(page, { name: 'E2E Hold Member', role: 'contributor' });
    let asked = false;
    await page.route(`**/api/ontologies/${demo.id}/public-holds`, (route) => {
      asked = true;
      return route.fulfill({ status: 403, json: { error: 'no' } });
    });
    await page.goto(`/o/${demo.id}/governance`);
    await settle(page);
    await expect(page.locator('section[aria-labelledby="held-h"]')).toHaveCount(0);
    expect(asked).toBe(false);
  });
});
