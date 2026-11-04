/**
 * A local forward proxy that every browser connection goes through during a recording
 * (Chromium is launched with it and with loopback not bypassed). It is the network
 * allowlist: plain HTTP requests, every redirect hop (the browser follows redirects as new
 * requests), event streams, service-worker fetches, and CONNECT tunnels for HTTPS and
 * WebSockets are all checked against the exact allowed origins. Anything else gets a 403
 * and its origin is reported.
 *
 * Responses that Playwright routes fulfil themselves (vendored modules, fonts) never
 * reach the network, so they never reach this proxy either.
 */
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

export interface Egress {
  url: string;
  /** Adds an origin to the allowlist (for servers started after the browser). */
  allow(origin: string): void;
  close(): Promise<void>;
}

const defaultPort = (protocol: string) => (protocol === 'https:' || protocol === 'wss:' ? '443' : '80');

export async function startEgressProxy(allowedOrigins: string[], outside: Set<string>): Promise<Egress> {
  const allowed = new Set(allowedOrigins.map((o) => new URL(o).origin));
  // CONNECT only names host:port, so match on that (it carries HTTPS and WebSockets).
  const allowedHostPorts = new Set<string>();
  const allow = (origin: string) => {
    const u = new URL(origin);
    allowed.add(u.origin);
    allowedHostPorts.add(`${u.hostname}:${u.port || defaultPort(u.protocol)}`);
  };
  for (const o of [...allowed]) allow(o);
  const sockets = new Set<net.Socket>();

  const server = http.createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end('Absolute URL expected');
      return;
    }
    if (!allowed.has(url.origin)) {
      outside.add(url.origin);
      res.writeHead(403, { 'content-type': 'text/plain' }).end('Blocked by the walkthrough network allowlist');
      return;
    }
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    const upstream = http.request(url, { method: req.method, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });

  const tunnel = (client: net.Socket, hostPort: string, head: Buffer, preface?: string) => {
    if (!allowedHostPorts.has(hostPort)) {
      outside.add(hostPort);
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const i = hostPort.lastIndexOf(':');
    const upstream = net.connect(Number(hostPort.slice(i + 1)), hostPort.slice(0, i).replace(/^\[|\]$/g, ''), () => {
      if (preface) upstream.write(preface);
      else client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  };

  server.on('connect', (req, client: net.Socket, head) => tunnel(client, req.url ?? '', head));
  // A WebSocket upgrade sent to the proxy as a plain request (rather than over CONNECT).
  server.on('upgrade', (req, client: net.Socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      client.destroy();
      return;
    }
    const lines = [`${req.method} ${url.pathname}${url.search} HTTP/${req.httpVersion}`];
    for (let k = 0; k < req.rawHeaders.length; k += 2) if (!/^proxy-/i.test(req.rawHeaders[k])) lines.push(`${req.rawHeaders[k]}: ${req.rawHeaders[k + 1]}`);
    tunnel(client, `${url.hostname}:${url.port || defaultPort(url.protocol)}`, head, `${lines.join('\r\n')}\r\n\r\n`);
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    allow,
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}
