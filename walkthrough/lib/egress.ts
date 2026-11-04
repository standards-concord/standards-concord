/**
 * A local forward proxy that every browser connection goes through during a recording
 * (Chromium is launched with it and with loopback not bypassed; see lib/browser.ts). It
 * is the network allowlist: plain HTTP requests, every redirect hop (the browser follows
 * redirects as new requests), event streams, service-worker fetches, and CONNECT tunnels
 * for HTTPS and WebSockets are all checked against the exact allowed origins, scheme
 * included. Anything else is refused and reported in `outside`, including requests the
 * proxy can't parse.
 *
 * What it checks, and where its view stops:
 * - Plain requests: an absolute http: URL on an allowed origin, and a Host header that is
 *   exactly that origin's host[:port]. Node's HTTP parser reads them, so every request
 *   on a kept-alive connection is checked.
 * - A CONNECT tunnel names only host:port, so its first bytes decide its scheme. A TLS
 *   ClientHello may only go to an allowed https: origin; what follows is encrypted, so
 *   the proxy can't see further (the browser checks the certificate against the name).
 * - Any other tunnel is plain HTTP, so it may only go to an allowed http: origin, and the
 *   proxy parses it itself: each request on it must be for that origin, with a matching
 *   Host, exactly as above.
 * - A WebSocket handshake (over a tunnel, or sent straight to the proxy as a ws: URL) is
 *   held to the same rules. Nothing after it is passed on until the server answers
 *   101 Switching Protocols; after that the connection carries WebSocket frames.
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
/** How much of an upstream WebSocket reply we read while waiting for its status line. */
const MAX_HEAD = 64 * 1024;
const HOST_HEADER = /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::\d{1,5})?$/i;

/** host:port with the default port filled in, lower-cased, IPv6 in brackets; undefined unless it's a bare host[:port]. */
function authority(host: string | undefined, protocol: string): string | undefined {
  if (!host || !HOST_HEADER.test(host)) return undefined;
  try {
    const u = new URL(`${protocol}//${host}`);
    return `${u.hostname}:${u.port || defaultPort(protocol)}`;
  } catch {
    return undefined;
  }
}

/** A TLS record carrying a ClientHello: content type 22, version 3.x, a length, handshake type 1. */
function isClientHello(b: Buffer) {
  return b.length >= 6 && b[0] === TLS_HANDSHAKE && b[1] === 3 && b[2] <= 4 && b.readUInt16BE(3) > 0 && b[5] === 1;
}

const connectTo = (hostPort: string, onConnect: () => void) => {
  const i = hostPort.lastIndexOf(':');
  return net.connect(Number(hostPort.slice(i + 1)), hostPort.slice(0, i).replace(/^\[|\]$/g, ''), onConnect);
};

/** The origin's host:port a tunnel was opened to; set on sockets handed to the tunnel parser. */
const TUNNEL = Symbol('tunnel');
type TunnelSocket = net.Socket & { [TUNNEL]?: string };

