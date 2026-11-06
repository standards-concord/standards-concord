import type { Locator } from '@playwright/test';
import { test, expect, signIn, demoOntology, settle } from './fixtures';

/**
 * Pixel alignment of the ontology page header: the chips beside the title share one centre
 * line, the open-changes link lines up with the health chip, and the health breakdown's
 * values start in one column. Checked in every look, since each look restyles the chips.
 */

const LOOKS = ['odi', 'spec', 'civic', 'workbench', 'classic'] as const;
/** Sub-pixel rounding only. The reported misalignment was 3-4px. */
const TOLERANCE = 1;

async function box(l: Locator) {
  const b = await l.boundingBox();
  if (!b) throw new Error(`no bounding box for ${l}`);
  return b;
}
const centreY = (b: { y: number; height: number }) => b.y + b.height / 2;

async function expectSameCentre(a: Locator, b: Locator, what: string) {
  const [ba, bb] = [await box(a), await box(b)];
  expect(Math.abs(centreY(ba) - centreY(bb)), `${what}: centres ${centreY(ba).toFixed(1)} vs ${centreY(bb).toFixed(1)}`).toBeLessThanOrEqual(TOLERANCE);
}

test.describe('ontology header alignment', () => {
  let demo: { id: string; title: string };
  test.beforeEach(async ({ page, request }) => {
    await signIn(page, { name: 'Alignment tester', role: 'steward' });
    demo = await demoOntology(request);
  });

  for (const look of LOOKS) {
    test(`chips line up in the ${look} look`, async ({ page }) => {
      await page.goto(`/o/${demo.id}?look=${look}`);
      await settle(page);
      const stage = page.getByRole('button', { name: /^Lifecycle stage: / });
      const demoBadge = page.locator('.ui-badge', { hasText: /^Demo$/ });
      const health = page.getByRole('button', { name: /^Health: / });
      const changes = page.getByRole('link', { name: /^\d+ open changes?$/ });
      await expect(stage).toBeVisible();
      await expect(demoBadge).toBeVisible();
      await expect(health).toBeVisible();

      await expectSameCentre(demoBadge, stage, 'Demo badge vs lifecycle stage');
      await expectSameCentre(stage, page.getByRole('heading', { level: 1, name: demo.title }), 'lifecycle stage vs title');
      // The two chips are the same height, so their tops and bottoms line up too.
      const [bd, bs] = [await box(demoBadge), await box(stage)];
      expect(Math.abs(bd.height - bs.height), `Demo ${bd.height}px tall, stage ${bs.height}px`).toBeLessThanOrEqual(TOLERANCE);

      // The link only shows while changes are open; the demo starts with some, but other specs may merge them.
      if (await changes.count()) await expectSameCentre(changes, health, 'open changes vs health chip');
      // The health chip's wrapper hugs it, so nothing below it pushes the row out of line.
      const wrapper = health.locator('xpath=..');
      const [bh, bw] = [await box(health), await box(wrapper)];
      expect(Math.abs(bh.height - bw.height), `health chip ${bh.height}px, wrapper ${bw.height}px`).toBeLessThanOrEqual(TOLERANCE);
    });

    test(`health breakdown values share one column in the ${look} look`, async ({ page }) => {
      await page.goto(`/o/${demo.id}?look=${look}`);
      await settle(page);
      await page.getByRole('button', { name: /^Health: / }).click();
      const panel = page.getByRole('dialog', { name: /^Health: / });
      const rows = panel.getByRole('listitem');
      await expect(rows).toHaveCount(4);
      const labels = await Promise.all((await rows.all()).map((r) => box(r.locator('[data-health-label]'))));
      const values = await Promise.all((await rows.all()).map((r) => box(r.locator('[data-health-value]'))));
      const labelX = labels.map((b) => b.x);
      const valueX = values.map((b) => b.x);
      for (const x of labelX) expect(Math.abs(x - labelX[0]), `label x ${labelX.join(', ')}`).toBeLessThanOrEqual(TOLERANCE);
      for (const x of valueX) expect(Math.abs(x - valueX[0]), `value x ${valueX.join(', ')}`).toBeLessThanOrEqual(TOLERANCE);
      // Values sit to the right of every label, never under one.
      const labelRight = Math.max(...labels.map((b) => b.x + b.width));
      expect(valueX[0]).toBeGreaterThan(labelRight);
    });
  }
});

const VOL = 'https://w3id.org/odi/volunteering#';

/** The left edge of every line a piece of text wraps onto. */
async function lineLefts(l: Locator) {
  return l.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    // One rect per line box (Chromium can split a line at a space, so merge rects on the same line).
    const byLine = new Map<number, number>();
    for (const r of Array.from(range.getClientRects())) {
      const top = Math.round(r.top);
      byLine.set(top, Math.min(byLine.get(top) ?? Infinity, r.left));
    }
    return [...byLine.values()];
  });
}

