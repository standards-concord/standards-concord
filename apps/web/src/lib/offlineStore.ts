/**
 * A copy on this device (IndexedDB) of what pages kept (lib/kept.ts), so Concord can show it with no
 * connection, after a reload or the next day. Entries are keyed like the kept answers, account first,
 * and only the signed-in account's entries are ever read back: signing out clears everything, and
 * opening Concord as anyone else drops the rest.
 *
 * Every call is best effort: without IndexedDB (a private window, blocked storage, the unit tests'
 * node environment) nothing is saved and nothing fails. Calls run in the order they were made, so a
 * clear after a save always wins.
 */
const DB_NAME = 'concord-offline';
const STORE = 'kept';

interface Saved {
  value: unknown;
  /** When it was saved (ms), so the oldest go first and the page can say how old a copy is. */
  at: number;
}

let opening: Promise<IDBDatabase | undefined> | undefined;
function db(): Promise<IDBDatabase | undefined> {
  opening ??= new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(undefined);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
      req.onblocked = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
  return opening;
}

/** One transaction on the store, made in call order; resolves when it completes (or failed). */
let queue: Promise<unknown> = Promise.resolve();
function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore, done: (v: T) => void) => void, fallback: T): Promise<T> {
  const next = queue.then(
    () =>
      db().then(
        (d) =>
          new Promise<T>((resolve) => {
            if (!d) return resolve(fallback);
            try {
              const tx = d.transaction(STORE, mode);
              let result = fallback;
              fn(tx.objectStore(STORE), (v) => (result = v));
              tx.oncomplete = () => resolve(result);
              tx.onerror = () => resolve(fallback);
              tx.onabort = () => resolve(fallback);
            } catch {
              resolve(fallback);
            }
          }),
      ),
  );
  queue = next;
  return next;
}

export function saveOffline(key: string, value: unknown): Promise<void> {
  return run<void>('readwrite', (s) => void s.put({ value, at: Date.now() } satisfies Saved, key), undefined);
}

export function dropOffline(key: string): Promise<void> {
  return run<void>('readwrite', (s) => void s.delete(key), undefined);
}

export function clearOffline(): Promise<void> {
  return run<void>('readwrite', (s) => void s.clear(), undefined);
}

/**
 * The entries saved for `account`, oldest first. Anything saved for another account is deleted on
 * the way (someone signed in as another account without signing out here).
 */
export function loadOffline(account: string): Promise<{ key: string; value: unknown; at: number }[]> {
  return run<{ key: string; value: unknown; at: number }[]>(
    'readwrite',
    (s, done) => {
      const found: { key: string; value: unknown; at: number }[] = [];
      const req = s.openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return done(found.sort((a, b) => a.at - b.at));
        const key = String(c.key);
        const saved = c.value as Saved;
        if (key.startsWith(`${account}|`)) found.push({ key, value: saved.value, at: saved.at });
        else c.delete();
        c.continue();
      };
    },
    [],
  );
}
