import { AsyncLocalStorage } from 'node:async_hooks';
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
  | 'forks'
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
 * Replace a document only if its `field` still has the value the caller read
 * (undefined: not set), in one statement. Returns false, writing nothing, if
 * the document changed or doesn't exist: a compare-and-swap that holds across
 * processes sharing the database.
 */
export function putIf<T extends { id: string }>(collection: Collection, doc: T, field: string, expected: string | number | undefined): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) throw new Error(`Bad field name ${field}`);
  const cond = expected === undefined ? `json_extract(data, '$.${field}') IS NULL` : `json_extract(data, '$.${field}') = ?`;
  const args: (string | number)[] = [JSON.stringify(doc), collection, doc.id];
  if (expected !== undefined) args.push(expected);
  const row = conn().prepare(`UPDATE docs SET data = ? WHERE collection = ? AND id = ? AND ${cond} RETURNING id`).get(...args);
  return !!row;
}

const fences = new AsyncLocalStorage<() => void>();

/**
 * Run `fn` with a fence: every putFenced() it makes (however deep, across
 * awaits) first runs `guard` in the same transaction as the write, so a guard
 * that throws stops the write atomically. This is how a slow process that has
 * lost its hold on something (a lease that ran out) is kept from writing over
 * newer work.
 */
export function withFence<T>(guard: () => void, fn: () => Promise<T>): Promise<T> {
  return fences.run(guard, fn);
}

/** put(), checked against the current fence (if any) in the same transaction. */
export function putFenced<T extends { id: string }>(collection: Collection, doc: T, parent?: string): T {
  const guard = fences.getStore();
  if (!guard) return put(collection, doc, parent);
  return transaction(() => {
    guard();
    return put(collection, doc, parent);
  });
}

/** putIf(), checked against the current fence (if any) in the same transaction. */
export function putIfFenced<T extends { id: string }>(collection: Collection, doc: T, field: string, expected: string | number | undefined): boolean {
  const guard = fences.getStore();
  return transaction(() => {
    guard?.();
    return putIf(collection, doc, field, expected);
  });
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
