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
 * - **A transaction ends only once the statements it started have finished.** When fn returns (or throws), the
 *   transaction waits for any statement still running on its behalf (say, one fn started but didn't await, or
 *   a `claim` halfway between its read and its write), and those count: if one fails, nothing is saved and it
 *   rejects with TransactionAbortedError. Then it commits or rolls back. Work fn started that calls the store
 *   later can't use the transaction, and doesn't quietly run on its own either: once the transaction is
 *   ending, committed or rolled back, its calls reject with TransactionEndedError. So the leftovers of a failed
 *   transaction (say, the other branches of a rejected Promise.all) can't save half of it, and un-awaited work
 *   can't save writes of its own after the transaction reported success. Await everything that belongs to the
 *   transaction, and start background work with `detached(fn)`.
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
  /** Insert a document only if none has its id, in one statement: true if this call inserted it. */
  insertOnce<T extends { id: string }>(collection: Collection, doc: T, parent?: string): Promise<boolean>;
  /** Delete the documents in a collection whose `field` is a number at or below `max`; returns how many. */
  removeWhereAtMost(collection: Collection, field: string, max: number): Promise<number>;
  clearAll(): Promise<void>;
  /**
   * Run fn as one transaction: all of it commits, or none of it does if fn throws. A nested call joins the outer
   * transaction. Await every call that is meant to be part of it: one still waiting on something else when fn
   * returns is refused when it gets to the store (see above).
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Run fn now, outside any transaction the caller is in (keeping a surrounding `withoutWaiting`): for background
   * work started from inside one. Its writes are its own, so they stay if that transaction rolls back. It is not
   * an after-commit hook.
   */
  detached<T>(fn: () => Promise<T>): Promise<T>;
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

/** Work started inside a transaction called the store once the transaction was ending or over, without detached(). */
export class TransactionEndedError extends Error {
  constructor() {
    super('This work belongs to a transaction that has ended: await it inside the transaction, or start it with detached()');
  }
}

/** One transaction's lifetime, shared by every context that can see it (including ones withoutWaiting copies). */
export interface TxState {
  /**
   * `finishing`: fn has returned or thrown, and statements it started are being waited for (they still run in
   * the transaction). `ending`: COMMIT or ROLLBACK is on its way and the outcome isn't known yet; nothing more
   * may use the connection.
   */
  status: 'open' | 'finishing' | 'ending' | 'committed' | 'rolledBack';
  /** The first statement failure inside the transaction, if any: it can then only roll back. */
  failed?: unknown;
}

/**
 * The transaction a store call should use, from the context it inherited: that one while it is open or
 * finishing; an error once it is ending or over (the call is leftover work: it should have been awaited, or
 * started with detached()).
 */
export function liveTransaction<T extends { state: TxState }>(tx: T | undefined): T | undefined {
  if (!tx || tx.state.status === 'open' || tx.state.status === 'finishing') return tx;
  throw new TransactionEndedError();
}

/**
 * The statements one transaction has started and not yet seen finish, so it can wait for them before ending.
 * A statement may start only while the transaction is open or finishing.
 */
export class Pending {
  private readonly running = new Set<Promise<unknown>>();

  constructor(private readonly state: TxState) {}

  /** Start a statement in the transaction: refused once it is ending or over; a failure dooms it. */
  start<T>(statement: () => Promise<T>): Promise<T> {
    const { status } = this.state;
    if (status !== 'open' && status !== 'finishing') return Promise.reject(new TransactionEndedError());
    const p = statement().catch((e: unknown) => {
      this.state.failed ??= e;
      throw e;
    });
    this.running.add(p);
    const done = () => this.running.delete(p);
    p.then(done, done);
    return p;
  }

  /**
   * Wait until nothing is running, including statements started by the ones being waited for (a claim's write
   * after its read): each round lets every continuation queued by the last one run before looking again.
   */
  async settle() {
    for (;;) {
      await new Promise((r) => setImmediate(r));
      if (!this.running.size) return;
      await Promise.allSettled([...this.running]);
    }
  }
}

export const BUSY_TIMEOUT_MS = 5000;

const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function checkField(field: string) {
  if (!FIELD.test(field)) throw new Error(`Bad field name ${field}`);
}
