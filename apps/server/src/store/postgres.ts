import { AsyncLocalStorage } from 'node:async_hooks';
import type { Collection } from '../db.js';
import { BUSY_TIMEOUT_MS, checkField, type DocStore, liveTransaction, StoreBusyError, TransactionAbortedError, type TxState } from './types.js';

/** What the store needs from a connection: pg's `Pool`/`PoolClient` and PGlite (and its transactions) all fit. */
export interface Queryable {
  query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

/** A Postgres connection source: node-postgres's pool for Neon, or PGlite in process. */
export interface PgDriver extends Queryable {
  /**
   * Run fn on one connection between BEGIN and COMMIT, rolling back if it throws. Fails with StoreBusyError if
   * no connection is free within BUSY_TIMEOUT_MS, or at once with `noWait`.
   */
  transaction<T>(fn: (q: Queryable) => Promise<T>, opts?: { noWait?: boolean }): Promise<T>;
  /** Whether every connection is in use, so a call would have to wait for one. */
  saturated(): boolean;
  /** VACUUM FULL the docs table without waiting for locks. False if it had to skip the table. */
  vacuumDocs(): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * The one writer lock (pg_advisory_xact_lock key): every transaction and every write takes it, so writers take
 * turns as they do under SQLite's BEGIN IMMEDIATE, and read-then-write code ported from SQLite keeps its meaning
 * under Postgres's default READ COMMITTED isolation. Cheap at Concord's write rate; narrow it per ontology if
 * writes ever queue.
 */
const WRITER_LOCK = 0x636f6e636f7264; // "concord"
/** How long `withoutWaiting` work waits on a row or table lock before giving up. */
const NO_WAIT_LOCK_TIMEOUT = '100ms';
/** Ordinary work waits up to this for the writer lock or a row lock, as SQLite waits up to its busy timeout. */
const LOCK_TIMEOUT = `${BUSY_TIMEOUT_MS}ms`;
/**
 * A transaction left open this long without a statement is ended by the server, releasing the writer lock. That
 * covers a function instance frozen or killed mid-transaction, which never sends COMMIT or ROLLBACK.
 */
const IDLE_IN_TRANSACTION_TIMEOUT = '30s';
const STATEMENT_TIMEOUT = '30s';

/** Postgres refused a lock within lock_timeout (55P03); statement_timeout (57014) is a different failure. */
const isLockTimeout = (e: unknown) => (e as { code?: string })?.code === '55P03';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS docs (
    collection text NOT NULL,
    id text NOT NULL,
    parent text,
    data json NOT NULL,
    created_at text NOT NULL,
    seq bigserial,
    PRIMARY KEY (collection, id)
  );
  CREATE INDEX IF NOT EXISTS docs_parent ON docs (collection, parent);
`;

interface PgTx {
  state: TxState;
  /** The transaction's connection. */
  q: Queryable;
}

interface Ctx {
  store: PostgresStore;
  tx?: PgTx;
  noWait: boolean;
}

/**
 * The document store on Postgres. Documents are stored as `json` (not `jsonb`), so each one reads back exactly
 * as written, key order included. Every function instance opens the same database, so unlike SQLite nothing
 * here relies on being the only process.
 */
export class PostgresStore implements DocStore {
  readonly kind = 'postgres' as const;
  private readonly als = new AsyncLocalStorage<Ctx>();

  private constructor(private readonly driver: PgDriver) {}

  /** Create the schema if needed. Safe when several instances cold-start at once: they take turns on the writer lock. */
  static async open(driver: PgDriver): Promise<PostgresStore> {
    await driver.transaction(async (q) => {
      await q.query('SELECT pg_advisory_xact_lock($1)', [WRITER_LOCK]);
      for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await q.query(stmt);
    });
    return new PostgresStore(driver);
  }

  private current(): { tx?: PgTx; noWait: boolean } {
    const c = this.als.getStore();
    if (c?.store !== this) return { noWait: false };
    return { tx: liveTransaction(c.tx), noWait: c.noWait };
  }

  /**
   * Reads go on the transaction's connection inside one, otherwise on any pooled connection. A statement that
   * fails inside a transaction dooms it (Postgres refuses everything after it until ROLLBACK), so that is recorded.
   */
  private reader(): Queryable {
    const c = this.current();
    if (c.tx) {
      const tx = c.tx;
      return {
        query: async <R>(sql: string, params?: unknown[]) => {
          try {
            return await tx.q.query<R>(sql, params);
          } catch (e) {
            tx.state.failed ??= e;
            throw isLockTimeout(e) ? new StoreBusyError({ cause: e }) : e;
          }
        },
      };
    }
    if (c.noWait && this.driver.saturated()) throw new StoreBusyError();
    return this.driver;
  }

  /** A single write: inside a transaction it joins it; outside, it is its own short transaction holding the writer lock. */
  private write<T>(step: (q: Queryable) => Promise<T>): Promise<T> {
    return this.current().tx ? step(this.reader()) : this.transaction(() => step(this.reader()));
  }

  async get<T>(collection: Collection, id: string): Promise<T | undefined> {
    const { rows } = await this.reader().query<{ data: string }>('SELECT data::text AS data FROM docs WHERE collection = $1 AND id = $2', [
      collection,
      id,
    ]);
    return rows[0] ? (JSON.parse(rows[0].data) as T) : undefined;
  }

  async list<T>(collection: Collection, parent?: string): Promise<T[]> {
    const { rows } =
      parent === undefined
        ? await this.reader().query<{ data: string }>('SELECT data::text AS data FROM docs WHERE collection = $1 ORDER BY created_at, seq', [collection])
        : await this.reader().query<{ data: string }>(
            'SELECT data::text AS data FROM docs WHERE collection = $1 AND parent = $2 ORDER BY created_at, seq',
            [collection, parent],
          );
    return rows.map((r) => JSON.parse(r.data) as T);
  }

  async put<T extends { id: string }>(collection: Collection, doc: T, parent?: string): Promise<T> {
    const createdAt = (doc as { createdAt?: string }).createdAt ?? new Date().toISOString();
    const data = JSON.stringify(doc);
    await this.write((q) =>
      q.query(
        `INSERT INTO docs (collection, id, parent, data, created_at) VALUES ($1, $2, $3, $4::json, $5)
         ON CONFLICT (collection, id) DO UPDATE SET parent = EXCLUDED.parent, data = EXCLUDED.data`,
        [collection, doc.id, parent ?? null, data, createdAt],
      ),
    );
    return doc;
  }

  async remove(collection: Collection, id: string): Promise<void> {
    await this.write((q) => q.query('DELETE FROM docs WHERE collection = $1 AND id = $2', [collection, id]));
  }

  async take<T>(collection: Collection, id: string): Promise<T | undefined> {
    const { rows } = await this.write((q) =>
      q.query<{ data: string }>('DELETE FROM docs WHERE collection = $1 AND id = $2 RETURNING data::text AS data', [collection, id]),
    );
    return rows[0] ? (JSON.parse(rows[0].data) as T) : undefined;
  }

  /** Read, check and write under the writer lock (and a row lock), so the result matches SQLite's one-statement version. */
  async claim<T>(collection: Collection, id: string, field: string, value: string | number): Promise<T | undefined> {
    checkField(field);
    return this.write(async (q) => {
      const { rows } = await q.query<{ data: string }>('SELECT data::text AS data FROM docs WHERE collection = $1 AND id = $2 FOR UPDATE', [
        collection,
        id,
      ]);
      if (!rows[0]) return undefined;
      const before = JSON.parse(rows[0].data) as Record<string, unknown>;
      if (Object.hasOwn(before, field) && before[field] !== null) return undefined;
      // Same placement as SQLite's json_set: replace a null in place, or append the new key.
      const after = { ...before, [field]: value };
      await q.query('UPDATE docs SET data = $3::json WHERE collection = $1 AND id = $2', [collection, id, JSON.stringify(after)]);
      delete before[field];
      return before as T;
    });
  }

  async clearAll(): Promise<void> {
    await this.write((q) => q.query('DELETE FROM docs'));
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const c = this.current();
    if (c.tx) return fn();
    const { noWait } = c;
    const state: TxState = { status: 'open' };
    try {
      return await this.driver.transaction(
        async (q) => {
          // Bounded waits, and a server-side end to a transaction whose function instance died holding the lock.
          await q.query(
            "SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true), set_config('idle_in_transaction_session_timeout', $3, true)",
            [noWait ? NO_WAIT_LOCK_TIMEOUT : LOCK_TIMEOUT, STATEMENT_TIMEOUT, IDLE_IN_TRANSACTION_TIMEOUT],
          );
          if (noWait) {
            const { rows } = await q.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS ok', [WRITER_LOCK]);
            if (!rows[0]?.ok) throw new StoreBusyError();
          } else {
            await q.query('SELECT pg_advisory_xact_lock($1)', [WRITER_LOCK]).catch((e) => {
              throw isLockTimeout(e) ? new StoreBusyError({ cause: e }) : e;
            });
          }
          const tx: PgTx = { state, q };
          try {
            const out = await this.als.run({ store: this, tx, noWait }, fn);
            if (state.failed !== undefined) throw new TransactionAbortedError(state.failed);
            // Marked before the driver sends COMMIT and returns the connection, so nothing left over can use it.
            state.status = 'committed';
            return out;
          } catch (e) {
            state.status = 'rolledBack';
            throw e;
          }
        },
        { noWait },
      );
    } catch (e) {
      state.status = 'rolledBack'; // Also if COMMIT itself failed.
      throw e;
    }
  }

  withoutWaiting<T>(fn: () => Promise<T>): Promise<T> {
    const c = this.als.getStore();
    return this.als.run({ store: this, tx: c?.store === this ? c.tx : undefined, noWait: true }, fn);
  }

  /**
   * VACUUM FULL rewrites the table into new files and drops the old ones, so old row versions are gone from the
   * live database. On Neon, page history is still kept for the project's restore window, and a secret is fully
   * gone only once that window has passed, so keep that window short.
   */
  async scrubFreeSpace(): Promise<boolean> {
    if (this.current().tx) return false; // VACUUM can't run inside a transaction.
    try {
      return await this.driver.vacuumDocs();
    } catch {
      return false;
    }
  }

  close(): Promise<void> {
    return this.driver.close();
  }
}
