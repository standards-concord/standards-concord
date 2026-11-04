import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { Readable } from 'node:stream';

/**
 * Fetching URLs that untrusted parties choose (OAuth Client ID Metadata
 * Documents), without letting them reach Concord's private network or tie up
 * the server:
 *
 *  - The address is checked inside the socket's own DNS lookup, so the
 *    address that was checked is the one connected to (no DNS rebinding).
 *    TLS still verifies the hostname.
 *  - Only global unicast addresses are allowed.
 *  - No redirects, no compression, a hard byte cap while streaming, one
 *    deadline covering DNS, connect and body, and a cap on concurrent fetches.
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

export interface SafeFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  /** Tests only: allow private addresses. */
  allowPrivate?: boolean;
}

/**
 * GET an https URL as text with the protections above. Throws FetchError:
 * 'not-found' for 404/410, 'bad-response' for other non-2xx or odd responses,
 * 'too-large', 'busy' when too many fetches are in flight, and 'unavailable'
 * for network errors and timeouts.
 */
export function safeFetchText(url: URL, opts: SafeFetchOptions = {}): Promise<string> {
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  const timeoutMs = opts.timeoutMs ?? 5000;
  if (url.protocol !== 'https:') return Promise.reject(new FetchError('bad-response', 'Only https URLs can be fetched'));
  if (active >= MAX_CONCURRENT) return Promise.reject(new FetchError('busy', 'Too many metadata fetches in progress'));
  active++;
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const done = (err: Error | undefined, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      active--;
      if (err) reject(err instanceof FetchError ? err : new FetchError('unavailable', err.message));
      else resolve(value!);
    };
    const req = https.request(
      url,
      {
        method: 'GET',
        headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'Concord OAuth' },
        lookup: (opts.allowPrivate ? dnsLookup : publicOnlyLookup) as never,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status === 404 || status === 410) return void (res.resume(), done(new FetchError('not-found', `HTTP ${status}`, status)));
        if (status >= 500) return void (res.resume(), done(new FetchError('unavailable', `HTTP ${status}`, status)));
        if (status < 200 || status >= 300) return void (res.resume(), done(new FetchError('bad-response', `HTTP ${status}`, status)));
        const encoding = res.headers['content-encoding'];
        if (encoding && encoding !== 'identity') return void (res.destroy(), done(new FetchError('bad-response', `Unexpected content encoding ${encoding}`)));
        const length = Number(res.headers['content-length']);
        if (Number.isFinite(length) && length > maxBytes) return void (res.destroy(), done(new FetchError('too-large', `Response is ${length} bytes`)));
        readCapped(res, maxBytes).then(
          (text) => done(undefined, text),
          (e: Error) => done(e),
        );
      },
    );
    // One deadline for DNS, connecting, TLS and the whole body.
    const timer = setTimeout(() => {
      req.destroy(new FetchError('unavailable', `Timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    req.on('error', (e) => done(e));
    req.end();
  });
}
