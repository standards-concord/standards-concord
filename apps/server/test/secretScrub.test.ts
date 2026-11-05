import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { get, openDb, put, scrubFreeSpace } from '../src/db.js';
import { cancelScrubRetry, migrateClientSecrets, scrubIfOwed, scrubRetryPending } from '../src/oauth.js';
import { storeOptionsFromEnv } from '../src/store/index.js';

const SCRUB = 'oauth-secret-scrub-v2';
const scrubState = async () => await get<{ id: string; owed: number; scrubbed: number }>('kv', SCRUB);
const scrubOwed = async () => {
  const s = await scrubState();
  return !s || s.scrubbed < s.owed;
};
const lookupClient = (c: { id: string; secret: string }) =>
  request(createApp()).post('/token').type('form').send({ grant_type: 'refresh_token', refresh_token: 'cnr_nope', client_id: c.id, client_secret: c.secret });

/**
 * The scrub bookkeeping, on whichever store the environment picks (SQLite, PGlite or Postgres): hashing a secret
 * owes a scrub, a scrub that succeeds pays it, and one that fails or races with new work leaves it owed. Legacy
 * clients are written through the store, as older versions' rows would read back.
 */
describe('scrub bookkeeping for old client secrets', () => {
  const legacyClient = async () => {
    const id = `client_${randomBytes(6).toString('hex')}`;
    const secret = randomBytes(32).toString('hex');
    await put('oauthClients', { id, info: { client_id: id, client_name: 'Legacy', redirect_uris: ['http://localhost:1/cb'], token_endpoint_auth_method: 'client_secret_post', client_secret: secret } });
    return { id, secret };
  };
  const stored = async (id: string) => (await get<{ info: Record<string, unknown>; secretHash?: string }>('oauthClients', id))!;

  beforeAll(() => openDb());
  afterEach(() => cancelScrubRetry());

  it('hashes a plain-text secret on start-up, owes a scrub, and pays it when the scrub succeeds', async () => {
    expect(await scrubIfOwed()).toBe(true);
    const c = await legacyClient();
    expect(await migrateClientSecrets()).toEqual({ hashed: 1, scrubbed: true });
    const doc = await stored(c.id);
    expect(doc.info.client_secret).toBeUndefined();
    expect(doc.secretHash).toBe(createHash('sha256').update(c.secret).digest('hex'));
    expect(await scrubOwed()).toBe(false);
  });

  it('keeps a scrub owed while it fails, and pays it on the next success', async () => {
    const before = (await scrubState())!;
    await put('kv', { ...before, owed: before.owed + 1 });
    expect(await scrubIfOwed(() => false)).toBe(false);
    expect(await scrubIfOwed(async () => { throw new Error('locked'); })).toBe(false);
    expect(await scrubOwed()).toBe(true);
    expect(await scrubIfOwed()).toBe(true);
    expect(await scrubOwed()).toBe(false);
  });

  it('keeps work owed that arrives while a scrub is running', async () => {
    expect(await scrubIfOwed()).toBe(true);
    const before = (await scrubState())!;
    await put('kv', { ...before, owed: before.owed + 1 });
    const racing = async () => {
      const now = (await scrubState())!;
      await put('kv', { ...now, owed: now.owed + 1 }); // another process hashes a secret meanwhile
      return true;
    };
    expect(await scrubIfOwed(racing)).toBe(false);
    expect(await scrubOwed()).toBe(true);
    expect(await scrubIfOwed()).toBe(true);
  });

  // Straight after the request, the scrub either ran or found the store busy (PGlite has one connection, which
  // the request may still be using) and was put off; it is never dropped. SQLite's own test checks it runs at once.
  it('hashes a secret when a client signs in with it, and scrubs it then or in a retry', async () => {
    expect(await scrubIfOwed()).toBe(true);
    const c = await legacyClient();
    expect((await lookupClient(c)).status).toBe(400); // past client authentication: the refresh token is what's wrong
    expect((await stored(c.id)).info.client_secret).toBeUndefined();
    await new Promise((r) => setTimeout(r, 200));
    if (await scrubOwed()) expect(scrubRetryPending()).toBe(true);
    else expect(scrubRetryPending()).toBe(false);
    cancelScrubRetry(); // standing in for the retry firing
    expect(await scrubIfOwed()).toBe(true);
  });
});

