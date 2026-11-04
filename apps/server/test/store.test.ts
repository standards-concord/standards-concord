import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { type DocStore, openStore, StoreBusyError, type StoreOptions } from '../src/store/index.js';

/**
 * One contract, three back ends: SQLite (today's store), PGlite (Postgres in process, as tests and local dev
 * will run it) and a real Postgres server (as Neon runs it in production). The real server is the only one
 * that exercises Postgres's own locking across separate connections, so CI must provide it (the test job's
 * `postgres` service sets TEST_DATABASE_URL); elsewhere it runs when one is given.
 */
const pgUrl = process.env.TEST_DATABASE_URL;
if (process.env.CI && !pgUrl) throw new Error('CI must set TEST_DATABASE_URL so the store is tested against a real Postgres server');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-store-'));
let n = 0;

interface Backend {
  name: string;
  /** Options for a fresh, empty store. A second `open` of the same options is another connection to the same data, where the back end allows it. */
  fresh: () => StoreOptions;
  /** Whether two stores can be open on the same data at once (separate connections, like two processes or function instances). */
  multiConnection: boolean;
}

const backends: Backend[] = [
  { name: 'sqlite', fresh: () => ({ kind: 'sqlite', file: path.join(tmp, `s${n++}.sqlite`) }), multiConnection: true },
  { name: 'pglite', fresh: () => ({ kind: 'pglite' }), multiConnection: false },
  ...(pgUrl ? [{ name: 'postgres', fresh: () => ({ kind: 'postgres', url: pgUrl }) as StoreOptions, multiConnection: true }] : []),
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
}

interface Doc {
  id: string;
  createdAt?: string;
  [k: string]: unknown;
}

