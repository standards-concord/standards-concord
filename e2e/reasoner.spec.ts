import { test, expect, demoOntology, signIn, signInAsPersona, uniq } from './fixtures';

/**
 * OWL 2 DL reasoning with sparq (WebAssembly) in place of HermiT on Java. The server runs
 * it for every validation and change request; the health panel can run the same reasoner
 * in the browser and compare verdicts.
 */

const VOL = 'https://w3id.org/odi/volunteering#';

test.describe('OWL reasoning with sparq', () => {
  test('the working draft is checked by sparq, and the check runs again in the browser with the same verdict', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signIn(page, { name: `Reasoner steward ${uniq()}`, role: 'steward' });
    await page.goto(`/o/${demo.id}`);
    const health = page.locator('#health');
    await expect(health.getByText('Consistent.', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(health.getByText(/^sparq · reasoning [\d.]+ ms \(\d+ ms in all\)$/)).toBeVisible();
    // The OWL reasoner ran, so the summary tile isn't "Not run".
    await expect(health.getByText('Reasoner (sparq)')).toBeVisible();

    // Only the draft's Turtle comes from the server; the reasoner itself is fetched and run here.
    const validationCalls: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/validation')) validationCalls.push(r.url()); });
    const wasm = page.waitForResponse((r) => /sparq_dl_wasm_bg[^/]*\.wasm/.test(r.url()) && r.ok());
    const source = page.waitForResponse((r) => r.url().includes(`/api/ontologies/${demo.id}/source`) && r.ok());
    // The reasoner runs in a Web Worker, so a large ontology doesn't freeze the page.
    const worker = page.waitForEvent('worker', (w) => /reasonWorker/.test(w.url()));
    await health.getByRole('button', { name: 'Check again in this browser' }).click();
    await Promise.all([wasm, source, worker]);
    const status = health.getByRole('status');
    await expect(status).toContainText(/This browser: consistent, all classes satisfiable \(sparq · reasoning [\d.]+ ms/);
    await expect(status).toContainText('Same result as the server.');
    expect(validationCalls).toEqual([]);
  });

  test("the browser result is only compared with the server's when both are for the same revision", async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signIn(page, { name: `Reasoner revision ${uniq()}`, role: 'steward' });
    // Used to go wrong: the page compared a fresh in-browser run with a report from when the page
    // loaded, so an edit in between showed up as the server "disagreeing". Here the draft moves on
    // (a different revision is served) and then differs at the same revision.
    let mode: 'moved' | 'tampered' = 'moved';
    // The real draft and its revision, fetched up front so the handler answers at once.
    const real = await page.request.get(`/api/ontologies/${demo.id}/source?format=turtle&ref=working`);
    const turtle = await real.text();
    const revision = real.headers()['x-concord-revision'];
    expect(revision).toBeTruthy();
    await page.route(new RegExp(`/api/ontologies/${demo.id}/source\\?`), (route) =>
      route.fulfill({
        contentType: 'text/turtle; charset=utf-8',
        headers: { 'x-concord-revision': mode === 'moved' ? 'a-later-revision' : revision },
        body: mode === 'moved' ? turtle : `${turtle}\n<${VOL}Person> <http://www.w3.org/2002/07/owl#disjointWith> <${VOL}Volunteer> .\n`,
      }),
    );
    await page.goto(`/o/${demo.id}`);
    const health = page.locator('#health');
    await expect(health.getByText('Consistent.', { exact: true })).toBeVisible({ timeout: 30_000 });
    const check = health.getByRole('button', { name: 'Check again in this browser' });
    const status = health.getByRole('status');
    await check.click();
    await expect(status).toContainText("This check and the server's result are for different revisions of the draft, so they can't be compared. Reload the page to compare.");
    await expect(status).not.toContainText('Same result as the server.');

    mode = 'tampered';
    await check.click();
    await expect(status).toContainText('This browser: unsatisfiable:');
    await expect(status).toContainText("The server's result for the same revision differs.");
    await page.unrouteAll({ behavior: 'wait' });
  });

  test('a change that makes a class unsatisfiable is caught by sparq on the server', async ({ page, request }) => {
    const demo = await demoOntology(request);
    const name = `PersonOrganisation${uniq()}`;
    // Tom (editor) proposes a class under both Person and Organisation, which are disjoint.
    await signInAsPersona(page, 'Tom Okafor');
    const res = await page.request.post(`/api/ontologies/${demo.id}/change-requests`, {
      data: {
        title: `Add ${name}`,
        description: 'A class that is both a person and an organisation.',
        ops: [{ op: 'addClass', localName: name, label: name.toLowerCase(), definition: 'An agent that is both a person and an organisation.', subClassOf: [VOL + 'Person', VOL + 'Organisation'] }],
        submit: true,
      },
    });
    expect(res.status()).toBe(201);
    const cr = (await res.json()) as { id: string; validation?: { passed: boolean; reasoner: { engine: string; unsatisfiable: string[] } } };
    expect(cr.validation?.reasoner).toMatchObject({ engine: 'sparq', unsatisfiable: [VOL + name] });
    expect(cr.validation?.passed).toBe(false);

    // A reviewer sees why on the change request's checks.
    await signInAsPersona(page, 'Mei Chen');
    await page.goto(`/o/${demo.id}/changes/${cr.id}?view=checks`);
    await expect(page.getByText('1 unsatisfiable class.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(new RegExp(`^Unsatisfiable: ${name.toLowerCase()}$`, 'i'))).toBeVisible();
    await expect(page.getByText(/^sparq · reasoning [\d.]+ ms/).first()).toBeVisible();
    // The in-browser re-check is only offered for the working draft, not for a proposal.
    await expect(page.getByRole('button', { name: 'Check again in this browser' })).toHaveCount(0);
  });

  // Used to go wrong: when the reasoner timed out or crashed, the health popover said "Not run
  // (structural checks only)", though no structural checks run then; and it called any
  // unsatisfiable class "Inconsistent", even with no verdict or a consistent ontology, so the
  // popover disagreed with the health panel's detail.
  const cases: { name: string; health: Record<string, unknown>; row: string; chip: RegExp; note?: string }[] = [
    {
      name: 'no verdict (timed out)',
      health: { consistent: true, reasonerConsistent: true, unsatisfiable: 0, reasoner: 'structural', reasonerChecked: 'none', incomplete: ["OWL reasoner gave no verdict, so validation can't pass: the OWL reasoner took longer than 60 s and was stopped"] },
      row: "No verdict, so validation can't pass",
      chip: /Checks incomplete/,
      note: 'took longer than 60 s',
    },
    {
      name: 'no verdict, with unsatisfiable classes from the structural fallback',
      health: { consistent: false, reasonerConsistent: true, unsatisfiable: 1, reasoner: 'structural', reasonerChecked: 'none', incomplete: ["OWL reasoner gave no verdict, so validation can't pass: outside OWL 2 DL"] },
      row: "No verdict, so validation can't pass",
      chip: /Checks incomplete/,
      note: 'outside OWL 2 DL',
    },
    {
      name: 'consistency only',
      health: { consistent: true, reasonerConsistent: true, unsatisfiable: 0, reasoner: 'structural', reasonerChecked: 'consistency', incomplete: ["OWL reasoner showed the draft is consistent but couldn't check every class, so validation can't pass: classification ran out of budget"] },
      row: 'Consistent, not every class checked',
      chip: /Checks incomplete/,
      note: 'classification ran out of budget',
    },
    {
      name: 'consistent with an unsatisfiable class',
      health: { consistent: false, reasonerConsistent: true, unsatisfiable: 1, reasoner: 'sparq', reasonerChecked: 'complete', incomplete: [] },
      row: 'Consistent, but 1 unsatisfiable class',
      chip: /Needs fixing/,
    },
    {
      name: 'inconsistent',
      health: { consistent: false, reasonerConsistent: false, unsatisfiable: 0, reasoner: 'sparq', reasonerChecked: 'complete', incomplete: [] },
      row: 'Inconsistent',
      chip: /Needs fixing/,
    },
  ];
  test('the health popover shows the server\'s own clean result as "Consistent"', async ({ page, request }) => {
    // Not injected: the summary's reasoner fields come from the server, so dropping them shows up here.
    const demo = await demoOntology(request);
    await signIn(page, { name: `Reasoner health ${uniq()}`, role: 'steward' });
    const o = (await (await page.request.get(`/api/ontologies/${demo.id}`)).json()) as { health: Record<string, unknown> };
    expect(o.health).toMatchObject({ reasoner: 'sparq', reasonerChecked: 'complete', reasonerConsistent: true, unsatisfiable: 0, consistent: true, incomplete: [] });
    await page.goto(`/o/${demo.id}`);
    await page.getByRole('button', { name: /^Health: / }).click();
    const reasonerRow = page.getByRole('dialog', { name: /^Health: / }).getByRole('listitem').filter({ hasText: 'Reasoner' });
    await expect(reasonerRow).toHaveText(/Reasoner\s*Consistent$/);
  });

  for (const c of cases) {
    test(`the health popover matches the reasoner's result: ${c.name}`, async ({ page, request }) => {
      const demo = await demoOntology(request);
      await signIn(page, { name: `Reasoner health ${uniq()}`, role: 'steward' });
      // The server's own reasoner finishes cleanly on the demo, so the summary is given another result.
      // The changed summary is made up front, so the handler answers at once: an async fetch inside
      // it raced with the page's own requests ("Route is already handled").
      const o = await (await page.request.get(`/api/ontologies/${demo.id}`)).json();
      o.health = { ...o.health, errors: 0, ...c.health };
      await page.route(new RegExp(`/api/ontologies/${demo.id}(\\?.*)?$`), (route) => route.fulfill({ json: o }));
      await page.goto(`/o/${demo.id}`);
      const chip = page.getByRole('button', { name: /^Health: / });
      await expect(chip).toContainText(c.chip);
      await chip.click();
      const panel = page.getByRole('dialog', { name: /^Health: / });
      const reasonerRow = panel.getByRole('listitem').filter({ hasText: 'Reasoner' });
      await expect(reasonerRow).toContainText(c.row);
      if (c.row !== 'Inconsistent') await expect(reasonerRow).not.toContainText('Inconsistent');
      await expect(panel).not.toContainText('structural checks only');
      if (c.note) await expect(panel.getByRole('note')).toContainText(c.note);
      // The page may still refetch the summary; let any handler in flight finish before teardown.
      await page.unrouteAll({ behavior: 'wait' });
    });
  }

  test('a signed-out visitor gets no validation report and no reasoner panel', async ({ page, request }) => {
    const demo = await demoOntology(request);
    expect((await page.request.get(`/api/ontologies/${demo.id}/validation`)).status()).toBe(401);
    await page.goto(`/o/${demo.id}`);
    // The app sends a signed-out visitor to the landing page.
    await expect(page.getByRole('button', { name: 'Try the demo' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check again in this browser' })).toHaveCount(0);
  });
});
