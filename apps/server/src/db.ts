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
  | 'apps'
  | 'appChecks'
  | 'oidcTokens'
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

/**
 * Insert a document only if none has this id yet, in one statement (the primary key is the
 * unique constraint, across processes too). True if this call inserted it.
 */
export function insertOnce<T extends { id: string }>(collection: Collection, doc: T, parent?: string): boolean {
  const row = conn()
    .prepare(`INSERT INTO docs (collection, id, parent, data, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(collection, id) DO NOTHING RETURNING id`)
    .get(collection, doc.id, parent ?? null, JSON.stringify(doc), new Date().toISOString());
  return !!row;
}

/** Set one field of a stored document, in one statement, leaving the rest as stored. */
export function setField(collection: Collection, id: string, field: string, value: string | number) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) throw new Error(`Bad field name ${field}`);
  conn().prepare(`UPDATE docs SET data = json_set(data, '$.${field}', ?) WHERE collection = ? AND id = ?`).run(value, collection, id);
}

/** Delete documents in a collection whose numeric `field` is below `value`. */
export function removeBelow(collection: Collection, field: string, value: number) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) throw new Error(`Bad field name ${field}`);
  conn().prepare(`DELETE FROM docs WHERE collection = ? AND json_extract(data, '$.${field}') < ?`).run(collection, value);
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
 * fn must be synchronous; a nested call joins the outer transaction.
 */
let inTransaction = false;
export function transaction<T>(fn: () => T): T {
  // A nested call joins the transaction already open.
  if (inTransaction) return fn();
  const c = conn();
  c.exec('BEGIN IMMEDIATE');
  inTransaction = true;
  try {
    const out = fn();
    c.exec('COMMIT');
    return out;
  } catch (e) {
    c.exec('ROLLBACK');
    throw e;
  } finally {
    inTransaction = false;
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