describe.each(backends)('document store on $name', (backend) => {
  const open: DocStore[] = [];
  let store: DocStore;
  let opts: StoreOptions;

  async function connect(o: StoreOptions = opts) {
    const s = await openStore(o);
    open.push(s);
    return s;
  }

  beforeEach(async () => {
    // PGlite is one in-process database per instance and slow to start, so its tests share one, emptied each time.
    if (!store || backend.multiConnection) {
      opts = backend.fresh();
      store = await connect();
    }
    await store.clearAll(); // The real server is shared between tests too.
  });

  afterAll(async () => {
    for (const s of open) await s.close().catch(() => {});
  });

  it('round-trips documents exactly, key order and awkward characters included', async () => {
    const doc = { id: 'a', zeta: 1, alpha: { b: [1, 'two', null], a: true }, text: 'naïve 🚀 "quoted" \\ back\u0000nul', n: 0.1 + 0.2 };
    await store.put('users', doc);
    const back = await store.get<typeof doc>('users', 'a');
    expect(back).toEqual(doc);
    expect(JSON.stringify(back)).toBe(JSON.stringify(doc));
    expect(await store.get('users', 'missing')).toBeUndefined();
    expect(await store.get('sessions', 'a')).toBeUndefined();
  });

  it('lists by collection and parent, oldest first, insertion order breaking ties, and keeps creation time on update', async () => {
    const t = '2026-01-01T00:00:00.000Z';
    await store.put('votes', { id: 'late', createdAt: '2026-02-01T00:00:00.000Z' }, 'o1');
    await store.put('votes', { id: 'tie-1', createdAt: t }, 'o1');
    await store.put('votes', { id: 'tie-2', createdAt: t }, 'o2');
    await store.put('votes', { id: 'tie-3', createdAt: t }, 'o1');
    await store.put('reviews', { id: 'other', createdAt: t }, 'o1');
    expect((await store.list<Doc>('votes')).map((d) => d.id)).toEqual(['tie-1', 'tie-2', 'tie-3', 'late']);
    expect((await store.list<Doc>('votes', 'o1')).map((d) => d.id)).toEqual(['tie-1', 'tie-3', 'late']);
    expect(await store.list('votes', 'none')).toEqual([]);

    // An update replaces the data and parent but not the creation time or the place in the order.
    await store.put('votes', { id: 'tie-1', createdAt: '2027-01-01T00:00:00.000Z', changed: true }, 'o2');
    expect((await store.list<Doc>('votes')).map((d) => d.id)).toEqual(['tie-1', 'tie-2', 'tie-3', 'late']);
    expect((await store.list<Doc>('votes', 'o2')).map((d) => d.id)).toEqual(['tie-1', 'tie-2']);
    expect(await store.get('votes', 'tie-1')).toMatchObject({ changed: true });

    await store.remove('votes', 'tie-2');
    expect((await store.list<Doc>('votes')).map((d) => d.id)).toEqual(['tie-1', 'tie-3', 'late']);
  });

  it('take hands a document to exactly one of several racing callers', async () => {
    await store.put('oauthCodes', { id: 'code', grant: 'g' });
    const results = await Promise.all(Array.from({ length: 10 }, () => store.take<Doc>('oauthCodes', 'code')));
    expect(results.filter(Boolean)).toEqual([{ id: 'code', grant: 'g' }]);
    expect(await store.get('oauthCodes', 'code')).toBeUndefined();
  });

  it('claim sets a field for exactly one of several racing callers, and returns the document as it was', async () => {
    await store.put('oauthCodes', { id: 'c', grant: 'g', usedAt: null });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => store.claim<Doc>('oauthCodes', 'c', 'usedAt', i)));
    const winners = results.filter(Boolean);
    expect(winners).toEqual([{ id: 'c', grant: 'g' }]);
    const after = await store.get<Doc>('oauthCodes', 'c');
    expect(typeof after?.usedAt).toBe('number');
    // The field keeps its place when it replaced a null.
    expect(Object.keys(after!)).toEqual(['id', 'grant', 'usedAt']);

    await store.put('oauthCodes', { id: 'd', grant: 'g' });
    expect(await store.claim('oauthCodes', 'd', 'usedBy', 'me')).toEqual({ id: 'd', grant: 'g' });
    expect(await store.get('oauthCodes', 'd')).toEqual({ id: 'd', grant: 'g', usedBy: 'me' });
    expect(await store.claim('oauthCodes', 'd', 'usedBy', 'you')).toBeUndefined();
    expect(await store.claim('oauthCodes', 'nope', 'usedBy', 'me')).toBeUndefined();
    await expect(store.claim('oauthCodes', 'd', "x') OR 1=1 --", 'me')).rejects.toThrow(/Bad field name/);
  });

  it('a transaction commits all of its writes or none of them, and a nested call joins it', async () => {
    expect(await store.transaction(async () => (await store.put('kv', { id: 'k1' })).id)).toBe('k1');

    await expect(
      store.transaction(async () => {
        await store.put('kv', { id: 'k2' });
        await store.transaction(async () => {
          await store.put('kv', { id: 'k3' });
          await store.remove('kv', 'k1');
        });
        await sleep(5);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await store.list<Doc>('kv')).map((d) => d.id)).toEqual(['k1']);
  });

  it('writers take turns, so read-then-write transactions never lose an update', async () => {
    await store.put('kv', { id: 'counter', value: 0 });
    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.transaction(async () => {
          const c = (await store.get<{ id: string; value: number }>('kv', 'counter'))!;
          await sleep(1); // Yield mid-transaction, as real code does when it awaits other work.
          await store.put('kv', { ...c, value: c.value + 1 });
        }),
      ),
    );
    expect(await store.get('kv', 'counter')).toEqual({ id: 'counter', value: 20 });
  });

  it('work outside an open transaction is neither visible to nor undone by it', async () => {
    const g = gate();
    const tx = store.transaction(async () => {
      await store.put('kv', { id: 'inside' });
      await g.opened;
      throw new Error('roll back');
    });
    await sleep(20); // Let the transaction start and write.
    const outsideRead = store.get('kv', 'inside');
    const outsideWrite = store.put('kv', { id: 'outside' });
    g.open();
    await expect(tx).rejects.toThrow('roll back');
    expect(await outsideRead).toBeUndefined();
    await outsideWrite;
    expect((await store.list<Doc>('kv')).map((d) => d.id)).toEqual(['outside']);
  });

  it('a claim racing a read-then-write transaction is never silently undone', async () => {
    // Used to be the risk in porting to Postgres: a transaction that read the row before the claim, then wrote
    // it back, would erase the claimed field, letting a second claim succeed later.
    await store.put('oauthCodes', { id: 'r', grant: 'g' });
    const g = gate();
    const tx = store.transaction(async () => {
      const doc = (await store.get<Doc>('oauthCodes', 'r'))!;
      await g.opened;
      await store.put('oauthCodes', { ...doc, touched: true });
    });
    await sleep(20);
    const claim = store.claim('oauthCodes', 'r', 'usedAt', 1);
    await sleep(20);
    g.open();
    await tx;
    const claimed = await claim;
    const final = (await store.get<Doc>('oauthCodes', 'r'))!;
    expect(final.touched).toBe(true);
    expect(claimed !== undefined).toBe(final.usedAt === 1);
    expect(await store.claim('oauthCodes', 'r', 'usedAt', 2)).toBeUndefined();
  });

  it('scrubFreeSpace succeeds when nothing holds a lock, and keeps the data', async () => {
    await store.put('oauthClients', { id: 'c', secret: 'x'.repeat(1000) });
    await store.put('oauthClients', { id: 'c', secretHash: 'h' });
    expect(await store.scrubFreeSpace()).toBe(true);
    expect(await store.get('oauthClients', 'c')).toEqual({ id: 'c', secretHash: 'h' });
  });

  // Only back ends that can have two connections on the same data get these; PGlite is one connection by design.
  if (backend.multiConnection) describe('across connections (separate processes or function instances)', () => {
    it('writers on different connections take turns', async () => {
      const other = await connect();
      await store.put('kv', { id: 'counter', value: 0 });
      const bump = (s: DocStore) =>
        s.transaction(async () => {
          const c = (await s.get<{ id: string; value: number }>('kv', 'counter'))!;
          await sleep(1);
          await s.put('kv', { ...c, value: c.value + 1 });
        });
      await Promise.all(Array.from({ length: 10 }, (_, i) => bump(i % 2 ? store : other)));
      expect(await store.get('kv', 'counter')).toEqual({ id: 'counter', value: 10 });
    });

    it('withoutWaiting gives up at once while another connection holds the writer lock, and works once it is free', async () => {
      const other = await connect();
      const g = gate();
      const held = gate();
      const tx = store.transaction(async () => {
        await store.put('kv', { id: 'held' });
        held.open();
        await g.opened;
      });
      await held.opened;
      const started = Date.now();
      await expect(other.withoutWaiting(() => other.transaction(async () => other.put('kv', { id: 'blocked' })))).rejects.toBeInstanceOf(
        StoreBusyError,
      );
      expect(Date.now() - started).toBeLessThan(2000);
      g.open();
      await tx;
      await other.withoutWaiting(() => other.transaction(async () => other.put('kv', { id: 'later' })));
      expect((await other.list<Doc>('kv')).map((d) => d.id)).toEqual(['held', 'later']);
    });
  });
});