export async function startEgressProxy(allowedOrigins: string[], outside: Set<string>): Promise<Egress> {
  // Which host:port pairs may be reached with TLS (https: origins) and in plain text (http:).
  const tls = new Set<string>();
  const plain = new Set<string>();
  const allow = (origin: string) => {
    const u = new URL(origin);
    const hp = `${u.hostname}:${u.port || defaultPort(u.protocol)}`;
    (u.protocol === 'https:' || u.protocol === 'wss:' ? tls : plain).add(hp);
  };
  for (const o of allowedOrigins) allow(o);
  const sockets = new Set<net.Socket>();
  const track = (s: net.Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  };
  const blocked = (what: string) => outside.add(what.slice(0, 300));

  /**
   * Where a parsed request may go: the allowed http: host:port it names, or a reason to
   * refuse it. Requests on a tunnel use the path form ("GET /x"); requests sent straight
   * to the proxy use the absolute form ("GET http://host/x").
   */
  const target = (req: http.IncomingMessage, scheme: 'http:' | 'ws:'): { hostPort: string; path: string } | { refuse: string } => {
    const tunnelled = (req.socket as TunnelSocket)[TUNNEL];
    const raw = req.url ?? '';
    let hostPort: string | undefined;
    let path: string;
    if (tunnelled) {
      if (!raw.startsWith('/')) return { refuse: `http://${tunnelled} (request for ${raw.slice(0, 100)})` };
      hostPort = tunnelled;
      path = raw;
    } else {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        return { refuse: `unparseable request: ${raw.slice(0, 200)}` };
      }
      if (url.protocol !== scheme || url.username || url.password) return { refuse: `${url.protocol}//${url.host}` };
      hostPort = authority(url.host, 'http:');
      if (!hostPort || !plain.has(hostPort)) return { refuse: `${url.protocol}//${url.host}` };
      path = `${url.pathname}${url.search}`;
    }
    const host = req.headers.host;
    if (authority(host, 'http:') !== hostPort) return { refuse: `http://${hostPort} (Host: ${host ?? 'none'})` };
    return { hostPort, path };
  };

  const forward = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const t = target(req, 'http:');
    if ('refuse' in t) {
      blocked(t.refuse);
      res.writeHead(403, { 'content-type': 'text/plain' }).end('Blocked by the walkthrough network allowlist');
      return;
    }
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    const i = t.hostPort.lastIndexOf(':');
    const upstream = http.request(
      { host: t.hostPort.slice(0, i).replace(/^\[|\]$/g, ''), port: Number(t.hostPort.slice(i + 1)), method: req.method, path: t.path, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  };

  /**
   * Passes a WebSocket handshake upstream and holds anything after it until the server
   * agrees to switch protocols, so no second request can ride along unchecked.
   */
  const upgrade = (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    const t = target(req, 'ws:');
    if ('refuse' in t || req.method !== 'GET' || !/^websocket$/i.test(req.headers.upgrade ?? '')) {
      blocked('refuse' in t ? t.refuse : `${req.url} (not a WebSocket handshake)`);
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const lines = [`GET ${t.path} HTTP/1.1`];
    for (let k = 0; k < req.rawHeaders.length; k += 2) if (!/^proxy-/i.test(req.rawHeaders[k])) lines.push(`${req.rawHeaders[k]}: ${req.rawHeaders[k + 1]}`);
    let held = head;
    const hold = (chunk: Buffer) => {
      held = Buffer.concat([held, chunk]);
    };
    client.on('data', hold);
    const upstream = connectTo(t.hostPort, () => upstream.write(`${lines.join('\r\n')}\r\n\r\n`));
    track(upstream);
    let reply = Buffer.alloc(0);
    const onReply = (chunk: Buffer) => {
      reply = Buffer.concat([reply, chunk]);
      const end = reply.indexOf('\r\n\r\n');
      if (end < 0 && reply.length < MAX_HEAD) return;
      upstream.off('data', onReply);
      client.off('data', hold);
      client.write(reply);
      if (end < 0 || !/^HTTP\/1\.1 101 /.test(reply.subarray(0, end).toString('latin1'))) {
        client.end();
        upstream.destroy();
        return;
      }
      if (held.length) upstream.write(held);
      upstream.pipe(client);
      client.pipe(upstream);
    };
    upstream.on('data', onReply);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  };

  // Requests Node's own parser rejects are refusals too.
  const clientError = (err: NodeJS.ErrnoException, socket: net.Socket) => {
    const to = (socket as TunnelSocket)[TUNNEL];
    if (err.code !== 'ECONNRESET') blocked(`unparseable request (${err.code ?? err.message})${to ? ` to ${to}` : ''}`);
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    else socket.destroy();
  };

  // Plain-text tunnels are parsed here, request by request, rather than passed through.
  const tunnels = http.createServer(forward);
  tunnels.on('upgrade', upgrade);
  tunnels.on('clientError', clientError);

  /** Reads the first bytes of a tunnel to learn its scheme, then sends it on its way. */
  const inspect = (client: TunnelSocket, hostPort: string, head: Buffer) => {
    let buf = head;
    const decide = () => {
      if (!buf.length || (buf[0] === TLS_HANDSHAKE && buf.length < 6)) return false;
      client.pause();
      if (buf[0] === TLS_HANDSHAKE) {
        if (!tls.has(hostPort)) blocked(`https://${hostPort}`);
        else if (!isClientHello(buf)) blocked(`https://${hostPort} (not a TLS ClientHello)`);
        else {
          const first = buf;
          const upstream = connectTo(hostPort, () => {
            upstream.write(first);
            upstream.pipe(client);
            client.pipe(upstream);
          });
          track(upstream);
          upstream.on('error', () => client.destroy());
          client.on('error', () => upstream.destroy());
          return true;
        }
        client.destroy();
        return true;
      }
      if (!plain.has(hostPort)) {
        blocked(`http://${hostPort}`);
        client.destroy();
        return true;
      }
      client[TUNNEL] = hostPort;
      client.unshift(buf);
      tunnels.emit('connection', client);
      client.resume();
      return true;
    };
    if (decide()) return;
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (decide()) client.off('data', onData);
    };
    client.on('data', onData);
  };

  const server = http.createServer(forward);
  server.on('connect', (req, client: net.Socket, head) => {
    const hostPort = authority(req.url, 'https:');
    if (!hostPort || (!tls.has(hostPort) && !plain.has(hostPort))) {
      blocked(hostPort ?? `CONNECT ${req.url}`);
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    client.on('error', () => client.destroy());
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    inspect(client, hostPort, head);
  });
  server.on('upgrade', upgrade);
  server.on('clientError', clientError);
  server.on('connection', track);

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    allow,
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        tunnels.close();
        server.close(() => r());
      }),
  };
}
