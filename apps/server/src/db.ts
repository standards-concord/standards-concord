import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

/**
 * A small JSON document store on SQLite. Platform metadata (users, roles,
 * change requests, votes) lives here; ontologies themselves live in git, and
 * people's private data (interview transcripts) lives in their Solid pods.
 */
export type Collection =
  | 'users'
  | 'sessions'
  | 'ontologies'
  | 'memberships'
  | 'useCases'
  | 'interviews'
  | 'meetings'
  | 'changeRequests'
  | 'reviews'
  | 'votes'
  | 'releases'
  | 'agentTokens'
  | 'agentReports'
  | 'oauthClients'
  | 'oauthRequests'
  | 'oauthCodes'
  | 'oauthGrants'
  | 'oauthTokens'
  | 'feedback'
  | 'activity'
  | 'kv';

let db: DatabaseSync | undefined;

export function openDb(file = path.join(config.dataDir, 'concord.sqlite')): DatabaseSync {
  if (db) return db;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS docs (
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      parent TEXT,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (collection, id)
    );
    CREATE INDEX IF NOT EXISTS docs_parent ON docs (collection, parent);
  `);
  return db;
}

/**
 * Remove every old copy of rewritten or deleted rows: VACUUM rebuilds the database file without its free
 * space (secure_delete only zeroes what is freed from now on, not what older versions left behind), then the
 * write-ahead log is copied in and emptied. Returns false, leaving the job to be retried, if another
 * connection blocked either step.
 */
export function scrubFreeSpace(): boolean {
  const c = conn();
  try {
    c.exec('VACUUM');
    const r = c.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number; log: number; checkpointed: number };
    return r.busy === 0 && r.log === r.checkpointed;
  } catch {
    return false;
  }
}

/**
 * Run fn without waiting on other connections' locks (busy_timeout 0): anything blocked throws SQLITE_BUSY
 * at once instead of stalling the request thread. For background work that can simply be retried later.
 */
export function withoutWaiting<T>(fn: () => T): T {
  const c = conn();
  c.exec('PRAGMA busy_timeout = 0');
  try {
    return fn();
  } finally {
    c.exec('PRAGMA busy_timeout = 5000');
  }
}

export function closeDb() {
  db?.close();
  db = undefined;
}

function conn() {
  return db ?? openDb();
}

/** `parent` is the indexed foreign key used for listing (usually an ontology id). */
export function put<T extends { id: string }>(collection: Collection, doc: T, parent?: string): T {
  const createdAt = (doc as { createdAt?: string }).createdAt ?? new Date().toISOString();
  conn()
    .prepare(
      `INSERT INTO docs (collection, id, parent, data, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(collection, id) DO UPDATE SET parent = excluded.parent, data = excluded.data`,
    )
    .run(collection, doc.id, parent ?? null, JSON.stringify(doc), createdAt);
  return doc;
}

export function get<T>(collection: Collection, id: string): T | undefined {
  const row = conn().prepare('SELECT data FROM docs WHERE collection = ? AND id = ?').get(collection, id) as
    | { data: string }
    | undefined;
  return row ? (JSON.parse(row.data) as T) : undefined;
}

export function mustGet<T>(collection: Collection, id: string): T {
  const doc = get<T>(collection, id);
  if (!doc) throw new HttpError(404, `${collection.replace(/s$/, '')} ${id} not found`);
  return doc;
}

export function list<T>(collection: Collection, parent?: string): T[] {
  const rows = (
    parent === undefined
      ? conn().prepare('SELECT data FROM docs WHERE collection = ? ORDER BY created_at').all(collection)
      : conn().prepare('SELECT data FROM docs WHERE collection = ? AND parent = ? ORDER BY created_at').all(collection, parent)
  ) as { data: string }[];
  return rows.map((r) => JSON.parse(r.data) as T);
}

export function remove(collection: Collection, id: string) {
  conn().prepare('DELETE FROM docs WHERE collection = ? AND id = ?').run(collection, id);
}

/** Delete a document and return it, in one statement: of several callers racing for it, only one gets it. */
export function take<T>(collection: Collection, id: string): T | undefined {
  const row = conn().prepare('DELETE FROM docs WHERE collection = ? AND id = ? RETURNING data').get(collection, id) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as T) : undefined;
}

/**
 * Set `field` to `value` on a document only if it is not set yet, in one
 * statement, and return the document as it was. Undefined means it doesn't
 * exist or someone else set the field first.
 */
export function claim<T>(collection: Collection, id: string, field: string, value: string | number): T | undefined {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) throw new Error(`Bad field name ${field}`);
  const row = conn()
    .prepare(`UPDATE docs SET data = json_set(data, '$.${field}', ?) WHERE collection = ? AND id = ? AND json_extract(data, '$.${field}') IS NULL RETURNING data`)
    .get(value, collection, id) as { data: string } | undefined;
  if (!row) return undefined;
  const doc = JSON.parse(row.data) as Record<string, unknown>;
  delete doc[field];
  return doc as T;
}

export function clearAll() {
  conn().exec('DELETE FROM docs');
}

/**
 * Run fn in one transaction. BEGIN IMMEDIATE takes the write lock before fn
 * reads anything, so read-then-write steps can't interleave with another
 * writer (another process on the same database waits, up to busy_timeout).
 * fn must be synchronous and must not nest transactions.
 */
export function transaction<T>(fn: () => T): T {
  const c = conn();
  c.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    c.exec('COMMIT');
    return out;
  } catch (e) {
    c.exec('ROLLBACK');
    throw e;
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Takes one from each counter (kv documents `{ id, count }`) if none is at its
 * limit, all or nothing. It runs in one IMMEDIATE transaction, which holds
 * SQLite's write lock from the first read, so separate connections or
 * processes can't both take the last one.
 */
export function reserveCounters(
  counters: { id: string; max: number }[],
  parent?: string,
  /** Tests only: another connection, and hooks between the steps, to prove the steps can't interleave or half-apply. */
  test?: { db?: DatabaseSync; afterRead?: () => void; beforeWrite?: (index: number) => void },
): boolean {
  const c = test?.db ?? conn();
  c.exec('BEGIN IMMEDIATE');
  try {
    const read = c.prepare("SELECT json_extract(data, '$.count') AS n FROM docs WHERE collection = 'kv' AND id = ?");
    const used = counters.map((k) => Number((read.get(k.id) as { n: number } | undefined)?.n ?? 0));
    test?.afterRead?.();
    if (counters.some((k, i) => used[i] >= k.max)) {
      c.exec('ROLLBACK');
      return false;
    }
    const write = c.prepare(
      `INSERT INTO docs (collection, id, parent, data, created_at) VALUES ('kv', ?, ?, ?, ?)
       ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data`,
    );
    counters.forEach((k, i) => {
      test?.beforeWrite?.(i);
      write.run(k.id, parent ?? null, JSON.stringify({ id: k.id, count: used[i] + 1 }), new Date().toISOString());
    });
    c.exec('COMMIT');
    return true;
  } catch (e) {
    c.exec('ROLLBACK');
    throw e;
  }
}

/** Gives back what reserveCounters took (never below zero), all or nothing. */
export function releaseCounters(ids: string[]) {
  const c = conn();
  c.exec('BEGIN IMMEDIATE');
  try {
    const dec = c.prepare("UPDATE docs SET data = json_set(data, '$.count', MAX(0, json_extract(data, '$.count') - 1)) WHERE collection = 'kv' AND id = ?");
    for (const id of ids) dec.run(id);
    c.exec('COMMIT');
  } catch (e) {
    c.exec('ROLLBACK');
    throw e;
  }
}
