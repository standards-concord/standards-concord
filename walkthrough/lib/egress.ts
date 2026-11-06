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
 *   tunnel may only go to an allowed https: origin, and must open with a complete
 *   ClientHello naming that host (SNI; none for an IP address). The proxy checks the
 *   hello's framing, its fixed fields and the framing of the list-valued extensions; the
 *   meaning of the rest is left to the TLS server, which is always an allowed origin. What follows
 *   is encrypted, so the proxy can't see further: the browser checks the server's
 *   certificate against that name, but a server holding certificates for several names
 *   could still be asked for another one inside TLS.
 * - Any other tunnel is plain HTTP, so it may only go to an allowed http: origin, and the
 *   proxy parses it itself: each request on it must be for that origin, with a matching
 *   Host, exactly as above.
 * - Every request, CONNECT included, must carry exactly one Host header naming its
 *   target; a CONNECT inside a tunnel, or anything malformed or unexpected, is refused.
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

/**
 * Checks the framing of the extensions a browser's ClientHello carries whose contents are
 * lists: each length must match its contents, and each list must be non-empty except
 * key_share's, which a client may leave empty to wait for the server's choice of group. Other extensions are checked
 * only for fitting in the hello; their meaning is for the TLS server (which is always an
 * allowed origin) to judge.
 */
function extensionOk(type: number, d: Buffer): boolean {
  const list16 = (unit: number) => d.length >= 2 + unit && d.readUInt16BE(0) === d.length - 2 && (d.length - 2) % unit === 0;
  switch (type) {
    case 10: // supported_groups: two-byte entries
    case 13: // signature_algorithms
    case 50: // signature_algorithms_cert
      return list16(2);
    case 43: // supported_versions: a one-byte length, then two-byte versions
      return d.length >= 3 && d[0] === d.length - 1 && d[0] % 2 === 0;
    case 45: // psk_key_exchange_modes: a one-byte length, then one-byte modes
    case 11: // ec_point_formats
      return d.length >= 2 && d[0] === d.length - 1;
    case 16: {
      // application_layer_protocol_negotiation: a list of non-empty one-byte-length names
      if (d.length < 3 || d.readUInt16BE(0) !== d.length - 2) return false;
      for (let k = 2; k < d.length; k += 1 + d[k]) if (d[k] === 0 || k + 1 + d[k] > d.length) return false;
      return true;
    }
    case 51: {
      // key_share: a list of (group, length, key) entries
      if (d.length < 2 || d.readUInt16BE(0) !== d.length - 2) return false;
      let k = 2;
      while (k < d.length) {
        if (k + 4 > d.length) return false;
        const n = d.readUInt16BE(k + 2);
        if (n === 0 || k + 4 + n > d.length) return false;
        k += 4 + n;
      }
      return true;
    }
    default:
      return true;
  }
}

/**
 * Reads a TLS ClientHello from the start of a tunnel: the whole first record, which must
 * hold the whole handshake message. Returns 'more' until enough bytes have arrived, the
 * server name it asks for (or null if none), or 'bad' if it isn't a well-formed ClientHello.
 * The browser always sends its ClientHello in one record (it is well under 16 KB).
 */
export function readClientHello(b: Buffer): 'more' | 'bad' | { serverName: string | null } {
  if (b.length < 5) return 'more';
  if (b[0] !== TLS_HANDSHAKE || b[1] !== 3 || b[2] > 4) return 'bad';
  const recordLength = b.readUInt16BE(3);
  if (recordLength < 4 || recordLength > 16384) return 'bad';
  if (b.length < 5 + recordLength) return 'more';
  const r = b.subarray(5, 5 + recordLength);
  if (r[0] !== 1) return 'bad';
  const length = r.readUIntBE(1, 3);
  if (4 + length !== r.length) return 'bad';
  let i = 4;
  const need = (n: number) => {
    if (i + n > r.length) throw new Error('short');
  };
  try {
    need(2 + 32);
    // legacy_version: TLS 1.0 to 1.2 (1.3 clients send 1.2 here).
    if (r[i] !== 3 || r[i + 1] < 1 || r[i + 1] > 3) return 'bad';
    i += 2 + 32; // version, random
    need(1);
    if (r[i] > 32) return 'bad';
    i += 1 + r[i]; // session id, at most 32 bytes
    need(2);
    const suites = r.readUInt16BE(i);
    if (suites < 2 || suites % 2) return 'bad';
    i += 2;
    need(suites);
    i += suites; // cipher suites: at least one, two bytes each
    need(1);
    const methods = r[i];
    need(1 + methods);
    if (methods < 1 || !r.subarray(i + 1, i + 1 + methods).includes(0)) return 'bad';
    i += 1 + methods; // compression methods, including "none"
    // Browsers always send extensions; a hello without them isn't one we expect.
    need(2);
    const end = i + 2 + r.readUInt16BE(i);
    i += 2;
    if (end !== r.length) return 'bad';
    let serverName: string | null = null;
    const seen = new Set<number>();
    while (i < end) {
      need(4);
      const type = r.readUInt16BE(i);
      const len = r.readUInt16BE(i + 2);
      i += 4;
      need(len);
      if (seen.has(type)) return 'bad';
      seen.add(type);
      if (type === 0) {
        // server_name: a list holding one host_name.
        if (serverName !== null || len < 5) return 'bad';
        const list = r.readUInt16BE(i);
        const nameType = r[i + 2];
        const nameLength = r.readUInt16BE(i + 3);
        if (list !== len - 2 || nameType !== 0 || nameLength !== len - 5) return 'bad';
        serverName = r.subarray(i + 5, i + 5 + nameLength).toString('latin1');
        if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(serverName)) return 'bad';
      } else if (!extensionOk(type, r.subarray(i, i + len))) return 'bad';
      i += len;
    }
    return i === end ? { serverName } : 'bad';
  } catch {
    return 'bad';
  }
}

