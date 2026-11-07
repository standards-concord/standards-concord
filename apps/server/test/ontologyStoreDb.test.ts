import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OntologyGraph } from '@concord/core';
import type { OntologyProject } from '@concord/shared';
import { closeDb, get, openDb, put } from '../src/db.js';
import { getRef, readCommit } from '../src/services/gitdb.js';
import { gitStore } from '../src/services/ontologyStore.js';
import { dbStore } from '../src/services/ontologyStoreDb.js';

/**
 * The database-backed ontology store: the guarantees the git-backed one gives, kept without a repository.
 *
 * With TEST_DATABASE_URL (CI's Postgres service) the store is a real Postgres pool, so the racing calls below run
 * on separate connections, as two function instances would; otherwise on the default store.
 */

const pgUrl = process.env.TEST_DATABASE_URL;
beforeAll(async () => {
  if (pgUrl) await openDb({ kind: 'postgres', url: pgUrl, max: 4 });
});
afterAll(async () => {
  if (pgUrl) await closeDb();
});

let n = 0;
const project = () => {
  n++;
  const slug = `dbstore-${n}-${Date.now()}`;
  return { id: slug, slug, title: "A vocabulary" } as OntologyProject;
};
const ttl = (label: string) => `<urn:x:thing> <http://www.w3.org/2000/01/rdf-schema#label> "${label}" .\n`;
const graph = (label: string) => OntologyGraph.fromTurtle(ttl(label));

