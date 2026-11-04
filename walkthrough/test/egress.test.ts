import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import { existsSync, mkdtempSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardContext, guardedPage, hasChromium, launchBrowser } from '../lib/browser.ts';
import { readClientHello, startEgressProxy, type Egress } from '../lib/egress.ts';
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
const aUpgrades: string[] = [];
const aRequests: string[] = [];
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
    aRequests.push(req.url ?? '');
    if (req.url === '/chain') res.writeHead(302, { location: `${B}/hop` }).end();
    else if (req.url === '/events') res.writeHead(302, { location: `${C}/events` }).end();
    else if (req.url === '/early')
      // WebRTC from the very first inline script, and from a fresh iframe, with the errors swallowed.
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<html><head><script>try { new RTCPeerConnection() } catch {}</script></head><body>' +
            '<iframe srcdoc="<script>try { new RTCPeerConnection() } catch {}</script>"></iframe></body></html>',
        );
    else res.writeHead(200, { 'content-type': 'text/html' }).end('<p>page</p>');
  });
  a.on('connection', () => aConnections++);
  // A minimal WebSocket handshake on A, so an allowed ws:// connection can open.
  a.on('upgrade', (req, socket) => {
    aUpgrades.push(req.url ?? '');
    if (req.url === '/refuse') {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
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
    const blocked = new Set<string>();
    await guardContext(guarded, blocked);
    const page = await guardedPage(guarded, blocked);
    await page.goto(`${A}/`);
    expect(await page.evaluate(tryRtc, stun)).toBe('blocked');
    // …and an attempt is reported even when the page swallows the error.
    expect([...blocked].some((b) => b.startsWith('webrtc: RTCPeerConnection'))).toBe(true);
    blocked.clear();
    await page.evaluate(() => {
      try {
        new RTCPeerConnection();
      } catch {
        /* swallowed */
      }
    });
    await expect.poll(() => blocked.size).toBe(1);
    // Page code can't silence the report: it comes from the debugger, not the page.
    blocked.clear();
    await page.evaluate(() => {
      (globalThis as any).__playwright__binding__ = () => {};
      (globalThis as any).__playwright__binding__controller__ = { callBinding: () => {} };
      try {
        new RTCPeerConnection();
      } catch {
        /* swallowed */
      }
    });
    await expect.poll(() => blocked.size).toBe(1);
    // Nor forge one: a script of its own under the replacement's name doesn't count.
    blocked.clear();
    await page.evaluate(() => {
      try {
        (0, eval)("throw new Error('forged')\n//# sourceURL=concord-walkthrough-no-webrtc.js");
      } catch {
        /* swallowed */
      }
    });
    await page.waitForTimeout(200);
    expect(blocked.size).toBe(0);
    // The first inline script and a fresh iframe are covered too.
    blocked.clear();
    await page.goto(`${A}/early`);
    await expect.poll(() => [...blocked].filter((b) => b.startsWith('webrtc: RTCPeerConnection')).length).toBeGreaterThanOrEqual(2);
    // A page the recording didn't open itself is closed and reported.
    blocked.clear();
    const [popup] = await Promise.all([guarded.waitForEvent('page'), page.evaluate(() => void window.open('about:blank'))]);
    await expect.poll(() => popup.isClosed()).toBe(true);
    expect([...blocked].some((b) => b.startsWith('unexpected page'))).toBe(true);
    await guarded.close();
    // …and even without it, the launch policy keeps WebRTC from sending UDP directly.
    const bare = await browser.newContext();
    const page2 = await bare.newPage();
    await page2.goto(`${A}/`);
    await page2.evaluate(tryRtc, stun);
    await bare.close();
    udp.close();
    expect(packets).toBe(0);
  }, 30_000);

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
  describe('raw requests', () => {
    const port = () => new URL(A).port;
    const handshake = (path: string, host: string) =>
      `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`;

    /** Opens a CONNECT tunnel to target, sends payload, and returns everything the proxy sends back. */
    const tunnel = (target: string, payload: Buffer | string) =>
      new Promise<string>((resolve) => {
        const sock = net.connect(Number(new URL(egress.url).port), '127.0.0.1', () => sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
        let got = '';
        let sent = false;
        sock.on('data', (d) => {
          got += d.toString('latin1');
          if (!sent && got.includes('\r\n\r\n')) {
            sent = true;
            sock.write(payload);
          }
        });
        const done = () => resolve(got);
        sock.on('close', done);
        sock.on('error', done);
        setTimeout(() => {
          sock.destroy();
          done();
        }, 1500);
      });

    /** Sends a request straight to the proxy (not over CONNECT). */
    const direct = (text: string) =>
      new Promise<string>((resolve) => {
        const sock = net.connect(Number(new URL(egress.url).port), '127.0.0.1', () => sock.write(text));
        let got = '';
        sock.on('data', (d) => (got += d.toString('latin1')));
        const done = () => resolve(got);
        sock.on('close', done);
        sock.on('error', done);
        setTimeout(() => {
          sock.destroy();
          done();
        }, 1500);
      });

    it('lets a WebSocket handshake through a tunnel to an allowed http: origin', async () => {
      const got = await tunnel(`127.0.0.1:${port()}`, handshake('/socket', `127.0.0.1:${port()}`));
      expect(got).toContain('101 Switching Protocols');
    });

    it('refuses tunnels whose Host has user info or a path, or that are not HTTP', async () => {
      const before = aUpgrades.length;
      for (const host of [`denied.invalid@127.0.0.1:${port()}`, `127.0.0.1:${port()}/bad`]) {
        const got = await tunnel(`127.0.0.1:${port()}`, handshake('/socket', host));
        expect(got).not.toContain('101');
      }
      expect(await tunnel(`127.0.0.1:${port()}`, `hello\r\nHost: 127.0.0.1:${port()}\r\n\r\n`)).toContain('400 Bad Request');
      expect(aUpgrades.length).toBe(before);
      expect([...outside].some((o) => o.includes('Host: denied.invalid@'))).toBe(true);
      expect([...outside].some((o) => o.startsWith('unparseable request'))).toBe(true);
    });

    it('checks every request on a plain tunnel, not just the first', async () => {
      const got = await tunnel(`127.0.0.1:${port()}`, `GET /first HTTP/1.1\r\nHost: 127.0.0.1:${port()}\r\n\r\nGET /second HTTP/1.1\r\nHost: denied.invalid\r\n\r\n`);
      expect(got).toMatch(/^HTTP\/1\.1 200 Connection Established\r\n\r\nHTTP\/1\.1 200 /);
      expect(got).toContain('403');
      expect(aRequests).toContain('/first');
      expect(aRequests).not.toContain('/second');
      expect(outside.has(`http://127.0.0.1:${port()} (Host: denied.invalid)`)).toBe(true);
    });

    it('lets Playwright’s own API requests (which tunnel plain HTTP) reach an allowed origin', async () => {
      const page = await browser.newPage();
      expect((await page.request.get(`${A}/api-request`)).status()).toBe(200);
      expect(aRequests).toContain('/api-request');
      await page.close();
    });

    it('passes nothing after the handshake unless the server switches protocols', async () => {
      const got = await tunnel(`127.0.0.1:${port()}`, handshake('/refuse', `127.0.0.1:${port()}`) + 'GET /smuggled HTTP/1.1\r\nHost: denied.invalid\r\n\r\n');
      expect(got).toContain('403');
      expect(aRequests).not.toContain('/smuggled');
    });

    /** The ClientHello Node's TLS client sends for a server name. */
    const clientHello = (servername?: string) =>
      new Promise<Buffer>((resolve) => {
        const srv = net.createServer((sock) => {
          sock.once('data', (d) => {
            resolve(d as Buffer);
            sock.destroy();
            srv.close();
          });
        });
        srv.listen(0, '127.0.0.1', () => {
          const c = tls.connect({ host: '127.0.0.1', port: (srv.address() as AddressInfo).port, servername, rejectUnauthorized: false });
          c.on('error', () => {});
        });
      });

    it('reads the server name from a real ClientHello, and rejects partial or fake ones', async () => {
      const hello = await clientHello('denied.test');
      expect(readClientHello(hello)).toEqual({ serverName: 'denied.test' });
      expect(readClientHello(await clientHello())).toEqual({ serverName: null });
      expect(readClientHello(hello.subarray(0, 40))).toBe('more');
      expect(readClientHello(Buffer.from([0x16, 3, 3, 0, 1, 1]))).toBe('bad');
      const broken = Buffer.from(hello);
      broken.writeUInt16BE(broken.readUInt16BE(3) - 1, 3);
      expect(readClientHello(broken.subarray(0, broken.length - 1))).toBe('bad');
    });

    it('refuses a TLS tunnel whose server name is not the host it was opened to', async () => {
      const bPort = new URL(B).port;
      egress.allow(`https://localhost:${bPort}`);
      const got = await tunnel(`localhost:${bPort}`, await clientHello('denied.test'));
      expect(got).not.toContain('ok');
      expect(outside.has(`https://localhost:${bPort} (TLS server name denied.test)`)).toBe(true);
      // The right name goes through (B isn't a TLS server, so it just answers 400 to the bytes).
      const before = outside.size;
      await tunnel(`localhost:${bPort}`, await clientHello('localhost'));
      expect(outside.size).toBe(before);
    });

    it('reports a tunnel that closes before its first bytes can be checked', async () => {
      const bPort = new URL(B).port;
      await new Promise<void>((resolve) => {
        const sock = net.connect(Number(new URL(egress.url).port), '127.0.0.1', () => sock.write(`CONNECT localhost:${bPort} HTTP/1.1\r\nHost: localhost:${bPort}\r\n\r\n`));
        sock.once('data', () => sock.end(Buffer.from([0x16, 3, 3])));
        sock.on('close', () => resolve());
      });
      await expect.poll(() => [...outside].some((o) => o.startsWith(`localhost:${bPort} (closed after 3 byte(s)`))).toBe(true);
    });

    it('refuses requests without a Host, with two, or a CONNECT inside a tunnel', async () => {
      expect(await direct(`GET ${A}/no-host HTTP/1.1\r\nConnection: close\r\n\r\n`)).toContain('403');
      expect(await tunnel(`127.0.0.1:${port()}`, `GET /no-host HTTP/1.1\r\nConnection: close\r\n\r\n`)).toContain('403');
      expect(outside.has(`http://127.0.0.1:${port()} (Host: none)`)).toBe(true);
      const before = aUpgrades.length;
      const two = handshake('/socket', `127.0.0.1:${port()}`).replace('\r\n\r\n', `\r\nHost: denied.invalid\r\n\r\n`);
      expect(await tunnel(`127.0.0.1:${port()}`, two)).toContain('403');
      expect(aUpgrades.length).toBe(before);
      expect(outside.has(`http://127.0.0.1:${port()} (2 Host headers)`)).toBe(true);
      expect(await tunnel(`127.0.0.1:${port()}`, `CONNECT 127.0.0.1:${new URL(C).port} HTTP/1.1\r\nHost: 127.0.0.1:${new URL(C).port}\r\n\r\n`)).toContain('403');
      expect([...outside].some((o) => o.includes('inside a tunnel'))).toBe(true);
      expect(aRequests).not.toContain('/no-host');
    });

    it('refuses bytes that only look like TLS', async () => {
      egress.allow(`https://127.0.0.1:${new URL(B).port}`);
      const got = await tunnel(`127.0.0.1:${new URL(B).port}`, Buffer.concat([Buffer.from([0x16]), Buffer.from('GET / HTTP/1.1\r\n\r\n')]));
      expect(got).not.toContain('ok');
      expect([...outside].some((o) => o.includes('not a well-formed TLS ClientHello'))).toBe(true);
    });

    it('accepts direct ws: upgrades to an allowed http: origin, and refuses wss: and unparseable ones', async () => {
      expect(await direct(handshake(`ws://127.0.0.1:${port()}/socket`, `127.0.0.1:${port()}`))).toContain('101 Switching Protocols');
      const before = aUpgrades.length;
      expect(await direct(handshake(`wss://127.0.0.1:${port()}/socket`, `127.0.0.1:${port()}`))).toContain('403');
      expect(aUpgrades.length).toBe(before);
      expect(outside.has(`wss://127.0.0.1:${port()}`)).toBe(true);
      await direct(handshake('ws://[bad/socket', `127.0.0.1:${port()}`));
      expect([...outside].some((o) => o.startsWith('unparseable'))).toBe(true);
    });

    it('refuses a forwarded request with user info in its Host', async () => {
      const got = await direct(`GET ${A}/ HTTP/1.1\r\nHost: denied.invalid@127.0.0.1:${port()}\r\nConnection: close\r\n\r\n`);
      expect(got).toMatch(/^HTTP\/1\.1 (400|403)/);
    });
  });
});
