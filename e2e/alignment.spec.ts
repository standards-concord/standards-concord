import type { Locator } from '@playwright/test';
import { test, expect, signIn, demoOntology, settle } from './fixtures';

/**
 * Pixel alignment of the ontology page header: the chips beside the title share one centre
 * line, the open-changes link lines up with the health chip, and the health breakdown's
 * values start in one column. Checked in every look, since each look restyles the chips.
 */

const LOOKS = ['spec', 'civic', 'workbench', 'classic'] as const;
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
