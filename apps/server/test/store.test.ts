import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nodePostgresDriver, pgliteDriver } from '../src/store/drivers.js';
import { type DocStore, openStore, StoreBusyError, type StoreOptions } from '../src/store/index.js';
import { type PgDriver, PostgresStore } from '../src/store/postgres.js';
import { FifoLock } from '../src/store/lock.js';
import { TransactionAbortedError, TransactionEndedError } from '../src/store/types.js';

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

/** A plain pg connection to the test server, outside any store: to hold locks or end other sessions. */
async function withAdmin<T>(fn: (c: { query(sql: string): Promise<unknown> }) => Promise<T>): Promise<T> {
  const { default: pg } = await import('pg');
  const c = new pg.Client({ connectionString: pgUrl, application_name: 'concord-test-admin' });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
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

  if (backend.name === 'pglite')
    it('opens on disk in a data directory that does not exist yet', async () => {
      // Used to fail at startup: PGlite only creates the last folder of its path.
      const dataDir = path.join(tmp, `missing-${n++}`, 'nested', 'pglite');
      const onDisk = await openStore({ kind: 'pglite', dataDir });
      open.push(onDisk);
      await onDisk.put('kv', { id: 'x' });
      expect(await onDisk.get('kv', 'x')).toEqual({ id: 'x' });
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

  it('work a committed transaction started without awaiting cannot write afterwards unless it was detached', async () => {
    // Async code inherits the context it started in. A fire-and-forget task started inside a transaction used
    // to run as ordinary calls after COMMIT, so accidentally un-awaited work saved writes of its own after the
    // transaction had reported success (Astra, PR #53 re-review 4). Now it is refused; background work says so
    // with detached(), and then waits its turn rather than joining another transaction.
    const later = gate();
    let leftover: Promise<unknown> | undefined;
    let background: Promise<unknown> | undefined;
    await store.transaction(async () => {
      await store.put('kv', { id: 'in-tx' });
      leftover = (async () => {
        await later.opened;
        await store.put('kv', { id: 'leftover' });
      })();
      leftover.catch(() => {});
      background = store.detached(async () => {
        await later.opened;
        await store.put('kv', { id: 'after-tx' });
        return store.transaction(async () => store.put('kv', { id: 'own-tx' }));
      });
    });
    const g = gate();
    const other = store.transaction(async () => {
      await store.put('kv', { id: 'other-tx' });
      await g.opened;
      throw new Error('roll back');
    });
    await sleep(20);
    later.open();
    await expect(leftover).rejects.toBeInstanceOf(TransactionEndedError);
    await sleep(20);
    g.open();
    await expect(other).rejects.toThrow('roll back');
    await background;
    // The detached writes waited for the other transaction rather than joining it, so its rollback kept them.
    expect((await store.list<Doc>('kv')).map((d) => d.id).sort()).toEqual(['after-tx', 'in-tx', 'own-tx']);
  });

  it('work left over from a rolled-back transaction cannot save anything', async () => {
    // Astra (PR #53 review): the other branches of a rejected Promise.all kept running after the rollback and
    // wrote outside it, or into an unrelated transaction, saving half of the failed transaction's work.
    const slow = gate();
    let leftover: Promise<unknown> | undefined;
    let leftoverNoWait: Promise<unknown> | undefined;
    await expect(
      store.transaction(async () => {
        leftover = (async () => {
          await slow.opened;
          await store.put('kv', { id: 'leftover' });
        })();
        leftoverNoWait = store.withoutWaiting(async () => {
          await slow.opened;
          await store.put('kv', { id: 'leftover-no-wait' });
        });
        await Promise.all([leftover, leftoverNoWait, Promise.reject(new Error('one branch failed'))]);
      }),
    ).rejects.toThrow('one branch failed');
    const g = gate();
    const other = store.transaction(async () => {
      await store.put('kv', { id: 'unrelated' });
      await g.opened;
    });
    await sleep(20);
    slow.open();
    await expect(leftover).rejects.toBeInstanceOf(TransactionEndedError);
    await expect(leftoverNoWait).rejects.toBeInstanceOf(TransactionEndedError);
    g.open();
    await other;
    expect((await store.list<Doc>('kv')).map((d) => d.id)).toEqual(['unrelated']);
  });

  it('a transaction whose statement failed saves nothing, even if the callback caught the error', async () => {
    // Astra (PR #53 review): Postgres silently committed nothing while reporting success; SQLite committed the
    // rest. Now both reject, so callers can't mistake a lost transaction for a saved one.
    await expect(
      store.transaction(async () => {
        await store.put('kv', { id: 'first' });
        await store.put('kv', { id: null as unknown as string }).catch(() => 'caught');
        await store.put('kv', { id: 'after' }).catch(() => 'caught'); // Postgres refuses it; SQLite would run it.
        return 'looks fine';
      }),
    ).rejects.toBeInstanceOf(TransactionAbortedError);
    expect(await store.list('kv')).toEqual([]);
    // The store is usable afterwards.
    await store.transaction(async () => store.put('kv', { id: 'next' }));
    expect((await store.list<Doc>('kv')).map((d) => d.id)).toEqual(['next']);
  });

  it('claims field names that Object.prototype also has, like any other', async () => {
    // Astra (PR #53 review): an inherited `constructor` counted as already set on Postgres.
    await store.put('kv', { id: 'p' });
    expect(await store.claim('kv', 'p', 'constructor', 'me')).toEqual({ id: 'p' });
    expect(await store.claim('kv', 'p', 'toString', 1)).toEqual({ id: 'p', constructor: 'me' });
    expect(await store.claim('kv', 'p', 'constructor', 'you')).toBeUndefined();
  });

  it('a claim still running when its transaction fails is rolled back with it', async () => {
    // Astra (PR #53 re-review 2): the claim's UPDATE, sent after its SELECT returned, ran after the ROLLBACK
    // and saved the field outside the failed transaction.
    await store.put('kv', { id: 'c' });
    await expect(
      store.transaction(async () => {
        await Promise.all([store.claim('kv', 'c', 'owner', 'me'), Promise.reject(new Error('another branch failed'))]);
      }),
    ).rejects.toThrow('another branch failed');
    await sleep(50);
    expect(await store.get('kv', 'c')).toEqual({ id: 'c' });
  });

  it('a statement still running when the callback returns counts: if it fails, the transaction does', async () => {
    // Astra (PR #53 re-review 2): the transaction checked for failures before the un-awaited put had failed,
    // so it reported success though Postgres had saved nothing.
    let caught = false;
    await expect(
      store.transaction(async () => {
        await store.put('kv', { id: 'first' });
        void store.put('kv', { id: null as unknown as string }).catch(() => (caught = true));
        return 'looks saved';
      }),
    ).rejects.toBeInstanceOf(TransactionAbortedError);
    expect(caught).toBe(true);
    expect(await store.list('kv')).toEqual([]);
  });

  it('a statement still running when the callback returns is saved with the transaction', async () => {
    await store.transaction(async () => {
      void store.put('kv', { id: 'not-awaited' });
    });
    expect(await store.get('kv', 'not-awaited')).toEqual({ id: 'not-awaited' });
  });

  it('detached work started inside a transaction runs outside it, and survives its rollback', async () => {
    let detached: Promise<unknown> | undefined;
    await expect(
      store.transaction(async () => {
        await store.put('kv', { id: 'inside' });
        detached = store.detached(async () => {
          await sleep(20);
          await store.put('kv', { id: 'background' });
        });
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    await detached;
    expect((await store.list<Doc>('kv')).map((d) => d.id)).toEqual(['background']);
  });

  if (backend.name !== 'sqlite')
    it('work left over from a failed transaction cannot write while its ROLLBACK is in flight', async () => {
      // Astra (PR #53 re-review 3): after fn threw, the transaction stayed "finishing", which still accepts
      // statements, until the driver's rollback returned; a child arriving then wrote on the connection after
      // ROLLBACK and its write was saved. Here the driver's rollback path is slowed down to hold that moment open.
      const real: PgDriver = backend.name === 'pglite' ? await pgliteDriver() : await nodePostgresDriver(pgUrl!);
      const slowRollback: PgDriver = {
        ...real,
        transaction: (fn, o) =>
          real.transaction(fn, o).catch(async (e) => {
            await sleep(150);
            throw e;
          }),
      };
      const s = await PostgresStore.open(slowRollback);
      open.push(s);
      await s.clearAll();
      let child: Promise<unknown> | undefined;
      await expect(
        s.transaction(async () => {
          child = (async () => {
            await sleep(50); // fn has thrown and the rollback is under way by now.
            await s.put('kv', { id: 'child' });
          })();
          child.catch(() => {});
          throw new Error('roll back');
        }),
      ).rejects.toThrow('roll back');
      await expect(child).rejects.toBeInstanceOf(TransactionEndedError);
      expect(await s.list('kv')).toEqual([]);
    });

  if (backend.name !== 'sqlite')
    it("a statement can't run on a transaction's connection once the transaction has ended", async () => {
      // Astra (PR #53 re-review 2): an operation that had already picked up the transaction's connection
      // (claim, between its read and its write) checked nothing before its next statement, so after the
      // transaction ended it ran on a connection already back in the pool. Each statement is now checked.
      const raw = store as unknown as { reader(): { query(sql: string, params?: unknown[]): Promise<unknown> } };
      let q!: { query(sql: string, params?: unknown[]): Promise<unknown> };
      await store.transaction(async () => {
        q = raw.reader();
        await q.query('SELECT 1');
      });
      await expect(
        q.query("INSERT INTO docs (collection, id, data, created_at) VALUES ('kv', 'late', '{}', '0')"),
      ).rejects.toBeInstanceOf(TransactionEndedError);
      expect(await store.get('kv', 'late')).toBeUndefined();
    });

  if (backend.name !== 'sqlite')
    it('work left over from a transaction cannot escape it while it is ending, even if COMMIT then fails', async () => {
      // Astra (PR #53 re-review 2): the transaction counted as committed before COMMIT was sent, so a child
      // arriving then ran on its own and saved its write though the COMMIT failed. Re-review 3: the trigger test
      // below didn't catch that on PGlite, which blocks the event loop while it commits, so nothing could
      // arrive meanwhile. Here the driver holds that moment open and then fails, on both back ends.
      const real: PgDriver = backend.name === 'pglite' ? await pgliteDriver() : await nodePostgresDriver(pgUrl!);
      const failingCommit: PgDriver = {
        ...real,
        transaction: (fn, o) =>
          real.transaction(async (q) => {
            const out = await fn(q);
            if (out === 'fail at commit') {
              await sleep(150);
              throw new Error('COMMIT failed');
            }
            return out;
          }, o),
      };
      const s = await PostgresStore.open(failingCommit);
      open.push(s);
      await s.clearAll();
      let child: Promise<unknown> | undefined;
      await expect(
        s.transaction(async () => {
          await s.put('kv', { id: 'parent' });
          child = (async () => {
            await sleep(50); // The transaction is ending by now.
            await s.put('kv', { id: 'child' });
          })();
          child.catch(() => {});
          return 'fail at commit';
        }),
      ).rejects.toThrow('COMMIT failed');
      await expect(child).rejects.toBeInstanceOf(TransactionEndedError);
      expect(await s.list('kv')).toEqual([]);
    });

  if (backend.name === 'postgres')
    it('work left over from a transaction cannot use it while COMMIT is in flight, nor escape a failed COMMIT', async () => {
      // Astra (PR #53 re-review 2): the transaction counted as committed before COMMIT was sent, so a child
      // arriving during a COMMIT that then failed saved its write on its own.
      const raw = store as unknown as { reader(): { query(sql: string): Promise<unknown> } };
      const exec = (sql: string) => store.transaction(() => raw.reader().query(sql));
      await exec(`CREATE OR REPLACE FUNCTION concord_test_fail_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE t timestamptz := clock_timestamp();
        BEGIN
          WHILE clock_timestamp() < t + interval '300 milliseconds' LOOP END LOOP;
          RAISE EXCEPTION 'refused at commit';
        END $$`);
      await exec(`CREATE CONSTRAINT TRIGGER concord_test_fail_at_commit AFTER INSERT ON docs DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW WHEN (NEW.id = 'fail-at-commit') EXECUTE FUNCTION concord_test_fail_at_commit()`);
      try {
        let child: Promise<unknown> | undefined;
        await expect(
          store.transaction(async () => {
            await store.put('kv', { id: 'fail-at-commit' });
            child = (async () => {
              await sleep(100); // COMMIT is running its 0.3 s trigger by now.
              await store.put('kv', { id: 'child' });
            })();
            child.catch(() => {}); // Checked below, once the transaction has failed.
          }),
        ).rejects.toThrow('refused at commit');
        await expect(child).rejects.toBeInstanceOf(TransactionEndedError);
        expect(await store.list('kv')).toEqual([]);
      } finally {
        await exec('DROP TRIGGER IF EXISTS concord_test_fail_at_commit ON docs');
      }
    });

  if (!backend.multiConnection || backend.name === 'sqlite')
    describe('one connection, shared in arrival order', () => {
      it('serves transactions in arrival order', async () => {
        // The hand-off that stops a newcomer overtaking is checked directly on FifoLock below; this checks the
        // store goes through it for transactions arriving while others finish.
        const order: number[] = [];
        const all: Promise<unknown>[] = [];
        for (let i = 0; i < 60; i++) {
          all.push(
            store.transaction(async () => {
              order.push(i);
              await sleep(0);
            }),
          );
          await new Promise((r) => setImmediate(r));
        }
        await Promise.all(all);
        expect(order).toEqual([...order].sort((x, y) => x - y));
      });

      it('a read outside the transaction holding the connection waits at most about 5 s, and withoutWaiting not at all', async () => {
        // Astra (PR #53 re-review 2): on PGlite, reads and writes waited without limit, withoutWaiting included.
        const g = gate();
        const held = gate();
        const tx = store.transaction(async () => {
          await store.put('kv', { id: 'held' });
          held.open();
          await g.opened;
        });
        await held.opened;
        let started = Date.now();
        await expect(store.detached(() => store.withoutWaiting(() => store.get('kv', 'held')))).rejects.toBeInstanceOf(StoreBusyError);
        await expect(store.detached(() => store.withoutWaiting(() => store.put('kv', { id: 'x' })))).rejects.toBeInstanceOf(StoreBusyError);
        expect(Date.now() - started).toBeLessThan(1000);
        started = Date.now();
        await expect(store.detached(() => store.get('kv', 'held'))).rejects.toBeInstanceOf(StoreBusyError);
        expect(Date.now() - started).toBeGreaterThan(4000);
        g.open();
        await tx;
        expect(await store.get('kv', 'held')).toEqual({ id: 'held' });
      });
    });

  it('detached work inside withoutWaiting still gives up at once rather than waiting', async () => {
    // Astra (PR #53 re-review 3): detached() reset the surrounding withoutWaiting, so the call waited behind
    // the held lock and then succeeded.
    const g = gate();
    const held = gate();
    const tx = store.transaction(async () => {
      await store.put('kv', { id: 'held' });
      held.open();
      await g.opened;
    });
    await held.opened;
    try {
      const started = Date.now();
      await expect(store.withoutWaiting(() => store.detached(() => store.put('kv', { id: 'x' })))).rejects.toBeInstanceOf(StoreBusyError);
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      g.open();
      await tx;
    }
    expect(await store.get('kv', 'x')).toBeUndefined();
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

    it('a writer gives up with StoreBusyError after about 5 s if another connection keeps the lock', async () => {
      // Astra (PR #53 review): a Postgres writer waited without limit, unlike SQLite's busy timeout.
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
      await expect(other.put('kv', { id: 'blocked' })).rejects.toBeInstanceOf(StoreBusyError);
      expect(Date.now() - started).toBeGreaterThan(4000);
      expect(Date.now() - started).toBeLessThan(9000);
      g.open();
      await tx;
      await other.put('kv', { id: 'later' });
    });

    if (backend.name === 'postgres')
      it('survives the server dropping its connections, idle or mid-transaction', async () => {
        // Astra (PR #53 review): with no 'error' listener on the pool or its clients, a terminated backend
        // crashed the process.
        const kill = () =>
          withAdmin((c) =>
            c.query(
              "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND application_name = '' AND state IS NOT NULL",
            ),
          );
        await store.put('kv', { id: 'before' }); // Leaves an idle connection in the pool.
        const inTx = store.transaction(async () => {
          await store.put('kv', { id: 'doomed' });
          await sleep(100);
          await store.put('kv', { id: 'doomed-2' });
        });
        const outcome = inTx.then(
          () => 'committed',
          () => 'failed',
        ); // Handled before the kill, so its rejection is never unhandled (re-review 3: a full run exited 1).
        await sleep(30);
        await kill();
        expect(await outcome).toBe('failed');
        await sleep(50);
        await store.put('kv', { id: 'after' });
        expect((await store.list<Doc>('kv')).map((d) => d.id)).toEqual(['before', 'after']);
      });

    if (backend.name === 'postgres') {
      it('a table lock held elsewhere makes reads and writes give up: after about 5 s, or at once withoutWaiting', async () => {
        // Astra (PR #53 re-review 2): reads outside a transaction had no lock timeout, and a table lock's
        // refusal surfaced as a raw 55P03 rather than StoreBusyError.
        await store.put('kv', { id: 'x' });
        const g = gate();
        const held = gate();
        const locker = withAdmin(async (c) => {
          await c.query('BEGIN');
          await c.query('LOCK TABLE docs IN ACCESS EXCLUSIVE MODE');
          held.open();
          await g.opened;
          await c.query('ROLLBACK');
        });
        await held.opened;
        try {
          let started = Date.now();
          await expect(store.withoutWaiting(() => store.get('kv', 'x'))).rejects.toBeInstanceOf(StoreBusyError);
          await expect(store.withoutWaiting(() => store.put('kv', { id: 'y' }))).rejects.toBeInstanceOf(StoreBusyError);
          expect(Date.now() - started).toBeLessThan(2000);
          started = Date.now();
          await expect(store.get('kv', 'x')).rejects.toBeInstanceOf(StoreBusyError);
          expect(Date.now() - started).toBeGreaterThan(4000);
          expect(Date.now() - started).toBeLessThan(9000);
        } finally {
          g.open();
          await locker;
        }
        expect(await store.get('kv', 'x')).toEqual({ id: 'x' });
      });

      it('with every pooled connection in use, withoutWaiting gives up at once, even when two arrive together', async () => {
        // Astra (PR #53 re-review 2): both of two simultaneous withoutWaiting calls saw the one idle connection,
        // so the second queued for it instead of giving up.
        const small = await connect({ kind: 'postgres', url: pgUrl!, max: 1 });
        await small.get('kv', 'warm'); // Leaves one idle connection.
        const g = gate();
        const first = small.withoutWaiting(() =>
          small.transaction(async () => {
            await small.put('kv', { id: 'first' });
            await g.opened;
          }),
        );
        try {
          const started = Date.now();
          const second = small.withoutWaiting(() => small.get('kv', 'first'));
          await expect(second).rejects.toBeInstanceOf(StoreBusyError);
          expect(Date.now() - started).toBeLessThan(150);
          await expect(small.withoutWaiting(() => small.put('kv', { id: 'third' }))).rejects.toBeInstanceOf(StoreBusyError);
        } finally {
          g.open(); // Even if an expectation failed, so the writer lock doesn't stay held for later tests.
          await first;
        }
        expect(await small.get('kv', 'first')).toEqual({ id: 'first' });
      });

      it('opening the store gives up with StoreBusyError if a table lock blocks creating the schema', async () => {
        // Astra (PR #53 re-review 3): schema statements surfaced a table lock's refusal as a raw 55P03.
        const g = gate();
        const held = gate();
        const locker = withAdmin(async (c) => {
          await c.query('BEGIN');
          await c.query('LOCK TABLE docs IN ACCESS EXCLUSIVE MODE');
          held.open();
          await g.opened;
          await c.query('ROLLBACK');
        });
        await held.opened;
        try {
          await expect(openStore(opts)).rejects.toBeInstanceOf(StoreBusyError);
        } finally {
          g.open();
          await locker;
        }
      });

      it('opening the store gives up after about 5 s if another connection keeps the writer lock', async () => {
        // Astra (PR #53 re-review 2): creating the schema waited for the writer lock without limit.
        const g = gate();
        const held = gate();
        const tx = store.transaction(async () => {
          held.open();
          await g.opened;
        });
        await held.opened;
        try {
          const started = Date.now();
          await expect(openStore(opts)).rejects.toBeInstanceOf(StoreBusyError);
          expect(Date.now() - started).toBeGreaterThan(4000);
        } finally {
          g.open();
          await tx;
        }
      });
    }

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

describe('FifoLock (the one connection of SQLite and PGlite)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('hands itself to the next waiter on release, so a newcomer arriving at that moment cannot overtake', async () => {
    // Astra (PR #53 review): SQLite's gate freed the connection and woke its waiters, so a transaction arriving
    // in that moment took it first; 100 newcomers overtook one waiter. (Re-review 2: the store-level test
    // passed without the fix, as nothing arrived in that moment; this checks the moment itself.)
    const lock = new FifoLock();
    const order: string[] = [];
    expect(lock.acquire()).toBeUndefined();
    const waiter = lock.acquire()!.then(() => order.push('waiter'));
    lock.release();
    const newcomer = lock.acquire(); // Same synchronous step as the release.
    expect(newcomer).toBeInstanceOf(Promise);
    expect(() => lock.acquire(true)).toThrow(StoreBusyError);
    const late = newcomer!.then(() => order.push('newcomer'));
    await waiter;
    lock.release();
    await late;
    lock.release();
    expect(order).toEqual(['waiter', 'newcomer']);
    expect(lock.busy).toBe(false);
  });

  it('a waiter gives up with StoreBusyError after 5 s, and leaves the queue', async () => {
    vi.useFakeTimers();
    const lock = new FifoLock();
    lock.acquire();
    const outcome = lock.acquire()!.then(
      () => 'granted',
      (e: unknown) => (e instanceof StoreBusyError ? 'busy' : 'other'),
    );
    await vi.advanceTimersByTimeAsync(4999);
    expect(await Promise.race([outcome, 'still waiting'])).toBe('still waiting');
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe('busy');
    lock.release();
    expect(lock.busy).toBe(false);
    expect(lock.acquire()).toBeUndefined();
  });
});
