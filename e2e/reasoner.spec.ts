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
    await health.getByRole('button', { name: 'Check again in this browser' }).click();
    await Promise.all([wasm, source]);
    const status = health.getByRole('status');
    await expect(status).toContainText(/This browser: consistent, all classes satisfiable \(sparq · reasoning [\d.]+ ms/);
    await expect(status).toContainText('Same result as the server.');
    expect(validationCalls).toEqual([]);
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

  test('a signed-out visitor gets no validation report and no reasoner panel', async ({ page, request }) => {
    const demo = await demoOntology(request);
    expect((await page.request.get(`/api/ontologies/${demo.id}/validation`)).status()).toBe(401);
    await page.goto(`/o/${demo.id}`);
    // The app sends a signed-out visitor to the landing page.
    await expect(page.getByRole('button', { name: 'Try the demo' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check again in this browser' })).toHaveCount(0);
  });
});
