import { test, expect, expectNoCrash, settle, signIn, demoOntology } from './fixtures';

/**
 * The second GPT-6 Astra review: honest summaries (health and governance), accessible popups,
 * disclosures that reopen when they should, and the overview and approval layouts.
 */

test.describe('summaries, popups and disclosures', () => {
  let demo: { id: string; title: string };
  test.beforeEach(async ({ page, request }) => {
    await signIn(page, { name: 'Disclosure tester', role: 'steward' });
    demo = await demoOntology(request);
  });

  test('the health chip says when a required check could not run', async ({ page }) => {
    const o = (await (await page.request.get(`/api/ontologies/${demo.id}`)).json()) as { health?: { consistent: boolean; errors: number; incomplete?: string[]; reasoner?: string } };
    expect(o.health, 'the summary carries health').toBeTruthy();
    expect(Array.isArray(o.health!.incomplete), 'health lists checks that could not run').toBeTruthy();
    await page.goto(`/o/${demo.id}`);
    const chip = page.getByRole('button', { name: /^Health: / });
    await chip.click();
    const panel = page.getByRole('dialog', { name: /^Health: / });
    const reasonerRow = panel.getByRole('listitem').filter({ hasText: 'Reasoner' });
    if (o.health!.incomplete!.length) {
      // Without the OWL reasoner, the chip must not claim the draft is healthy.
      await expect(chip).toContainText(o.health!.consistent && !o.health!.errors ? 'Checks incomplete' : 'Needs fixing');
      await expect(reasonerRow).toContainText(/Not run|Inconsistent/);
      await expect(panel.getByRole('note')).toContainText('Not every check could run');
      // The popup's overall verdict says what the pass covers, too.
      await expect(panel.getByRole('listitem').filter({ hasText: 'Overall validation' })).not.toContainText(/Passed$/);
      if (!o.health!.errors) await expect(panel.getByRole('listitem').filter({ hasText: 'Overall validation' })).toContainText('Available checks passed, reasoning incomplete');
    } else {
      await expect(chip).not.toContainText('Checks incomplete');
      await expect(reasonerRow).not.toContainText('Not run');
    }
  });

  test('following a link to #health focuses the section straight away, even while the report is still loading', async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route(/\/api\/ontologies\/[^/]+\/validation/, async (route) => {
      await held;
      await route.continue();
    });
    await page.goto(`/o/${demo.id}#health`);
    const health = page.locator('#health');
    await expect(health.getByText('Validating…')).toBeVisible();
    await expect(health).toBeFocused();
    // Move on before the report arrives: when it lands, focus stays where the reader put it.
    await page.getByRole('button', { name: /Ontology details/ }).focus();
    release();
    await expect(health.getByRole('button', { name: /Lint findings/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Ontology details/ })).toBeFocused();
  });

  test('on a very short screen a popup uses the whole height rather than going off screen', async ({ page }) => {
    await page.goto(`/o/${demo.id}`);
    await settle(page);
    const bubble = page.getByRole('button', { name: /^Lifecycle stage: / });
    const panel = page.getByRole('dialog', { name: /^Lifecycle stage/ });
    const inView = async (vh: number) => {
      const box = (await panel.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(vh);
    };
    for (const vh of [100, 60]) {
      await page.setViewportSize({ width: 1000, height: vh });
      // The sticky header covers most of a screen this short, so use the keyboard rather than a click.
      await bubble.focus();
      await bubble.press('Enter');
      await expect(panel).toBeVisible();
      await inView(vh);
      // Neither side of the trigger has room for the panel, so it takes the whole height instead.
      await expect(panel).toHaveAttribute('data-placement', 'screen');
      // Scrolling past the end of the panel doesn't move the page behind it or carry the panel away.
      const scrollY = await page.evaluate(() => window.scrollY);
      await panel.hover({ force: true });
      for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 400);
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
      await inView(vh);
      await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);
      // Closing it gives the page its scrolling back.
      expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe('');
    }
    // Back at a normal height, it sits next to its trigger again.
    await bubble.press('Enter');
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect(panel).not.toHaveAttribute('data-placement', 'screen');
    await inView(800);
  });

  test('detailed validation never says a plain “Passed” when the reasoner did not run', async ({ page }) => {
    const o = (await (await page.request.get(`/api/ontologies/${demo.id}`)).json()) as { health?: { errors: number; incomplete?: string[] } };
    test.skip(!o.health?.incomplete?.length, 'the reasoner ran here, so a plain pass is honest');
    await page.goto(`/o/${demo.id}#health`);
    await settle(page);
    const health = page.locator('#health');
    await expect(health).toBeFocused();
    await expect(health.getByText('Not run', { exact: true })).toBeVisible();
    await expect(health.getByText('Passed', { exact: true })).toHaveCount(0);
    if (!o.health!.errors) await expect(health.getByText('Available checks passed, reasoning incomplete')).toBeVisible();
  });

  test('popups take focus, return it on Escape, and close when tabbing away', async ({ page }) => {
    await page.goto(`/o/${demo.id}`);
    const bubble = page.getByRole('button', { name: /^Lifecycle stage: / });
    await bubble.click();
    const panel = page.getByRole('dialog', { name: /^Lifecycle stage/ });
    await expect(panel).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(bubble).toBeFocused();
    // Keyboard only: Enter opens, Tab out closes.
    await page.keyboard.press('Enter');
    await expect(panel).toBeVisible();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(panel).toHaveCount(0);
  });

  test('popups stay inside the viewport on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(`/o/${demo.id}`);
    await settle(page);
    for (const name of [/^Lifecycle stage: /, /^Health: /, /^Simulated clock/]) {
      const trigger = page.getByRole('button', { name }).first();
      if (!(await trigger.isVisible())) continue;
      await trigger.click();
      const box = (await page.getByRole('dialog', { name }).boundingBox())!;
      expect(box.x, `${name} left edge`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${name} right edge`).toBeLessThanOrEqual(360);
      await page.keyboard.press('Escape');
    }
  });

  test('following the health link again reopens lint findings on the overview', async ({ page }) => {
    await page.goto(`/o/${demo.id}`);
    await settle(page);
    const lint = page.locator('#health').getByRole('button', { name: /Lint findings/ });
    await expect(lint).toBeVisible();
    if ((await lint.getAttribute('aria-expanded')) === 'true') await lint.click();
    await expect(lint).toHaveAttribute('aria-expanded', 'false');
    // The overview is already mounted; the link must still open lint.
    await page.getByRole('button', { name: /^Health: / }).click();
    await page.getByRole('dialog', { name: /^Health: / }).getByRole('link', { name: /full report/ }).click();
    await expect(lint).toHaveAttribute('aria-expanded', 'true');
    // And again, after closing it, while already on #health.
    await lint.click();
    await page.getByRole('button', { name: /^Health: / }).click();
    await page.getByRole('dialog', { name: /^Health: / }).getByRole('link', { name: /full report/ }).click();
    await expect(lint).toHaveAttribute('aria-expanded', 'true');
  });

  test('validation groups keep their inner state when closed and reopened', async ({ page }) => {
    await page.goto(`/o/${demo.id}`);
    await settle(page);
    const health = page.locator('#health');
    const cqs = health.getByRole('button', { name: /Competency questions/ });
    if ((await cqs.getAttribute('aria-expanded')) !== 'true') await cqs.click();
    const firstQuestion = health.locator('li button').filter({ hasText: /\?/ }).first();
    test.skip(!(await firstQuestion.count()), 'no competency questions in the demo');
    await firstQuestion.click();
    await expect(health.locator('pre, code').filter({ hasText: /SELECT|ASK/i }).first()).toBeVisible();
    await cqs.click();
    await cqs.click();
    await expect(health.locator('pre, code').filter({ hasText: /SELECT|ASK/i }).first()).toBeVisible();
  });

  test('the overview tucks technical details away and shows each count once', async ({ page }) => {
    await page.goto(`/o/${demo.id}`);
    await settle(page);
    const main = page.locator('main');
    await expect(main.getByText('Classes', { exact: true })).toBeHidden();
    // "Open changes" lives in the header only.
    await expect(main.getByText('Open changes', { exact: true })).toHaveCount(0);
    const details = page.getByRole('button', { name: /Ontology details/ });
    await expect(details).toContainText(/\d+ class/);
    await details.click();
    for (const label of ['Classes', 'Properties', 'Individuals', 'Use cases', 'Releases', 'Ontology IRI', 'Governance', 'Created']) await expect(main.getByText(label, { exact: true }).first()).toBeVisible();
  });

  test('approval details keep their label readable in the narrow sidebar', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/o/${demo.id}/changes?status=all`);
    await settle(page);
    await page.locator('main a[href*="/changes/"]').first().click();
    await settle(page);
    await expectNoCrash(page);
    const details = page.getByRole('button', { name: /Approval details/ });
    const box = (await details.boundingBox())!;
    const label = (await details.getByText('Approval details', { exact: true }).boundingBox())!;
    // The title keeps a full line; any summary sits under it, not squeezed beside it.
    expect(label.width).toBeGreaterThan(80);
    expect(box.height).toBeGreaterThanOrEqual(label.height);
  });

  test('a change request keeps cautions visible above the collapsed rationale', async ({ page }) => {
    const crs = (await (await page.request.get(`/api/ontologies/${demo.id}/change-requests`)).json()) as { id: string }[];
    let found = false;
    for (const c of crs.slice(0, 12)) {
      const d = (await (await page.request.get(`/api/change-requests/${c.id}`)).json()) as { analysis?: { existingTerms?: string[] } };
      if (!d.analysis?.existingTerms?.length) continue;
      found = true;
      await page.goto(`/o/${demo.id}/changes/${c.id}`);
      await settle(page);
      await expect(page.getByRole('note').filter({ hasText: 'Existing terms may already cover this' })).toBeVisible();
      await expect(page.getByRole('button', { name: /Rationale and risks/ })).toHaveAttribute('aria-expanded', 'false');
      break;
    }
    test.skip(!found, 'no change request in the demo suggests existing terms');
  });
});
