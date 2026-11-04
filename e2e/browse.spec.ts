import { readFileSync } from 'node:fs';
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
    // Starts with just the top-level classes.
    const agent = item(page, 'agent');
    await expect(agent).toHaveAttribute('aria-expanded', 'false');
    await expect(item(page, 'person')).toHaveCount(0);

    // One tab stop; arrows move, Right expands, Left collapses, Enter opens.
    await agent.focus();
    await page.keyboard.press('ArrowRight');
    await expect(agent).toHaveAttribute('aria-expanded', 'true');
    await expect(item(page, 'person')).toHaveAttribute('aria-level', '2');
    await page.keyboard.press('ArrowLeft');
    await expect(agent).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('ArrowRight');
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

  test('tree rows carry their term names, and leaves have no expand or collapse control', async ({ page }) => {
    await page.goto(base);
    await settle(page);
    await page.getByRole('button', { name: 'Expand all classes' }).click();
    const items = tree(page).getByRole('treeitem');
    expect(await items.count()).toBeGreaterThan(5);
    // The tree is operated with the keyboard and by clicking rows; it holds no buttons, so no
    // unnamed or disabled "Expand"/"Collapse" controls on leaves.
    await expect(tree(page).getByRole('button')).toHaveCount(0);
    for (const item of await items.all()) {
      await expect(item).toHaveAccessibleName(/\w/);
      const leaf = (await item.getAttribute('aria-expanded')) === null;
      if (leaf) await expect(item).not.toHaveAccessibleName(/^(Expand|Collapse)$/);
    }
  });

  test('property and individual lists start collapsed, with counts, and open to show a selected term', async ({ page }) => {
    await page.goto(base);
    await settle(page);
    const objProps = page.getByRole('button', { name: /^Object properties \(\d+\)$/ });
    await expect(objProps).toHaveAttribute('aria-expanded', 'false');
    await objProps.click();
    await expect(objProps).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('button', { name: 'has skill', exact: true }).click();
    await expect.poll(() => term(page)).toBe(`${VOL}hasSkill`);

    await page.goto(`${base}?term=${encodeURIComponent(`${VOL}startDateTime`)}`);
    await settle(page);
    await expect(page.getByRole('button', { name: /^Datatype properties \(\d+\)$/ })).toHaveAttribute('aria-expanded', 'true');
    // A property shows its domain and range up front, and its rules on request.
    const panel = page.locator('main');
    await expect(panel.getByText('Domain', { exact: true })).toBeVisible();
    await expect(panel.getByText('Range', { exact: true })).toBeVisible();
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
    // Secondary detail is grouped into collapsed sections with counts.
    const usage = panel.locator('details', { has: page.locator('summary', { hasText: 'Usage' }) });
    await expect(usage).not.toHaveAttribute('open');
    await usage.locator('summary').click();
    await expect(usage.getByRole('button', { name: 'submitted by' })).toBeVisible();
    await expect(usage.getByText('points to its parent person')).toBeVisible();
    const editorial = panel.locator('details', { has: page.locator('summary', { hasText: 'Editorial details' }) });
    await editorial.locator('summary').click();
    await expect(editorial.getByText('Source')).toBeVisible();

    // A neighbourhood diagram of the class.
    await panel.locator('summary', { hasText: 'Neighbourhood diagram' }).click();
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
    await expect(panel.getByText('Subclasses', { exact: true }).first()).toBeVisible();
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
    await expect(d).toHaveAccessibleDescription(new RegExp(`^${classes} classes`));

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
    const scope = page.getByRole('combobox', { name: 'Scope' });
    await expect(scope.locator('option[value="1"]')).toHaveAttribute('disabled', '');

    const all = await d.locator('[data-node]').count();
    // Picking a class on the canvas keeps the whole diagram, and opens the class beside it.
    await d.locator(`[data-node="${VOL}Role"]`).click();
    await expect.poll(() => term(page)).toBe(`${VOL}Role`);
    const details = page.getByRole('complementary', { name: 'Term details' });
    await expect(details.getByRole('heading', { name: 'volunteer role', exact: true })).toBeVisible();
    await expect(d.locator(`[data-node="${VOL}Role"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(d.locator('[data-node]')).toHaveCount(all);

    await scope.selectOption('1');
    await expect.poll(() => d.locator('[data-node]').count()).toBeLessThan(all);
    await expect(d.locator(`[data-node="${VOL}TimeCommitment"]`)).toBeVisible();
    await expect(d.locator(`[data-node="${VOL}Location"]`)).toHaveCount(0);
    await expect(page).toHaveURL(/hops=1/);
    await page.getByRole('button', { name: 'Show entire ontology' }).click();
    await expect(d.locator('[data-node]')).toHaveCount(all);
    await scope.selectOption('1');

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

    // Resizing refits (recentres) the drawing, unless it has been moved by hand.
    const viewport = d.locator('[data-viewport]');
    const moved = await viewport.getAttribute('transform');
    await page.setViewportSize({ width: 1000, height: 950 });
    await page.waitForTimeout(200);
    await expect(viewport).toHaveAttribute('transform', moved!);
    await d.getByRole('button', { name: 'Fit to view' }).click();
    const fitted = await viewport.getAttribute('transform');
    await page.setViewportSize({ width: 1400, height: 950 });
    await expect(viewport).not.toHaveAttribute('transform', fitted!);

    const download = page.waitForEvent('download');
    await d.getByRole('button', { name: 'Download as SVG' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.svg$/);
    const svg = await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c).toString());
    expect(svg).toContain('<svg');
    expect(svg).toContain('volunteering opportunity');
  });

  test('the diagram, with a class open beside it, passes an accessibility check', async ({ page }) => {
    await page.goto(`${base}?view=diagram&term=${encodeURIComponent(`${VOL}Session`)}`);
    await settle(page);
    await expect(page.getByTestId('class-diagram').locator('[data-node]').first()).toBeVisible();
    await axe(page, 'main');
  });
});

test.describe('diagram scope, focus and contrast (review fixes)', () => {
  const nodes = (page: Page) => page.getByTestId('class-diagram').locator('[data-node]');

  test('picking a class or property keeps the drawing; recentring is explicit', async ({ page }) => {
    await page.goto(`${base}?view=diagram&term=${encodeURIComponent(`${VOL}Role`)}`);
    await settle(page);
    const d = page.getByTestId('class-diagram');
    const near = await nodes(page).count();
    await expect(d.locator(`[data-node="${VOL}Location"]`)).toHaveCount(0);

    // Clicking another class in the drawing shows its details but keeps the scope around Role.
    await d.locator(`[data-node="${VOL}TimeCommitment"]`).click();
    await expect.poll(() => term(page)).toBe(`${VOL}TimeCommitment`);
    await expect(page).toHaveURL(new RegExp(`around=${encodeURIComponent(`${VOL}Role`)}`));
    await expect(nodes(page)).toHaveCount(near);

    // Following a property link in the details keeps it too.
    const details = page.getByRole('complementary', { name: 'Term details' });
    await details.getByRole('table', { name: /Properties of/ }).getByRole('button').first().click();
    await expect.poll(() => term(page)).not.toBe(`${VOL}TimeCommitment`);
    await expect(nodes(page)).toHaveCount(near);
    await expect(page.getByRole('combobox', { name: 'Scope' })).toHaveValue('1');

    // "Centre on" redraws around the inspected class.
    await d.locator(`[data-node="${VOL}TimeCommitment"]`).click();
    await page.getByRole('button', { name: 'Centre on time commitment' }).click();
    await expect(page).toHaveURL(new RegExp(`around=${encodeURIComponent(`${VOL}TimeCommitment`)}`));
    await expect(page.getByRole('button', { name: /^Centre on/ })).toHaveCount(0);

    // Choosing a class outside the drawing from the term list recentres on it.
    await page.getByRole('button', { name: 'Terms' }).click();
    await tree(page).getByRole('treeitem', { name: /^location\b/ }).first().click();
    await expect.poll(() => term(page)).toBe(`${VOL}Location`);
    await expect(page).toHaveURL(new RegExp(`around=${encodeURIComponent(`${VOL}Location`)}`));
    await expect(d.locator(`[data-node="${VOL}Location"]`)).toBeVisible();
  });

  test('one tab stop for the classes, and keyboard focus stays in view with a visible ring', async ({ page }) => {
    await page.goto(`${base}?view=diagram`);
    await settle(page);
    const d = page.getByTestId('class-diagram');
    await expect(d.locator('[data-node][tabindex="0"]')).toHaveCount(1);
    // Zoom right in so most classes are off screen.
    await d.focus();
    for (let i = 0; i < 6; i++) await page.keyboard.press('+');
    await d.locator('[data-node][tabindex="0"]').focus();
    await expect(d.locator('[data-focus-ring]')).toHaveCount(1);
    for (const key of ['End', 'ArrowLeft', 'ArrowUp', 'Home', 'ArrowRight', 'ArrowDown']) {
      await page.keyboard.press(key);
      const id = await page.evaluate(() => document.activeElement?.getAttribute('data-node'));
      expect(id, key).toBeTruthy();
      await expect(d.locator('[data-node][tabindex="0"]')).toHaveAttribute('data-node', id!);
      // Panning happens on focus; give React a frame to apply it.
      await expect
        .poll(async () => {
          // Both boxes are read together, since focusing can also scroll the page.
          const [frame, b] = [(await d.boundingBox())!, (await d.locator(`[data-node="${id}"]`).boundingBox())!];
          return b.x >= frame.x - 1 && b.y >= frame.y - 1 && b.x + Math.min(b.width, frame.width) <= frame.x + frame.width + 1 && b.y + Math.min(b.height, frame.height) <= frame.y + frame.height + 1;
        }, { message: `${key} → ${id} is on screen` })
        .toBe(true);
    }
    // Enter opens the class, and a link jumps straight to its details.
    await page.keyboard.press('Enter');
    const go = page.getByRole('link', { name: /^Go to details of/ });
    await go.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('term-details');
  });

  test('relationships are also listed as text, linked to their terms', async ({ page }) => {
    await page.goto(`${base}?view=diagram`);
    await settle(page);
    const d = page.getByTestId('class-diagram');
    // Class names include their attributes and relationships, not just counts.
    await expect(d.locator(`[data-node="${VOL}Session"]`)).toHaveAttribute('aria-label', /attributes: .*start date and time : dateTime \[1\]/);
    await expect(d.locator(`[data-node="${VOL}Application"]`)).toHaveAttribute('aria-label', /relationships: .*submitted by +1 person/);
    const text = page.getByTestId('diagram-text');
    await text.getByText(/^Relationships as text/).click();
    const row = text.getByRole('listitem').filter({ hasText: 'submitted by' });
    await expect(row).toContainText('application');
    await expect(row).toContainText('[1]');
    await expect(row).toContainText('person');
    await expect(text.getByRole('listitem').filter({ hasText: 'is a kind of' }).first()).toBeVisible();
    await row.getByRole('button', { name: 'person' }).click();
    await expect.poll(() => term(page)).toBe(`${VOL}Person`);
  });

  test('selection and hover emphasise without fading, in light and dark themes', async ({ page }) => {
    for (const scheme of ['light', 'dark'] as const) {
      await test.step(scheme, async () => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(`${base}?view=diagram&term=${encodeURIComponent(`${VOL}Application`)}&hops=0`);
        await settle(page);
        const d = page.getByTestId('class-diagram');
        await expect(d.locator('[data-near]').first()).toBeAttached();
        await d.locator(`[data-node="${VOL}Session"]`).hover();
        await expect(d.locator('[data-edge][data-on]').first()).toBeAttached();
        await expect(d.locator('[opacity]')).toHaveCount(0);
        await axe(page, '[data-testid="class-diagram"]');
      });
    }
  });

  test('a diagram inside a closed section is fitted when the section opens', async ({ page }) => {
    await page.goto(`${base}?term=${encodeURIComponent(`${VOL}Session`)}`);
    await settle(page);
    await page.getByText('Neighbourhood diagram', { exact: false }).first().click();
    const d = page.getByTestId('class-diagram');
    await expect(d.locator('[data-node]').first()).toBeVisible();
    const frame = (await d.boundingBox())!;
    expect(frame.width).toBeGreaterThan(100);
    await expect
      .poll(async () => {
        for (const n of await d.locator('[data-node]').all()) {
          const b = (await n.boundingBox())!;
          if (b.x < frame.x - 1 || b.x + b.width > frame.x + frame.width + 1) return false;
        }
        return true;
      })
      .toBe(true);
    expect(Number((await d.getByLabel(/^Zoom \d+ percent$/).innerText()).replace('%', ''))).toBeGreaterThan(20);
  });

  test('the view switcher says what each view is for', async ({ page }) => {
    await page.goto(base);
    await settle(page);
    const views = page.getByRole('radiogroup', { name: 'View' });
    await expect(views).toHaveAccessibleDescription(/Find a term/);
    await views.getByRole('radio', { name: 'Diagram' }).click();
    await expect(views).toHaveAccessibleDescription(/attributes, types and how many/);
    await views.getByRole('radio', { name: 'Graph' }).click();
    await expect(views).toHaveAccessibleDescription(/how classes connect/);
  });
});

test.describe('large and unusual ontologies (stubbed)', () => {
  const NS = 'https://example.org/big#';
  const cls = (l: string, sup: string[] = [], restrictions: unknown[] = []) => ({ kind: 'class', iri: NS + l, label: l, superClasses: sup.map((x) => NS + x), equivalentClasses: [], disjointWith: [], restrictions });
  const prop = (l: string, extra: Record<string, unknown> = {}) => ({ kind: 'objectProperty', iri: NS + l, label: l, domain: [], range: [], superProperties: [], characteristics: [], ...extra });

  async function stub(page: Page, classes: ReturnType<typeof cls>[], objectProperties: ReturnType<typeof prop>[] = [], datatypeProperties: ReturnType<typeof prop>[] = []) {
    const view = { metadata: { iri: 'https://example.org/big', title: 'Big', creators: [], contributors: [] }, classes, objectProperties, datatypeProperties, annotationProperties: [], individuals: [], prefixes: { big: NS }, tripleCount: 1 };
    await page.route(/\/api\/ontologies\/[^/]+\/view/, (r) => r.fulfill({ json: view }));
    await page.route(/\/api\/ontologies\/[^/]+\/terms\//, (r) => {
      const iri = decodeURIComponent(new URL(r.request().url()).pathname.split('/terms/')[1]);
      const t = [...classes, ...objectProperties].find((x) => x.iri === iri);
      return t ? r.fulfill({ json: { ...t, usedBy: [] } }) : r.fulfill({ status: 404, json: { error: 'not found' } });
    });
  }

  // Downloads the diagram as SVG and returns the file's text.
  async function exportSvg(page: Page, d: ReturnType<Page['locator']>, during?: () => Promise<void>) {
    const download = page.waitForEvent('download');
    await d.getByRole('button', { name: 'Download as SVG' }).click();
    await during?.();
    return readFileSync(await (await download).path(), 'utf8');
  }
  // CSS declaring the same Inter files the export outlines, so text can be drawn to compare.
  const interFaces = () =>
    [
      ['400', 'normal', '400-normal'],
      ['600', 'normal', '600-normal'],
      ['400', 'italic', '400-italic'],
    ]
      .map(([w, st, f]) => {
        const data = readFileSync(`apps/web/node_modules/@fontsource/inter/files/inter-latin-${f}.woff`).toString('base64');
        return `@font-face{font-family:Inter;font-weight:${w};font-style:${st};src:url(data:font/woff;base64,${data}) format('woff')}`;
      })
      .join('');

  test("if the page couldn't load Inter, the export keeps the text the screen shows", async ({ page, consoleGuard }) => {
    // The screen falls back to another font, so Inter's glyphs would be in the wrong places.
    // (Only the page's own font loads fail; the export can still fetch the files.)
    consoleGuard.allow(/Failed to load resource|net::ERR_FAILED/);
    await page.route(/inter-.*\.woff2?(\?|$)/, (route) => (route.request().resourceType() === 'font' ? route.abort() : route.continue()));
    await stub(page, [cls('Owner'), cls('Pet')]);
    await page.goto(`${base}?view=diagram&hops=0`);
    const d = page.getByTestId('class-diagram');
    await expect(d.locator('[data-node]')).toHaveCount(2);
    const svgText = await exportSvg(page, d);
    expect(svgText).not.toContain('<use');
    expect(svgText).toMatch(/<text[^>]*textLength[^>]*>Owner<\/text>/);
  });

  test('a diagram that changes while it is being exported is saved in one consistent state', async ({ page }) => {
    const rel = 'isTheRegisteredKeeperOfThisParticularPet';
    await stub(page, [cls('Owner', [], [{ property: NS + rel, kind: 'some', filler: NS + 'Pet' }]), cls('Pet')], [prop(rel)]);
    await page.goto(`${base}?view=diagram&hops=0`);
    const d = page.getByTestId('class-diagram');
    await expect(d.locator('[data-node]')).toHaveCount(2);
    // Hold the export's fonts back, and meanwhile select Owner, which makes its relationship
    // label bold (wider).
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route(/inter-.*\.woff/, async (route) => (await held, route.continue()));
    const svgText = await exportSvg(page, d, async () => {
      await d.locator(`[data-node="${NS}Owner"]`).click();
      await expect(d.locator('[data-edge] text[font-weight="600"]').first()).toBeVisible();
      release();
    });
    // Every outlined run spans the same width as the text it was made from.
    const viewer = await page.context().newPage();
    await viewer.setContent(`<style>${interFaces()} [data-text-layer]{fill-opacity:1}</style>${svgText}`);
    await viewer.evaluate(() => document.fonts.ready);
    const pairs = await viewer.locator('[data-outline]').evaluateAll((els) =>
      els.map((g) => [Math.round((g as SVGGraphicsElement).getBBox().width), Math.round((g.nextElementSibling as SVGGraphicsElement).getBBox().width), g.nextElementSibling!.textContent]),
    );
    expect(pairs.length).toBeGreaterThan(2);
    for (const [outline, text, name] of pairs) expect(Math.abs(Number(outline) - Number(text)), String(name)).toBeLessThanOrEqual(2);
    await viewer.close();
  });

  test('exported diagrams draw exactly the glyphs on screen, stay searchable and stay compact', async ({ page }) => {
    // Kerned capitals, an arrow (which Inter would otherwise turn into one glyph), and enough
    // attributes for the italic "+ 1 more" line.
    const attrs = Array.from({ length: 13 }, (_, i) => ({ ...prop(`AVATAR->WAVE ${i}`, { domain: [NS + 'Kerned'], range: ['http://www.w3.org/2001/XMLSchema#string'] }), kind: 'datatypeProperty' }));
    await stub(page, [{ ...cls('Kerned'), label: 'AVATAR WAVE -> Tokyo' }], [], attrs);
    await page.goto(`${base}?view=diagram&hops=0`);
    const d = page.getByTestId('class-diagram');
    await expect(d.locator('[data-node]')).toHaveCount(1);
    await expect(d.locator('[data-node] text', { hasText: '+ 1 more' })).toHaveAttribute('font-style', 'italic');
    const svgText = await exportSvg(page, d);
    const faces = interFaces();
    const viewer = await page.context().newPage();
    await viewer.setContent('<body></body>');
    // Draw the file twice: as exported (outlines), and with the outlines hidden and its text
    // shown in the same Inter. They should match pixel for pixel, apart from anti-aliasing.
    const result = await viewer.evaluate(
      async ({ svgText, faces }) => {
        const draw = async (markup: string) => {
          const img = new Image();
          img.src = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
          await img.decode();
          const c = document.createElement('canvas');
          c.width = img.naturalWidth * 2;
          c.height = img.naturalHeight * 2;
          const ctx = c.getContext('2d')!;
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0, c.width, c.height);
          return ctx.getImageData(0, 0, c.width, c.height).data;
        };
        const style = `<style>${faces} [data-outline]{display:none} [data-text-layer]{fill-opacity:1}</style>`;
        const asText = svgText.replace(/(<svg[^>]*>)/, `$1${style}`);
        const [a, b] = await Promise.all([draw(svgText), draw(asText)]);
        // Compare each outlined run of text on its own, so one wrong line can't hide in the total.
        const host = document.createElement('div');
        host.innerHTML = svgText;
        document.body.append(host);
        const svg = host.querySelector('svg')!;
        const [vx, vy, vw] = svg.getAttribute('viewBox')!.split(' ').map(Number);
        const k = (Number(svg.getAttribute('width')) / vw) * 2;
        const width = Number(svg.getAttribute('width')) * 2;
        const runs = [...svg.querySelectorAll('[data-outline] > g')].map((g) => {
          const box = (g as SVGGraphicsElement).getBBox();
          // From the run's own coordinates to the drawing's.
          const sx = svg.getScreenCTM()!.inverse().multiply((g as SVGGraphicsElement).getScreenCTM()!);
          const x0 = Math.floor((box.x * sx.a + sx.e - vx) * k) - 2;
          const y0 = Math.floor((box.y * sx.d + sx.f - vy) * k) - 2;
          let ink = 0;
          let differ = 0;
          for (let y = y0; y < y0 + box.height * k + 4; y++)
            for (let x = x0; x < x0 + box.width * k + 4; x++) {
              const i = (y * width + x) * 4;
              const da = 765 - a[i] - a[i + 1] - a[i + 2];
              const db = 765 - b[i] - b[i + 1] - b[i + 2];
              if (da > 150 || db > 150) ink++;
              if (Math.abs(da - db) > 300) differ++;
            }
          return { text: g.closest('[data-node], [data-edge]') ? (g.parentElement!.nextElementSibling?.textContent ?? '').slice(0, 30) : '', ink, differ, ratio: ink ? differ / ink : 0 };
        });
        return runs;
      },
      { svgText, faces },
    );
    expect(result.length).toBeGreaterThanOrEqual(14);
    for (const r of result) expect(r.ink, r.text).toBeGreaterThan(50);
    // Typically 0-3% of a line's ink pixels differ, from anti-aliasing (up to about 9% on an
    // occasional line). A hyphen and arrowhead drawn where the screen shows one arrow glyph
    // makes the typical line differ by about 7%, glyphs stretched to kerned widths by about
    // 17%, and an italic line drawn upright by about 30%.
    const ratios = result.map((r) => r.ratio).sort((x, y) => x - y);
    expect(ratios[Math.floor(ratios.length / 2)], 'typical line').toBeLessThan(0.035);
    for (const r of result) expect(r.ratio, r.text).toBeLessThan(0.18);

    // The real text is still in the file: the browser's find-in-page finds it.
    await viewer.setContent(svgText);
    expect(await viewer.evaluate(() => (window as unknown as { find: (s: string) => boolean }).find('AVATAR WAVE'))).toBe(true);
    await viewer.close();
  });

  test('exporting a large diagram stays compact and quick', async ({ page }) => {
    const classes = [];
    const attrs = [];
    for (let i = 0; i < 100; i++) {
      classes.push(cls(`Class${i}`));
      for (let j = 0; j < 12; j++) attrs.push({ ...prop(`attributeNumber${j}OfClass${i}`, { domain: [NS + `Class${i}`], range: ['http://www.w3.org/2001/XMLSchema#string'] }), kind: 'datatypeProperty' });
    }
    await stub(page, classes, [], attrs);
    await page.goto(`${base}?view=diagram&hops=0`);
    await page.getByRole('button', { name: /^Draw all \d+ classes anyway/ }).click();
    const d = page.getByTestId('class-diagram');
    await expect(d.locator('[data-node]')).toHaveCount(100);
    const plain = await d.locator('svg[data-width]').evaluate((svg) => new XMLSerializer().serializeToString(svg).length);
    const started = Date.now();
    const svgText = await exportSvg(page, d);
    const took = Date.now() - started;
    // Each glyph shape is stored once and reused; drawing every occurrence in full made the
    // file about 70 times larger than the diagram's own markup.
    expect(svgText.length / plain).toBeLessThan(8);
    expect(took).toBeLessThan(10_000);
  });

  test('a large ontology asks where to start, and can still draw everything to fit', async ({ page }) => {
    const classes = [cls('Root')];
    for (let i = 0; i < 12; i++) {
      classes.push(cls(`Group${i}`, ['Root']));
      for (let j = 0; j < 9; j++) classes.push(cls(`Item${i}x${j}`, [`Group${i}`]));
    }
    await stub(page, classes);
    await page.goto(`${base}?view=diagram`);
    const prompt = page.getByTestId('large-diagram');
    await expect(prompt).toContainText(`${classes.length} classes`);
    await expect(page.getByTestId('class-diagram')).toHaveCount(0);

    await prompt.getByRole('group', { name: 'Start from a class' }).getByRole('button').first().click();
    await expect(page).toHaveURL(/around=/);
    const d = page.getByTestId('class-diagram');
    await expect(d.locator('[data-node]').first()).toBeVisible();
    expect(await d.locator('[data-node]').count()).toBeLessThan(30);

    await page.getByRole('button', { name: 'Show entire ontology' }).click();
    await page.getByRole('button', { name: `Draw all ${classes.length} classes anyway` }).click();
    await expect(d.locator('[data-node]')).toHaveCount(classes.length);
    // Fitting a drawing this size needs to zoom out well past 20%.
    const frame = (await d.boundingBox())!;
    for (const n of [d.locator('[data-node]').first(), d.locator('[data-node]').last()]) {
      const b = (await n.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(frame.x - 1);
      expect(b.x + b.width).toBeLessThanOrEqual(frame.x + frame.width + 1);
    }
  });

  test('a long class list is shown in pages, and the selected class is always in it', async ({ page }) => {
    const classes = Array.from({ length: 450 }, (_, i) => cls(`Class${String(i).padStart(3, '0')}`));
    await stub(page, classes);
    await page.goto(`${base}?term=${encodeURIComponent(NS + 'Class449')}`);
    await expect(tree(page).getByRole('treeitem', { name: /^Class449/ })).toHaveAttribute('aria-selected', 'true');
    await expect(tree(page).getByRole('treeitem', { name: /^Class399/ })).toHaveCount(1);
    await expect(tree(page).getByRole('treeitem', { name: /^Class400/ })).toHaveCount(0);
    // The selected row is the tree's tab stop.
    await expect(tree(page).locator('[role="treeitem"][tabindex="0"]')).toHaveAccessibleName(/^Class449/);
    await page.getByRole('button', { name: /^Show more classes/ }).click();
    await expect(tree(page).getByRole('treeitem', { name: /^Class400/ })).toHaveCount(1);
    await expect(page.getByRole('button', { name: /^Show more classes/ })).toHaveCount(0);
  });

  test('long class names wrap instead of being cut off', async ({ page }) => {
    const long = 'Organisation that coordinates volunteering opportunities across several regional partners';
    await stub(page, [{ ...cls('Long'), label: long }]);
    await page.goto(base);
    const row = tree(page).getByRole('treeitem', { name: new RegExp(`^${long}`) });
    await expect(row).toBeVisible();
    const clipped = await row.evaluate((el) => [...el.querySelectorAll('span')].some((s) => s.scrollWidth > s.clientWidth + 1));
    expect(clipped).toBe(false);
  });

  test('long names wrap inside their diagram boxes and the exported drawing', async ({ page }) => {
    const long = 'Organisation that coordinates volunteering opportunities across several regional partners';
    const word = 'Supercalifragilisticexpialidociousorganisationalidentifierwithoutanyspaces';
    const classes = [
      { ...cls('Long', [], [{ property: NS + 'collaboratesWithAnotherOrganisationOnSharedProgrammes', kind: 'some', filler: NS + 'Long' }]), label: long },
      // CJK text is wider at the regular weight than the bold one in some fonts.
      { ...cls('Word', ['Long'], [{ property: NS + 'cjk', kind: 'some', filler: NS + 'Word' }]), label: word },
      // Only the Arabic letter needs a font with Arabic; the rest is outlined.
      { ...cls('Mixed', ['Long']), label: `ع${'i'.repeat(40)}` },
    ];
    const attr = { ...prop('theFullRegisteredCharityNumberAsRecordedByTheNationalRegulator', { domain: [NS + 'Long'], range: ['http://www.w3.org/2001/XMLSchema#string'] }), kind: 'datatypeProperty' };
    await stub(page, classes, [prop('collaboratesWithAnotherOrganisationOnSharedProgrammes'), { ...prop('cjk'), label: '协调各地区合作伙伴开展志愿服务机会的组织'.repeat(3) }], [attr]);
    await page.goto(`${base}?view=diagram&hops=0`);
    const d = page.getByTestId('class-diagram');
    await expect(d.locator('[data-node]')).toHaveCount(3);
    const overflow = () =>
      d.locator('svg[data-width]').evaluate((svg) => {
        const out: string[] = [];
        const inside = (t: Element, box: DOMRect) => {
          const b = t.getBoundingClientRect();
          if (b.left < box.left - 1 || b.right > box.right + 1 || b.top < box.top - 1 || b.bottom > box.bottom + 1) out.push(`${t.textContent} overflows its box`);
        };
        for (const node of svg.querySelectorAll('[data-node]')) {
          const box = node.querySelector('rect:not([data-focus-ring])')!.getBoundingClientRect();
          for (const t of node.querySelectorAll('text')) inside(t, box);
        }
        // Relationship labels, which turn bold when highlighted, keep some padding in their box.
        for (const edge of svg.querySelectorAll('[data-edge]')) {
          const rect = edge.querySelector('rect');
          const t = edge.querySelector('text');
          if (!rect || !t) continue;
          const r = rect.getBBox();
          const b = t.getBBox();
          if (b.x < r.x + 3 || b.x + b.width > r.x + r.width - 3) out.push(`${t.textContent} (${b.width}) is too wide for its label box (${r.width})`);
        }
        // The export's bounds are data-width by data-height (it adds a margin around them).
        const content = (svg.querySelector('[data-viewport]') as SVGGElement).getBBox();
        const w = Number((svg as SVGSVGElement).dataset.width);
        const h = Number((svg as SVGSVGElement).dataset.height);
        if (content.x < -6 || content.y < -6 || content.x + content.width > w + 1 || content.y + content.height > h + 1) out.push(`content ${JSON.stringify(content)} exceeds ${w}x${h}`);
        return out;
      });
    expect(await overflow()).toEqual([]);
    // Selecting the class highlights its relationships, in bold.
    await d.locator(`[data-node="${NS}Long"]`).click();
    await expect(d.locator(`[data-node="${NS}Long"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(d.locator('[data-edge] text[font-weight="600"]').first()).toBeVisible();
    expect(await overflow()).toEqual([]);

    // The exported file draws its text as outlines, so it looks the same wherever it is opened,
    // whatever fonts are available; only characters Inter lacks (here, CJK) are drawn as text.
    const svgText = await exportSvg(page, d);
    const viewer = await page.context().newPage();
    for (const font of ['DejaVu Serif', 'WenQuanYi Zen Hei Mono']) {
      await viewer.setContent(`<style>body{margin:0} svg *{font-family:'${font}' !important}</style>${svgText}`);
      const problems = await viewer.locator('svg').first().evaluate((svg) => {
        const out: string[] = [];
        const view = svg.getBoundingClientRect();
        const inside = (t: Element, box: DOMRect, what: string) => {
          const b = t.getBoundingClientRect();
          const name = t.closest('[data-node], [data-edge]')?.getAttribute('aria-label')?.slice(0, 40) ?? t.textContent?.slice(0, 40);
          if (b.width && (b.left < box.left - 1 || b.right > box.right + 1)) out.push(`${name} overflows ${what}`);
        };
        const drawn = svg.querySelectorAll('[data-outline] > g > *');
        if (drawn.length < 50) out.push(`only ${drawn.length} outlined glyphs`);
        // Latin text is only in the invisible text layer.
        for (const t of svg.querySelectorAll('[data-outline] text')) if (/[A-Za-z]/.test(t.textContent ?? '')) out.push(`"${t.textContent?.slice(0, 40)}" drawn as text`);
        for (const node of svg.querySelectorAll('[data-node]')) for (const t of node.querySelectorAll('[data-outline] > g > *')) inside(t, node.querySelector('rect:not([data-focus-ring])')!.getBoundingClientRect(), 'its box');
        for (const edge of svg.querySelectorAll('[data-edge]')) {
          const rect = edge.querySelector('rect');
          if (rect) for (const t of edge.querySelectorAll('[data-outline] > g > *')) inside(t, rect.getBoundingClientRect(), 'its label');
        }
        for (const t of drawn) inside(t, view, 'the drawing');
        return out;
      });
      expect(problems, font).toEqual([]);
    }
    // Each outlined label spans the same width as the text on screen.
    await viewer.setContent(svgText);
    const widths = (root: Page | ReturnType<Page['locator']>, sel: string) => root.locator(sel).evaluateAll((els) => els.map((e) => Math.round((e as SVGGraphicsElement).getBBox().width)));
    for (const [live, out] of [
      [`[data-node="${NS}Long"] text`, `[data-node="${NS}Long"] [data-outline]`],
      [`[data-edge="assoc"][data-source="${NS}Long"] text`, `[data-edge="assoc"][data-source="${NS}Long"] [data-outline]`],
    ]) {
      const shown = await widths(d, live);
      const exported = await widths(viewer, out);
      expect(exported.length).toBe(shown.length);
      exported.forEach((w, i) => expect(Math.abs(w - shown[i]), `${out} #${i}`).toBeLessThanOrEqual(2));
    }
    await viewer.close();
    // The full names are still there for assistive technology.
    await expect(d.locator(`[data-node="${NS}Long"]`)).toHaveAttribute('aria-label', new RegExp(`^${long}`));
    await expect(d.locator(`[data-node="${NS}Word"]`)).toHaveAttribute('aria-label', new RegExp(`^${word}`));
  });

  test('every class in a longer subclass cycle can be selected in the tree', async ({ page }) => {
    await stub(page, [cls('Root'), cls('A', ['B']), cls('B', ['C']), cls('C', ['A'])]);
    for (const c of ['A', 'B', 'C']) {
      await page.goto(`${base}?term=${encodeURIComponent(NS + c)}`);
      await expect(tree(page).getByRole('treeitem', { name: new RegExp(`^${c}\\b`) })).toHaveAttribute('aria-selected', 'true');
      await expect(tree(page).getByRole('treeitem', { name: /^Root\b/ })).toBeVisible();
    }
  });

  test('classes in a subclass cycle still appear in the tree', async ({ page }) => {
    await stub(page, [cls('Root'), cls('A', ['B']), cls('B', ['A'])]);
    await page.goto(`${base}?term=${encodeURIComponent(NS + 'B')}`);
    await expect(tree(page).getByRole('treeitem', { name: /^B\b/ })).toHaveAttribute('aria-selected', 'true');
    await expect(tree(page).getByRole('treeitem', { name: /^Root\b/ })).toBeVisible();
  });

  test('every diagram edge of a contradictory property shows the conflict', async ({ page }) => {
    const classes = [cls('Animal'), { ...cls('Cat', ['Animal']), disjointWith: [NS + 'Dog'] }, cls('Dog', ['Animal']), cls('Owner', [], [
      { property: NS + 'hasPet', kind: 'some', filler: NS + 'Cat' },
      { property: NS + 'hasPet', kind: 'some', filler: NS + 'Dog' },
    ])];
    await stub(page, classes, [prop('hasPet', { characteristics: ['functional'] })]);
    await page.goto(`${base}?view=diagram&hops=0`);
    const d = page.getByTestId('class-diagram');
    for (const target of ['Cat', 'Dog']) await expect(d.locator(`[data-edge="assoc"][data-source="${NS}Owner"][data-target="${NS}${target}"]`)).toContainText('conflict');
  });

  test('contradictions and qualified constraints are shown, not merged', async ({ page }) => {
    const classes = [
      cls('Animal'),
      cls('Cat', ['Animal']),
      cls('Dog', ['Animal']),
      cls('Owner', [], [
        { property: NS + 'hasPet', kind: 'max', filler: NS + 'Cat', cardinality: 1 },
        { property: NS + 'hasPet', kind: 'some', filler: NS + 'Dog' },
      ]),
      cls('Breeder', [], [
        { property: NS + 'hasPet', kind: 'max', filler: NS + 'Cat', cardinality: 3 },
        { property: NS + 'hasPet', kind: 'min', filler: NS + 'Cat', cardinality: 2 },
      ]),
      { ...cls('Lonely'), superClassExpressions: ['inverse hasPet min 2 Owner'] },
      cls('Strict', ['Owner'], [
        { property: NS + 'hasPet', kind: 'min', cardinality: 3 },
        { property: NS + 'hasPet', kind: 'max', cardinality: 2 },
      ]),
    ];
    await stub(page, classes, [prop('hasPet', { range: [NS + 'Animal'] })]);
    await page.goto(`${base}?term=${encodeURIComponent(NS + 'Owner')}`);
    const table = page.getByRole('table', { name: 'Properties of Owner' });
    const row = table.getByRole('row').filter({ hasText: 'hasPet' });
    await expect(row.getByRole('cell').nth(1)).toHaveText('1..*');
    await expect(row).toContainText('at most 1 Cat');
    await expect(row).toContainText('at least one Dog');

    await page.goto(`${base}?term=${encodeURIComponent(NS + 'Strict')}`);
    const strict = page.getByRole('table', { name: 'Properties of Strict' }).getByRole('row').filter({ hasText: 'hasPet' });
    await expect(strict).toContainText('Conflict');
    await expect(strict).toContainText('at least 3');

    // The diagram labels the relationships the same way.
    await page.goto(`${base}?view=diagram&hops=0`);
    const d = page.getByTestId('class-diagram');
    await expect(d.locator(`[data-edge="assoc"][data-source="${NS}Owner"][data-target="${NS}Dog"]`)).toContainText('1..*');
    await expect(d.locator(`[data-edge="assoc"][data-source="${NS}Owner"][data-target="${NS}Cat"]`)).toContainText('0..1');
    await expect(d.locator(`[data-edge="assoc"][data-source="${NS}Strict"]`).first()).toContainText('conflict');
    // Several constraints on one type combine into one range of counts.
    await expect(d.locator(`[data-edge="assoc"][data-source="${NS}Breeder"][data-target="${NS}Cat"]`)).toContainText('2..3');

    // Axioms that can't be summarised are shown even when there's no property table.
    await page.goto(`${base}?term=${encodeURIComponent(NS + 'Lonely')}`);
    await expect(page.getByRole('note')).toContainText('inverse hasPet min 2 Owner');
  });
});

test.describe('reduced motion', () => {
  // How many times the drawing (zoom, pan and every node's position) changes, sampled every frame, while
  // an action takes effect: an animation passes through intermediate states, an immediate
  // change goes straight to the end. Counting frames drawn is unreliable on slow machines.
  const changesDuring = async (page: Page, action: () => Promise<void>) => {
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      type Cy = { pan: () => { x: number; y: number }; zoom: () => number; nodes: () => { position: () => { x: number; y: number } }[] };
      const cy = (document.querySelector('[data-testid="ontology-graph"] [data-cy]') as HTMLElement & { cy: Cy }).cy;
      const w = window as unknown as { states: string[]; sampling: boolean };
      // The zoom, the pan and every node's position.
      const state = () => JSON.stringify([Math.round(cy.zoom() * 1000), ...[cy.pan(), ...cy.nodes().map((n) => n.position())].map((p) => [Math.round(p.x), Math.round(p.y)])]);
      w.states = [state()];
      w.sampling = true;
      const tick = () => {
        const s = state();
        if (s !== w.states[w.states.length - 1]) w.states.push(s);
        if (w.sampling) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await action();
    await page.waitForTimeout(1200);
    const states = await page.evaluate(() => {
      const w = window as unknown as { states: string[]; sampling: boolean };
      w.sampling = false;
      return w.states.length;
    });
    return states - 1;
  };

  for (const motion of ['reduce', 'no-preference'] as const) {
    test(`the graph ${motion === 'reduce' ? 'does not animate' : 'animates'} with reduced motion ${motion === 'reduce' ? 'on' : 'off'}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: motion });
      await page.goto(`${base}?view=graph`);
      const g = page.getByTestId('ontology-graph');
      await expect(g).toHaveAttribute('data-ready', 'true');
      await expect(g).toHaveAttribute('data-motion', motion === 'reduce' ? 'reduced' : 'full');
      await page.getByRole('button', { name: 'Terms' }).click();
      const layout = await changesDuring(page, () => page.getByRole('combobox', { name: 'Graph layout' }).selectOption('radial').then(() => {}));
      // Selecting a class recentres on it.
      const centre = await changesDuring(page, () => tree(page).getByRole('treeitem', { name: /^agent\b/ }).first().click());
      if (motion === 'reduce') {
        // Straight to the new layout or position.
        expect(layout).toBeLessThanOrEqual(1);
        expect(centre).toBeLessThanOrEqual(1);
      } else {
        // At least one state on the way.
        expect(layout).toBeGreaterThanOrEqual(2);
        expect(centre).toBeGreaterThanOrEqual(2);
      }
      await expectNoCrash(page);
    });
  }
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
    // The term navigation folds away in the canvas views.
    await expect(tree(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Terms' }).click();
    await item(page, 'agent').click();
    await item(page, 'agent').press('ArrowRight');
    await item(page, 'person').click();
    await expect.poll(() => term(page)).toBe(`${VOL}Person`);
    await expect(page).toHaveURL(/view=graph/);
    await expect(page.getByRole('complementary', { name: 'Term details' }).getByRole('heading', { name: 'person', exact: true })).toBeVisible();
    // Picking a term keeps the whole graph; recentring is a separate action.
    const g = page.getByTestId('ontology-graph');
    await expect(g).not.toHaveAttribute('aria-label', /around/);
    const all = Number((await g.getAttribute('aria-label'))!.match(/Graph of (\d+) classes/)![1]);
    await page.getByRole('button', { name: 'Centre on person' }).click();
    await expect(g).toHaveAttribute('aria-label', /around person/);
    await expect(page).toHaveURL(/around=/);
    const near = Number((await g.getAttribute('aria-label'))!.match(/Graph of (\d+) classes/)![1]);
    expect(near).toBeLessThan(all);
    await page.getByRole('button', { name: 'Show entire ontology' }).click();
    await expect(g).not.toHaveAttribute('aria-label', /around person/);
    await page.getByRole('button', { name: 'Close term details' }).click();
    await expect.poll(() => term(page)).toBeNull();
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
