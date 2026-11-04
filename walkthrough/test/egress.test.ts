import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import { existsSync, mkdtempSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardContext, hasChromium, launchBrowser } from '../lib/browser.ts';
import { startEgressProxy, type Egress } from '../lib/egress.ts';
import { fontFile, serveFonts } from '../lib/fonts.ts';

// These need Playwright's Chromium. The walkthrough CI job installs it and sets
// WALKTHROUGH_BROWSER_TESTS=1, so there a missing browser fails rather than skips;
// the general test job has no browser and skips them.
const required = process.env.WALKTHROUGH_BROWSER_TESTS === '1';
if (required && !hasChromium()) throw new Error('WALKTHROUGH_BROWSER_TESTS=1 but Playwright Chromium is not installed');
const run = required || hasChromium();

/** Two local servers: "allowed" (A, B) and "denied" (C). C records every hit. */
const hits: string[] = [];
let a: http.Server, b: http.Server, c: http.Server;
let A = '', B = '', C = '';
let egress: Egress;
let browser: Browser;
const outside = new Set<string>();

let aConnections = 0;
const listen = (h: http.RequestListener) =>
  new Promise<[http.Server, string]>((r) => {
    const s = http.createServer(h).listen(0, '127.0.0.1', () => r([s, `http://127.0.0.1:${(s.address() as AddressInfo).port}`]));
  });

