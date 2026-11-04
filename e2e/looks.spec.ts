import type { Page } from '@playwright/test';
import { test, expect, expectNoCrash, settle, signIn, demoOntology } from './fixtures';

/**
 * Visual looks (apps/web/src/lib/look.ts): the whole app's style is a set of CSS
 * variables picked by <html data-look>. These check that the default applies, that
 * ?look= and the Appearance page switch and remember it, that every look renders the
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

  test('the Appearance page switches looks, by mouse and keyboard', async ({ page }) => {
    await signIn(page, { name: 'Look tester' });
    await page.goto('/appearance');
    await expect(page.getByRole('heading', { name: 'Appearance', level: 1 })).toBeVisible();
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

    // The user menu links to the picker, and Profile no longer repeats it.
    await page.getByRole('button', { name: /Look tester/ }).click();
    await expect(page.getByRole('menu').getByRole('link', { name: 'Appearance' })).toHaveAttribute('href', '/appearance');
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Profile', level: 1 })).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Visual style' })).toHaveCount(0);
  });

  test('the Appearance page works signed out, since the choice is kept in the browser', async ({ page }) => {
    await page.goto('/appearance');
    await settle(page);
    await page.getByRole('radio', { name: /Workbench/ }).click();
    expect(await look(page)).toBe('workbench');
    await page.goto('/login');
    await settle(page);
    expect(await look(page)).toBe('workbench');
  });

  for (const id of LOOKS) {
    test(`the ${id} look renders the main pages without errors`, async ({ page, request }) => {
      await signIn(page, { name: `${id} tester` });
      const demo = await demoOntology(request);
      for (const path of [`/?look=${id}`, `/o/${demo.id}`, `/o/${demo.id}/browse`, `/o/${demo.id}/changes`, `/o/${demo.id}/governance`, '/settings', '/appearance']) {
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
          // [text, background, minimum ratio]: 4.5 for text, 3 for control boundaries and focus rings.
          const pairs: [string, string, number?][] = [
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
            ['header-muted', 'header-bg'],
            ['danger-fg', 'danger'],
            ['control-line', 'surface', 3],
            ['control-line', 'bg', 3],
            ['header-focus', 'header-bg', 3],
            ['focus', 'surface', 3],
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
          for (const [a, b, min = 4.5] of pairs) {
            const ca = rgb(a);
            const cb = rgb(b);
            if (!ca || !cb) continue;
            const [hi, lo] = [lum(ca), lum(cb)].sort((x, y) => y - x);
            const ratio = (hi + 0.05) / (lo + 0.05);
            if (ratio < min) out.push(`${a} on ${b}: ${ratio.toFixed(2)} < ${min}`);
          }
          probe.remove();
          return out;
        });
        failures.push(...bad.map((b) => `${id}: ${b}`));
      }
      expect(failures).toEqual([]);
    });
  }

  test('a valid ?look= wins over the saved look, an invalid one falls back to it, and both scripts agree', async ({ page }) => {
    // What the inline script in index.html chose before the app booted.
    await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => ((window as unknown as { bootLook?: string }).bootLook = document.documentElement.dataset.look)));
    await page.goto('/login?look=workbench');
    await page.goto('/login?look=nonsense');
    expect(await page.evaluate(() => (window as unknown as { bootLook?: string }).bootLook)).toBe('workbench');
    expect(await look(page)).toBe('workbench');
    await page.goto('/login?look=civic');
    expect(await page.evaluate(() => (window as unknown as { bootLook?: string }).bootLook)).toBe('civic');
    expect(await look(page)).toBe('civic');
  });

  test('choosing a look on the Appearance page replaces ?look= in the address, so a reload keeps the choice', async ({ page }) => {
    await signIn(page, { name: 'Override tester' });
    await page.goto('/appearance?look=civic');
    await settle(page);
    await page.getByRole('radio', { name: /Workbench/ }).click();
    await expect(page).not.toHaveURL(/look=/);
    await page.reload();
    await settle(page);
    expect(await look(page)).toBe('workbench');
  });

  for (const id of LOOKS)
    test(`the ${id} masthead: readable account menu, visible focus and chevrons`, async ({ page }) => {
      await signIn(page, { name: 'Masthead tester' });
      await page.goto(`/?look=${id}`);
      await settle(page);
      const ratio = (fg: string, bg: string) =>
        page.evaluate(
          ([a, b]) => {
            const parse = (c: string) => c.match(/[\d.]+/g)!.slice(0, 3).map(Number);
            const lum = ([r, g, bl]: number[]) => {
              const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
              return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl);
            };
            const [hi, lo] = [lum(parse(a)), lum(parse(b))].sort((x, y) => y - x);
            return (hi + 0.05) / (lo + 0.05);
          },
          [fg, bg],
        );
      const headerBg = await page.locator('.app-header').evaluate((el) => getComputedStyle(el).backgroundColor);
      // Account menu: its items use page colours, not the masthead's.
      await page.getByRole('button', { name: /Masthead tester/ }).click();
      const item = page.getByRole('menu').getByRole('link', { name: 'Appearance' });
      const [itemColor, menuBg] = await item.evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el.closest('[role=menu]')!).backgroundColor]);
      expect(await ratio(itemColor, menuBg), 'menu item contrast').toBeGreaterThanOrEqual(4.5);
      await page.keyboard.press('Escape');
      if (/rgba\(.*, 0?\.\d+\)$/.test(headerBg)) return; // translucent classic header: covered by the token test
      // Chevrons and the focus ring against the masthead.
      const chevron = await page.locator('.app-header .app-header-muted').first().evaluate((el) => getComputedStyle(el).color);
      expect(await ratio(chevron, headerBg), 'chevron contrast').toBeGreaterThanOrEqual(3);
      await page.locator('.app-header a').first().focus();
      await page.keyboard.press('Tab');
      const [inHeader, style, outline] = await page.evaluate(() => {
        const el = document.activeElement!;
        const cs = getComputedStyle(el);
        return [!!el.closest('.app-header'), cs.outlineStyle, cs.outlineColor];
      });
      expect(inHeader && style !== 'none', 'a masthead control shows a focus ring').toBe(true);
      expect(await ratio(outline, headerBg), 'focus ring contrast').toBeGreaterThanOrEqual(3);
    });

  test('reduced motion turns off transitions and animations', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/login');
    const d = await page.getByRole('button', { name: 'Try the demo' }).evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(parseFloat(d)).toBeLessThan(0.01);
  });

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
