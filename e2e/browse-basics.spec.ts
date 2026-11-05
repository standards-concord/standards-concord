import { test, expect, demoOntology, settle, signInAsPersona, uniq } from './fixtures';

/**
 * Browse basics: search, open a term, deep-link to it, and report a problem with it. The
 * visual views (class tree, diagram, graph) are covered in browse.spec.ts.
 */

test.describe('browse basics', () => {
  test('a term opens from the tree, has its own link, and survives a reload', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signInAsPersona(page, 'Gareth Lewis');
    await page.goto(`/o/${demo.id}/browse`);
    await settle(page);
    await page.getByRole('textbox', { name: /^Search terms/ }).fill('volunteer');
    await page.getByRole('main').getByRole('button', { name: /^volunteer Class/ }).click();
    await expect(page).toHaveURL(/[?&]term=https%3A%2F%2Fw3id\.org%2Fodi%2Fvolunteering%23Volunteer/);
    await expect(page.getByRole('heading', { level: 2, name: 'volunteer' })).toBeVisible();
    await page.reload();
    await settle(page);
    await expect(page.getByRole('heading', { level: 2, name: 'volunteer' })).toBeVisible();
  });

  test('search narrows the terms', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signInAsPersona(page, 'Gareth Lewis');
    await page.goto(`/o/${demo.id}/browse`);
    await settle(page);
    await page.getByRole('textbox', { name: /^Search terms/ }).fill('skill');
    await expect(page.getByRole('main').getByRole('button', { name: /skill/i }).first()).toBeVisible();
    await expect(page.getByRole('main').getByRole('button', { name: /^physical location\b/ })).toHaveCount(0);
  });

  test('a problem with a term is reported from its page and becomes a change request about it', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signInAsPersona(page, 'Gareth Lewis');
    await page.goto(`/o/${demo.id}/browse?term=${encodeURIComponent('https://w3id.org/odi/volunteering#Volunteer')}`);
    await settle(page);
    await page.getByRole('button', { name: 'Report a problem with this term' }).click();
    const d = page.getByRole('dialog', { name: 'Report a problem with “volunteer”' });
    const title = `Volunteer definition is circular ${uniq()}`;
    await d.getByLabel('Short title').fill(title);
    await d.getByLabel('What’s the problem?').fill('The definition uses the word volunteer.');
    await d.getByRole('button', { name: 'Submit report' }).click();
    await expect(page).toHaveURL(/\/changes\/cr_[^/]+$/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { level: 2, name: new RegExp(title) })).toBeVisible();
  });
});
