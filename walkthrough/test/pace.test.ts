/**
 * A check run (--check, no video) skips what only paces the video for a viewer, which made
 * `pnpm walkthrough --check --strict` the slowest part of CI: about 50 s of pauses between
 * shots, 650 ms pointer glides, typing at 16 characters a second, and a settle that waited
 * for networkidle (at least 500 ms after the last request) plus fixed delays after every
 * click. The fast settle still waits for the page's own requests and spinners.
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasChromium } from '../lib/browser.ts';
import { Director } from '../lib/director.ts';
import { fast } from '../lib/terminal.ts';

/** Just enough of a Playwright page for the Director's pacing. */
function fakePage(spinner = { busy: false }) {
  const context = new EventEmitter();
  const moves: [number, number][] = [];
  const page = {
    context: () => context,
    mouse: { move: async (x: number, y: number) => void moves.push([x, y]), down: async () => {}, up: async () => {}, wheel: async () => {} },
    waitForLoadState: async () => {},
    locator: () => ({ count: async () => (spinner.busy ? 1 : 0) }),
    evaluate: async () => {},
  } as unknown as Page;
  // An aborted request, as when the page navigates away, isn't reported as a failure.
  const request = (type = 'fetch') => ({ resourceType: () => type, failure: () => ({ errorText: 'net::ERR_ABORTED' }), url: () => 'http://hub/x', method: () => 'GET' });
  return { page, context, moves, request };
}

const timed = async (p: Promise<unknown>) => {
  const t = Date.now();
  await p;
  return Date.now() - t;
};

describe('pacing in a check run', () => {
  it('moves the pointer in one step, where a recording glides', async () => {
    const quick = fakePage();
    await new Director(quick.page, false, true).moveTo(100, 100);
    expect(quick.moves).toEqual([[100, 100]]);
    const slow = fakePage();
    await new Director(slow.page, false).moveTo(100, 100, 160);
    expect(slow.moves.length).toBeGreaterThanOrEqual(8);
    expect(slow.moves.at(-1)).toEqual([100, 100]);
  });

  it('skips pauses for the viewer, which a recording keeps', async () => {
    expect(await timed(new Director(fakePage().page, false, true).pause(5000))).toBeLessThan(50);
    expect(await timed(new Director(fakePage().page, false).pause(120))).toBeGreaterThanOrEqual(110);
  });

  it('settles only once the page has no request in flight', async () => {
    const f = fakePage();
    const d = new Director(f.page, false, true);
    const r = f.request();
    f.context.emit('request', r);
    setTimeout(() => f.context.emit('requestfinished', r), 300);
    const ms = await timed(d.settle());
    expect(ms).toBeGreaterThanOrEqual(300);
    expect(ms).toBeLessThan(1000);
  });

  it('counts a failed request as finished, and ignores streams that never end', async () => {
    const f = fakePage();
    const d = new Director(f.page, false, true);
    const failed = f.request();
    f.context.emit('request', failed);
    f.context.emit('request', f.request('eventsource'));
    f.context.emit('request', f.request('websocket'));
    setTimeout(() => f.context.emit('requestfailed', failed), 200);
    const ms = await timed(d.settle());
    expect(ms).toBeGreaterThanOrEqual(200);
    expect(ms).toBeLessThan(1000);
  });

  it('settles only once no spinner shows', async () => {
    const spinner = { busy: true };
    const f = fakePage(spinner);
    setTimeout(() => (spinner.busy = false), 300);
    expect(await timed(new Director(f.page, false, true).settle())).toBeGreaterThanOrEqual(300);
  });

  it('draws the coding agent’s typing at once and spends no time thinking', () => {
    expect(fast('shell', ['ls', { cwdLabel: '~/app' }])).toEqual(['ls', { cwdLabel: '~/app', cps: 0 }]);
    expect(fast('ask', ['Add log hours', { cps: 45 }])).toEqual(['Add log hours', { cps: 0 }]);
    expect(fast('say', ['Done.'])).toEqual(['Done.', { cps: 0 }]);
    expect(fast('think', [1400, 'Reading'])).toEqual([0, 'Reading']);
    expect(fast('connector', ['Concord', 'https://hub/mcp', { cps: 26 }])).toEqual(['Concord', 'https://hub/mcp', { cps: 0 }]);
    expect(fast('tool', ['search', '{}'])).toEqual(['search', '{}']);
  });

  // Pauses for the viewer go through d.pause(), which a check run skips. sleep() is left only
  // for real waits (polling the app, or letting smooth scrolling arrive), so a check run that
  // skipped one of those would no longer test the same thing.
  it('keeps sleep() in the scenes only for real waits', () => {
    for (const f of ['scenes.ts', 'clips.ts', 'features.ts']) {
      const lines = readFileSync(path.resolve(import.meta.dirname, '..', f), 'utf8').split('\n');
      lines.forEach((l, i) => {
        if (!/\bsleep\(/.test(l) || /^import /.test(l)) return;
        const near = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
        expect(near, `${f}:${i + 1} sleeps for something other than a real wait; use c.d.pause() for pacing`).toMatch(/\bfor \(|real wait/i);
      });
    }
  });
});

const run = process.env.WALKTHROUGH_BROWSER_TESTS === '1' || hasChromium();
describe.runIf(run)('a fast settle in a real browser', () => {
  let browser: Browser;
  let server: Server;
  let url: string;
  beforeAll(async () => {
    // The page fetches something slow after it loads, then marks itself done.
    server = createServer((req, res) => {
      if (req.url === '/slow') return void setTimeout(() => res.end('ok'), 400);
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><body><script>addEventListener('load', () => fetch('/slow').then((r) => r.text()).then(() => (document.body.dataset.done = '1')));</script></body>`);
    }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
    server?.close();
  });

  it('waits for a request the page starts after loading', async () => {
    const page = await browser.newPage();
    const d = new Director(page, true, true);
    await d.goto(url);
    expect(await page.evaluate(() => document.body.dataset.done)).toBe('1');
    await page.close();
  });
});
