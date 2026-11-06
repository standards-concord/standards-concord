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

test.describe('moving around the ontology is instant', () => {
  // Each term click, and each search, used to ask the server and show a spinner until it
  // answered. The page already holds the whole ontology, so these now never wait on it.
  test('picking terms, following links and searching show results with the server cut off', async ({ page, consoleGuard }) => {
    consoleGuard.allow(/Failed to load resource|ERR_INTERNET_DISCONNECTED/);
    await page.goto(`${base}?term=${encodeURIComponent(`${VOL}Skill`)}`);
    await settle(page);
    await expect(page.getByRole('heading', { level: 2, name: 'skill' })).toBeVisible();
    const asked: string[] = [];
    await page.route('**/api/**', (route) => {
      asked.push(route.request().url());
      return route.abort('internetdisconnected');
    });

    // "Used by" is worked out here, and its links open the term.
    await page.locator('summary', { hasText: /^Usage/ }).click();
    const usedBy = page.locator('dt', { hasText: /^Used by$/ }).locator('xpath=following-sibling::dd[1]');
    const first = usedBy.getByRole('button').first();
    const name = (await first.innerText()).trim();
    await first.click();
    await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();

    await item(page, 'time commitment').click();
    await expect(page.getByRole('heading', { level: 2, name: 'time commitment' })).toBeVisible();

    await page.getByLabel('Search terms').fill('skill');
    await expect(page.getByText('Search results')).toBeVisible();
    await expect(page.getByRole('button', { name: /^skill/i }).first()).toBeVisible();
    await page.getByLabel('Search terms').fill('zzqxw');
    await expect(page.getByText('No terms match “zzqxw”.')).toBeVisible();

    expect(asked).toEqual([]);
    await expectNoCrash(page);
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

  type Run = { text: string; width: number; weight: string; style: string };
  // Every run of text in an SVG (a text element's rows, or the element itself) as drawn.
  const drawnRuns = async (svg: Element) => {
    await document.fonts.ready;
    return [...svg.querySelectorAll('text')]
      .flatMap((t) => (t.querySelector('tspan') ? [...t.querySelectorAll('tspan')] : [t]))
      .map((t) => {
        const cs = getComputedStyle(t);
        return { text: t.textContent ?? '', width: (t as SVGTextContentElement).getComputedTextLength(), weight: cs.fontWeight, style: cs.fontStyle };
      });
  };
  const onScreen = (d: ReturnType<Page['locator']>) => d.locator('svg[data-width]').evaluate(drawnRuns);
  /** Opens an exported SVG on its own page, as a browser would, and measures its text. */
  async function openExport(page: Page, svgText: string) {
    const viewer = await page.context().newPage();
    await viewer.setContent(`<body style="margin:0">${svgText}</body>`);
    return { viewer, runs: await viewer.locator('svg').first().evaluate(drawnRuns) };
  }
  // Runs the file draws at a different width from the screen: within a pixel, or rounding over
  // a long run in a fallback font (characters Inter lacks).
  const mismatched = (shown: Run[], saved: Run[]) =>
    shown.length !== saved.length
      ? [`${saved.length} runs saved, ${shown.length} on screen`]
      : saved.flatMap((r, i) => (Math.abs(r.width - shown[i].width) > Math.max(1, shown[i].width * 0.002) ? [`${r.text.slice(0, 40)}: ${r.width} drawn, ${shown[i].width} on screen`] : []));
  const fontFaces = (svgText: string) => svgText.match(/@font-face\{/g)?.length ?? 0;

  test('exported diagrams keep real text, carry the font and draw it as on screen', async ({ page }) => {
    // Kerned capitals, arrows Inter draws as one glyph, and enough attributes for the italic
    // "+ 1 more" line.
    const attrs = Array.from({ length: 13 }, (_, i) => ({ ...prop(`AVATAR->WAVE ${i} => ok`, { domain: [NS + 'Kerned'], range: ['http://www.w3.org/2001/XMLSchema#string'] }), kind: 'datatypeProperty' }));
    await stub(page, [{ ...cls('Kerned'), label: 'AVATAR WAVE -> Tokyo' }], [], attrs);
    await page.goto(`${base}?view=diagram&hops=0`);
    const d = page.getByTestId('class-diagram');
    await expect(d.locator('[data-node]')).toHaveCount(1);
    await expect(d.locator('[data-node] text', { hasText: '+ 1 more' })).toHaveAttribute('font-style', 'italic');
    // The screen keeps Inter's normal ligatures and alternates, and uses its real italic.
    const screen = await d.locator('svg[data-width]').evaluate((svg) => {
      const cs = getComputedStyle(svg.querySelector('text')!);
      return { ligatures: cs.fontVariantLigatures, features: cs.fontFeatureSettings, italic: [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'Inter' && f.style === 'italic' && f.status === 'loaded') };
    });
    expect(screen).toEqual({ ligatures: 'normal', features: 'normal', italic: true });

    const svgText = await exportSvg(page, d);
    expect(svgText).toMatch(/@font-face\{font-family:Inter;font-weight:600;font-style:normal;unicode-range:[^;]+;src:url\(data:font\/woff2;base64,/);
    // Only the Latin subset, in the three faces the diagram uses: this text needs nothing else.
    expect(fontFaces(svgText)).toBe(3);
    expect(svgText).toMatch(/<(text|tspan)[^>]*>AVATAR WAVE -&gt; Tokyo</);
    // Nothing is stretched to fit, and nothing is outlined.
    expect(svgText).not.toContain('textLength');
    expect(svgText).not.toContain('<use');

    const shown = await onScreen(d);
    const { viewer, runs } = await openExport(page, svgText);
    expect(runs.length).toBeGreaterThanOrEqual(14);
    expect(runs.map((r) => r.style)).toContain('italic');
    expect(runs.map((r) => r.weight)).toContain('600');
    expect(mismatched(shown, runs)).toEqual([]);
    // Its text can be found and selected.
    expect(await viewer.evaluate(() => (window as unknown as { find: (s: string) => boolean }).find('AVATAR WAVE'))).toBe(true);
    expect(await viewer.evaluate(() => String(getSelection()))).toBe('AVATAR WAVE');
    await viewer.close();
  });

  test('Greek, Cyrillic, Vietnamese and combining accents are drawn in Inter in the file too; emoji are left alone', async ({ page }) => {
    const labels = {
      Greek: 'Οργανισμός εθελοντικής δράσης',
      Cyrillic: 'Добровольческая организация',
      Vietnamese: 'Tổ chức tình nguyện',
      Combining: 'Cafe\u0301 nai\u0308ve',
      Emoji: 'Family 👨‍👩‍👧 🏳️‍🌈 🇬🇧 👍🏽',
    };
    await stub(page, Object.entries(labels).map(([k, label]) => ({ ...cls(k), label })));
    await page.goto(`${base}?view=diagram&hops=0`);
    const d = page.getByTestId('class-diagram');
    await expect(d.locator('[data-node]')).toHaveCount(5);
    const svgText = await exportSvg(page, d);
    // Latin plus the Greek, Cyrillic and Vietnamese subsets (and whichever cover the accents).
    expect(fontFaces(svgText)).toBeGreaterThanOrEqual(4);
    // Emoji keep their shapes: nothing in the file stretches text.
    expect(svgText).not.toContain('textLength');
    const shown = await onScreen(d);
    const { viewer, runs } = await openExport(page, svgText);
    expect(mismatched(shown, runs)).toEqual([]);
    for (const label of Object.values(labels)) expect(runs.map((r) => r.text)).toContain(label);
    await viewer.close();
  });

  test('exporting waits for the font, and saves one consistent state of a changing diagram', async ({ page }) => {
    const rel = 'isTheRegisteredKeeperOfThisParticularPet';
    await stub(page, [cls('Owner', [], [{ property: NS + rel, kind: 'some', filler: NS + 'Pet' }]), cls('Pet')], [prop(rel)]);
    // Hold every Inter file back, so the page first draws (and measures) in a fallback font.
    // (Where Inter is installed system-wide the fallback is Inter too, and this proves less.)
    // The page's own font loads are released last, after the export has its copy.
    let releaseExport!: () => void;
    let releasePage!: () => void;
    const exportHeld = new Promise<void>((r) => (releaseExport = r));
    const pageHeld = new Promise<void>((r) => (releasePage = r));
    await page.route(/inter-.*\.woff2?(\?|$)/, async (route) => {
      const type = route.request().resourceType();
      // (In development, scripts import the files' URLs as modules; those aren't held.)
      if (type === 'font') await pageHeld;
      else if (type !== 'script') await exportHeld;
      await route.continue();
    });
    // (Held fonts hold back the load event too.)
    await page.goto(`${base}?view=diagram&hops=0`, { waitUntil: 'domcontentloaded' });
    const d = page.getByTestId('class-diagram');
    await expect(d.locator('[data-node]')).toHaveCount(2);
    expect(await page.evaluate(() => document.fonts.status)).toBe('loading');
    // Export, and meanwhile select Owner, which makes its relationship label bold (wider); then
    // let the fonts arrive.
    const svgText = await exportSvg(page, d, async () => {
      await d.locator(`[data-node="${NS}Owner"]`).click();
      await expect(d.locator('[data-edge] text[font-weight="600"]').first()).toBeVisible();
      releaseExport();
      await page.waitForTimeout(500);
      releasePage();
    });
    expect(svgText).toMatch(new RegExp(`<text[^>]*font-weight="600"[^>]*>${rel}\\b`));
    // The file matches the page as it is now, laid out again in Inter: the snapshot was taken
    // after the font loaded, and the boxes were sized for it.
    const { viewer, runs } = await openExport(page, svgText);
    expect(runs.length).toBeGreaterThanOrEqual(3);
    expect(mismatched(await onScreen(d), runs)).toEqual([]);
    const sizes = (root: Page) => root.locator('[data-node] rect:not([data-focus-ring])').evaluateAll((els) => els.map((e) => Math.round((e as SVGGraphicsElement).getBBox().width)));
    expect(await sizes(viewer)).toEqual(await sizes(page));
    await viewer.close();
  });

  test('a diagram can be saved as a PNG at twice its size', async ({ page }) => {
    await stub(page, [cls('Owner'), cls('Pet')]);
    await page.goto(`${base}?view=diagram&hops=0`);
    const d = page.getByTestId('class-diagram');
    await expect(d.locator('[data-node]')).toHaveCount(2);
    const size = await d.locator('svg[data-width]').evaluate((svg) => [Number((svg as SVGSVGElement).dataset.width) + 40, Number((svg as SVGSVGElement).dataset.height) + 40]);
    const download = page.waitForEvent('download');
    await d.getByRole('button', { name: 'Download as PNG' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.png$/);
    const png = readFileSync(await file.path());
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual(size.map((n) => n * 2));
  });

  test('the first PNG saved draws every label, in every script', async ({ page }) => {
    // Straight after the page opens, before the file's embedded fonts have ever been used.
    const labels = ['Οργανισμός εθελοντών', 'Добровольческая организация', 'Tổ chức tình nguyện', 'Cafe\u0301 nai\u0308ve', 'Plain Latin'];
    await stub(page, labels.map((label, i) => ({ ...cls(`C${i}`), label })));
    await page.goto(`${base}?view=diagram&hops=0`);
    const d = page.getByTestId('class-diagram');
    await expect(d.locator('[data-node]')).toHaveCount(labels.length);
    const download = page.waitForEvent('download');
    await d.getByRole('button', { name: 'Download as PNG' }).click();
    const png = readFileSync(await (await download).path()).toString('base64');
    // Where each title is drawn, in the drawing's coordinates (the file adds a 20 px margin).
    const areas = await d.locator('svg[data-width]').evaluate((svg) => {
      const m = (svg.querySelector('[data-viewport]') as SVGGElement).getScreenCTM()!.inverse();
      return [...svg.querySelectorAll('[data-node] text[data-title]')].map((t) => {
        const r = t.getBoundingClientRect();
        const a = new DOMPoint(r.left, r.top).matrixTransform(m);
        const b = new DOMPoint(r.right, r.bottom).matrixTransform(m);
        return { text: t.textContent ?? '', x: a.x + 20, y: a.y + 20, w: b.x - a.x, h: b.y - a.y };
      });
    });
    expect(areas).toHaveLength(labels.length);
    const viewer = await page.context().newPage();
    const blank = await viewer.evaluate(
      async ({ png, areas }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${png}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        const k = 2;
        return areas
          .filter((a) => {
            const px = ctx.getImageData(Math.floor(a.x * k), Math.floor(a.y * k), Math.ceil(a.w * k), Math.ceil(a.h * k)).data;
            let ink = 0;
            for (let i = 0; i < px.length; i += 4) if (Math.abs(px[i] - px[0]) + Math.abs(px[i + 1] - px[1]) + Math.abs(px[i + 2] - px[2]) > 150) ink++;
            return ink < 20;
          })
          .map((a) => a.text);
      },
      { png, areas },
    );
    expect(blank).toEqual([]);
    await viewer.close();
  });

  test('a PNG matches the SVG drawn in a browser, label by label, however the view is zoomed', async ({ page }) => {
    // Kerning and arrows, an italic "+ 1 more" row, an inherited attribute (a coloured arrow), a
    // CJK relationship, Greek, Cyrillic and Vietnamese, right-to-left text (with directional
    // overrides), emoji (including a white circle, which has little contrast), a blank Hangul
    // filler and a deprecated (struck through) class.
    const attrs = [
      { ...prop('AVATAR -> WAVE => Tokyo', { domain: [NS + 'Base'], range: ['http://www.w3.org/2001/XMLSchema#string'] }), kind: 'datatypeProperty' },
      ...Array.from({ length: 12 }, (_, i) => ({ ...prop(`extra${i}`, { domain: [NS + 'Base'], range: ['http://www.w3.org/2001/XMLSchema#string'] }), kind: 'datatypeProperty' })),
      { ...prop('own', { domain: [NS + 'Kid'], range: ['http://www.w3.org/2001/XMLSchema#string'] }), kind: 'datatypeProperty' },
    ];
    await stub(
      page,
      [
        { ...cls('Base', [], [{ property: NS + 'knows', kind: 'some', filler: NS + 'Kid' }]), label: 'Οργανισμός Организация Tổ chức' },
        { ...cls('Kid', ['Base']), label: `مرحبا ${'i'.repeat(20)} ⚪ 👨‍👩‍👧 🇬🇧 \u3164 Café` },
        { ...cls('Old'), label: '\u202Ereversed\u202C Retired class', deprecated: true },
      ],
      [{ ...prop('knows'), label: '协调 knows' }],
      attrs,
    );
    await page.goto(`${base}?view=diagram&hops=0`);
    const d = page.getByTestId('class-diagram');
    await expect(d.locator('[data-node]')).toHaveCount(3);
    await page.getByRole('button', { name: 'Inherited attributes' }).click();
    await expect(d.locator('[data-node] tspan', { hasText: '↑' }).first()).toBeVisible();
    await expect(d.locator('[data-node] text', { hasText: /^\+ \d+ more/ }).first()).toHaveAttribute('font-style', 'italic');
    // At the fitted view, zoomed in, and zoomed well in (most of the drawing out of view).
    const compare = async (zoom: string) => {
      const svgText = await exportSvg(page, d);
      const download = page.waitForEvent('download');
      await d.getByRole('button', { name: 'Download as PNG' }).click();
      const png = readFileSync(await (await download).path()).toString('base64');
      // Where each run of text is drawn, in the file's coordinates (with its 20 px margin).
      const areas = await d.locator('svg[data-width]').evaluate((svg) => {
        const m = (svg.querySelector('[data-viewport]') as SVGGElement).getScreenCTM()!.inverse();
        return [...svg.querySelectorAll('text')]
          .flatMap((t) => (t.querySelector('tspan') ? [...t.querySelectorAll('tspan')] : [t]))
          .filter((t) => t.textContent?.trim())
          .map((t) => {
            const r = t.getBoundingClientRect();
            const a = new DOMPoint(r.left, r.top).matrixTransform(m);
            const b = new DOMPoint(r.right, r.bottom).matrixTransform(m);
            return { text: t.textContent!.slice(0, 30), x: a.x + 20, y: a.y + 20, w: b.x - a.x, h: b.y - a.y };
          });
      });
      expect(areas.length).toBeGreaterThan(15);
      const viewer = await page.context().newPage();
      const results = await viewer.evaluate(
        async ({ svgText, png, areas }) => {
          const load = async (src: string) => {
            const img = new Image();
            img.src = src;
            await img.decode();
            return img;
          };
          const out = await load(`data:image/png;base64,${png}`);
          const svg = await load(URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' })));
          // The SVG image's embedded fonts load after it decodes; give them time.
          await new Promise((r) => setTimeout(r, 1500));
          const k = out.naturalWidth / svg.naturalWidth;
          const pixels = (img: HTMLImageElement) => {
            const c = document.createElement('canvas');
            c.width = out.naturalWidth;
            c.height = out.naturalHeight;
            const ctx = c.getContext('2d')!;
            ctx.drawImage(img, 0, 0, c.width, c.height);
            return ctx.getImageData(0, 0, c.width, c.height).data;
          };
          const a = pixels(out);
          const b = pixels(svg);
          const width = out.naturalWidth;
          // Each label on its own, so one missing or misplaced label can't hide in the total.
          return areas.map((r) => {
            const x0 = Math.max(0, Math.floor(r.x * k) - 2);
            const y0 = Math.max(0, Math.floor(r.y * k) - 2);
            const x1 = Math.min(width, Math.ceil((r.x + r.w) * k) + 2);
            const y1 = Math.min(out.naturalHeight, Math.ceil((r.y + r.h) * k) + 2);
            const bg = (y0 * width + x0) * 4;
            let inkA = 0;
            let inkB = 0;
            let differ = 0;
            for (let y = y0; y < y1; y++)
              for (let x = x0; x < x1; x++) {
                const i = (y * width + x) * 4;
                const da = Math.abs(a[i] - b[bg]) + Math.abs(a[i + 1] - b[bg + 1]) + Math.abs(a[i + 2] - b[bg + 2]);
                const db = Math.abs(b[i] - b[bg]) + Math.abs(b[i + 1] - b[bg + 1]) + Math.abs(b[i + 2] - b[bg + 2]);
                if (da > 60) inkA++;
                if (db > 60) inkB++;
                if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 120) differ++;
              }
            return { text: r.text, inkA, inkB, ratio: differ / Math.max(1, inkA, inkB) };
          });
        },
        { svgText, png, areas },
      );
      for (const r of results) {
        expect(r.inkB, `${zoom}: ${r.text} drawn in the SVG`).toBeGreaterThan(10);
        expect(r.ratio, `${zoom}: ${r.text}: ${JSON.stringify(r)}`).toBeLessThan(0.05);
      }
      await viewer.close();
    };
    for (const steps of [0, 3, 5]) {
      for (let i = 0; i < steps; i++) await d.getByRole('button', { name: 'Zoom in' }).click();
      await compare(await d.getByLabel(/^Zoom \d+ percent$/).innerText());
    }
  });

  test('a PNG of a large diagram is saved within the size budget', async ({ page }) => {
    // Every canvas the export makes, including the one that checks the fonts, stays in budget.
    await page.addInitScript(() => {
      const sizes: number[][] = ((window as unknown as { canvasSizes: number[][] }).canvasSizes = []);
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...a: Parameters<typeof getContext>) {
        sizes.push([this.width, this.height]);
        return getContext.apply(this, a);
      } as typeof getContext;
    });
    const classes = [];
    const attrs = [];
    for (let i = 0; i < 500; i++) {
      classes.push(cls(`Class${i}`));
      for (let j = 0; j < 12; j++) attrs.push({ ...prop(`attributeNumber${j}OfClass${i}`, { domain: [NS + `Class${i}`], range: ['http://www.w3.org/2001/XMLSchema#string'] }), kind: 'datatypeProperty' });
    }
    await stub(page, classes, [], attrs);
    await page.goto(`${base}?view=diagram&hops=0`);
    await page.getByRole('button', { name: /^Draw all \d+ classes anyway/ }).click();
    const d = page.getByTestId('class-diagram');
    await expect(d.locator('[data-node]')).toHaveCount(500);
    const download = page.waitForEvent('download');
    await d.getByRole('button', { name: 'Download as PNG' }).click();
    const png = readFileSync(await (await download).path());
    const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
    expect(Math.max(w, h)).toBeLessThanOrEqual(16_384);
    expect(w * h).toBeLessThanOrEqual(64_000_000);
    await expect(d.getByRole('alert')).toHaveCount(0);
    for (const [cw, ch] of await page.evaluate(() => (window as unknown as { canvasSizes: number[][] }).canvasSizes)) {
      expect(Math.max(cw, ch)).toBeLessThanOrEqual(16_384);
      expect(cw * ch).toBeLessThanOrEqual(64_000_000);
    }
  });

  test('labels with only accents or punctuation in a subset still save as PNG', async ({ page }) => {
    // Decomposed accents (each subset's only characters here are combining marks), a lone full
    // stop, and a combining grave on its own.
    const labels = ['Cafe\u0301', 're\u0301sume\u0301', '.', 'a\u0300', '\u0300'];
    await stub(page, labels.map((label, i) => ({ ...cls(`C${i}`), label })));
    await page.goto(`${base}?view=diagram&hops=0`);
    const d = page.getByTestId('class-diagram');
    await expect(d.locator('[data-node]')).toHaveCount(labels.length);
    const download = page.waitForEvent('download');
    await d.getByRole('button', { name: 'Download as PNG' }).click();
    expect(readFileSync(await (await download).path()).subarray(1, 4).toString()).toBe('PNG');
    await expect(d.getByRole('alert')).toHaveCount(0);
  });

  test('transparent pixels never count as a loaded font', async ({ page }) => {
    // A canvas that reads back transparent black (as when nothing was drawn): the font check must
    // not mistake it for dark ink and save an image whose labels may still be blank.
    await page.addInitScript(() => {
      const getImageData = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = function (this: CanvasRenderingContext2D, ...a: Parameters<typeof getImageData>) {
        const real = getImageData.apply(this, a);
        return new ImageData(new Uint8ClampedArray(real.data.length), real.width, real.height);
      } as typeof getImageData;
    });
    await stub(page, [cls('Owner'), cls('Pet')]);
    await page.goto(`${base}?view=diagram&hops=0`);
    const d = page.getByTestId('class-diagram');
    await expect(d.locator('[data-node]')).toHaveCount(2);
    let downloads = 0;
    page.on('download', () => downloads++);
    await d.getByRole('button', { name: 'Download as PNG' }).click();
    await expect(d.getByRole('alert')).toContainText("fonts didn't load", { timeout: 15_000 });
    expect(downloads).toBe(0);
  });

  test('a PNG too large for the browser is saved smaller, and one it cannot make says so', async ({ page }) => {
    // A browser that can't allocate canvases above a given size (as large canvases fail on
    // memory-constrained devices), and then one that can't encode any PNG at all.
    await page.addInitScript(() => {
      const w = window as unknown as { canvasLimit?: number; failEncode?: boolean; failNext?: number };
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...a: Parameters<typeof getContext>) {
        if (w.failNext && w.failNext-- > 0) return null;
        return w.canvasLimit && this.width * this.height > w.canvasLimit ? null : getContext.apply(this, a);
      } as typeof getContext;
      const toBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, cb: BlobCallback, ...a: [string?, number?]) {
        return w.failEncode ? setTimeout(() => cb(null)) && undefined : toBlob.call(this, cb, ...a);
      };
    });
    await stub(page, [cls('Owner'), cls('Pet')]);
    await page.goto(`${base}?view=diagram&hops=0`);
    const d = page.getByTestId('class-diagram');
    await expect(d.locator('[data-node]')).toHaveCount(2);
    const [w, h] = await d.locator('svg[data-width]').evaluate((svg) => [Number((svg as SVGSVGElement).dataset.width) + 40, Number((svg as SVGSVGElement).dataset.height) + 40]);
    await page.evaluate((limit) => ((window as unknown as { canvasLimit: number }).canvasLimit = limit), w * h * 4 - 1);
    const download = page.waitForEvent('download');
    await d.getByRole('button', { name: 'Download as PNG' }).click();
    const png = readFileSync(await (await download).path());
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([w, h]);
    await expect(d.getByRole('alert')).toHaveCount(0);

    await page.evaluate(() => ((window as unknown as { failEncode: boolean }).failEncode = true));
    let downloads = 0;
    page.on('download', () => downloads++);
    await d.getByRole('button', { name: 'Download as PNG' }).click();
    await expect(d.getByRole('alert')).toContainText("Couldn't save the diagram as PNG");
    expect(downloads).toBe(0);
    // No canvas for the small check that the fonts have loaded (the first one the export asks
    // for): it says so, rather than saving an image that may be missing its labels.
    await page.evaluate(() => {
      const w = window as unknown as { failEncode: boolean; failNext: number };
      w.failEncode = false;
      w.failNext = 1;
    });
    await d.getByRole('button', { name: 'Download as PNG' }).click();
    await expect(d.getByRole('alert')).toContainText("Couldn't save the diagram as PNG");
    expect(downloads).toBe(0);
    // Trying again clears the message once it works.
    const again = page.waitForEvent('download');
    await d.getByRole('button', { name: 'Download as PNG' }).click();
    await again;
    await expect(d.getByRole('alert')).toHaveCount(0);
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
    // The diagram's own markup and about 80 kB of embedded font (the Latin subset, three faces).
    expect(svgText.length).toBeLessThan(plain * 1.1 + 150_000);
    expect(took).toBeLessThan(5_000);
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
      // Right-to-left text with Latin in it.
      { ...cls('Mixed', ['Long']), label: `ع${'i'.repeat(150)}` },
      // Inter draws "=>" as one arrow; measuring has to shape it the same way as the screen.
      { ...cls('Arrows', ['Long']), label: 'a => b => c => d => e => f => g => h => i => j => k => l => m => n => o => p => q' },
    ];
    const attr = { ...prop('theFullRegisteredCharityNumberAsRecordedByTheNationalRegulator', { domain: [NS + 'Long'], range: ['http://www.w3.org/2001/XMLSchema#string'] }), kind: 'datatypeProperty' };
    await stub(page, classes, [prop('collaboratesWithAnotherOrganisationOnSharedProgrammes'), { ...prop('cjk'), label: '协调各地区合作伙伴开展志愿服务机会的组织'.repeat(3) }], [attr]);
    await page.goto(`${base}?view=diagram&hops=0`);
    const d = page.getByTestId('class-diagram');
    await expect(d.locator('[data-node]')).toHaveCount(4);
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
    // (Polled: until every font has loaded, a fallback can draw text a little wider.)
    await expect.poll(overflow).toEqual([]);
    // Selecting the class highlights its relationships, in bold.
    await d.locator(`[data-node="${NS}Long"]`).click();
    await expect(d.locator(`[data-node="${NS}Long"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(d.locator('[data-edge] text[font-weight="600"]').first()).toBeVisible();
    await expect.poll(overflow).toEqual([]);

    // Saved and reopened, the file draws every label at its on-screen width, inside its box.
    const svgText = await exportSvg(page, d);
    expect(svgText).not.toContain('textLength');
    const shown = await onScreen(d);
    const reopened = await openExport(page, svgText);
    expect(reopened.runs.length).toBeGreaterThan(8);
    expect(mismatched(shown, reopened.runs)).toEqual([]);
    await reopened.viewer.setContent(`<body style="margin:0">${svgText}</body>`);
    const saved = reopened.viewer.locator('svg').first();
    expect(await saved.evaluate((svg) => document.fonts.ready.then(() => svg.querySelectorAll('[data-node]').length))).toBe(4);
    // (The same checks as on screen, run on the file.)
    const problems = await saved.evaluate((svg) => {
      const out: string[] = [];
      for (const node of svg.querySelectorAll('[data-node]')) {
        const box = node.querySelector('rect:not([data-focus-ring])')!.getBoundingClientRect();
        for (const t of node.querySelectorAll('text')) {
          const b = t.getBoundingClientRect();
          if (b.left < box.left - 1 || b.right > box.right + 1) out.push(`${t.textContent?.slice(0, 40)} overflows its box`);
        }
      }
      for (const edge of svg.querySelectorAll('[data-edge]')) {
        const rect = edge.querySelector('rect');
        const t = edge.querySelector('text');
        if (!rect || !t) continue;
        const r = rect.getBBox();
        const b = t.getBBox();
        if (b.x < r.x + 3 || b.x + b.width > r.x + r.width - 3) out.push(`${t.textContent} (${b.width}) is too wide for its label box (${r.width})`);
      }
      const view = svg.getBoundingClientRect();
      for (const t of svg.querySelectorAll('text')) {
        const b = t.getBoundingClientRect();
        if (b.left < view.left || b.right > view.right) out.push(`${t.textContent?.slice(0, 40)} is outside the drawing`);
      }
      return out;
    });
    expect(problems).toEqual([]);
    await reopened.viewer.close();
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
