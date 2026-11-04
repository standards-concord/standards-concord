/**
 * A local forward proxy that every browser connection goes through during a recording
 * (Chromium is launched with it and with loopback not bypassed; see lib/browser.ts). It
 * is the network allowlist: plain HTTP requests, every redirect hop (the browser follows
 * redirects as new requests), event streams, service-worker fetches, and CONNECT tunnels
 * for HTTPS and WebSockets are all checked against the exact allowed origins, scheme
 * included. Anything else gets a 403 (or a closed tunnel) and its origin is reported.
 *
 * A CONNECT request only names host:port, so a tunnel is checked again on its first
 * bytes: a TLS handshake is let through only to an https: origin, and plain text only to
 * an http: origin, and then only as an HTTP request whose Host is that origin. So with
 * http://127.0.0.1:5184 allowed, https://127.0.0.1:5184 is still refused. Forwarded
 * plain requests must also carry the Host of the URL they ask for.
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
const TLS_HANDSHAKE = 0x16;
/** How much of a plain tunnel's first request we read before giving up on finding its Host. */
const MAX_HEAD = 64 * 1024;

/** host:port with the default port filled in, lower-cased, IPv6 in brackets. */
function authority(host: string, protocol: string): string | undefined {
  try {
    const u = new URL(`${protocol}//${host}`);
    return `${u.hostname}:${u.port || defaultPort(protocol)}`;
  } catch {
    return undefined;
  }
}

export async function startEgressProxy(allowedOrigins: string[], outside: Set<string>): Promise<Egress> {
  const allowed = new Set<string>();
  // Tunnels: which host:port pairs may carry TLS (https:) and which plain text (http:).
  const tls = new Set<string>();
  const plain = new Set<string>();
  const allow = (origin: string) => {
    const u = new URL(origin);
    allowed.add(u.origin);
    const hp = `${u.hostname}:${u.port || defaultPort(u.protocol)}`;
    (u.protocol === 'https:' || u.protocol === 'wss:' ? tls : plain).add(hp);
  };
  for (const o of allowedOrigins) allow(o);
  const sockets = new Set<net.Socket>();
  const track = (s: net.Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  };

  const server = http.createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end('Absolute URL expected');
      return;
    }
    const host = req.headers.host;
    if (!allowed.has(url.origin) || (host && authority(host, url.protocol) !== authority(url.host, url.protocol))) {
      outside.add(host && allowed.has(url.origin) ? `${url.origin} (Host: ${host})` : url.origin);
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

  const refuse = (client: net.Socket, what: string) => {
    outside.add(what);
    client.destroy();
  };

  /** Connects the client to host:port once its first bytes have been checked. */
  const open = (client: net.Socket, hostPort: string, first: Buffer) => {
    const i = hostPort.lastIndexOf(':');
    const upstream = net.connect(Number(hostPort.slice(i + 1)), hostPort.slice(0, i).replace(/^\[|\]$/g, ''), () => {
      upstream.write(first);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    track(upstream);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  };

  /** Reads the start of a tunnel and lets it through only if it matches an allowed origin's scheme. */
  const inspect = (client: net.Socket, hostPort: string, head: Buffer) => {
    let buf = head;
    const decide = () => {
      if (!buf.length) return false;
      client.pause();
      if (buf[0] === TLS_HANDSHAKE) {
        if (!tls.has(hostPort)) refuse(client, `https://${hostPort}`);
        else open(client, hostPort, buf);
        return true;
      }
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buf.length > MAX_HEAD) refuse(client, `http://${hostPort}`);
        else {
          client.resume();
          return false;
        }
        return true;
      }
      const host = /^host:[ \t]*([^\r\n]*)$/im.exec(buf.subarray(0, end).toString('latin1'))?.[1]?.trim();
      if (!plain.has(hostPort)) refuse(client, `http://${hostPort}`);
      else if (!host || authority(host, 'http:') !== hostPort) refuse(client, `http://${hostPort} (Host: ${host ?? 'none'})`);
      else open(client, hostPort, buf);
      return true;
    };
    if (decide()) return;
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (decide()) client.off('data', onData);
    };
    client.on('data', onData);
  };

  server.on('connect', (req, client: net.Socket, head) => {
    const hostPort = authority(req.url ?? '', 'https:');
    if (!hostPort || (!tls.has(hostPort) && !plain.has(hostPort))) {
      outside.add(hostPort ?? String(req.url));
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    client.on('error', () => client.destroy());
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    inspect(client, hostPort, head);
  });

  // A WebSocket upgrade sent to the proxy as a plain request (rather than over CONNECT).
  server.on('upgrade', (req, client: net.Socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      client.destroy();
      return;
    }
    const origin = url.origin.replace(/^ws/, 'http');
    const host = req.headers.host;
    if (!allowed.has(origin) || (host && authority(host, url.protocol) !== authority(url.host, url.protocol))) {
      outside.add(origin);
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const lines = [`${req.method} ${url.pathname}${url.search} HTTP/${req.httpVersion}`];
    for (let k = 0; k < req.rawHeaders.length; k += 2) if (!/^proxy-/i.test(req.rawHeaders[k])) lines.push(`${req.rawHeaders[k]}: ${req.rawHeaders[k + 1]}`);
    open(client, authority(url.host, url.protocol)!, Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`), head]));
  });
  server.on('connection', track);

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
