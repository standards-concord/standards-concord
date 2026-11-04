import type { Collection } from '../db.js';

/**
 * The platform's document store, as an async interface so it can sit on SQLite (one process, a file on disk)
 * or Postgres (Neon on Vercel, PGlite in tests and local dev). Both back ends keep the guarantees `db.ts`
 * gives today:
 *
 * - **Writers take turns.** A transaction holds the one writer lock from its first statement to COMMIT, so
 *   read-then-write steps inside it can't interleave with another writer (SQLite: BEGIN IMMEDIATE; Postgres:
 *   a transaction-scoped advisory lock). A write outside a transaction takes the same lock for its one
 *   statement, so `claim` and `take` stay atomic against transactions too.
 * - **Reads never wait for writers**, and see only committed data from outside a transaction.
 * - **Nested transactions join the outer one.** Calls made anywhere inside `transaction(fn)` (including in
 *   functions fn calls) run on the transaction's connection; this is tracked with AsyncLocalStorage, so
 *   callers don't pass a handle around.
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

/** Thrown by `withoutWaiting` work that would have had to wait for a lock. */
export class StoreBusyError extends Error {
  constructor() {
    super('The database is busy; try again later');
  }
}

const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function checkField(field: string) {
  if (!FIELD.test(field)) throw new Error(`Bad field name ${field}`);
}
