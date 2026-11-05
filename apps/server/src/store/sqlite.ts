import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Collection } from '../db.js';
import { FifoLock } from './lock.js';
import { BUSY_TIMEOUT_MS, checkField, type DocStore, liveTransaction, StoreBusyError, TransactionAbortedError, TransactionEndedError, type TxState } from './types.js';

interface SqliteTx {
  state: TxState;
}

interface Ctx {
  store: SqliteStore;
  tx?: SqliteTx;
  noWait: boolean;
}

/**
 * The document store on one SQLite connection, for a single long-running process (the Docker image, the VM,
 * self-hosting). node:sqlite is synchronous, so each statement runs to completion without yielding.
 *
 * One connection means an open transaction is visible to every statement on it. While a transaction's fn is
 * awaiting something, statements from other requests must not run on the connection (they would join the
 * transaction and roll back with it). So the connection is a first-come, first-served lock: a transaction holds
 * it from BEGIN to COMMIT, a statement outside one holds it for that statement, and statements inside the
 * transaction (tracked with AsyncLocalStorage) go straight through. Releasing hands it straight to the next in
 * line, so nobody can be overtaken.
 */
export class SqliteStore implements DocStore {
  readonly kind = 'sqlite' as const;
  private readonly als = new AsyncLocalStorage<Ctx>();
  private readonly lock = new FifoLock();

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

  private current(): { tx?: SqliteTx; noWait: boolean } {
    const c = this.als.getStore();
    if (c?.store !== this) return { noWait: false };
    return { tx: liveTransaction(c.tx), noWait: c.noWait };
  }

  /**
   * Run one synchronous statement: inside the caller's transaction, or holding the connection for just this
   * statement. The connection's busy_timeout is 0, and a statement blocked by another connection's lock is
   * retried here instead (SQLite's own busy wait would freeze the event loop, and with it a lock holder in this
   * process). withoutWaiting work gives up at the first refusal.
   */
  private async run<T>(step: () => T): Promise<T> {
    const c = this.current();
    if (c.tx) return this.inTransaction(c.tx, step);
    const deadline = Date.now() + BUSY_TIMEOUT_MS;
    for (let wait = 1; ; wait = Math.min(wait * 2, 50)) {
      const turn = this.lock.acquire(c.noWait);
      if (turn) await turn;
      try {
        return step();
      } catch (e) {
        if (!isBusy(e)) throw e;
        if (c.noWait || Date.now() >= deadline) throw new StoreBusyError({ cause: e });
      } finally {
        this.lock.release();
      }
      await sleep(wait);
    }
  }

  /**
   * A statement that fails inside a transaction dooms it, as it would on Postgres. node:sqlite statements run to
   * completion when called, so none is ever left running when the transaction ends.
   */
  private inTransaction<T>(tx: SqliteTx, step: () => T): T {
    if (tx.state.status !== 'open' && tx.state.status !== 'finishing') throw new TransactionEndedError();
    try {
      return step();
    } catch (e) {
      tx.state.failed ??= e;
      throw e;
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
    const c = this.current();
    if (c.tx) return fn();
    const turn = this.lock.acquire(c.noWait);
    if (turn) await turn;
    const tx: SqliteTx = { state: { status: 'open' } };
    try {
      // Holding this process's turn, wait (asynchronously) for any other process's write lock.
      const deadline = Date.now() + BUSY_TIMEOUT_MS;
      for (let wait = 1; ; wait = Math.min(wait * 2, 50)) {
        try {
          this.db.exec('BEGIN IMMEDIATE');
          break;
        } catch (e) {
          if (!isBusy(e)) throw e;
          if (c.noWait || Date.now() >= deadline) throw new StoreBusyError({ cause: e });
        }
        await sleep(wait);
      }
      let out: T;
      try {
        try {
          out = await this.als.run({ store: this, tx, noWait: c.noWait }, fn);
        } finally {
          // Statements here run to completion when called, so there is nothing to wait for: straight to ending.
          tx.state.status = 'ending';
        }
        if (tx.state.failed !== undefined) throw new TransactionAbortedError(tx.state.failed);
        this.db.exec('COMMIT');
      } catch (e) {
        if (this.db.isTransaction) this.db.exec('ROLLBACK');
        throw e;
      }
      tx.state.status = 'committed';
      return out;
    } finally {
      if (tx.state.status !== 'committed') tx.state.status = 'rolledBack';
      this.lock.release();
    }
  }

  detached<T>(fn: () => Promise<T>): Promise<T> {
    const c = this.als.getStore();
    return this.als.run({ store: this, noWait: c?.store === this && c.noWait }, fn);
  }

  withoutWaiting<T>(fn: () => Promise<T>): Promise<T> {
    const c = this.als.getStore();
    return this.als.run({ store: this, tx: c?.store === this ? c.tx : undefined, noWait: true }, fn);
  }

  /**
   * VACUUM rebuilds the file without its free space (secure_delete only zeroes what is freed from now on),
   * then the write-ahead log is copied in and emptied. False if another connection blocked either step.
   */
  async scrubFreeSpace(): Promise<boolean> {
    if (this.current().tx) return false; // VACUUM can't run inside a transaction.
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
    const turn = this.lock.acquire(false);
    if (turn) await turn;
    this.db.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isBusy(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return /SQLITE_BUSY|database is locked/i.test(msg);
}
