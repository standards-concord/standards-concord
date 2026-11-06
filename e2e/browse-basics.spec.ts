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

  test('the list view folds away classes like it folds away properties', async ({ page, request }) => {
    // Jesse: Object and Datatype properties could be collapsed but Classes couldn't, and the view was called "Classes".
    const demo = await demoOntology(request);
    await signInAsPersona(page, 'Aisha Rahman');
    await page.goto(`/o/${demo.id}/browse`);
    await settle(page);
    const views = page.getByRole('radiogroup', { name: 'View' });
    await expect(views.getByRole('radio', { name: 'List' })).toHaveAttribute('aria-checked', 'true');
    await expect(views.getByRole('radio', { name: 'Classes' })).toHaveCount(0);

    const classes = page.getByRole('button', { name: /^Classes \(\d+\)$/ });
    const tree = page.getByRole('tree', { name: /Classes/ });
    await expect(classes).toHaveAttribute('aria-expanded', 'true');
    await expect(tree).toBeVisible();
    await classes.click();
    await expect(classes).toHaveAttribute('aria-expanded', 'false');
    await expect(tree).toBeHidden();
    await expect(page.getByRole('button', { name: 'Expand all classes' })).toBeHidden();
    // The property lists still work while classes are folded away.
    await page.getByRole('button', { name: /^Object properties \(\d+\)$/ }).click();
    await page.getByRole('button', { name: 'has role', exact: true }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'has role' })).toBeVisible();
    await classes.click();
    await expect(tree).toBeVisible();
  });

  test('a folded class list opens again to show a class picked elsewhere on the page', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signInAsPersona(page, 'Priya Shah');
    await page.goto(`/o/${demo.id}/browse?term=${encodeURIComponent('https://w3id.org/odi/volunteering#hasRole')}`);
    await settle(page);
    const classes = page.getByRole('button', { name: /^Classes \(\d+\)$/ });
    await classes.click();
    await expect(classes).toHaveAttribute('aria-expanded', 'false');
    // Following the property's domain opens a class, which the list shows again.
    await page.getByText('Domain', { exact: true }).locator('xpath=following-sibling::dd[1]').getByRole('button', { name: 'volunteering opportunity' }).click();
    await expect(classes).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('tree', { name: /Classes/ }).getByRole('treeitem', { name: /^volunteering opportunity\b/, selected: true })).toBeVisible();
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
