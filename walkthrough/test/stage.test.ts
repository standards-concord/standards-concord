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
import { pathToFileURL } from 'node:url';
import { Director, garbled, ringProblem, unreadableCards, type Ringed } from '../lib/director.ts';
import { Terminal } from '../lib/terminal.ts';

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
    for (const t of ['[object U]', '[object Object]', 'undefined']) expect(garbled(t)).toBe(true);
    for (const t of ['Saturday park clean-up', 'A weekly phone call with an older person', '']) expect(garbled(t)).toBe(false);
  });

  it('needs every card title, and lets a summary be empty but not an object', () => {
    // The sample apps render an empty paragraph for an opportunity without a summary.
    expect(unreadableCards(['Saturday park clean-up'], [''])).toEqual([]);
    expect(unreadableCards([''], ['Help keep the park clean'])).toEqual(['']);
    expect(unreadableCards(['Food bank'], ['[object U]'])).toEqual(['[object U]']);
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

  const fixture = async (body: string) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('about:blank'); // a fresh window: the overlay installs itself once per window
    await page.setContent(`<body style="margin:0;height:3000px">${body}</body>`);
    await page.addScriptTag({ content: stage('overlay.js') });
  };
  const highlight = (id: string) => page.evaluate((i) => (window as any).__wt.highlight(document.getElementById(i), i), id);
  const ringShown = () => page.evaluate(() => document.getElementById('__wt-overlay')!.shadowRoot!.querySelector('.ring')!.classList.contains('on'));
  const lost = () => page.evaluate(() => (window as any).__wt.ringLost());

  it('follows its element when the window is resized', async () => {
    await fixture(`<section id="half" style="width:50%;height:150px;margin:100px 0 0 0;background:#eee">Members</section>`);
    await highlight('half');
    await page.waitForTimeout(600);
    expect((await ring()).left).toBe(16 - 8);
    const wide = await page.evaluate(() => document.getElementById('__wt-overlay')!.shadowRoot!.querySelector('.ring')!.getBoundingClientRect().width);
    await page.setViewportSize({ width: 900, height: 720 });
    await page.waitForTimeout(100);
    const narrow = await page.evaluate(() => document.getElementById('__wt-overlay')!.shadowRoot!.querySelector('.ring')!.getBoundingClientRect().width);
    expect(Math.round(wide - narrow)).toBe(190);
  });

  it('reports an element below the fold, inside a transparent parent, or clipped by its container', async () => {
    await fixture(`
      <section id="below" style="margin-top:900px;height:100px">Below the fold</section>
      <div style="opacity:0"><section id="faded" style="height:100px">Faded out</section></div>
      <div style="position:fixed;top:0;left:0;width:300px;height:200px;overflow:hidden">
        <section id="clipped" style="margin-top:400px;height:100px">Scrolled away inside a panel</section>
      </div>`);
    expect(ringProblem(await highlight('below'))).toMatch(/off screen/);
    await page.evaluate(() => document.getElementById('faded')!.scrollIntoView());
    expect(ringProblem(await highlight('faded'))).toMatch(/hidden/);
    expect(ringProblem(await highlight('clipped'))).toMatch(/off screen/);
  });

  it('counts only the text that can be seen inside a tall element', async () => {
    // Its only text is at the top, scrolled out of view: the ring would be around blank space.
    await fixture(`<section id="tall" style="height:2600px"><h2 style="margin:0">Members</h2></section>`);
    await page.evaluate(() => window.scrollTo(0, 1200));
    expect(ringProblem(await highlight('tall'))).toMatch(/blank space/);
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(ringProblem(await highlight('tall'))).toBeUndefined();
  });

  it('hides a ring whose element leaves the screen or the page, and says so', async () => {
    await fixture(`<section id="a" style="margin-top:100px;height:150px">Members</section><section id="b" style="height:150px">Governance</section>`);
    expect(ringProblem(await highlight('a'))).toBeUndefined();
    await page.waitForTimeout(100);
    expect(await ringShown()).toBe(true);
    expect(await lost()).toBe('');
    await page.evaluate(() => window.scrollTo(0, 1000));
    await expect.poll(ringShown).toBe(false);
    expect(await lost()).toBe('went off screen');
    // Back in view, the ring comes back; what happened is still reported.
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(ringShown).toBe(true);
    expect(await lost()).toBe('went off screen');

    expect(ringProblem(await highlight('b'))).toBeUndefined();
    await page.evaluate(() => document.getElementById('b')!.remove());
    await expect.poll(ringShown).toBe(false);
    expect(await lost()).toBe('was removed from the page');
  });

  it('counts only content inside its own scrolling container, and notices content that disappears', async () => {
    // The card is on screen, but its only text sits in an inner panel, scrolled out of view.
    await fixture(`
      <section id="card" style="margin-top:100px;width:400px;height:200px">
        <div style="height:120px;overflow:hidden"><p style="margin:300px 0 0">Members</p></div>
      </section>
      <section id="note" style="width:400px;height:200px"><p id="words">Governance</p></section>`);
    expect(ringProblem(await highlight('card'))).toMatch(/blank space/);
    expect(ringProblem(await highlight('note'))).toBeUndefined();
    await page.evaluate(() => ((document.getElementById('words') as HTMLElement).style.opacity = '0'));
    await expect.poll(ringShown).toBe(false);
    expect(await lost()).toBe('went blank');
  });

  it('hides a ring whose element is hidden after it was drawn', async () => {
    await fixture(`<section id="a" style="margin-top:100px;height:150px">Members</section>`);
    expect(ringProblem(await highlight('a'))).toBeUndefined();
    await page.evaluate(() => ((document.getElementById('a') as HTMLElement).style.display = 'none'));
    await expect.poll(ringShown).toBe(false);
    expect(await lost()).toBe('was hidden');
  });

  it('the director warns about a ring lost while shown, but not one it scrolled away from itself', async () => {
    await fixture(`<section id="a" style="margin-top:100px;height:150px">Members</section><section id="b" style="margin-top:1500px;height:150px">Governance</section><section id="c" style="margin-top:1500px;height:150px">Releases</section>`);
    const d = new Director(page, false);
    await d.highlight(page.locator('#a'), 'the members');
    await page.waitForTimeout(50);
    // Moving to a ring further down scrolls the first one away: that isn't a lost ring.
    await d.highlight(page.locator('#b'), 'the governance card');
    await page.waitForTimeout(50);
    expect(d.warnings).toEqual([]);
    await page.evaluate(() => document.getElementById('b')!.remove());
    await page.waitForTimeout(50);
    await d.clearHighlight();
    expect(d.warnings).toEqual(['The highlight on the governance card was removed from the page while it was shown']);
    // The last ring of a recording is checked at the end.
    await d.highlight(page.locator('#c'), 'the releases');
    await page.waitForTimeout(50);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(50);
    await d.checkRing();
    expect(d.warnings.at(-1)).toBe('The highlight on the releases went off screen while it was shown');
  });

  it('loads Claude Code on the web from its address and redraws the session on return', async () => {
    const url = pathToFileURL(path.resolve(import.meta.dirname, '../stage/claude-web.html')).href;
    const d = { page, goto: (u: string) => page.goto(u), label: async () => {} } as unknown as Director;
    const term = new Terminal(d, url);
    await term.open();
    await term.title('helping-hands');
    await term.connector('Concord', 'https://hub/mcp', { cps: 0 });
    await term.closeConnector('Concord');
    await term.startAgent({ cwdPath: '~/code/helping-hands' });
    await term.ask('Add a way to log volunteering hours', { cps: 0 });
    await term.say('I will check the standard first.', { cps: 0 });
    // Away to the app and back: the same session, connector and project.
    await page.goto('about:blank');
    await term.open();
    expect(await page.locator('#msgs').innerText()).toContain('Add a way to log volunteering hours');
    expect(await page.locator('#chip').innerText()).toContain('Concord');
    expect(await page.locator('#modal').evaluate((m) => m.classList.contains('on'))).toBe(false);
    // A new session in the same project keeps its name and connector, not the conversation.
    await term.clear();
    await page.goto('about:blank');
    await term.open();
    expect(await page.locator('#msgs').innerText()).not.toContain('log volunteering hours');
    expect(await page.locator('#chip').innerText()).toContain('Concord');
    expect(await page.locator('#url').innerText()).toBe('claude.ai/code/helping-hands');
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
