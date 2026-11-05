/**
 * The presentation layers drawn during a recording, in a real browser:
 * - the highlight ring follows its element (it used to be a snapshot of where the element
 *   was, and at 1:05 of the first published tour it sat on an empty side panel), and
 *   ringing nothing visible is reported so a --publish run refuses it;
 * - Claude Code on the web (stage/claude-web.html) takes every call the scenes make.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import { hasChromium } from '../lib/browser.ts';
import { garbled, ringProblem, type Ringed } from '../lib/director.ts';

const required = process.env.WALKTHROUGH_BROWSER_TESTS === '1';
if (required && !hasChromium()) throw new Error('WALKTHROUGH_BROWSER_TESTS=1 but Playwright Chromium is not installed');
const run = required || hasChromium();

const stage = (f: string) => readFileSync(path.resolve(import.meta.dirname, '../stage', f), 'utf8');

describe('what a ring is around', () => {
  const r = (o: Partial<Ringed>): Ringed => ({ visible: true, onScreen: true, text: 'Members', media: false, width: 300, height: 120, ...o });
  it('accepts visible text or media, and names what is wrong otherwise', () => {
    expect(ringProblem(r({}))).toBeUndefined();
    expect(ringProblem(r({ text: '', media: true }))).toBeUndefined();
    expect(ringProblem(r({ text: '' }))).toMatch(/blank space/);
    expect(ringProblem(r({ visible: false }))).toMatch(/hidden/);
    expect(ringProblem(r({ onScreen: false }))).toMatch(/off screen/);
    expect(ringProblem(null)).toMatch(/could not be drawn/);
  });
});

describe('unreadable app text', () => {
  // The first tour's sample app titled every card "[object U]" and nobody noticed until it was published.
  it('catches objects printed as text, and passes real titles', () => {
    for (const t of ['[object U]', '[object Object]', 'undefined', '  ']) expect(garbled(t)).toBe(true);
    for (const t of ['Saturday park clean-up', 'A weekly phone call with an older person']) expect(garbled(t)).toBe(false);
  });

  it("the sample app reads a value out of the generated classes' sets", () => {
    // They are set-like but not `instanceof Set` (minified, the class is called "U").
    class U { constructor(private items: unknown[]) {} [Symbol.iterator]() { return this.items[Symbol.iterator](); } }
    for (const f of ['base/app.js', 'feature/app.js']) {
      const src = readFileSync(path.resolve(import.meta.dirname, '../sample-app', f), 'utf8');
      const line = src.split('\n').find((l) => l.startsWith('const one = '));
      expect(line, f).toBeTruthy();
      const one = new Function(`${line}; return one;`)() as (v: unknown) => unknown;
      expect(one(new U(['Saturday park clean-up'])), f).toBe('Saturday park clean-up');
      expect(one('plain'), f).toBe('plain');
      expect(one(undefined), f).toBeUndefined();
    }
  });
});

describe.runIf(run)('in a browser', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  }, 60_000);
  afterAll(() => browser?.close());

  const ring = () =>
    page.evaluate(() => {
      const r = (document.getElementById('__wt-overlay')!.shadowRoot!.querySelector('.ring') as HTMLElement).getBoundingClientRect();
      return { top: Math.round(r.top), left: Math.round(r.left), height: Math.round(r.height) };
    });

  it('keeps the ring on its element when the page scrolls or moves it', async () => {
    await page.setContent(
      `<body style="margin:0;height:3000px"><div id="push" style="height:200px"></div><section id="card" style="width:400px;height:150px;margin-left:100px;background:#eee">Members</section><div id="empty" style="width:300px;height:400px;margin-top:40px"></div></body>`,
    );
    await page.addScriptTag({ content: stage('overlay.js') });
    const seen = await page.evaluate(() => (window as any).__wt.highlight(document.getElementById('card'), 'members'));
    expect(ringProblem(seen)).toBeUndefined();
    await page.waitForTimeout(600);
    expect((await ring()).top).toBe(200 - 8);

    await page.evaluate(() => window.scrollTo(0, 120));
    await page.waitForTimeout(100);
    expect((await ring()).top).toBe(200 - 120 - 8);

    // Content added above it moves it down; the ring goes with it.
    await page.evaluate(() => ((document.getElementById('push') as HTMLElement).style.height = '300px'));
    await page.waitForTimeout(100);
    expect((await ring()).top).toBe(300 - 120 - 8);
  });

  it('reports a ring around blank space or something hidden', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    const blank = await page.evaluate(() => (window as any).__wt.highlight(document.getElementById('empty')));
    expect(ringProblem(blank)).toMatch(/blank space/);
    const hidden = await page.evaluate(() => {
      const el = document.getElementById('card')!;
      el.style.visibility = 'hidden';
      return (window as any).__wt.highlight(el);
    });
    expect(ringProblem(hidden)).toMatch(/hidden/);
  });

  it('draws Claude Code on the web from the calls the scenes make', async () => {
    await page.setContent(stage('claude-web.html'));
    const term = (fn: string, ...args: unknown[]) => page.evaluate(([f, a]) => (window as any).term[f as string](...(a as unknown[])), [fn, args] as const);
    await term('title', 'helping-hands');
    await term('file', 'app.js', 'import { VolunteeringDataset } from "https://hub/def/volunteering.js";');
    await term('connector', 'Concord', 'https://hub/mcp', { cps: 0 });
    await expect.poll(() => page.getByText('✓ Connected').isVisible()).toBe(true);
    await term('closeConnector');
    await term('connected', 'Concord');
    expect(await page.locator('#chip').innerText()).toContain('Concord');
    await term('startAgent', { cwdPath: '~/code/helping-hands' });
    await term('ask', 'Add a way to log volunteering hours', { cps: 0 });
    await term('say', 'I will check the standard first.', { cps: 0 });
    await term('tool', 'concord - search_terms (MCP)', 'query: "hours"');
    await term('result', 'hoursPerWeek\nTimeCommitment');
    await term('diff', 'app.js', 'Added 1 line', [{ t: 'add', n: 1, s: 'import x' }]);
    await term('html', '<span class="bold">Write</span><span class="dim">(data/activities.ttl)</span>', 'bullet tool');
    await term('result', 'Wrote 11 lines to data/activities.ttl');
    const text = await page.locator('#msgs').innerText();
    // A new session starts with an empty conversation, then shows each step.
    expect(text).not.toContain('VolunteeringDataset');
    for (const s of ['Add a way to log volunteering hours', 'search_terms', 'hoursPerWeek', 'Edit', '+ import x', 'Write', 'Wrote 11 lines']) expect(text).toContain(s);
    expect(await page.locator('#url').innerText()).toBe('claude.ai/code/helping-hands');
  });
});
