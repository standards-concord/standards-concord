import type { Page } from '@playwright/test';
import { test, expect, expectNoCrash, settle, signIn, demoOntology } from './fixtures';

/**
 * Visual looks (apps/web/src/lib/look.ts): the whole app's style is a set of CSS
 * variables picked by <html data-look>. These check that the default applies, that
 * ?look= and the Settings picker switch and remember it, that every look renders the
 * main pages cleanly, and that each look's colour pairs meet WCAG AA in light and dark.
 */

const LOOKS = ['spec', 'civic', 'workbench', 'classic'] as const;

const look = (page: Page) => page.evaluate(() => document.documentElement.dataset.look);

test.describe('looks', () => {
  test('the Specification look is the default, applied before the app renders', async ({ page }) => {
    await page.goto('/login');
    expect(await look(page)).toBe('spec');
    const fonts = await page.evaluate(() => ({
      body: getComputedStyle(document.body).fontFamily,
      heading: getComputedStyle(document.querySelector('h1')!).fontFamily,
    }));
    expect(fonts.body).toContain('Source Sans 3');
    expect(fonts.heading).toContain('Source Serif 4');
  });

  test('?look= switches the look and is remembered on later pages', async ({ page }) => {
    await page.goto('/login?look=civic');
    expect(await look(page)).toBe('civic');
    await page.goto('/login');
    expect(await look(page)).toBe('civic');
    // Unknown values are ignored.
    await page.goto('/login?look=sparkly');
    expect(await look(page)).toBe('civic');
    await page.goto('/login?look=spec');
    expect(await look(page)).toBe('spec');
  });

  test('the Settings appearance picker switches looks, by mouse and keyboard', async ({ page }) => {
    await signIn(page, { name: 'Look tester' });
    await page.goto('/settings');
    await settle(page);
    const group = page.getByRole('radiogroup', { name: 'Visual style' });
    await expect(group).toBeVisible();
    await expect(group.getByRole('radio')).toHaveCount(LOOKS.length);
    await expect(group.getByRole('radio', { name: /Specification/ })).toHaveAttribute('aria-checked', 'true');

    await group.getByRole('radio', { name: /Workbench/ }).click();
    expect(await look(page)).toBe('workbench');
    await expect(group.getByRole('radio', { name: /Workbench/ })).toHaveAttribute('aria-checked', 'true');
    await expect(group.getByRole('radio', { name: /Specification/ })).toHaveAttribute('aria-checked', 'false');

    // Arrow keys move the selection, as in any radio group.
    await page.keyboard.press('ArrowRight');
    expect(await look(page)).toBe('classic');
    await expect(group.getByRole('radio', { name: /Original/ })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    expect(await look(page)).toBe('spec');

    await group.getByRole('radio', { name: /Civic grid/ }).click();
    await page.reload();
    await settle(page);
    expect(await look(page)).toBe('civic');
    await expect(page.getByRole('radio', { name: /Civic grid/ })).toHaveAttribute('aria-checked', 'true');

    // The user menu links to the picker.
    await page.getByRole('button', { name: /Look tester/ }).click();
    await expect(page.getByRole('menu').getByRole('link', { name: 'Appearance' })).toHaveAttribute('href', '/settings#appearance');
  });

  for (const id of LOOKS) {
    test(`the ${id} look renders the main pages without errors`, async ({ page, request }) => {
      await signIn(page, { name: `${id} tester` });
      const demo = await demoOntology(request);
      for (const path of [`/?look=${id}`, `/o/${demo.id}`, `/o/${demo.id}/browse`, `/o/${demo.id}/changes`, `/o/${demo.id}/governance`, '/settings']) {
        await page.goto(path);
        await settle(page);
        await expectNoCrash(page);
        expect(await look(page), path).toBe(id);
      }
    });
  }

  for (const scheme of ['light', 'dark'] as const) {
    test(`every look's colour pairs meet WCAG AA contrast (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/login');
      const failures: string[] = [];
      for (const id of LOOKS) {
        await page.evaluate((l) => (document.documentElement.dataset.look = l), id);
        const bad = await page.evaluate(() => {
          // Text colour on background colour, as the components pair them.
          const pairs: [string, string][] = [
            ['fg', 'bg'],
            ['fg', 'surface'],
            ['muted', 'surface'],
            ['muted', 'surface-2'],
            ['muted', 'accent-soft'],
            ['subtle', 'surface'],
            ['subtle', 'bg'],
            ['accent', 'surface'],
            ['accent', 'bg'],
            ['accent', 'accent-soft'],
            ['accent-fg', 'accent'],
            ['ok', 'ok-soft'],
            ['ok', 'surface'],
            ['warn', 'warn-soft'],
            ['warn', 'surface'],
            ['danger', 'danger-soft'],
            ['danger', 'surface'],
            ['header-fg', 'header-bg'],
          ];
          const probe = document.createElement('span');
          document.body.appendChild(probe);
          const rgb = (v: string) => {
            probe.style.color = `var(--${v})`;
            const m = getComputedStyle(probe).color.match(/[\d.]+/g)!.map(Number);
            // Translucent colours (the classic header) sit on the page background.
            return m.length > 3 && m[3] < 1 ? null : m.slice(0, 3);
          };
          const lum = ([r, g, b]: number[]) => {
            const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
            return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
          };
          const out: string[] = [];
          for (const [a, b] of pairs) {
            const ca = rgb(a);
            const cb = rgb(b);
            if (!ca || !cb) continue;
            const [hi, lo] = [lum(ca), lum(cb)].sort((x, y) => y - x);
            const ratio = (hi + 0.05) / (lo + 0.05);
            if (ratio < 4.5) out.push(`${a} on ${b}: ${ratio.toFixed(2)}`);
          }
          probe.remove();
          return out;
        });
        failures.push(...bad.map((b) => `${id}: ${b}`));
      }
      expect(failures).toEqual([]);
    });
  }

  test('no sparkle icons remain on the AI features', async ({ page, request }) => {
    await signIn(page, { name: 'Icon tester', role: 'steward' });
    const demo = await demoOntology(request);
    for (const path of ['/login', `/o/${demo.id}/use-cases`, `/o/${demo.id}/changes`]) {
      await page.goto(path);
      await settle(page);
      await expect(page.locator('svg.lucide-sparkles, svg.lucide-wand-sparkles')).toHaveCount(0);
    }
  });
});
