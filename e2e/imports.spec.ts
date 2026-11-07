import { test, expect, demoOntology, expectNoCrash, signIn, uniq } from './fixtures';

/**
 * Checking an ontology together with the ontologies it imports (owl:imports). Every change is
 * reasoned over with its imports loaded, a failure names the import it comes from, and anyone
 * signed in can propose importing another ontology from the Overview.
 */

const VOL = 'https://w3id.org/odi/volunteering';

async function newOntology(page: import('@playwright/test').Page, title: string) {
  const res = await page.request.post('/api/ontologies', { data: { title, prefix: `im${uniq()}` } });
  expect(res.status()).toBe(201);
  return (await res.json()) as { id: string; namespace: string; title: string };
}

test.describe('ontologies that import others', () => {
  test('a signed-in person proposes an import from the Overview, and the change is checked with it', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signIn(page, { name: `Importer ${uniq()}`, role: 'owner' });
    const o = await newOntology(page, `Community stewardship ${uniq()}`);

    await page.goto(`/o/${o.id}`);
    const buildsOn = page.getByRole('region', { name: 'Builds on' });
    await expect(buildsOn.getByText(/doesn't import any others yet/)).toBeVisible({ timeout: 30_000 });
    await buildsOn.getByRole('button', { name: 'Import an ontology' }).click();

    const dialog = page.getByRole('dialog', { name: 'Import an ontology' });
    await dialog.getByLabel('Ontology to import').selectOption({ label: demo.title });
    await dialog.getByLabel('Why (optional)').fill('Reuse their definition of a person');
    await dialog.getByRole('button', { name: 'Propose the import' }).click();

    // The new change request opens on its checks, which loaded the imported ontology.
    await expect(page).toHaveURL(new RegExp(`/o/${o.id}/changes/[^/?]+\\?view=checks`));
    await expect(page.getByRole('heading', { name: `Import ${demo.title}` })).toBeVisible();
    const imported = page.getByRole('button', { name: /Imported ontologies/ });
    await expect(imported).toContainText('1 ontology, consistent', { timeout: 30_000 });
    await imported.click();
    await expect(page.getByText('Consistent with everything it imports.')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Imported ontologies checked' }).getByRole('link', { name: demo.title })).toHaveAttribute('href', `/o/${demo.id}`);
    await expectNoCrash(page);
  });

  // Used to go wrong: an ontology with owl:imports was reasoned over on its own, so the reasoner
  // gave no verdict (its imports weren't loaded), and a class the imported ontology makes
  // impossible was never caught.
  test('a class under two classes the imported ontology keeps apart fails, and the checks name the import', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signIn(page, { name: `Importer ${uniq()}`, role: 'owner' });
    const o = await newOntology(page, `Hybrid agents ${uniq()}`);
    const res = await page.request.post(`/api/ontologies/${o.id}/change-requests`, {
      data: {
        title: 'Reuse volunteering agents',
        description: 'Something that is both a person and an organisation.',
        kind: 'feature',
        ops: [
          { op: 'addImport', iri: VOL },
          { op: 'addClass', localName: 'Hybrid', label: 'hybrid agent', definition: 'Something said to be both a person and an organisation.', subClassOf: [`${VOL}#Person`, `${VOL}#Organisation`] },
        ],
      },
    });
    expect(res.status()).toBe(201);
    const cr = (await res.json()) as { id: string; validation: { passed: boolean; imports: { unsatisfiable: string[] } } };
    expect(cr.validation.passed).toBe(false);
    expect(cr.validation.imports.unsatisfiable).toEqual([`${o.namespace}Hybrid`]);

    await page.goto(`/o/${o.id}/changes/${cr.id}?view=checks`);
    await expect(page.getByRole('button', { name: /Imported ontologies/ })).toContainText('conflicts', { timeout: 30_000 });
    // Opened by itself, because it fails.
    await expect(page.getByText(/Together with what it imports, 1 class can never have members/)).toBeVisible();
    await expect(page.getByRole('list', { name: 'Where the problem comes from' })).toContainText(`Comes from ${demo.title}: it makes hybrid agent impossible.`);
  });

  test('someone signed out cannot propose an import', async ({ page, request }) => {
    const demo = await demoOntology(request);
    const res = await request.post(`/api/ontologies/${demo.id}/change-requests`, { data: { title: 'Import something', description: 'x', kind: 'feature', ops: [{ op: 'addImport', iri: 'https://example.org/other' }] } });
    expect(res.status()).toBe(401);
    // The ontology's pages, and so the import form, are behind sign-in.
    await page.goto(`/o/${demo.id}`);
    await expect(page.getByRole('button', { name: 'Try the demo' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import an ontology' })).toHaveCount(0);
    await expectNoCrash(page);
  });
});
