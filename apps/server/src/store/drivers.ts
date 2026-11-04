import type { PgDriver, Queryable } from './postgres.js';

/**
 * node-postgres pool, for Neon (or any Postgres) by connection string. Loaded only when a database URL is set,
 * so the SQLite build never imports pg.
 */
export async function nodePostgresDriver(connectionString: string, opts: { max?: number } = {}): Promise<PgDriver> {
  const { default: pg } = await import('pg');
  // A function instance handles a few requests at once; Neon's pooler fans connections in on its side.
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 5, idleTimeoutMillis: 10_000 });
  return {
    query: <R>(sql: string, params?: unknown[]) => pool.query(sql, params) as unknown as Promise<{ rows: R[] }>,
    async transaction(fn) {
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query('BEGIN');
        const out = await fn(client as unknown as Queryable);
        await client.query('COMMIT');
        return out;
      } catch (e) {
        try {
          await client.query('ROLLBACK');
        } catch {
          broken = true; // The connection is unusable: drop it rather than return it to the pool.
        }
        throw e;
      } finally {
        client.release(broken);
      }
    },
    async vacuumDocs() {
      const client = await pool.connect();
      let skipped = false;
      const onNotice = (n: { message?: string }) => {
        if (/skipping/i.test(n.message ?? '')) skipped = true;
      };
      client.on('notice', onNotice);
      try {
        // SKIP_LOCKED gives up at once if any session holds a lock on the table, rather than queueing behind it.
        await client.query('VACUUM (FULL, SKIP_LOCKED) docs');
        return !skipped;
      } finally {
        client.off('notice', onNotice);
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** PGlite: Postgres compiled to WebAssembly, in process. For tests and local development; `dataDir` undefined keeps it in memory. */
export async function pgliteDriver(dataDir?: string): Promise<PgDriver> {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create(dataDir);
  return {
    // PGlite runs one statement at a time and holds statements from outside an open transaction until it ends.
    query: <R>(sql: string, params?: unknown[]) => db.query<R>(sql, params),
    transaction: (fn) => db.transaction((tx) => fn(tx as Queryable)),
    async vacuumDocs() {
      await db.query('VACUUM (FULL) docs');
      return true;
    },
    close: () => db.close(),
  };
}
