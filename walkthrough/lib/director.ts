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
  ) {
    // A script error, a console error or a failed request is a broken shot, even if every
    // click landed: the page may be showing an error state the narration doesn't mention.
    page.context().on('weberror', (e) => this.note(`Page error on ${e.page()?.url() ?? '?'}: ${e.error().message.split('\n')[0]}`));
    page.context().on('console', (m) => {
      if (m.type() === 'error' && !/ERR_BLOCKED_BY_CLIENT/.test(m.text())) this.note(`Console error on ${m.page()?.url() ?? '?'}: ${m.text().split('\n')[0].slice(0, 200)}`);
    });
    page.context().on('requestfailed', (r) => {
      const why = r.failure()?.errorText ?? '';
      // Blocked requests are reported as outside requests; aborted ones are cancelled by navigating away.
      if (!/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/.test(why)) this.note(`Request failed: ${r.method()} ${r.url()} (${why})`);
    });
    page.context().on('response', (r) => {
      if (r.status() >= 400 && !/\/favicon\.ico$/.test(r.url())) this.note(`HTTP ${r.status()} from ${r.request().method()} ${r.url()}`);
    });
  }

  /** Records a warning without throwing (for events that arrive outside a step). */
  note(msg: string) {
    this.warnings.push(msg);
    console.warn(`  ! ${msg}`);
  }

  /**
   * Checks something the narration claims (a query returned rows, validation passed).
   * A recording where an action ran but its claimed outcome didn't happen must not publish.
   */
  claim(ok: unknown, msg: string) {
    if (!ok) this.warn(`Narrated outcome not shown: ${msg}`);
    return !!ok;
  }

  /** Waits for something to appear as the narration claims, or warns. */
  async claimVisible(target: Locator, msg: string, timeout = 10_000) {
    const ok = await target
      .first()
      .waitFor({ state: 'visible', timeout })
      .then(() => true)
      .catch(() => false);
    return this.claim(ok, msg);
  }

  warn(msg: string) {
    this.warnings.push(msg);
    console.warn(`  ! ${msg}`);
    if (this.strict) throw new Error(msg);
  }

  /** Navigates and waits for the app to settle (no spinners, fonts loaded). */
  async goto(url: string, opts: { settle?: boolean; keepCard?: boolean } = {}) {
    await this.checkRing();
    const res = await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    if (res && res.status() >= 400) this.warn(`${url} answered HTTP ${res.status()}`);
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

  /**
   * Rings an element (with an optional caption) until the next highlight or clear. The ring
   * follows the element itself in the page, and ringing nothing visible is a warning (so a
   * --publish run refuses it): a ring once sat on an empty side panel.
   */
  async highlight(target: Locator | undefined, what: string, tag?: string) {
    if (!target) return this.clearHighlight();
    // Settle the ring being shown before scrolling, which would move it out of view.
    await this.checkRing();
    const l = await this.find(target, what);
    if (!l) return;
    await l.scrollIntoViewIfNeeded().catch(() => {});
    await this.ring(l, what, tag);
  }

  /** Rings exactly this element (see highlight). */
  async ring(l: Locator, what: string, tag?: string) {
    await this.checkRing();
    this.ringed = what;
    const seen = await l.evaluate((el, t) => (window as any).__wt?.highlight(el, t) ?? null, tag).catch(() => null);
    const problem = ringProblem(seen);
    if (problem) this.warn(`The highlight on ${what} ${problem}`);
  }

  async clearHighlight() {
    await this.checkRing();
    await this.page.evaluate(() => (window as any).__wt?.highlight(null)).catch(() => {});
  }

  /**
   * The ring being shown, and whether it stayed in view while it was (the overlay hides it if
   * not). Checked when it is cleared or replaced, before scrolling to a new one, when the page
   * changes, and at the end of the recording.
   */
  private ringed = '';
  async checkRing() {
    if (!this.ringed) return;
    const what = this.ringed;
    this.ringed = '';
    const lost = await this.page.evaluate(() => (window as any).__wt?.ringLost?.() ?? '').catch(() => '');
    if (lost) this.warn(`The highlight on ${what} ${lost} while it was shown`);
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

/** What the overlay reported about a ringed element, if it shows nothing worth ringing. */
export interface Ringed {
  visible: boolean;
  onScreen: boolean;
  text: string;
  media: boolean;
  width: number;
  height: number;
}

/** Why a ring would be around nothing (blank, hidden or off screen), or undefined if it's fine. */
export function ringProblem(r: Ringed | null | undefined): string | undefined {
  if (!r) return 'could not be drawn';
  if (!r.visible) return `is around something hidden (${r.width}×${r.height})`;
  if (!r.onScreen) return 'is off screen';
  if (!r.text && !r.media) return 'is around blank space';
  return undefined;
}

/**
 * Text a page shows that is really an object printed as a string ("[object U]", "undefined").
 * The first published tour's sample app showed "[object U]" for every title: the generated
 * classes return sets that aren't `instanceof Set`, and the app printed the set itself.
 */
export function garbled(text: string): boolean {
  return /\[object [^\]]*\]|^(undefined|null|NaN)$/.test(text.trim());
}

/** The sample app's card text that is unreadable: every title must read; a summary may be empty. */
export function unreadableCards(titles: string[], summaries: string[]): string[] {
  return [...titles.filter((t) => !t.trim() || garbled(t)), ...summaries.filter(garbled)];
}
