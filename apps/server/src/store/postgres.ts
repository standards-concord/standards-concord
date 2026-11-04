import { AsyncLocalStorage } from 'node:async_hooks';
import type { Collection } from '../db.js';
import { checkField, type DocStore, StoreBusyError } from './types.js';

/** What the store needs from a connection: pg's `Pool`/`PoolClient` and PGlite (and its transactions) all fit. */
export interface Queryable {
  query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

/** A Postgres connection source: node-postgres's pool for Neon, or PGlite in process. */
export interface PgDriver extends Queryable {
  /** Run fn on one connection between BEGIN and COMMIT, rolling back if it throws. */
  transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
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

interface Ctx {
  store: PostgresStore;
  /** The transaction's connection, when inside one. */
  tx?: Queryable;
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

  private ctx(): Ctx | undefined {
    const c = this.als.getStore();
    return c?.store === this ? c : undefined;
  }

  /** Reads go on the transaction's connection inside one, otherwise on any pooled connection. */
  private reader(): Queryable {
    return this.ctx()?.tx ?? this.driver;
  }

  /** A single write: inside a transaction it joins it; outside, it is its own short transaction holding the writer lock. */
  private write<T>(step: (q: Queryable) => Promise<T>): Promise<T> {
    const tx = this.ctx()?.tx;
    return tx ? step(tx) : this.transaction(() => step(this.ctx()!.tx!));
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
      if (before[field] !== undefined && before[field] !== null) return undefined;
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
    const outer = this.ctx();
    if (outer?.tx) return fn();
    const noWait = outer?.noWait ?? false;
    return this.driver.transaction(async (tx) => {
      if (noWait) {
        await tx.query(`SET LOCAL lock_timeout = '${NO_WAIT_LOCK_TIMEOUT}'`);
        const { rows } = await tx.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS ok', [WRITER_LOCK]);
        if (!rows[0]?.ok) throw new StoreBusyError();
      } else {
        await tx.query('SELECT pg_advisory_xact_lock($1)', [WRITER_LOCK]);
      }
      return this.als.run({ store: this, tx, noWait }, fn);
    });
  }

  withoutWaiting<T>(fn: () => Promise<T>): Promise<T> {
    const outer = this.ctx();
    return this.als.run({ store: this, tx: outer?.tx, noWait: true }, fn);
  }

  /**
   * VACUUM FULL rewrites the table into new files and drops the old ones, so old row versions are gone from the
   * live database. On Neon, page history is still kept for the project's restore window, and a secret is fully
   * gone only once that window has passed, so keep that window short.
   */
  async scrubFreeSpace(): Promise<boolean> {
    if (this.ctx()?.tx) return false; // VACUUM can't run inside a transaction.
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