test.describe('class page alignment and type names', () => {
  let demo: { id: string; title: string };
  test.beforeEach(async ({ page, request }) => {
    // Reading a class page needs no special role, so a contributor sees exactly what a steward does.
    await signIn(page, { name: 'Alignment reader', role: 'contributor' });
    demo = await demoOntology(request);
  });

  test('a property name that wraps onto two lines stays left-aligned', async ({ page }) => {
    // Browsers centre a button's text, so "has accessibility feature" wrapped and sat centred
    // under the left-aligned property names around it (reported on the Volunteering opportunity class).
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`/o/${demo.id}/browse?term=${encodeURIComponent(`${VOL}VolunteeringOpportunity`)}`);
    await settle(page);
    const table = page.getByRole('table', { name: /^Properties of / });
    const name = table.getByRole('rowheader', { name: /^has accessibility feature/ }).getByRole('button', { name: 'has accessibility feature' });
    await expect(name).toBeVisible();
    const lefts = await lineLefts(name);
    expect(lefts.length, 'the name should wrap at phone width, or this test checks nothing').toBeGreaterThan(1);
    for (const x of lefts) expect(Math.abs(x - lefts[0]), `line starts ${lefts.map((v) => v.toFixed(1)).join(', ')}`).toBeLessThanOrEqual(TOLERANCE);
    // And the name starts where a one-line name in the next row does.
    const short = table.getByRole('rowheader', { name: /^has role/ }).getByRole('button', { name: 'has role' });
    expect(Math.abs(lefts[0] - (await box(short)).x)).toBeLessThanOrEqual(TOLERANCE);
  });

  test('well-known XSD types read as plain names, not xsd: names', async ({ page }) => {
    // The Expected type column and the Range row used to show "xsd:string" and "xsd:nonNegativeInteger".
    await page.goto(`/o/${demo.id}/browse?term=${encodeURIComponent(`${VOL}VolunteeringOpportunity`)}`);
    await settle(page);
    const table = page.getByRole('table', { name: /^Properties of / });
    const titleRow = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: /^title/ }) });
    await expect(titleRow.getByRole('cell').first()).toHaveText('String');
    await expect(titleRow.getByTitle('xsd:string')).toHaveText('String');
    await expect(table).not.toContainText('xsd:');

    await page.goto(`/o/${demo.id}/browse?term=${encodeURIComponent(`${VOL}minimumAge`)}`);
    await settle(page);
    const range = page.getByText('Range', { exact: true }).locator('xpath=following-sibling::dd[1]');
    await expect(range).toHaveText('Non-negative integer');
    await expect(range.getByTitle('xsd:nonNegativeInteger')).toBeVisible();
    // A datatype isn't a term of the ontology, so it isn't a link to a missing page.
    await expect(range.getByRole('button')).toHaveCount(0);
  });

  test('"Subclass of" lines up with its value', async ({ page }) => {
    // The small label sat a few pixels above its value's baseline.
    await page.goto(`/o/${demo.id}/browse?term=${encodeURIComponent(`${VOL}VolunteeringOpportunity`)}`);
    await settle(page);
    const label = page.getByText('Subclass of', { exact: true });
    const value = label.locator('xpath=following-sibling::dd[1]');
    // A zero-size inline box sits on the first line's baseline.
    const baseline = (l: Locator) =>
      l.evaluate((el) => {
        const probe = document.createElement('span');
        probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
        el.prepend(probe);
        const y = probe.getBoundingClientRect().top;
        probe.remove();
        return y;
      });
    expect(Math.abs((await baseline(label)) - (await baseline(value)))).toBeLessThanOrEqual(TOLERANCE);
  });
});

test.describe('lists that line up', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, { name: 'Alignment steward', role: 'steward' });
  });

  test('governance rules start in one column, whatever the level badge says', async ({ page, request }) => {
    // The Patch, Minor and Major badges shrank to their text, so each rule started at a different x.
    const demo = await demoOntology(request);
    await page.goto(`/o/${demo.id}/governance`);
    await settle(page);
    for (const name of ['What each kind of change needs', 'What each kind of release needs']) {
      const rows = await page.getByRole('list', { name }).getByRole('listitem').all();
      expect(rows).toHaveLength(3);
      const starts = await Promise.all(rows.map(async (r) => (await box(r.locator(':scope > span').last())).x));
      for (const x of starts) expect(Math.abs(x - starts[0]), `${name}: ${starts.join(', ')}`).toBeLessThanOrEqual(TOLERANCE);
    }
  });

  test('system events in the activity feed get a round icon the size of an avatar', async ({ page }) => {
    // The robot icon's background stretched into a tall pill beside multi-line events.
    await page.goto('/');
    await settle(page);
    const icon = page.locator('ol li span:has(> svg.lucide-bot)').first();
    await expect(icon).toBeVisible();
    const b = await box(icon);
    expect(Math.abs(b.width - b.height), `icon ${b.width}x${b.height}`).toBeLessThanOrEqual(TOLERANCE);
    const avatar = page.locator('ol [data-avatar]').first();
    if (await avatar.count()) expect(Math.abs((await box(avatar)).width - b.width)).toBeLessThanOrEqual(TOLERANCE);
  });

  test('the masthead never cuts "Concord" short on a phone', async ({ page }) => {
    // With the ODI logo as well as Concord's, the word was truncated to "C…" at phone width.
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/?look=odi');
    await settle(page);
    const home = page.getByRole('link', { name: 'Concord: home' });
    // Hiding the word is fine (Concord's mark is still there); showing part of it isn't.
    const word = home.locator('span', { hasText: /^Concord/ }).first();
    if (await word.isVisible()) {
      const clipped = await word.evaluate((el) => el.scrollWidth > el.clientWidth);
      expect(clipped).toBe(false);
    }
    await expect(home).toBeVisible();
  });
});
