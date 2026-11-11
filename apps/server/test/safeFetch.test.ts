import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import net, { type AddressInfo, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claim, closeDb, openDb, put, take, transaction } from '../src/db.js';
import { FetchError, ipLiteral, safeFetchText } from '../src/safeFetch.js';

const until = async (check: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return check();
};

describe('IP addresses written into the URL', () => {
  // Plain listeners on loopback: a fetch that got past the check would show up as a connection.
  const listeners: net.Server[] = [];
  let connections = 0;
  let port4 = 0;
  let port6 = 0;
  beforeAll(async () => {
    const listen = (host: string) =>
      new Promise<number>((resolve) => {
        const s = net.createServer((sock) => {
          connections++;
          sock.destroy();
        });
        listeners.push(s);
        // No IPv6 on this machine: skip the IPv6 case.
        s.once('error', () => resolve(0));
        s.listen(0, host, () => resolve((s.address() as AddressInfo).port));
      });
    port4 = await listen('127.0.0.1');
    port6 = await listen('::1');
  });
  afterAll(() => listeners.forEach((s) => s.listening && s.close()));

  it('normalises every spelling to an address', () => {
    expect(ipLiteral(new URL('https://2130706433/'))).toBe('127.0.0.1');
    expect(ipLiteral(new URL('https://0x7f.1/'))).toBe('127.0.0.1');
    expect(ipLiteral(new URL('https://[::ffff:127.0.0.1]/'))).toBe('::ffff:7f00:1');
    expect(ipLiteral(new URL('https://example.org/'))).toBeUndefined();
  });

  it('refuses private addresses before opening a socket', async () => {
    const urls = [`https://127.0.0.1:${port4}/meta`, `https://2130706433:${port4}/meta`, `https://0x7f.1:${port4}/meta`, `https://[::ffff:127.0.0.1]:${port4}/meta`, `https://[::ffff:7f00:1]:${port4}/meta`];
    // IPv6 loopback is refused before any socket too; the listener only exists where the machine has IPv6.
    urls.push(`https://[::1]:${port6 || port4}/meta`);
    for (const u of urls) await expect(safeFetchText(new URL(u)), u).rejects.toThrow(/not a public address/);
    await new Promise((r) => setTimeout(r, 100));
    expect(connections).toBe(0);
  });
});

describe('responses that are refused or too slow', () => {
  let server: https.Server;
  let port = 0;
  let ca = '';
  const open = new Set<Socket>();
  let written = 0;

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
    ca = fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8');
    server = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: ca }, (req, res) => {
      const status = Number(req.url!.slice(1)) || 200;
      // Every response streams forever: only the client hanging up ends it.
      res.writeHead(status, status === 302 ? { Location: 'https://example.org/' } : {});
      const tick = setInterval(() => {
        if (res.destroyed) return clearInterval(tick);
        res.write(Buffer.alloc(1024, 'a'), () => void 0);
        written += 1024;
      }, 2);
      res.on('close', () => clearInterval(tick));
    });
    server.on('secureConnection', (sock) => {
      open.add(sock);
      sock.on('close', () => open.delete(sock));
      sock.on('error', () => void 0);
    });
    await new Promise<void>((r) => server.listen(0, 'localhost', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const fetchFrom = (p: string, opts: { timeoutMs?: number; maxBytes?: number } = {}) => safeFetchText(new URL(`https://localhost:${port}${p}`), { allowPrivate: true, ca, ...opts });

  it('hangs up on error responses straight away instead of reading their bodies', async () => {
    for (const [status, kind] of [
      [404, 'not-found'],
      [410, 'not-found'],
      [500, 'unavailable'],
      [302, 'bad-response'],
    ] as const) {
      await expect(fetchFrom(`/${status}`, { maxBytes: 16 }), String(status)).rejects.toMatchObject({ kind });
      const after = written;
      expect(await until(() => open.size === 0), `connection for ${status} closed`).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      expect(written - after, `bytes sent after ${status} was refused`).toBeLessThan(64 * 1024);
    }
  });

  it('cuts off a body at the byte limit and closes the connection', async () => {
    await expect(fetchFrom('/200', { maxBytes: 4096 })).rejects.toMatchObject({ kind: 'too-large' });
    expect(await until(() => open.size === 0)).toBe(true);
  });

  it('frees its slot only after the connection is gone, so the concurrency cap holds; others wait their turn', async () => {
    // Four slow fetches fill every slot; a fifth waits instead of connecting (or failing).
    // 2026-11-11: 300 ms deadlines could close these sockets before the checks on busy machines.
    const slow = [1, 2, 3, 4].map(() => fetchFrom('/200', { timeoutMs: 60_000, maxBytes: Infinity }).catch((e: FetchError) => e));
    try {
      expect(await until(() => open.size === 4, 30_000)).toBe(true);
      let fifthDone = false;
      const fifth = fetchFrom('/404').catch((e: FetchError) => e).finally(() => (fifthDone = true));
      await new Promise((r) => setTimeout(r, 100));
      expect(open.size).toBe(4);
      expect(fifthDone).toBe(false);
      for (const sock of open) sock.destroy();
      const results = await Promise.all(slow);
      expect(results.every((e) => e instanceof FetchError && e.kind === 'unavailable')).toBe(true);
      // Once a slot is free the fifth runs (its own deadline starts then).
      expect(await fifth).toMatchObject({ kind: 'not-found' });
      expect(await until(() => open.size === 0)).toBe(true);
    } finally {
      for (const sock of open) sock.destroy();
    }
  });
});