describe('database-backed ontology store', () => {
  it('serves a release as it is now, even when the same version is released again with other content', async () => {
    // Step 5: the release graph cache was keyed by name only, so on Vercel an instance that cached a demo release
    // kept serving it after another instance reset the demo and released that version again.
    const p = project();
    await dbStore.init(p, ttl('v0'), '# Readme\n');
    await dbStore.writeRelease(p, '1.0.0', await graph('first'), {}, 'First', { name: 'Steward' });
    expect(await (await dbStore.at(p, '1.0.0')).toTurtle()).toContain('"first"');
    await dbStore.writeRelease(p, '1.0.0', await graph('again'), {}, 'Again', { name: 'Steward' });
    expect(await (await dbStore.at(p, '1.0.0')).toTurtle()).toContain('"again"');
    await expect(dbStore.at(p, '9.9.9')).rejects.toMatchObject({ status: 404 });
  });

  // Review r1 of step 5: the cache key named one head's blob, but the content was read by name through another head
  // lookup, so a release reset in between could cache other bytes under that key. The keyed blob itself is read.
  it('caches a release under the blob it read, even if the version is released again in between', async () => {
    const p = project();
    await dbStore.init(p, ttl('v0'), '# Readme\n');
    await dbStore.writeRelease(p, '1.0.0', await graph('first'), {}, 'First', { name: 'Steward' });
    const real = dbStore.head.bind(dbStore);
    // Another instance releases 1.0.0 again just after this one looked up the release's blob.
    dbStore.head = async (...args) => {
      const head = await real(...args);
      dbStore.head = real;
      await dbStore.writeRelease(p, '1.0.0', await graph('again'), {}, 'Again', { name: 'Steward' });
      return head;
    };
    try {
      // The content is the blob its cache key names (the first release), never the newer bytes under the old key.
      expect(await (await dbStore.at(p, '1.0.0')).toTurtle()).toContain('"first"');
      expect(await (await dbStore.at(p, '1.0.0')).toTurtle()).toContain('"again"');
    } finally {
      dbStore.head = real;
    }
  });

  it('lets one of two writers that read the same draft commit, and rolls back the other’s bookkeeping', async () => {
    const p = project();
    const base = await dbStore.init(p, ttl('v0'), '# Readme\n');
    const write = async (label: string) =>
      await dbStore.commitWorking(p, await graph(label), label, { name: label }, base, async (commit) => {
        await put('kv', { id: `${p.slug}:recorded:${label}`, commit });
      });
    const results = await Promise.allSettled([write('left'), write('right')]);
    const won = results.findIndex((r) => r.status === 'fulfilled');
    expect(won).toBeGreaterThanOrEqual(0);
    const lost = results[1 - won] as PromiseRejectedResult;
    expect(lost.status).toBe('rejected');
    expect(lost.reason).toMatchObject({ status: 409 });
    const [winner, loser] = won === 0 ? ['left', 'right'] : ['right', 'left'];
    expect(await dbStore.head(p)).toBe((results[won] as PromiseFulfilledResult<string>).value);
    expect(await dbStore.readWorkingText(p)).toContain(`"${winner}"`);
    expect(await get('kv', `${p.slug}:recorded:${winner}`)).toBeDefined();
    expect(await get('kv', `${p.slug}:recorded:${loser}`)).toBeUndefined();
  });

  it('changes nothing when the caller’s own check refuses, even with nothing to commit', async () => {
    const p = project();
    const base = await dbStore.init(p, ttl('v0'), '# Readme\n');
    const refuse = async () => {
      await put('kv', { id: `${p.slug}:half-written` });
      throw Object.assign(new Error('no longer approved'), { status: 409 });
    };
    await expect(dbStore.commitWorking(p, await graph('v1'), 'v1', { name: 'A' }, base, refuse)).rejects.toThrow('no longer approved');
    // Same draft (commit === base): the check still runs.
    await expect(dbStore.advanceTo(p, base, base, refuse)).rejects.toThrow('no longer approved');
    expect(await dbStore.head(p)).toBe(base);
    expect(await get('kv', `${p.slug}:half-written`)).toBeUndefined();
    // And the draft only moves forward.
    const next = await dbStore.commitWorking(p, await graph('v1'), 'v1', { name: 'A' });
    await expect(dbStore.advanceTo(p, next, base)).rejects.toThrow('does not build on');
  });

  it('gives a fork name to one creator only, and moves a fork’s branch with its record', async () => {
    const p = project();
    const base = await dbStore.init(p, ttl('v0'), '# Readme\n');
    const create = async (label: string) =>
      await dbStore.commitFork(p, 'shared-name', await graph(label), `Fork as ${label}`, { name: label }, { parent: base, create: true }, async (commit) => {
        await put('kv', { id: `${p.slug}:fork:${label}`, commit });
      });
    const results = await Promise.allSettled([create('one'), create('two')]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const head = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<string>).value;
    expect(await getRef(p.slug, 'refs/heads/forks/shared-name')).toBe(head);
    expect(await dbStore.hasForkBranch(p, 'shared-name')).toBe(true);
    expect(await dbStore.hasForkBranch(p, 'other-name')).toBe(false);

    // An edit on a stale head is refused before its record runs; one on the head moves the branch.
    let recorded = false;
    await expect(
      dbStore.commitFork(p, 'shared-name', await graph('stale'), 'stale', { name: 'S' }, { parent: base }, async () => {
        recorded = true;
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(recorded).toBe(false);
    const edit = await dbStore.commitFork(p, 'shared-name', await graph('edited'), 'edit', { name: 'E' }, { parent: head }, async () => undefined);
    expect(await getRef(p.slug, 'refs/heads/forks/shared-name')).toBe(edit);
    // A record that refuses leaves the branch where it was.
    await expect(
      dbStore.commitFork(p, 'shared-name', await graph('refused'), 'refused', { name: 'R' }, { parent: edit }, async () => {
        throw new Error('fork moved on');
      }),
    ).rejects.toThrow('fork moved on');
    expect(await getRef(p.slug, 'refs/heads/forks/shared-name')).toBe(edit);
  });

  it('answers history questions as the git-backed store does', async () => {
    // The same steps on both stores; ids differ (commit times), but what each method reports must not.
    const run = async (store: typeof dbStore | typeof gitStore) => {
      const p = project();
      await store.init(p, ttl('v0'), '# Readme\n');
      const upstream0 = await store.head(p);
      await store.commitWorking(p, await graph('v1'), 'First edit', { name: 'Ana', email: 'ana@example.org' });
      // Nothing changed: no commit.
      const same = await store.commitWorking(p, await graph('v1'), 'No-op', { name: 'Ana' });
      expect(same).toBe(await store.head(p));
      await store.writeRelease(p, '1.0.0', await graph('v1'), { 'index.html': '<h1>1.0.0</h1>' }, 'First release', { name: 'Steward' });
      const fork = await store.commitFork(p, 'f', await graph('fork'), 'Fork it', { name: 'Dev' }, { parent: await store.head(p), create: true }, async () => undefined);
      const forked = await store.commitFork(p, 'f', await graph('fork 2'), 'Fork edit', { name: 'Dev' }, { parent: fork }, async () => undefined);
      const second = await store.commitWorking(p, await graph('v2'), 'Second edit', { name: 'Ben' });
      // A fork synced with upstream: two parents, the fork's own first.
      const synced = await store.commitFork(p, 'f', await graph('fork 3'), 'Sync with upstream', { name: 'Dev' }, { parent: forked, extraParents: [await store.head(p)] }, async () => undefined);
      await store.updateReleaseFiles(p, { '1.0.0': { 'index.html': '<h1>1.0.0 (superseded)</h1>', 'notes.md': 'n' } }, 'Refresh release pages');
      await store.updateRepoFile(p, 'CHANGELOG.md', '# Changelog\n\nRewritten.\n', 'Rewrite the changelog');
      await store.writeRelease(p, '1.1.0', await graph('v2'), {}, 'Second release', { name: 'Steward' });
      return {
        log: (await store.log(p)).map(({ author, subject, date }) => ({ author, subject, date: date.slice(19) })),
        limited: (await store.log(p, 2)).map((c) => c.subject),
        forkLog: (await store.forkLog(p, synced)).map((c) => c.subject),
        behind: await store.commitsSince(p, upstream0),
        versions: await store.versions(p),
        page: await store.readReleaseFile(p, '1.0.0', 'index.html'),
        notes: await store.readReleaseFile(p, '1.0.0', 'notes.md'),
        missing: await store.readReleaseFile(p, '9.9.9', 'index.html'),
        changelog: (await store.readReleaseFile(p, '1.1.0', 'ontology.ttl'))?.includes('"v2"'),
        released: (await (await store.at(p, '1.0.0')).toTurtle()).includes('"v1"'),
        working: (await store.readWorkingText(p)).includes('"v2"'),
        // A merged change request's diff: its commit against the commit it was made on (the first parent).
        second: await store.commitOf(p, second).then(async (c) => ({ subject: c.subject, parentHasV1: (await store.readAt(p, c.parent!)).includes('"v1"') })),
        syncedOnFork: (await store.commitOf(p, synced)).parent === forked,
        first: await store.commitOf(p, upstream0),
        synced,
      };
    };
    const { synced, ...fromDb } = await run(dbStore);
    const { synced: _, ...fromGit } = await run(gitStore);
    expect(fromDb).toEqual(fromGit);
    expect(fromDb.versions).toEqual(['1.0.0', '1.1.0']);
    expect(fromDb.forkLog).toEqual(['Sync with upstream', 'Fork edit', 'Fork it']);
    expect(fromDb.second).toEqual({ subject: 'Second edit', parentHasV1: true });
    expect(fromDb.syncedOnFork).toBe(true);
    expect(fromDb.first).toEqual({ parent: undefined, subject: 'Create A vocabulary' });
    expect((await readCommit(synced)).parents).toHaveLength(2);
  });

  it('empties every repository with a reset, in the same transaction as the rest', async () => {
    const p = project();
    await dbStore.init(p, ttl('v0'), '# Readme\n');
    await dbStore.wipe(async () => {
      const { clearAll } = await import('../src/db.js');
      await clearAll();
    });
    await expect(dbStore.head(p)).rejects.toMatchObject({ status: 404 });
  });
});
