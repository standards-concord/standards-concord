import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, expectNoCrash, settle, signIn, demoOntology } from './fixtures';

/**
 * The Browse tab's visual views of the ontology: the class tree and class pages, the
 * UML-style class diagram and the network graph. Uses the seeded volunteering ontology.
 */

const VOL = 'https://w3id.org/odi/volunteering#';
let base = '';

test.beforeEach(async ({ page, request }) => {
  await signIn(page, { name: 'E2E browser', role: 'contributor' });
  const demo = await demoOntology(request);
  base = `/o/${demo.id}/browse`;
});

const tree = (page: Page) => page.getByRole('tree', { name: /Classes/ });
const item = (page: Page, name: string) => tree(page).getByRole('treeitem', { name: new RegExp(`^${name}\\b`) }).first();
const term = (page: Page) => new URL(page.url()).searchParams.get('term');

async function axe(page: Page, include: string) {
  const r = await new AxeBuilder({ page }).include(include).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}\n${v.nodes.slice(0, 5).map((n) => `  ${n.html.slice(0, 160)}\n    ${n.failureSummary?.split('\n').slice(1).join(' ')}`).join('\n')}`)).toEqual([]);
}

test.describe('class tree and class pages', () => {
  test('the hierarchy is a keyboard-operable tree', async ({ page }) => {
    await page.goto(base);
    await settle(page);
    await expect(tree(page)).toBeVisible();
    const agent = item(page, 'agent');
    await expect(agent).toHaveAttribute('aria-expanded', 'true');
    await expect(item(page, 'person')).toHaveAttribute('aria-level', '2');

    // One tab stop; arrows move, Left collapses, Right expands, Enter opens.
    await agent.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(agent).toHaveAttribute('aria-expanded', 'false');
    await expect(item(page, 'person')).toHaveCount(0);
    await page.keyboard.press('ArrowRight');
    await expect(agent).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(item(page, 'organisation')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => term(page)).toBe(`${VOL}Organisation`);
    await expect(item(page, 'organisation')).toHaveAttribute('aria-selected', 'true');

    // Type-ahead jumps to the next class starting with the typed letters.
    await page.keyboard.type('ses');
    await expect(item(page, 'session')).toBeFocused();

    // Collapse and expand everything.
    await page.getByRole('button', { name: 'Collapse all classes' }).click();
    await expect(item(page, 'person')).toHaveCount(0);
    await page.getByRole('button', { name: 'Expand all classes' }).click();
    await expect(item(page, 'volunteer')).toBeVisible();
  });

  test('a class page shows where it sits, its properties and what points to it', async ({ page }) => {
    await page.goto(`${base}?term=${encodeURIComponent(`${VOL}Volunteer`)}`);
    await settle(page);
    // The tree opens the path to the selection.
    await expect(item(page, 'volunteer')).toHaveAttribute('aria-selected', 'true');

    const panel = page.locator('main');
    await expect(panel.getByRole('heading', { name: 'volunteer', exact: true })).toBeVisible();
    const crumbs = panel.getByRole('navigation', { name: 'Hierarchy path' });
    await expect(crumbs).toContainText('Thing');
    await expect(crumbs).toContainText('agent');
    await expect(crumbs).toContainText('person');

    // Properties inherited from person, schema.org style.
    const props = panel.getByRole('table', { name: 'Properties of volunteer' });
    await expect(props.getByText('Inherited from')).toBeVisible();
    const hasSkill = props.getByRole('row', { name: /has skill/ });
    await expect(hasSkill).toContainText('skill');
    await expect(hasSkill).toContainText('0..*');

    // Relationships that can point at a volunteer, via its parent.
    const incoming = panel.locator('details', { hasText: 'Relationships pointing here' });
    await expect(incoming.getByRole('button', { name: 'submitted by' })).toBeVisible();
    await expect(incoming.getByText('points to its parent person')).toBeVisible();

    // A neighbourhood diagram of the class.
    const mini = panel.getByTestId('class-diagram');
    await expect(mini.locator('[data-node]')).not.toHaveCount(0);
    await expect(mini.locator(`[data-node="${VOL}Person"]`)).toBeVisible();

    // Everything is a link: open the property, then its range class.
    await hasSkill.getByRole('button', { name: 'has skill' }).click();
    await expect.poll(() => term(page)).toBe(`${VOL}hasSkill`);
    await expect(panel.getByRole('heading', { name: 'has skill', exact: true })).toBeVisible();
    await page.goBack();
    await expect.poll(() => term(page)).toBe(`${VOL}Volunteer`);
    await crumbs.getByRole('button', { name: 'agent' }).click();
    await expect.poll(() => term(page)).toBe(`${VOL}Agent`);
    await expect(panel.getByText('Subclasses')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'organisation' }).first()).toBeVisible();
  });

  test('cardinalities come from restrictions', async ({ page }) => {
    await page.goto(`${base}?term=${encodeURIComponent(`${VOL}Application`)}`);
    await settle(page);
    const props = page.getByRole('table', { name: 'Properties of application' });
    await expect(props.getByRole('row', { name: /for opportunity/ }).locator('td').nth(1)).toHaveText('1');
    await expect(props.getByRole('row', { name: /submitted by/ })).toContainText('person');
  });

  test('the class page passes an accessibility check', async ({ page }) => {
    await page.goto(`${base}?term=${encodeURIComponent(`${VOL}Session`)}`);
    await settle(page);
    await expect(page.getByRole('table', { name: 'Properties of session' })).toBeVisible();
    await axe(page, 'main');
  });
});

test.describe('class diagram', () => {
  test('draws every class as a box, with attributes, relationships and subclass links', async ({ page }) => {
    await page.goto(`${base}?view=diagram`);
    await settle(page);
    const d = page.getByTestId('class-diagram');
    const classes = await page.request.get(`/api/ontologies/${base.split('/')[2]}/view?ref=working`).then((r) => r.json()).then((v) => v.classes.length as number);
    await expect(d.locator('[data-node]')).toHaveCount(classes);
    await expect(d.locator('[data-edge="sub"]').first()).toBeAttached();
    await expect(d.locator('[data-edge="assoc"]').first()).toBeAttached();
    // Session's attributes are listed in its box with type and cardinality.
    const session = d.locator(`[data-node="${VOL}Session"]`);
    await expect(session).toContainText('start date and time : dateTime [1]');
    await expect(d).toHaveAttribute('aria-label', new RegExp(`${classes} classes`));

    // Options hide and show parts of the notation.
    await page.getByRole('button', { name: 'Attributes', exact: true }).click();
    await expect(session).not.toContainText('dateTime');
    await page.getByRole('button', { name: 'Attributes', exact: true }).click();
    await page.getByRole('button', { name: 'Relationships', exact: true }).click();
    await expect(d.locator('[data-edge="assoc"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Relationships', exact: true }).click();
    await page.getByRole('button', { name: 'Inherited attributes' }).click();
    await expect(d.locator(`[data-node="${VOL}VolunteerInvolvingOrganisation"]`)).toContainText('charity number');
  });

  test('clicking or pressing Enter on a class opens it, and the view can focus on it', async ({ page }) => {
    await page.goto(`${base}?view=diagram`);
    await settle(page);
    const d = page.getByTestId('class-diagram');
    const scope = page.getByRole('combobox', { name: 'Diagram scope' });
    await expect(scope.locator('option[value="1"]')).toHaveAttribute('disabled', '');

    await d.locator(`[data-node="${VOL}Role"]`).click();
    await expect.poll(() => term(page)).toBe(`${VOL}Role`);
    await expect(page.getByRole('heading', { name: 'volunteer role', exact: true })).toBeVisible();
    await expect(d.locator(`[data-node="${VOL}Role"]`)).toHaveAttribute('aria-pressed', 'true');

    const all = await d.locator('[data-node]').count();
    await scope.selectOption('1');
    await expect.poll(() => d.locator('[data-node]').count()).toBeLessThan(all);
    await expect(d.locator(`[data-node="${VOL}TimeCommitment"]`)).toBeVisible();
    await expect(d.locator(`[data-node="${VOL}Location"]`)).toHaveCount(0);
    await expect(page).toHaveURL(/hops=1/);

    // Keyboard: arrows move between boxes, Enter opens.
    await d.locator(`[data-node="${VOL}Role"]`).focus();
    await page.keyboard.press('ArrowDown');
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-node'));
    expect(focused).toBeTruthy();
    expect(focused).not.toBe(`${VOL}Role`);
    await page.keyboard.press('Enter');
    await expect.poll(() => term(page)).toBe(focused);
  });

  test('zoom, fit and SVG download work', async ({ page }) => {
    await page.goto(`${base}?view=diagram`);
    await settle(page);
    const d = page.getByTestId('class-diagram');
    const pct = d.getByLabel(/^Zoom \d+ percent$/);
    const before = await pct.innerText();
    await d.getByRole('button', { name: 'Zoom in' }).click();
    await expect(pct).not.toHaveText(before);
    await d.getByRole('button', { name: 'Fit to view' }).click();
    await expect(pct).toHaveText(before);
    // Keyboard zoom on the canvas.
    await d.focus();
    await page.keyboard.press('-');
    await expect(pct).not.toHaveText(before);

    const download = page.waitForEvent('download');
    await d.getByRole('button', { name: 'Download as SVG' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.svg$/);
    const svg = await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c).toString());
    expect(svg).toContain('<svg');
    expect(svg).toContain('volunteering opportunity');
  });

  test('the diagram passes an accessibility check', async ({ page }) => {
    await page.goto(`${base}?view=diagram`);
    await settle(page);
    await expect(page.getByTestId('class-diagram').locator('[data-node]').first()).toBeVisible();
    await axe(page, 'main');
  });
});

test.describe('graph', () => {
  test('lays out the ontology and switches layouts and filters without errors', async ({ page }) => {
    await page.goto(`${base}?view=graph`);
    const g = page.getByTestId('ontology-graph');
    await expect(g).toHaveAttribute('data-ready', 'true');
    await expect(g).toHaveAttribute('aria-label', /Graph of \d+ classes and \d+ links/);
    const links = async () => Number((await g.getAttribute('aria-label'))!.match(/and (\d+) links/)![1]);
    const base0 = await links();
    expect(base0).toBeGreaterThan(5);

    for (const layout of ['force', 'radial', 'hierarchy']) {
      await page.getByRole('combobox', { name: 'Graph layout' }).selectOption(layout);
      await page.waitForTimeout(500);
      await expectNoCrash(page);
    }
    await page.getByRole('button', { name: 'Attributes', exact: true }).click();
    await expect.poll(links).toBeGreaterThan(base0);
    await page.getByRole('button', { name: 'Disjointness' }).click();
    await page.getByRole('button', { name: 'Relationships', exact: true }).click();
    await page.getByRole('button', { name: 'Subclasses', exact: true }).click();
    await expect(g).toHaveAttribute('data-ready', 'true');
  });

  test('selecting a class from the tree highlights it in the graph and opens its page', async ({ page }) => {
    await page.goto(`${base}?view=graph`);
    await expect(page.getByTestId('ontology-graph')).toHaveAttribute('data-ready', 'true');
    await item(page, 'person').click();
    await expect.poll(() => term(page)).toBe(`${VOL}Person`);
    await expect(page).toHaveURL(/view=graph/);
    await expect(page.getByRole('heading', { name: 'person', exact: true })).toBeVisible();
    // A click on a node in the canvas selects it too.
    const box = (await page.getByTestId('ontology-graph').boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expectNoCrash(page);
  });

  test('PNG download works', async ({ page }) => {
    await page.goto(`${base}?view=graph`);
    const g = page.getByTestId('ontology-graph');
    await expect(g).toHaveAttribute('data-ready', 'true');
    const download = page.waitForEvent('download');
    await g.getByRole('button', { name: 'Download as PNG' }).click();
    expect((await download).suggestedFilename()).toBe('ontology-graph.png');
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('every view fits the screen', async ({ page }) => {
    for (const v of ['', '?view=diagram', '?view=graph', `?term=${encodeURIComponent(`${VOL}Session`)}`]) {
      await test.step(v || 'classes', async () => {
        await page.goto(base + v);
        await settle(page);
        await expectNoCrash(page);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBeLessThanOrEqual(1);
      });
    }
  });
});
