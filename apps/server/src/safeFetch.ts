import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { Readable } from 'node:stream';

/**
 * Fetching URLs that untrusted parties choose (OAuth Client ID Metadata
 * Documents), without letting them reach Concord's private network or tie up
 * the server:
 *
 *  - A host written as an IP address is checked before any socket opens (Node
 *    skips the DNS lookup for those). Host names are checked inside the
 *    socket's own DNS lookup, so the address that was checked is the one
 *    connected to (no DNS rebinding). TLS still verifies the hostname.
 *  - Only global unicast addresses are allowed.
 *  - No redirects, no compression, a hard byte cap while streaming, one
 *    deadline covering DNS, connect and body, and a cap on concurrent fetches.
 *    Whatever the outcome, the connection is destroyed before the fetch's
 *    slot is released, so no response keeps downloading after it is refused.
 */

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
// Within 2000::/3 (the only global unicast space), these are still not reachable public hosts
// or can tunnel to IPv4 addresses we would otherwise refuse.
const V6_BLOCKED: [string, number][] = [
  ['2001::', 23], // IETF protocol assignments, including Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['3fff::', 20], // documentation
];

const v4Blocked = new BlockList();
for (const [net, bits] of V4_BLOCKED) v4Blocked.addSubnet(net, bits, 'ipv4');
const v6Blocked = new BlockList();
for (const [net, bits] of V6_BLOCKED) v6Blocked.addSubnet(net, bits, 'ipv6');
const v6Global = new BlockList();
v6Global.addSubnet('2000::', 3, 'ipv6');