/**
 * Plain-text client secrets written by older versions must not survive anywhere in the database files. These
 * read the SQLite file's bytes and hold locks on it from other connections, so they apply to the SQLite store
 * only. On Postgres the scrub is VACUUM FULL, which rewrites the table into new files (store/postgres.ts), and
 * the bookkeeping above runs there too.
 */
describe.runIf(storeOptionsFromEnv().kind === 'sqlite')('scrubbing old client secrets from the SQLite file', () => {
  const file = path.join(config.dataDir, 'concord.sqlite');
  const bytes = () => Buffer.concat([fs.readFileSync(file), fs.existsSync(`${file}-wal`) ? fs.readFileSync(`${file}-wal`) : Buffer.alloc(0)]);
  const state = async () => await get<{ id: string; owed: number; scrubbed: number }>('kv', 'oauth-secret-scrub-v2');
  const owed = async () => {
    const s = await state();
    return !s || s.scrubbed < s.owed;
  };
  /**
   * A client as older versions stored it, written the way they wrote the file (no secure_delete), on a
   * connection of its own as an older process would have.
   */
  const legacyFile = (fn: (raw: DatabaseSync) => void) => {
    const raw = new DatabaseSync(file);
    try {
      raw.exec('PRAGMA busy_timeout = 5000; PRAGMA secure_delete = OFF');
      fn(raw);
    } finally {
      raw.close();
    }
  };
  const legacyClient = async () => {
    const id = `client_${randomBytes(6).toString('hex')}`;
    const secret = randomBytes(32).toString('hex');
    const doc = { id, info: { client_id: id, client_name: 'Legacy', redirect_uris: ['http://localhost:1/cb'], token_endpoint_auth_method: 'client_secret_post', client_secret: secret } };
    legacyFile((raw) =>
      raw.prepare('INSERT INTO docs (collection, id, parent, data, created_at) VALUES (?, ?, NULL, ?, ?)').run('oauthClients', id, JSON.stringify(doc), new Date().toISOString()),
    );
    return { id, secret };
  };
  /** Another connection holding an old snapshot: checkpoints can't finish while it's open. */
  const holdReader = () => {
    const reader = new DatabaseSync(file);
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM docs').get();
    return () => {
      reader.exec('COMMIT');
      reader.close();
    };
  };
  const lookup = (c: { id: string; secret: string }) =>
    request(createApp()).post('/token').type('form').send({ grant_type: 'refresh_token', refresh_token: 'cnr_nope', client_id: c.id, client_secret: c.secret });
  const tick = () => new Promise((r) => setTimeout(r, 20));

  beforeAll(() => openDb()); // Creates the file and its table before the legacy writer touches them.
  afterEach(() => cancelScrubRetry());

  it('leaves no copy of a migrated or long-deleted secret, and keeps a blocked scrub owed', async () => {
    const clients: { id: string; secret: string }[] = [];
    for (let i = 0; i < 20; i++) clients.push(await legacyClient());
    // One deleted long ago: its row content sits in free pages.
    const gone = await legacyClient();
    legacyFile((raw) => {
      raw.prepare("DELETE FROM docs WHERE collection = 'oauthClients' AND id = ?").run(gone.id);
      raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    });
    expect(bytes().includes(clients[0].secret)).toBe(true);

    const release = holdReader();
    expect(await migrateClientSecrets()).toEqual({ hashed: 20, scrubbed: false });
    expect(await owed()).toBe(true);
    expect(scrubRetryPending()).toBe(true);
    // A restart with nothing new to hash still owes the scrub.
    cancelScrubRetry();
    expect(await migrateClientSecrets()).toEqual({ hashed: 0, scrubbed: false });
    release();

    expect(await migrateClientSecrets()).toEqual({ hashed: 0, scrubbed: true });
    const all = bytes();
    for (const c of [...clients, gone]) expect(all.includes(c.secret)).toBe(false);
    expect(await migrateClientSecrets()).toEqual({ hashed: 0, scrubbed: true });
  });

  it('keeps work owed that arrives while a scrub is running (another process hashing a secret)', async () => {
    expect(await scrubIfOwed()).toBe(true);
    await legacyClient();
    await migrateClientSecrets(); // owes generation n and scrubs it
    const late = await legacyClient();
    // Our scrub starts from generation n+1; while it runs, another process hashes `late` and owes n+2.
    const before = (await state())!;
    await put('kv', { ...before, owed: before.owed + 1 });
    const racing = async () => {
      const ok = await scrubFreeSpace();
      const now = (await state())!;
      await put('kv', { ...now, owed: now.owed + 1 });
      return ok;
    };
    expect(await scrubIfOwed(racing)).toBe(false);
    expect(await owed()).toBe(true);
    // The owed generation is still scrubbed by the next attempt (here, the next start).
    expect((await migrateClientSecrets()).scrubbed).toBe(true);
    expect(await owed()).toBe(false);
    expect(bytes().includes(late.secret)).toBe(false);
  });

  it('owes a new scrub when a lookup hashes a secret, retries it once in the background, and the restart finishes it', async () => {
    expect(await scrubIfOwed()).toBe(true);
    const c = await legacyClient();
    const release = holdReader();
    const res = await lookup(c);
    expect(res.status).toBe(400); // past client authentication: the refresh token is what's wrong
    expect((await get<{ info: Record<string, unknown> }>('oauthClients', c.id))!.info.client_secret).toBeUndefined();
    await tick();
    expect(await owed()).toBe(true);
    expect(scrubRetryPending()).toBe(true); // one retry, backed off
    release();
    cancelScrubRetry();
    expect(await migrateClientSecrets()).toEqual({ hashed: 0, scrubbed: true });
    expect(bytes().includes(c.secret)).toBe(false);
  });

  it('scrubs straight after a lookup hashes a secret, when nothing blocks it', async () => {
    const c = await legacyClient();
    await lookup(c);
    await tick();
    expect(await owed()).toBe(false);
    expect(scrubRetryPending()).toBe(false);
    expect(bytes().includes(c.secret)).toBe(false);
  });

  it('gives up at once, without throwing, if another connection holds the write lock when completion is recorded', async () => {
    await legacyClient();
    await migrateClientSecrets();
    expect(await owed()).toBe(false);
    const late = await legacyClient();
    // What hashing `late` on lookup records: the hash in place of the secret, and one more scrub owed.
    const doc = (await get<{ id: string; info: Record<string, unknown> }>('oauthClients', late.id))!;
    const { client_secret: _s, ...info } = doc.info;
    await put('oauthClients', { ...doc, info, secretHash: createHash('sha256').update(late.secret).digest('hex') });
    const before = (await state())!;
    await put('kv', { ...before, owed: before.owed + 1 });
    const writer = new DatabaseSync(file);
    const lockedAfterScrub = async () => {
      const ok = await scrubFreeSpace();
      writer.exec('BEGIN IMMEDIATE'); // another process takes the write lock just before we record completion
      return ok;
    };
    const t = Date.now();
    expect(await scrubIfOwed(lockedAfterScrub)).toBe(false);
    expect(Date.now() - t).toBeLessThan(1000);
    writer.exec('ROLLBACK');
    writer.close();
    expect(await owed()).toBe(true);
    // Ordinary requests still wait for locks as usual afterwards, rather than giving up.
    const blocker = new DatabaseSync(file);
    blocker.exec('BEGIN IMMEDIATE');
    const waiting = put('kv', { id: 'written-after-a-wait' });
    setTimeout(() => {
      blocker.exec('ROLLBACK');
      blocker.close();
    }, 200);
    await waiting;
    expect(await get('kv', 'written-after-a-wait')).toBeDefined();
    expect(await scrubIfOwed()).toBe(true);
    expect(bytes().includes(late.secret)).toBe(false);
  });

  it('does not stall the server while another connection blocks the scrub', async () => {
    const clients = [await legacyClient(), await legacyClient(), await legacyClient()];
    const release = holdReader();
    const started = Date.now();
    expect((await migrateClientSecrets()).scrubbed).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    const more = [await legacyClient(), await legacyClient(), await legacyClient()];
    const t = Date.now();
    for (const c of more) expect((await lookup(c)).status).toBe(400);
    await tick();
    expect(Date.now() - t).toBeLessThan(2000);
    expect(scrubRetryPending()).toBe(true);
    release();
    cancelScrubRetry();
    expect((await migrateClientSecrets()).scrubbed).toBe(true);
    const all = bytes();
    for (const c of [...clients, ...more]) expect(all.includes(c.secret)).toBe(false);
  });
});