beforeAll(async () => {
  [c, C] = await listen((req, res) => {
    hits.push(req.url ?? '');
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: leaked\n\n');
    } else res.end('denied server');
  });
  [b, B] = await listen((req, res) => {
    if (req.url === '/hop') res.writeHead(302, { location: `${C}/leak` }).end();
    else res.end('ok');
  });
  [a, A] = await listen((req, res) => {
    if (req.url === '/chain') res.writeHead(302, { location: `${B}/hop` }).end();
    else if (req.url === '/events') res.writeHead(302, { location: `${C}/events` }).end();
    else res.writeHead(200, { 'content-type': 'text/html' }).end('<p>page</p>');
  });
  a.on('connection', () => aConnections++);
  // A minimal WebSocket handshake on A, so an allowed ws:// connection can open.
  a.on('upgrade', (req, socket) => {
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  if (!run) return;
  egress = await startEgressProxy([A, B], outside);
  browser = await launchBrowser({ proxy: egress.url });
});

afterAll(async () => {
  await browser?.close();
  await egress?.close();
  for (const s of [a, b, c]) s?.close();
});

describe.runIf(run)('egress proxy', () => {
  it('allows the allowlisted origins', async () => {
    const page = await browser.newPage();
    expect((await page.goto(`${A}/`))?.status()).toBe(200);
    await page.close();
  });

  it('blocks a denied origin at any redirect hop', async () => {
    const page = await browser.newPage();
    const res = await page.goto(`${A}/chain`).catch(() => undefined);
    expect(res?.status() ?? 403).toBe(403);
    expect(hits).not.toContain('/leak');
    expect(outside.has(C)).toBe(true);
    await page.close();
  });

  it('blocks event streams that redirect away', async () => {
    const page = await browser.newPage();
    await page.goto(`${A}/`);
    const got = await page.evaluate(
      (url) =>
        new Promise<string>((r) => {
          const es = new EventSource(url);
          es.onmessage = (e) => r(e.data);
          es.onerror = () => r('error');
          setTimeout(() => r('timeout'), 3000);
        }),
      `${A}/events`,
    );
    expect(got).not.toBe('leaked');
    expect(hits).not.toContain('/events');
    await page.close();
  });

  it('blocks WebSockets to a denied origin and reports them', async () => {
    const page = await browser.newPage();
    await page.goto(`${A}/`);
    const port = new URL(C).port;
    const got = await page.evaluate(
      (url) =>
        new Promise<string>((r) => {
          const ws = new WebSocket(url);
          ws.onopen = () => r('open');
          ws.onerror = () => r('error');
          setTimeout(() => r('timeout'), 3000);
        }),
      `ws://127.0.0.1:${port}/socket`,
    );
    expect(got).toBe('error');
    expect(outside.has(`127.0.0.1:${port}`)).toBe(true);
    await page.close();
  });
  it('opens allowed WebSockets to an http: origin', async () => {
    const page = await browser.newPage();
    await page.goto(`${A}/`);
    const got = await page.evaluate(
      (url) =>
        new Promise<string>((r) => {
          const ws = new WebSocket(url);
          ws.onopen = () => r('open');
          ws.onerror = () => r('error');
          setTimeout(() => r('timeout'), 3000);
        }),
      `ws://127.0.0.1:${new URL(A).port}/socket`,
    );
    expect(got).toBe('open');
    await page.close();
  });

  it('refuses https: to a host:port that is only allowed as http:', async () => {
    const page = await browser.newPage();
    await page.goto(`${A}/`);
    const before = aConnections;
    const target = `https://127.0.0.1:${new URL(A).port}`;
    const got = await page.evaluate((url) => fetch(url).then(() => 'loaded', () => 'failed'), `${target}/`);
    expect(got).toBe('failed');
    expect(outside.has(target)).toBe(true);
    expect(aConnections).toBe(before);
    await page.close();
  });

  it('refuses forwarded requests whose Host is not the URL they ask for', async () => {
    const status = await new Promise<number>((r) => {
      const req = http.request(egress.url, { method: 'GET', path: `${A}/`, headers: { host: 'elsewhere.example' } }, (res) => {
        res.resume();
        r(res.statusCode ?? 0);
      });
      req.on('error', () => r(0));
      req.end();
    });
    expect(status).toBe(403);
    expect([...outside].some((o) => o.includes('Host: elsewhere.example'))).toBe(true);
  });

  it('sends no WebRTC traffic around the proxy', async () => {
    const udp = dgram.createSocket('udp4');
    let packets = 0;
    udp.on('message', () => packets++);
    await new Promise<void>((r) => udp.bind(0, '127.0.0.1', r));
    const stun = `stun:127.0.0.1:${(udp.address() as AddressInfo).port}`;
    const tryRtc = (stunUrl: string) =>
      new Promise<string>((r) => {
        try {
          const pc = new RTCPeerConnection({ iceServers: [{ urls: stunUrl }] });
          pc.createDataChannel('x');
          void pc.createOffer().then((o) => pc.setLocalDescription(o));
          setTimeout(() => r('created'), 3000);
        } catch {
          r('blocked');
        }
      });
    // With the recording's guard, pages have no RTCPeerConnection at all…
    const guarded = await browser.newContext();
    await guardContext(guarded);
    const page = await guarded.newPage();
    await page.goto(`${A}/`);
    expect(await page.evaluate(tryRtc, stun)).toBe('blocked');
    await guarded.close();
    // …and even without it, the launch policy keeps WebRTC from sending UDP directly.
    const bare = await browser.newContext();
    const page2 = await bare.newPage();
    await page2.goto(`${A}/`);
    await page2.evaluate(tryRtc, stun);
    await bare.close();
    udp.close();
    expect(packets).toBe(0);
  });

  it('downloads a missing font outside the browser, and refuses to when offline', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wt-fonts-'));
    const url = 'https://fonts.gstatic.com/s/test/v1/test.woff2';
    const fetched = new Set<string>();
    const missing = new Set<string>();
    const asked: string[] = [];
    const context = await browser.newContext();
    await serveFonts(context, {
      dir,
      offline: false,
      fetched,
      missing,
      fetch: (async (u: string) => {
        asked.push(u);
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'font/woff2' } });
      }) as typeof fetch,
    });
    const page = await context.newPage();
    await page.goto(`${A}/`);
    const size = await page.evaluate((u) => fetch(u).then((r) => r.arrayBuffer()).then((b) => b.byteLength), url);
    expect(size).toBe(3);
    expect(asked).toEqual([url]);
    expect(fetched.has(url)).toBe(true);
    expect(existsSync(fontFile(dir, url))).toBe(true);
    expect([...outside].some((o) => o.includes('fonts.gstatic.com'))).toBe(false);
    await context.close();

    const offline = await browser.newContext();
    await serveFonts(offline, { dir, offline: true, fetched: new Set(), missing });
    const page2 = await offline.newPage();
    await page2.goto(`${A}/`);
    const other = 'https://fonts.gstatic.com/s/test/v1/other.woff2';
    expect(await page2.evaluate((u) => fetch(u).then(() => 'loaded', () => 'failed'), other)).toBe('failed');
    expect(missing.has(other)).toBe(true);
    await offline.close();
  });
});
