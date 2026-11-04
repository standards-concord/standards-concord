import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { get, openDb, put, remove } from '../src/db.js';
import { migrateClientSecrets } from '../src/oauth.js';

/** Plain-text client secrets written by older versions must not survive anywhere in the database files. */
describe('scrubbing old client secrets from the database files', () => {
  const file = path.join(config.dataDir, 'concord.sqlite');
  const bytes = () => Buffer.concat([fs.readFileSync(file), fs.existsSync(`${file}-wal`) ? fs.readFileSync(`${file}-wal`) : Buffer.alloc(0)]);
  const legacyClient = () => {
    const id = `client_${randomBytes(6).toString('hex')}`;
    const secret = randomBytes(32).toString('hex');
    put('oauthClients', { id, info: { client_id: id, client_name: 'Legacy', redirect_uris: ['http://localhost:1/cb'], token_endpoint_auth_method: 'client_secret_post', client_secret: secret } });
    return secret;
  };

  it('leaves no copy of a migrated or long-deleted secret, and retries a scrub another connection blocked', () => {
    const db = openDb();
    db.exec('PRAGMA secure_delete = OFF'); // how older versions wrote the file
    const secrets = Array.from({ length: 20 }, legacyClient);
    // One that was deleted long ago: its row content sits in free pages.
    const gone = legacyClient();
    const goneId = (db.prepare("SELECT id FROM docs WHERE data LIKE ?").get(`%${gone}%`) as { id: string }).id;
    remove('oauthClients', goneId);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    expect(bytes().includes(secrets[0])).toBe(true);
    db.exec('PRAGMA secure_delete = ON');

    // Another connection holding an old snapshot blocks the scrub: it must not count as done.
    const reader = new DatabaseSync(file);
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM docs').get();
    expect(migrateClientSecrets()).toEqual({ hashed: 20, scrubbed: false });
    expect(get<{ done: boolean }>('kv', 'oauth-secret-scrub')?.done).toBe(false);
    // Nothing new to hash, but the scrub is still owed and still blocked.
    expect(migrateClientSecrets()).toEqual({ hashed: 0, scrubbed: false });
    reader.exec('COMMIT');
    reader.close();

    expect(migrateClientSecrets()).toEqual({ hashed: 0, scrubbed: true });
    const all = bytes();
    for (const s of [...secrets, gone]) expect(all.includes(s)).toBe(false);
    expect(fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0).toBeLessThan(64 * 1024);
    // Done is remembered: later starts don't rebuild the file again.
    expect(migrateClientSecrets()).toEqual({ hashed: 0, scrubbed: true });
  });

  it('owes a new scrub when a lookup hashes a secret after the last one, even across a restart', async () => {
    const db = openDb();
    expect(migrateClientSecrets().scrubbed).toBe(true);
    db.exec('PRAGMA secure_delete = OFF');
    const id = `client_${randomBytes(6).toString('hex')}`;
    const secret = randomBytes(32).toString('hex');
    // A record in the old format arriving after startup (an older writer, or an import).
    put('oauthClients', { id, info: { client_id: id, client_name: 'Late', redirect_uris: ['http://localhost:1/cb'], token_endpoint_auth_method: 'client_secret_post', client_secret: secret } });
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('PRAGMA secure_delete = ON');
    expect(bytes().includes(secret)).toBe(true);

    // Keep the scrub blocked so the restart path is what has to clean up.
    const reader = new DatabaseSync(file);
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM docs').get();
    const res = await request(createApp()).post('/token').type('form').send({ grant_type: 'refresh_token', refresh_token: 'cnr_nope', client_id: id, client_secret: secret });
    expect(res.status).toBe(400); // past client authentication: the refresh token is what's wrong
    expect(get<{ info: Record<string, unknown> }>('oauthClients', id)!.info.client_secret).toBeUndefined();
    await new Promise((r) => setImmediate(r));
    expect(get<{ done: boolean }>('kv', 'oauth-secret-scrub')?.done).toBe(false);
    reader.exec('COMMIT');
    reader.close();

    // The next start has nothing to hash but still owes the scrub.
    expect(migrateClientSecrets()).toEqual({ hashed: 0, scrubbed: true });
    expect(bytes().includes(secret)).toBe(false);
  });

  it('scrubs straight away after a lookup hashes a secret, when nothing blocks it', async () => {
    const db = openDb();
    db.exec('PRAGMA secure_delete = OFF');
    const id = `client_${randomBytes(6).toString('hex')}`;
    const secret = randomBytes(32).toString('hex');
    put('oauthClients', { id, info: { client_id: id, client_name: 'Late', redirect_uris: ['http://localhost:1/cb'], token_endpoint_auth_method: 'client_secret_post', client_secret: secret } });
    db.exec('PRAGMA secure_delete = ON');
    await request(createApp()).post('/token').type('form').send({ grant_type: 'refresh_token', refresh_token: 'cnr_nope', client_id: id, client_secret: secret });
    await new Promise((r) => setImmediate(r));
    expect(get<{ done: boolean }>('kv', 'oauth-secret-scrub')?.done).toBe(true);
    expect(bytes().includes(secret)).toBe(false);
  });
});