/** True only for addresses on the public internet. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !v4Blocked.check(ip, 'ipv4');
  if (family !== 6) return false;
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mapped) return isPublicAddress(mapped);
  // Any other form of ::ffff:0:0/96 (such as ::ffff:7f00:1) falls outside 2000::/3 below and is refused.
  return v6Global.check(ip, 'ipv6') && !v6Blocked.check(ip, 'ipv6');
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** A DNS lookup for sockets that refuses to resolve to anything but public addresses. */
export function publicOnlyLookup(hostname: string, options: { all?: boolean; family?: number } | number, callback: LookupCallback) {
  const opts = typeof options === 'number' ? { family: options } : options;
  dnsLookup(hostname, { all: true, family: opts.family ?? 0 }, (err, addresses) => {
    if (err) return callback(err, '');
    const list = addresses as LookupAddress[];
    const bad = list.find((a) => !isPublicAddress(a.address));
    if (!list.length || bad) {
      const e = new Error(`Refusing to connect to ${hostname} (${bad?.address ?? 'no address'}): not a public address`) as NodeJS.ErrnoException;
      e.code = 'EPRIVATE';
      return callback(e, '');
    }
    if (opts.all) return callback(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
}

/** Read a stream into a string, failing as soon as it passes `maxBytes`. */
export function readCapped(stream: Readable, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        stream.destroy();
        reject(new FetchError('too-large', `Response is larger than ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', (e) => reject(e));
    // Closed without 'end' (the connection was cut): never leave the caller waiting.
    stream.on('close', () => reject(new FetchError('unavailable', 'The connection closed before the response finished')));
  });
}

export class FetchError extends Error {
  constructor(
    readonly kind: 'not-found' | 'too-large' | 'bad-response' | 'unavailable' | 'busy',
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

let active = 0;
const MAX_CONCURRENT = 4;
/** Requests waiting for one of the MAX_CONCURRENT connections, in order. Beyond MAX_QUEUED, new ones are refused as 'busy'. */
const waiting: (() => void)[] = [];
const MAX_QUEUED = 500;

/** Wait for a connection slot (first come, first served). */
function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  if (waiting.length >= MAX_QUEUED) return Promise.reject(new FetchError('busy', 'Too many fetches waiting'));
  // The slot is handed over by release() without decrementing, so it can't be taken by a newcomer in between.
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

export interface SafeFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  /** Tests only: allow private addresses. */
  allowPrivate?: boolean;
  /** Tests only: trust this CA certificate (PEM) as well. */
  ca?: string;
  /** Accept header (default application/json). */
  accept?: string;
  /** Allow plain http too. Only for hosts the operator configured as trusted (and tests). */
  allowHttp?: boolean;
}

/** The URL's host as an IP address, if it is written as one (WHATWG URLs normalise 2130706433 to 127.0.0.1). */
export function ipLiteral(url: URL): string | undefined {
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  return isIP(host) ? host : undefined;
}

export interface SafeRequestOptions extends SafeFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  /** Refuse a status before its body is read (the connection is dropped at once). */
  refuseStatus?: (status: number) => FetchError | undefined;
}

export interface SafeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Make one request with the protections above, whatever the status (redirects
 * are returned, never followed). Throws FetchError 'too-large', 'busy',
 * 'bad-response' (refused address, scheme or encoding) or 'unavailable'
 * (network errors and the deadline, which covers the whole body).
 */
export function safeRequest(url: URL, opts: SafeRequestOptions = {}): Promise<SafeResponse> {
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  const timeoutMs = opts.timeoutMs ?? 5000;
  if (url.protocol !== 'https:' && !(opts.allowHttp && url.protocol === 'http:')) return Promise.reject(new FetchError('bad-response', 'Only https URLs can be fetched'));
  if (url.username || url.password) return Promise.reject(new FetchError('bad-response', 'URLs with credentials are not fetched'));
  const literal = ipLiteral(url);
  if (literal && !opts.allowPrivate && !isPublicAddress(literal)) return Promise.reject(new FetchError('bad-response', `Refusing to connect to ${literal}: not a public address`));
  return acquire().then(() => connect(url, opts, maxBytes, timeoutMs));
}

/** One request, holding a connection slot until it settles. */
function connect(url: URL, opts: SafeRequestOptions, maxBytes: number, timeoutMs: number): Promise<SafeResponse> {
  return new Promise<SafeResponse>((resolve, reject) => {
    let settled = false;
    const done = (err: Error | undefined, value?: SafeResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Tear the connection down before giving the slot back: nothing more is read once we've decided.
      req.destroy();
      release();
      if (err) reject(err instanceof FetchError ? err : new FetchError('unavailable', err.message));
      else resolve(value!);
    };
    const headers: Record<string, string> = { Accept: opts.accept ?? 'application/json', 'User-Agent': 'Concord', ...opts.headers, 'Accept-Encoding': 'identity' };
    if (opts.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(opts.body));
    const req = (url.protocol === 'http:' ? http : https).request(
      url,
      {
        method: opts.method ?? 'GET',
        headers,
        // A fresh connection each time: no pooled socket outlives the fetch.
        agent: false,
        ...(opts.ca ? { ca: opts.ca } : {}),
        lookup: (opts.allowPrivate ? dnsLookup : publicOnlyLookup) as never,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // Refused responses are never read: done() destroys the connection.
        const refused = opts.refuseStatus?.(status);
        if (refused) return done(refused);
        const encoding = res.headers['content-encoding'];
        if (encoding && encoding !== 'identity') return done(new FetchError('bad-response', `Unexpected content encoding ${encoding}`));
        const length = Number(res.headers['content-length']);
        if (Number.isFinite(length) && length > maxBytes) return done(new FetchError('too-large', `Response is ${length} bytes`));
        const flat: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) flat[k] = Array.isArray(v) ? v.join(', ') : v;
        if (opts.method === 'HEAD') return done(undefined, { status, headers: flat, body: '' });
        readCapped(res, maxBytes).then(
          (body) => done(undefined, { status, headers: flat, body }),
          (e: Error) => done(e),
        );
      },
    );
    // One deadline for DNS, connecting, TLS and the whole body.
    const timer = setTimeout(() => done(new FetchError('unavailable', `Timed out after ${timeoutMs} ms`)), timeoutMs);
    req.on('error', (e) => done(e));
    req.end(opts.body);
  });
}

/**
 * GET an https URL as text with the protections above. Throws FetchError:
 * 'not-found' for 404/410, 'bad-response' for other non-2xx or odd responses,
 * 'too-large', 'busy' when too many fetches are in flight, and 'unavailable'
 * for network errors and timeouts.
 */
export async function safeFetchText(url: URL, opts: SafeFetchOptions = {}): Promise<string> {
  const res = await safeRequest(url, {
    ...opts,
    refuseStatus: (status) => {
      if (status === 404 || status === 410) return new FetchError('not-found', `HTTP ${status}`, status);
      if (status >= 500) return new FetchError('unavailable', `HTTP ${status}`, status);
      if (status < 200 || status >= 300) return new FetchError('bad-response', `HTTP ${status}`, status);
      return undefined;
    },
  });
  return res.body;
}
