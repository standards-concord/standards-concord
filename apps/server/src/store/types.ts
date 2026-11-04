import type { Collection } from '../db.js';

/**
 * The platform's document store, as an async interface so it can sit on SQLite (one process, a file on disk)
 * or Postgres (Neon on Vercel, PGlite in tests and local dev). All three back ends keep these rules, and
 * test/store.test.ts checks each of them against each back end:
 *
 * - **Writers take turns.** A transaction holds the one writer lock from its first statement to COMMIT, so
 *   read-then-write steps inside it can't interleave with another writer (SQLite: BEGIN IMMEDIATE; Postgres:
 *   a transaction-scoped advisory lock). A write outside a transaction takes the same lock for its one
 *   statement, so `claim` and `take` stay atomic against transactions too.
 * - **Reads outside a transaction see only committed data.** They may wait their turn for a connection: SQLite
 *   and PGlite have one, shared in arrival order, and a Postgres pool can be fully checked out.
 * - **Waits are bounded.** A call that can't get the lock or a connection within 5 s fails with StoreBusyError;
 *   inside `withoutWaiting` it fails at once.
 * - **Nested transactions join the outer one.** Calls made anywhere inside `transaction(fn)` (including in
 *   functions fn calls) run on the transaction's connection; this is tracked with AsyncLocalStorage, so
 *   callers don't pass a handle around.
 * - **A transaction is all or nothing, even if fn catches an error.** If any statement in it failed, it rolls
 *   back and rejects with TransactionAbortedError, though fn caught the error and returned. (Postgres can't go
 *   on after a failed statement; SQLite could, but behaves the same so code can't come to rely on it.)
 * - **Work a transaction started but didn't await** can't use it once it has ended. After a commit it runs as
 *   ordinary calls outside any transaction; after a rollback its calls reject with TransactionEndedError, so
 *   the leftovers of a failed transaction (say, the other branches of a rejected Promise.all) can't save
 *   half of its work.
 * - **`list` order** is creation time, then insertion order for ties.
 */
export interface DocStore {
  readonly kind: 'sqlite' | 'postgres';
  get<T>(collection: Collection, id: string): Promise<T | undefined>;
  /** Every document in a collection, or only those with this `parent`, oldest first. */
  list<T>(collection: Collection, parent?: string): Promise<T[]>;
  /** Insert or replace. `parent` is the indexed foreign key used for listing (usually an ontology id). Keeps the original creation time. */
  put<T extends { id: string }>(collection: Collection, doc: T, parent?: string): Promise<T>;
  remove(collection: Collection, id: string): Promise<void>;
  /** Delete a document and return it, atomically: of several callers racing for it, only one gets it. */
  take<T>(collection: Collection, id: string): Promise<T | undefined>;
  /**
   * Set `field` to `value` only if it is not set yet (absent or null), atomically, and return the document as
   * it was before (without the field). Undefined means it doesn't exist or someone else set the field first.
   */
  claim<T>(collection: Collection, id: string, field: string, value: string | number): Promise<T | undefined>;
  clearAll(): Promise<void>;
  /** Run fn as one transaction: all of it commits, or none of it does if fn throws. A nested call joins the outer transaction. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Run fn without waiting on locks another connection holds: anything blocked throws at once instead of
   * stalling. For background work that can simply be retried later.
   */
  withoutWaiting<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Rewrite storage so old copies of rewritten or deleted rows are gone (see oauth.ts's secret scrub).
   * False means it was blocked and should be retried.
   */
  scrubFreeSpace(): Promise<boolean>;
  close(): Promise<void>;
}

/** The lock or a connection wasn't free in time (at once, inside `withoutWaiting`). */
export class StoreBusyError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('The database is busy; try again later', options);
  }
}

/** A statement inside the transaction failed, so none of it was saved, even though the callback carried on. */
export class TransactionAbortedError extends Error {
  constructor(cause: unknown) {
    super(`A statement failed inside this transaction, so none of it was saved: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

/** Work started inside a transaction that rolled back tried to use the store afterwards. */
export class TransactionEndedError extends Error {
  constructor() {
    super('This work was started by a transaction that has rolled back');
  }
}

/** One transaction's lifetime, shared by every context that can see it (including ones withoutWaiting copies). */
export interface TxState {
  status: 'open' | 'committed' | 'rolledBack';
  /** The first statement error inside the transaction, if any: it can then only roll back. */
  failed?: unknown;
}

/**
 * The transaction a call should use, from the context it inherited: the open one; none if that one has
 * committed (the call is leftover work and runs on its own); and an error if it rolled back.
 */
export function liveTransaction<T extends { state: TxState }>(tx: T | undefined): T | undefined {
  if (!tx || tx.state.status === 'committed') return undefined;
  if (tx.state.status === 'rolledBack') throw new TransactionEndedError();
  return tx;
}

export const BUSY_TIMEOUT_MS = 5000;

const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function checkField(field: string) {
  if (!FIELD.test(field)) throw new Error(`Bad field name ${field}`);
}