const connectTo = (hostPort: string, onConnect: () => void) => {
  const i = hostPort.lastIndexOf(':');
  return net.connect(Number(hostPort.slice(i + 1)), hostPort.slice(0, i).replace(/^\[|\]$/g, ''), onConnect);
};

/** The origin's host:port a tunnel was opened to; set on sockets handed to the tunnel parser. */
const TUNNEL = Symbol('tunnel');
type TunnelSocket = net.Socket & { [TUNNEL]?: string };

export interface EgressOptions {
  /** Called with the error code each time a client hang-up is ignored rather than reported (for tests). */
  onHangUp?: (code: string) => void;
}

export async function startEgressProxy(allowedOrigins: string[], outside: Set<string>, options: EgressOptions = {}): Promise<Egress> {
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
    const hosts = req.rawHeaders.filter((_, k) => k % 2 === 0 && /^host$/i.test(req.rawHeaders[k])).length;
    if (hosts > 1) return { refuse: `http://${hostPort} (${hosts} Host headers)` };
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

  // Requests Node's own parser rejects are refusals too. A browser hanging up (ECONNRESET
  // when the proxy reads, EPIPE when it writes, as when a page navigates away mid-response)
  // is not a request at all, and nothing is forwarded from here either way.
  const HANG_UPS = new Set(['ECONNRESET', 'EPIPE']);
  const clientError = (err: NodeJS.ErrnoException, socket: net.Socket) => {
    const to = (socket as TunnelSocket)[TUNNEL];
    if (HANG_UPS.has(err.code ?? '')) options.onHangUp?.(err.code!);
    else blocked(`unparseable request (${err.code ?? err.message})${to ? ` to ${to}` : ''}`);
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    else socket.destroy();
  };

  // An Expect header other than 100-continue: Node would answer 417 itself, unrecorded.
  const expectation = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const to = (req.socket as TunnelSocket)[TUNNEL];
    blocked(`${to ? `http://${to}` : String(req.url).slice(0, 200)} (Expect: ${String(req.headers.expect).slice(0, 60)})`);
    res.writeHead(417).end();
  };

  // Plain-text tunnels are parsed here, request by request, rather than passed through.
  const tunnels = http.createServer({ requireHostHeader: false }, forward);
  tunnels.on('upgrade', upgrade);
  tunnels.on('clientError', clientError);
  tunnels.on('checkExpectation', expectation);
  // A CONNECT inside a tunnel would open a tunnel the outer check never saw.
  tunnels.on('connect', (req, client: net.Socket) => {
    blocked(`http://${(client as TunnelSocket)[TUNNEL]} (CONNECT ${String(req.url).slice(0, 100)} inside a tunnel)`);
    client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });

  /** Reads the first bytes of a tunnel to learn its scheme, then sends it on its way. */
  const inspect = (client: TunnelSocket, hostPort: string, head: Buffer) => {
    let buf = head;
    let decided = false;
    const hostname = hostPort.slice(0, hostPort.lastIndexOf(':')).replace(/^\[|\]$/g, '');
    const isIp = net.isIP(hostname) !== 0;
    const decide = () => {
      if (!buf.length) return false;
      if (buf[0] === TLS_HANDSHAKE) {
        const hello = readClientHello(buf);
        if (hello === 'more') return false;
        decided = true;
        client.pause();
        if (!tls.has(hostPort)) blocked(`https://${hostPort}`);
        else if (hello === 'bad') blocked(`https://${hostPort} (not a well-formed TLS ClientHello)`);
        // The name the browser asks the server for must be the one the tunnel was allowed for
        // (browsers send none for an IP address).
        else if (isIp ? hello.serverName !== null : hello.serverName?.toLowerCase() !== hostname.toLowerCase())
          blocked(`https://${hostPort} (TLS server name ${hello.serverName ?? 'none'})`);
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
      decided = true;
      client.pause();
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
    // A tunnel that sent something but closed before it could be checked is a refusal too.
    const ended = () => {
      if (decided) return;
      decided = true;
      if (buf.length) blocked(`${hostPort} (closed after ${buf.length} byte(s), before they could be checked)`);
      client.destroy();
    };
    client.on('end', ended);
    client.on('close', ended);
  };

  const server = http.createServer({ requireHostHeader: false }, forward);
  server.on('connect', (req, client: net.Socket, head) => {
    const hostPort = authority(req.url, 'https:');
    if (!hostPort || (!tls.has(hostPort) && !plain.has(hostPort))) {
      blocked(hostPort ?? `CONNECT ${req.url}`);
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    // Its Host must be exactly the target too, as for any other request.
    const hosts = req.rawHeaders.filter((_, k) => k % 2 === 0 && /^host$/i.test(req.rawHeaders[k])).length;
    if (hosts !== 1 || authority(req.headers.host, 'https:') !== hostPort) {
      blocked(`CONNECT ${hostPort} (${hosts === 1 ? `Host: ${req.headers.host}` : `${hosts} Host headers`})`);
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    client.on('error', () => client.destroy());
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    inspect(client, hostPort, head);
  });
  server.on('upgrade', upgrade);
  server.on('clientError', clientError);
  server.on('checkExpectation', expectation);
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
