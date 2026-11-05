import { AsyncLocalStorage } from 'node:async_hooks';
import { type DocStore, openStore, type StoreOptions } from './store/index.js';

/**
 * Platform metadata (users, roles, change requests, votes) as JSON documents. Ontologies themselves live in
 * git, and people's private data (interview transcripts) in their Solid pods.
 *
 * Every call is async and goes to the store the environment picks (store/index.ts): Postgres when
 * DATABASE_URL is set (Neon on Vercel), PGlite with CONCORD_STORE=pglite, SQLite otherwise. Calls made inside
 * transaction(fn), however deep, join that transaction.
 */
export type Collection =
  | 'users'
  | 'sessions'
  | 'ontologies'
  | 'memberships'
  | 'useCases'
  | 'interviews'
  | 'meetings'
  | 'changeRequests'
  | 'publicReports'
  | 'reportNonces'
  | 'reviews'
  | 'votes'
  | 'releases'
  | 'agentTokens'
  | 'agentReports'
  | 'oauthClients'
  | 'oauthRequests'
  | 'oauthCodes'
  | 'oauthGrants'
  | 'oauthTokens'
  | 'feedback'
  | 'requirementsDocs'
  | 'feedbackPublications'
  | 'activity'
  | 'apps'
  | 'appChecks'
  | 'oidcTokens'
  | 'appFollowUps'
  | 'kv';

let store: Promise<DocStore> | undefined;

/** Open the store (once; later calls return the same one). */
export function openDb(opts?: StoreOptions): Promise<DocStore> {
  if (!store) {
    store = openStore(opts);
    store.catch(() => (store = undefined)); // A failed open (database unreachable) is retried on the next call.
  }
  return store;
}

export async function closeDb() {
  const s = store;
  store = undefined;
  if (s) await (await s).close();
}

const conn = () => openDb();

/** `parent` is the indexed foreign key used for listing (usually an ontology id). */
export async function put<T extends { id: string }>(collection: Collection, doc: T, parent?: string): Promise<T> {
  return (await conn()).put(collection, doc, parent);
}

export async function get<T>(collection: Collection, id: string): Promise<T | undefined> {
  return (await conn()).get<T>(collection, id);
}

export async function mustGet<T>(collection: Collection, id: string): Promise<T> {
  const doc = await get<T>(collection, id);
  if (!doc) throw new HttpError(404, `${collection.replace(/s$/, '')} ${id} not found`);
  return doc;
}

export async function list<T>(collection: Collection, parent?: string): Promise<T[]> {
  return (await conn()).list<T>(collection, parent);
}

export async function remove(collection: Collection, id: string): Promise<void> {
  await (await conn()).remove(collection, id);
}

/** Delete a document and return it, atomically: of several callers racing for it, only one gets it. */
export async function take<T>(collection: Collection, id: string): Promise<T | undefined> {
  return (await conn()).take<T>(collection, id);
}

/**
 * Set `field` to `value` on a document only if it is not set yet, atomically, and return the document as it
 * was. Undefined means it doesn't exist or someone else set the field first.
 */
export async function claim<T>(collection: Collection, id: string, field: string, value: string | number): Promise<T | undefined> {
  return (await conn()).claim<T>(collection, id, field, value);
}

/** Insert a document only if none has its id, in one statement: true if this call inserted it. */
export async function insertOnce<T extends { id: string }>(collection: Collection, doc: T, parent?: string): Promise<boolean> {
  return (await conn()).insertOnce(collection, doc, parent);
}

/** Delete the documents in a collection whose `field` is a number at or below `max`; returns how many. */
export async function removeWhereAtMost(collection: Collection, field: string, max: number): Promise<number> {
  return (await conn()).removeWhereAtMost(collection, field, max);
}

export async function clearAll(): Promise<void> {
  await (await conn()).clearAll();
}

/**
 * Run fn in one transaction: writers take turns, so read-then-write steps inside can't interleave with another
 * writer, in this process or any other. A nested call joins the outer transaction. Keep fn short: no network
 * calls (LLM, GitHub, pods) inside, because every other writer waits for it. Await every store call that
 * belongs to it: the transaction waits for statements already running when fn returns, but a call made later
 * (after a timer, say) runs outside it.
 */
export async function transaction<T>(fn: () => T | Promise<T>): Promise<T> {
  return (await conn()).transaction(async () => insideTransaction.run(true, fn));
}

const insideTransaction = new AsyncLocalStorage<boolean>();
/**
 * True inside transaction(fn) (and not inside detached(fn) started from one). Code that waits for an in-memory
 * lock checks this: waiting for it while holding the writer lock deadlocks against a holder that needs to write.
 */
export const inTransaction = () => insideTransaction.getStore() === true;

/**
 * Run fn without waiting on other connections' locks: anything blocked throws at once instead of stalling.
 * For background work that can simply be retried later.
 */
export async function withoutWaiting<T>(fn: () => T | Promise<T>): Promise<T> {
  return (await conn()).withoutWaiting(async () => fn());
}

/**
 * Run fn outside any transaction the caller is in: for background work (timers, notifications) started from
 * inside one, which would otherwise inherit it and be refused once it rolls back or while it commits.
 */
export async function detached<T>(fn: () => T | Promise<T>): Promise<T> {
  return (await conn()).detached(async () => insideTransaction.run(false, fn));
}

/** Rewrite storage so old copies of rewritten or deleted rows are gone. False if blocked: retry later. */
export async function scrubFreeSpace(): Promise<boolean> {
  return (await conn()).scrubFreeSpace();
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Takes one from each counter (kv documents `{ id, count }`) if none is at its limit, all or nothing. It runs in
 * one transaction, which holds the writer lock from its first read to COMMIT, so separate connections or
 * processes can't both take the last one.
 */
export async function reserveCounters(
  counters: { id: string; max: number }[],
  parent?: string,
  /** Tests only: hooks between the steps, to prove the steps can't interleave or half-apply. */
  test?: { afterRead?: () => void | Promise<void>; beforeWrite?: (index: number) => void | Promise<void> },
): Promise<boolean> {
  return transaction(async () => {
    const used: number[] = [];
    for (const k of counters) used.push(Number((await get<{ count?: number }>('kv', k.id))?.count ?? 0));
    await test?.afterRead?.();
    if (counters.some((k, i) => used[i] >= k.max)) return false;
    for (const [i, k] of counters.entries()) {
      await test?.beforeWrite?.(i);
      await put('kv', { id: k.id, count: used[i] + 1 }, parent);
    }
    return true;
  });
}

/** Gives back what reserveCounters took (never below zero), all or nothing. */
export async function releaseCounters(ids: string[], parent?: string): Promise<void> {
  await transaction(async () => {
    for (const id of ids) {
      const doc = await get<{ id: string; count?: number }>('kv', id);
      if (doc) await put('kv', { ...doc, count: Math.max(0, Number(doc.count ?? 0) - 1) }, parent);
    }
  });
}
