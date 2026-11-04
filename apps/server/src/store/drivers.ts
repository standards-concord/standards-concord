import type { PgDriver, Queryable } from './postgres.js';
import { BUSY_TIMEOUT_MS, StoreBusyError } from './types.js';

/**
 * node-postgres pool, for Neon (or any Postgres) by connection string. Loaded only when a database URL is set,
 * so the SQLite build never imports pg.
 */
export async function nodePostgresDriver(connectionString: string, opts: { max?: number } = {}): Promise<PgDriver> {
  const { default: pg } = await import('pg');
  const max = opts.max ?? 5; // A function instance handles a few requests at once; Neon's pooler fans connections in on its side.
  const pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 10_000, connectionTimeoutMillis: BUSY_TIMEOUT_MS });
  // An idle connection the server drops (restart, Neon scaling to zero) emits 'error' on the pool; unhandled,
  // that would crash the process. The pool discards the connection and opens a new one when next needed.
  pool.on('error', (err) => console.warn(`[db] idle connection lost: ${err.message}`));

  const connect = async (noWait: boolean) => {
    if (noWait && pool.idleCount === 0 && pool.totalCount >= max) throw new StoreBusyError();
    try {
      return await pool.connect();
    } catch (e) {
      throw /timeout/i.test((e as Error).message) ? new StoreBusyError({ cause: e }) : e;
    }
  };

  return {
    query: <R>(sql: string, params?: unknown[]) => pool.query(sql, params) as unknown as Promise<{ rows: R[] }>,
    saturated: () => pool.idleCount === 0 && pool.totalCount >= max,
    async transaction(fn, { noWait = false } = {}) {
      const client = await connect(noWait);
      // A connection lost mid-transaction emits 'error' on the checked-out client (unhandled, a crash); the
      // statement in flight rejects too, so here it only marks the connection as not to be reused.
      let broken = false;
      const onError = (err: Error) => {
        broken = true;
        console.warn(`[db] connection lost in a transaction: ${err.message}`);
      };
      client.on('error', onError);
      try {
        await client.query('BEGIN');
        const out = await fn(client as unknown as Queryable);
        await client.query('COMMIT');
        return out;
      } catch (e) {
        if (!broken) {
          try {
            await client.query('ROLLBACK');
          } catch {
            broken = true;
          }
        }
        throw e;
      } finally {
        client.off('error', onError);
        client.release(broken); // A broken connection is closed rather than returned to the pool.
      }
    },
    async vacuumDocs() {
      const client = await connect(true);
      let skipped = false;
      const onNotice = (n: { message?: string }) => {
        if (/skipping/i.test(n.message ?? '')) skipped = true;
      };
      let broken = false;
      const onError = () => (broken = true);
      client.on('notice', onNotice);
      client.on('error', onError);
      try {
        // SKIP_LOCKED gives up at once if any session holds a lock on the table, rather than queueing behind it.
        await client.query('VACUUM (FULL, SKIP_LOCKED) docs');
        return !skipped;
      } finally {
        client.off('notice', onNotice);
        client.off('error', onError);
        client.release(broken);
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
    saturated: () => false, // One connection, shared in arrival order: waiting for it is waiting for the lock.
    async vacuumDocs() {
      await db.query('VACUUM (FULL) docs');
      return true;
    },
    close: () => db.close(),
  };
}
