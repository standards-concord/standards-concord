import fs from 'node:fs';
import { FifoLock } from './lock.js';
import { asBusy, begin, type PgDriver, type Queryable } from './postgres.js';
import { BUSY_TIMEOUT_MS, StoreBusyError, TransactionAbortedError } from './types.js';

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
    // Free connections: idle ones, plus room to open more, less those already promised to callers in the queue
    // (the pool hands an idle one over on the next tick, so two callers can both see it idle).
    if (noWait && pool.idleCount + (max - pool.totalCount) - pool.waitingCount <= 0) throw new StoreBusyError();
    try {
      return await pool.connect();
    } catch (e) {
      throw /timeout/i.test((e as Error).message) ? new StoreBusyError({ cause: e }) : e;
    }
  };

  const transaction: PgDriver['transaction'] = async (fn, { noWait }) => {
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
      await client.query(begin(noWait));
      const out = await fn(client as unknown as Queryable);
      // COMMIT of a transaction a failed statement aborted succeeds, reporting ROLLBACK: nothing was saved.
      const done = await client.query('COMMIT');
      if (done.command === 'ROLLBACK') throw new TransactionAbortedError(new Error('COMMIT rolled back'));
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
  };

  return {
    read: <R>(sql: string, params: unknown[] | undefined, { noWait }: { noWait: boolean }) =>
      transaction(
        (q) =>
          q.query<R>(sql, params).catch((e) => {
            throw asBusy(e);
          }),
        { noWait },
      ),
    transaction,
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

/**
 * PGlite: Postgres compiled to WebAssembly, in process. For tests and local development; `dataDir` undefined
 * keeps it in memory. It is one connection, so like SQLite it is a first-come, first-served lock: a transaction
 * holds it from BEGIN to COMMIT and a read outside one holds it for that read. The lock gives the same bounded
 * waits and `withoutWaiting` refusals as a pool.
 */
export async function pgliteDriver(dataDir?: string): Promise<PgDriver> {
  const { PGlite } = await import('@electric-sql/pglite');
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true }); // PGlite creates only the last folder of the path.
  const db = await PGlite.create(dataDir);
  const lock = new FifoLock();
  const q = db as unknown as Queryable;
  return {
    read: <R>(sql: string, params: unknown[] | undefined, { noWait }: { noWait: boolean }) => lock.with(() => db.query<R>(sql, params), noWait),
    transaction: (fn, { noWait }) =>
      lock.with(async () => {
        await db.exec(begin(noWait));
        try {
          const out = await fn(q);
          await db.query('COMMIT');
          return out;
        } catch (e) {
          await db.query('ROLLBACK');
          throw e;
        }
      }, noWait),
    vacuumDocs: () =>
      lock.with(async () => {
        await db.query('VACUUM (FULL) docs');
        return true;
      }, true),
    close: () => lock.with(() => db.close()),
  };
}