describe('single-use writes with more than one database connection', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'concord-db-')), 'test.sqlite');
  let other: DatabaseSync;
  beforeAll(async () => {
    await closeDb();
    await openDb({ kind: 'sqlite', file });
    // A second connection to the same file stands in for another server process.
    other = new DatabaseSync(file);
    other.exec('PRAGMA busy_timeout = 5000');
  });
  afterAll(async () => {
    other.close();
    await closeDb();
  });

  it('lets only one writer consume a token, whichever connection gets there first', async () => {
    await put('oauthTokens', { id: 'tok1', grantId: 'g', kind: 'refresh', expiresAt: 0 }, 'g');
    // The other process consumes it first...
    const changed = other.prepare(`UPDATE docs SET data = json_set(data, '$.consumedAt', 1) WHERE collection = 'oauthTokens' AND id = 'tok1' AND json_extract(data, '$.consumedAt') IS NULL`).run();
    expect(changed.changes).toBe(1);
    // ...so this one loses, even though it never saw the change before trying.
    expect(await claim('oauthTokens', 'tok1', 'consumedAt', 2)).toBeUndefined();
    await put('oauthTokens', { id: 'tok2', grantId: 'g', kind: 'refresh', expiresAt: 0 }, 'g');
    expect(await claim('oauthTokens', 'tok2', 'consumedAt', 2)).toMatchObject({ id: 'tok2' });
    expect(await claim('oauthTokens', 'tok2', 'consumedAt', 3)).toBeUndefined();
  });

  it('hands an authorization code to one caller only', async () => {
    await put('oauthCodes', { id: 'code1' });
    expect(await take('oauthCodes', 'code1')).toMatchObject({ id: 'code1' });
    expect(await take('oauthCodes', 'code1')).toBeUndefined();
  });

  it('takes the write lock before reading, so another writer waits for the whole step', async () => {
    await put('kv', { id: 'counter', n: 0 });
    await transaction(async () => {
      // While this transaction is open, the other connection cannot start writing.
      other.exec('PRAGMA busy_timeout = 0');
      expect(() => other.exec('BEGIN IMMEDIATE')).toThrow(/locked|busy/i);
      other.exec('PRAGMA busy_timeout = 5000');
      await put('kv', { id: 'counter', n: 1 });
    });
    other.exec('BEGIN IMMEDIATE');
    other.exec('COMMIT');
  });
});
