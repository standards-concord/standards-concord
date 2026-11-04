import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Collection } from '../db.js';
import { checkField, type DocStore, StoreBusyError } from './types.js';

/** How long a statement keeps retrying while another connection holds the write lock, as busy_timeout did. */
const BUSY_TIMEOUT_MS = 5000;

interface Ctx {
  store: SqliteStore;
  inTransaction: boolean;
  noWait: boolean;
}

/**
 * The document store on one SQLite connection, for a single long-running process (the Docker image, the VM,
 * self-hosting). node:sqlite is synchronous, so each statement runs to completion without yielding; the async
 * part is the gate below.
 *
 * One connection means an open transaction is visible to every statement on it. While a transaction's fn is
 * awaiting something, statements from other requests must not run on the connection (they would join the
 * transaction and roll back with it), so they wait until it commits. Statements inside the transaction (tracked
 * with AsyncLocalStorage) go straight through.
 */
export class SqliteStore implements DocStore {
  readonly kind = 'sqlite' as const;
  private readonly als = new AsyncLocalStorage<Ctx>();
  /** Settles when the transaction now open on the connection ends. */
  private active: Promise<void> | undefined;

  private constructor(private readonly db: DatabaseSync) {}

  static open(file: string): SqliteStore {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 0;
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
    return new SqliteStore(db);
  }

  private ctx(): Ctx | undefined {
    const c = this.als.getStore();
    return c?.store === this ? c : undefined;
  }

  /**
   * Run one synchronous step on the connection once no other context's transaction is open. Nothing can start
   * a transaction between the last check and `step`, because both happen in the same tick.
   *
   * The connection's busy_timeout is 0, and a step blocked by another connection's lock is retried here
   * instead: SQLite's own busy wait would freeze the event loop, and with it the transaction holding the lock
   * if that is in this process. withoutWaiting work gives up at the first refusal.
   */
  private async run<T>(step: () => T): Promise<T> {
    const c = this.ctx();
    const deadline = Date.now() + BUSY_TIMEOUT_MS;
    for (let wait = 1; ; wait = Math.min(wait * 2, 50)) {
      if (!c?.inTransaction) while (this.active) await this.active;
      try {
        return step();
      } catch (e) {
        if (!isBusy(e) || c?.inTransaction) throw e;
        if (c?.noWait) throw new StoreBusyError();
        if (Date.now() >= deadline) throw e;
      }
      await sleep(wait);
    }
  }

  async get<T>(collection: Collection, id: string): Promise<T | undefined> {
    const row = await this.run(
      () => this.db.prepare('SELECT data FROM docs WHERE collection = ? AND id = ?').get(collection, id) as { data: string } | undefined,
    );
    return row ? (JSON.parse(row.data) as T) : undefined;
  }

  async list<T>(collection: Collection, parent?: string): Promise<T[]> {
    const rows = (await this.run(() =>
      parent === undefined
        ? this.db.prepare('SELECT data FROM docs WHERE collection = ? ORDER BY created_at, rowid').all(collection)
        : this.db.prepare('SELECT data FROM docs WHERE collection = ? AND parent = ? ORDER BY created_at, rowid').all(collection, parent),
    )) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as T);
  }

  async put<T extends { id: string }>(collection: Collection, doc: T, parent?: string): Promise<T> {
    const createdAt = (doc as { createdAt?: string }).createdAt ?? new Date().toISOString();
    const data = JSON.stringify(doc);
    await this.run(() =>
      this.db
        .prepare(
          `INSERT INTO docs (collection, id, parent, data, created_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(collection, id) DO UPDATE SET parent = excluded.parent, data = excluded.data`,
        )
        .run(collection, doc.id, parent ?? null, data, createdAt),
    );
    return doc;
  }

  async remove(collection: Collection, id: string): Promise<void> {
    await this.run(() => this.db.prepare('DELETE FROM docs WHERE collection = ? AND id = ?').run(collection, id));
  }

  async take<T>(collection: Collection, id: string): Promise<T | undefined> {
    const row = await this.run(
      () => this.db.prepare('DELETE FROM docs WHERE collection = ? AND id = ? RETURNING data').get(collection, id) as { data: string } | undefined,
    );
    return row ? (JSON.parse(row.data) as T) : undefined;
  }

  async claim<T>(collection: Collection, id: string, field: string, value: string | number): Promise<T | undefined> {
    checkField(field);
    const row = await this.run(
      () =>
        this.db
          .prepare(
            `UPDATE docs SET data = json_set(data, '$.${field}', ?) WHERE collection = ? AND id = ? AND json_extract(data, '$.${field}') IS NULL RETURNING data`,
          )
          .get(value, collection, id) as { data: string } | undefined,
    );
    if (!row) return undefined;
    const doc = JSON.parse(row.data) as Record<string, unknown>;
    delete doc[field];
    return doc as T;
  }

  async clearAll(): Promise<void> {
    await this.run(() => this.db.exec('DELETE FROM docs'));
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const outer = this.ctx();
    if (outer?.inTransaction) return fn();
    const noWait = outer?.noWait ?? false;
    let done!: () => void;
    // `active` is set in the same synchronous step as BEGIN, so no statement from another context can run inside
    // this transaction before it is marked open.
    await this.run(() => {
      this.db.exec('BEGIN IMMEDIATE');
      this.active = new Promise((resolve) => (done = resolve));
    });
    try {
      const out = await this.als.run({ store: this, inTransaction: true, noWait }, fn);
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.active = undefined;
      done();
    }
  }

  withoutWaiting<T>(fn: () => Promise<T>): Promise<T> {
    const outer = this.ctx();
    return this.als.run({ store: this, inTransaction: outer?.inTransaction ?? false, noWait: true }, fn);
  }

  /**
   * VACUUM rebuilds the file without its free space (secure_delete only zeroes what is freed from now on),
   * then the write-ahead log is copied in and emptied. False if another connection blocked either step.
   */
  async scrubFreeSpace(): Promise<boolean> {
    try {
      return await this.run(() => {
        this.db.exec('VACUUM');
        const r = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number; log: number; checkpointed: number };
        return r.busy === 0 && r.log === r.checkpointed;
      });
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    while (this.active) await this.active;
    this.db.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isBusy(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return /SQLITE_BUSY|database is locked/i.test(msg);
}
