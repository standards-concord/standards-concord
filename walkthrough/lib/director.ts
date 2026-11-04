/**
 * Helpers the scenes use to drive the browser like a person would on a screen
 * recording: the pointer glides to things before clicking, typing has a human rhythm,
 * and anything the narration talks about can be ringed.
 *
 * UI drift should not wreck a recording, so helpers that look for an element are soft:
 * if it isn't there they log a warning and carry on. Run with --strict to make any
 * warning fail the run (CI does this, so a renamed button is caught on the PR).
 */
import type { Locator, Page } from '@playwright/test';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Director {
  private cursor = { x: 640, y: 420 };
  readonly warnings: string[] = [];

  constructor(
    readonly page: Page,
    private readonly strict: boolean,
  ) {}

  warn(msg: string) {
    this.warnings.push(msg);
    console.warn(`  ! ${msg}`);
    if (this.strict) throw new Error(msg);
  }

  /** Navigates and waits for the app to settle (no spinners, fonts loaded). */
  async goto(url: string, opts: { settle?: boolean; keepCard?: boolean } = {}) {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.settle(opts.settle !== false);
    // A chapter card carries across navigation; unless asked to keep it, fade it out now.
    if (!opts.keepCard) await this.page.evaluate(() => (window as any).__wt?.hideChapter()).catch(() => {});
    await this.page.evaluate(([x, y]) => (window as any).__wt?.setCursor(x, y), [this.cursor.x, this.cursor.y]).catch(() => {});
  }

  async settle(spinners = true) {
    await this.page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    if (spinners) {
      // No spinners for a moment in a row: some pages load in two waves.
      for (let quiet = 0, tries = 0; quiet < 3 && tries < 75; tries++) {
        const busy = await this.page.locator('[aria-busy="true"]').count().catch(() => 0);
        quiet = busy ? 0 : quiet + 1;
        await sleep(200);
      }
    }
    await this.page.evaluate(() => document.fonts?.ready).catch(() => {});
    await sleep(250);
  }

  /** Resolves a locator to its first visible match, or warns and returns undefined. */
  async find(target: Locator, what: string, timeout = 8000): Promise<Locator | undefined> {
    const l = target.first();
    try {
      await l.waitFor({ state: 'visible', timeout });
      return l;
    } catch {
      this.warn(`Could not find ${what}`);
      return undefined;
    }
  }

  /** Glides the pointer to (x, y) with an ease-in-out curve. */
  async moveTo(x: number, y: number, ms = 650) {
    const from = { ...this.cursor };
    const steps = Math.max(8, Math.round(ms / 16));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      await this.page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
      await sleep(ms / steps);
    }
    this.cursor = { x, y };
  }

  async pointAt(target: Locator, what: string) {
    const l = await this.find(target, what);
    if (!l) return undefined;
    await l.scrollIntoViewIfNeeded().catch(() => {});
    const box = await l.boundingBox();
    if (!box) return undefined;
    await this.moveTo(box.x + Math.min(box.width / 2, 60), box.y + box.height / 2);
    return l;
  }

  async click(target: Locator, what: string, opts: { settle?: boolean } = {}) {
    const l = await this.pointAt(target, what);
    if (!l) return false;
    await sleep(180);
    await this.page.mouse.down();
    await sleep(70);
    await this.page.mouse.up();
    if (opts.settle !== false) await this.settle();
    return true;
  }

  async type(target: Locator, text: string, what: string, cps = 16) {
    if (!(await this.click(target, what, { settle: false }))) return false;
    await target.first().fill('');
    await target.first().pressSequentially(text, { delay: 1000 / cps });
    return true;
  }

  /** Rings an element (with an optional caption) until the next highlight or clear. */
  async highlight(target: Locator | undefined, what: string, tag?: string) {
    if (!target) return this.page.evaluate(() => (window as any).__wt?.highlight(null));
    const l = await this.find(target, what);
    if (!l) return;
    await l.scrollIntoViewIfNeeded().catch(() => {});
    const box = await l.boundingBox();
    if (box) await this.page.evaluate(([b, t]) => (window as any).__wt?.highlight(b, t), [box, tag] as const);
  }

  async clearHighlight() {
    await this.page.evaluate(() => (window as any).__wt?.highlight(null)).catch(() => {});
  }

  async label(text?: string) {
    await this.page.evaluate((t) => (window as any).__wt?.label(t), text ?? '').catch(() => {});
  }

  /** A full-screen chapter card that fades out to reveal the page underneath. */
  async chapter(card: { eyebrow?: string; title: string; sub?: string }, holdMs = 2800) {
    await this.page.evaluate(([c, ms]) => (window as any).__wt?.chapter(c, ms), [card, holdMs] as const);
  }

  /** Scrolls the main page smoothly by dy pixels. */
  async scroll(dy: number, ms = 900) {
    const steps = Math.max(6, Math.round(ms / 16));
    for (let i = 0; i < steps; i++) {
      await this.page.mouse.wheel(0, dy / steps);
      await sleep(ms / steps);
    }
  }
}
