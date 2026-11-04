import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startEgressProxy, type Egress } from '../lib/egress.ts';

/** Two local servers: "allowed" (A, B) and "denied" (C). C records every hit. */
const hits: string[] = [];
let a: http.Server, b: http.Server, c: http.Server;
let A = '', B = '', C = '';
let egress: Egress;
let browser: Browser;
const outside = new Set<string>();

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
  egress = await startEgressProxy([A, B], outside);
  browser = await chromium.launch({ proxy: { server: egress.url, bypass: '<-loopback>' }, args: ['--disable-features=LocalNetworkAccessChecks'] });
});

afterAll(async () => {
  await browser?.close();
  await egress?.close();
  for (const s of [a, b, c]) s?.close();
});

describe('egress proxy', () => {
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
});
