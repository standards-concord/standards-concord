import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OntologyGraph } from '@concord/core';
import type { OntologyProject } from '@concord/shared';
import { config } from '../src/config.js';
import { closeDb, get, openDb, put, rawStore, readOnlyStore, ReadOnlyError, remove } from '../src/db.js';
import { copyDatabase, exportHistories, exportPrivateFiles, IMPORT_MARKER, importHistories, importPrivateFiles, importVerified, verifyImport } from '../src/migrate/index.js';
import { mirrorToPod } from '../src/services/alpha.js';
import { setRef } from '../src/services/gitdb.js';
import { solid } from '../src/services/solid.js';
import type { StoredRow } from '../src/store/types.js';
import { readCommit } from '../src/services/gitdb.js';
import { gitStore } from '../src/services/ontologyStore.js';
import { dbStore } from '../src/services/ontologyStoreDb.js';
import { openStore, type DocStore } from '../src/store/index.js';

/**
 * The cutover tool (src/migrate): a VM's database (SQLite) and repositories, made by the git store, copied into
 * Postgres (PGlite here) for the database store, checked, and exported back. The source is built in this file's own
 * data directory by the git store itself; then the database this file uses is swapped for an empty Postgres.
 */

const ttl = (label: string) => `<urn:x:thing> <http://www.w3.org/2000/01/rdf-schema#label> "${label}" .\n`;
const graph = (label: string) => OntologyGraph.fromTurtle(ttl(label));
const p = { id: `mig-${Date.now()}`, slug: `mig-${Date.now()}`, title: 'Migrated vocabulary' } as OntologyProject;
let source: DocStore;
let synced: string;
let firstRelease: string;

beforeAll(async () => {
  await openDb();
  // A history as the VM has it: drafts, releases, a fork synced with upstream, and the records naming them.
  await gitStore.init(p, ttl('v0'), '# Readme\n');
  await put('ontologies', p);
  await gitStore.commitWorking(p, await graph('v1'), 'First edit', { name: 'Ana', email: 'ana@example.org' });
  await gitStore.writeRelease(p, '1.0.0', await graph('v1'), { 'index.html': '<h1>1.0.0</h1>' }, 'First release', { name: 'Steward' });
  firstRelease = await gitStore.head(p);
  const fork = await gitStore.commitFork(p, 'f', await graph('fork'), 'Fork it', { name: 'Dev' }, { parent: firstRelease, create: true }, async () => undefined);
  await gitStore.commitWorking(p, await graph('v2'), 'Second edit', { name: 'Ben' });
  synced = await gitStore.commitFork(p, 'f', await graph('fork 2'), 'Sync with upstream', { name: 'Dev' }, { parent: fork, extraParents: [await gitStore.head(p)] }, async () => undefined);
  await put('forks', { id: `${p.id}-f`, slug: 'f', ontologyId: p.id, head: synced, baseCommit: firstRelease }, p.id);
  await put('releases', { id: `${p.id}-r1`, ontologyId: p.id, version: '1.0.0', status: 'published', commit: firstRelease }, p.id);
  await put('changeRequests', { id: `${p.id}-cr`, ontologyId: p.id, baseCommit: firstRelease, mergedCommit: await gitStore.head(p) }, p.id);
  // Swap this file's database for an empty Postgres; the SQLite file becomes the source.
  await closeDb();
  source = await openStore({ kind: 'sqlite', file: path.join(config.dataDir, 'concord.sqlite') });
  await openDb({ kind: 'pglite' });
});
afterAll(async () => {
  await source?.close();
  await closeDb();
});

describe('moving a database to the database-backed ontology store', () => {
  it('copies every document exactly, imports every history, and verifies it against the source', async () => {
    const copied = await copyDatabase(source);
    expect(copied.rows).toBe((await source.rows()).length);
    const imported = await importHistories(config.dataDir);
    expect(imported.notes.filter((n) => n.startsWith(p.slug))).toEqual([]);
    const marker = await verifyImport(source, config.dataDir);
    expect(marker).toMatchObject({ id: IMPORT_MARKER, ontologies: (await source.rows()).filter((r) => r.collection === 'ontologies').length });
    expect(await importVerified()).toBe(true);
    // The database store now answers as the git store does from the repository.
    expect(await dbStore.head(p)).toBe(await gitStore.head(p));
    expect((await dbStore.log(p)).map((c) => c.subject)).toEqual((await gitStore.log(p)).map((c) => c.subject));
    expect(await dbStore.forkLog(p, synced)).toEqual(await gitStore.forkLog(p, synced));
    expect(await dbStore.versions(p)).toEqual(await gitStore.versions(p));
    expect(await dbStore.readWorkingText(p)).toBe(await gitStore.readWorkingText(p));
    expect(await dbStore.readReleaseFile(p, '1.0.0', 'index.html')).toBe('<h1>1.0.0</h1>');
    expect(await dbStore.hasForkBranch(p, 'f')).toBe(true);
    expect((await readCommit(synced)).parents).toHaveLength(2);
  });

  it('can run again: documents are replaced, objects added once, and it still verifies', async () => {
    await copyDatabase(source);
    await importHistories(config.dataDir);
    await expect(verifyImport(source, config.dataDir)).resolves.toMatchObject({ id: IMPORT_MARKER });
  });

  // On Vercel there is no data directory: the private files the VM kept for accounts with no pod (step 5) move into
  // the database with everything else, and back again for a rollback.
  it('moves the private files kept on disk into the database, checks them, and writes them back', async () => {
    const user = `mig-user-${Date.now()}`;
    const dir = path.join(config.dataDir, 'private', user);
    fs.mkdirSync(path.join(dir, 'concord', 'use-cases'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'concord', 'use-cases', 'a.ttl'), '<urn:a> <urn:b> "private" .\n');
    fs.writeFileSync(path.join(dir, 'binary'), Buffer.from([0, 255, 1, 254]));
    fs.writeFileSync(path.join(dir, '.binary.concord-tmp'), 'half written'); // a crash's leftover, not data
    const back = fs.mkdtempSync(path.join(tmpdir(), 'concord-private-'));
    try {
      expect((await importPrivateFiles(config.dataDir)).files).toBe(2);
      expect(await get('privateFiles', `${user}/concord/use-cases/a.ttl`)).toMatchObject({ data: Buffer.from('<urn:a> <urn:b> "private" .\n').toString('base64') });
      await expect(verifyImport(source, config.dataDir)).resolves.toMatchObject({ id: IMPORT_MARKER });

      // A file that changed on disk since (or a row that differs) is caught.
      fs.writeFileSync(path.join(dir, 'binary'), 'changed');
      await expect(verifyImport(source, config.dataDir)).rejects.toThrow(`private file ${user}/binary wasn't imported as it is on disk`);
      fs.writeFileSync(path.join(dir, 'binary'), Buffer.from([0, 255, 1, 254]));

      await exportPrivateFiles(back);
      expect(fs.readFileSync(path.join(back, 'private', user, 'binary'))).toEqual(Buffer.from([0, 255, 1, 254]));
      expect(fs.statSync(path.join(back, 'private', user, 'concord', 'use-cases', 'a.ttl')).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(back, { recursive: true, force: true });
      await importPrivateFiles(config.dataDir); // and the rows go with them
    }
    await expect(verifyImport(source, config.dataDir)).resolves.toMatchObject({ id: IMPORT_MARKER });
  });

  // Follow-up to step 5e: on the VM every account has a pod on the VM's own Solid server, and Concord keeps its private
  // data there, not in the data directory. The import used to take only the data directory's files, so at cutover
  // that data (use cases' private parts, transcripts, testing records) would have been left behind.
  it('takes what Concord kept in the pods it made, from the Solid server’s data directory, and refuses without it', async () => {
    const user = `mig-pod-${Date.now()}`;
    const podRow: StoredRow = {
      collection: 'kv',
      id: `pod:${user}`,
      data: JSON.stringify({ id: `pod:${user}`, podUrl: `https://pods.example.org/alice-${user.slice(-6)}/`, webId: 'https://pods.example.org/alice/profile/card#me', clientId: 'c', clientSecret: 's' }),
      createdAt: new Date().toISOString(),
    };
    await source.putRows([podRow]);
    const pods = fs.mkdtempSync(path.join(tmpdir(), 'concord-pods-'));
    const kept = path.join(pods, `alice-${user.slice(-6)}`, 'concord');
    const onDisk = path.join(config.dataDir, 'private', user);
    try {
      await copyDatabase(source);
      // As the Community Solid Server's file backend keeps them: a name that doesn't give the type gets `$.<ext>`.
      fs.mkdirSync(path.join(kept, 'interviews'), { recursive: true });
      fs.mkdirSync(path.join(kept, 'alpha'), { recursive: true });
      fs.writeFileSync(path.join(kept, 'interviews', 'i1.ttl'), '<urn:i> <urn:said> "in the pod" .\n');
      fs.writeFileSync(path.join(kept, 'interviews', 'notes$.txt'), 'plain words');
      fs.writeFileSync(path.join(kept, 'alpha', 'testing.jsonld'), '{"revision":3}');
      // Access control and metadata aren't data.
      for (const aux of ['.acl', '.meta', 'alpha/testing.jsonld.meta', 'interviews/.acl', 'interviews/i1.ttl.acl']) fs.writeFileSync(path.join(kept, aux), 'aux');
      // A file kept on disk for the same path (a pod write that once failed) loses to the pod's, which was read first.
      fs.mkdirSync(path.join(onDisk, 'interviews'), { recursive: true });
      fs.writeFileSync(path.join(onDisk, 'interviews', 'i1.ttl'), 'older, on disk');

      await expect(importPrivateFiles(config.dataDir)).rejects.toThrow(/1 account\(s\) have pods on the VM's Solid server: give its data directory \(--pods\)/);
      await expect(verifyImport(source, config.dataDir)).rejects.toThrow(/--pods/);
      expect((await importPrivateFiles(config.dataDir, pods)).files).toBe(3);
      const row = async (rel: string) => Buffer.from(((await get<{ data: string }>('privateFiles', `${user}/${rel}`))?.data ?? ''), 'base64').toString('utf8');
      expect(await row('interviews/i1.ttl')).toBe('<urn:i> <urn:said> "in the pod" .\n');
      expect(await row('interviews/notes')).toBe('plain words');
      expect(await row('alpha/testing.jsonld')).toBe('{"revision":3}');
      await expect(verifyImport(source, config.dataDir, pods)).resolves.toMatchObject({ id: IMPORT_MARKER });

      // A pod file that changed since is caught, and so is a pod the directory doesn't have.
      fs.writeFileSync(path.join(kept, 'alpha', 'testing.jsonld'), '{"revision":4}');
      await expect(verifyImport(source, config.dataDir, pods)).rejects.toThrow(`private file ${user}/alpha/testing.jsonld wasn't imported as it is on disk`);
      const elsewhere = fs.mkdtempSync(path.join(tmpdir(), 'concord-pods-'));
      await expect(importPrivateFiles(config.dataDir, elsewhere)).rejects.toThrow(`pod:${user}: its pod https://pods.example.org/alice-${user.slice(-6)}/ isn't in`);
      fs.rmSync(elsewhere, { recursive: true, force: true });
    } finally {
      fs.rmSync(pods, { recursive: true, force: true });
      fs.rmSync(onDisk, { recursive: true, force: true });
      await source.remove('kv', podRow.id);
      await (await rawStore()).remove('kv', podRow.id);
      await importPrivateFiles(config.dataDir);
    }
    await expect(verifyImport(source, config.dataDir)).resolves.toMatchObject({ id: IMPORT_MARKER });
  });

  it('refuses an import with a missing object, naming it and what needs it', async () => {
    const tree = (await readCommit(firstRelease)).tree;
    const saved = await get<object>('gitObjects', tree);
    await remove('gitObjects', tree);
    try {
      await expect(verifyImport(source, config.dataDir)).rejects.toThrow(new RegExp(`${p.slug}: object ${tree} is missing .*release 1\\.0\\.0`));
    } finally {
      await put('gitObjects', { ...saved!, id: tree });
    }
  });

  it('refuses a copy whose documents differ from the source', async () => {
    const r = (await get<{ id: string; title: string }>('ontologies', p.id))!;
    await put('ontologies', { ...r, title: 'Changed after the copy' });
    try {
      await expect(verifyImport(source, config.dataDir)).rejects.toThrow(`ontologies ${p.id} doesn't match its source`);
    } finally {
      await copyDatabase(source);
    }
  });

  it('exports the histories back into git repositories the git store can use', async () => {
    const out = fs.mkdtempSync(path.join(tmpdir(), 'concord-export-'));
    try {
      await exportHistories(out);
      const git = (...args: string[]) => execFileSync('git', ['--git-dir', path.join(out, 'ontologies', p.slug, '.git'), ...args]).toString().trim();
      expect(git('rev-parse', 'refs/concord/draft')).toBe(await dbStore.head(p));
      expect(git('rev-parse', 'refs/heads/main')).toBe(await dbStore.head(p));
      expect(git('rev-parse', 'refs/heads/forks/f')).toBe(synced);
      const original = execFileSync('git', ['-C', path.join(config.dataDir, 'ontologies', p.slug), 'log', '--format=%H', 'HEAD']).toString();
      expect(git('log', '--format=%H', 'main')).toBe(original.trim());
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });

  // Review r1 of #118: each of these used to pass verification (or be lost on export).
  const repo = () => path.join(config.dataDir, 'ontologies', p.slug);
  const inRepo = (...args: string[]) => execFileSync('git', ['-C', repo(), '-c', 'user.name=Tester', '-c', 'user.email=tester@example.org', ...args]).toString().trim();
  const recopy = async () => {
    await copyDatabase(source);
    await importHistories(config.dataDir);
    return verifyImport(source, config.dataDir);
  };

  it('never takes a verified marker from the source, and forgets its own before verifying again', async () => {
    // An exported database carried its marker, so copying it back counted as verified before anything was checked.
    await source.put('kv', { id: IMPORT_MARKER, verifiedAt: '2026-01-01T00:00:00Z', ontologies: 1, objects: 1, notes: [] });
    try {
      await copyDatabase(source);
      expect(await importVerified()).toBe(false);
    } finally {
      await source.remove('kv', IMPORT_MARKER);
    }
    await recopy();
    // A verification that fails leaves no marker behind, not the last one.
    const r = (await get<{ id: string; title: string }>('ontologies', p.id))!;
    await put('ontologies', { ...r, title: 'Changed after the copy' });
    await expect(verifyImport(source, config.dataDir)).rejects.toThrow(`doesn't match its source`);
    expect(await get('kv', IMPORT_MARKER)).toBeUndefined();
    await recopy();
  });

  it('refuses a damaged copy of an object no record names, and an import mends it', async () => {
    // Only objects reachable from named commits were rehashed, so a damaged dangling object or tag passed.
    const blob = execFileSync('git', ['-C', repo(), 'hash-object', '-w', '--stdin'], { input: 'nothing points here\n' }).toString().trim();
    await importHistories(config.dataDir);
    await put('gitObjects', { id: blob, type: 'blob', data: Buffer.from('damaged').toString('base64') });
    await expect(verifyImport(source, config.dataDir)).rejects.toThrow(`blob ${blob} doesn't match its repository's copy`);
    await recopy();
  });

  it('refuses an ontology whose repository is missing', async () => {
    // A missing repository was only a note, so an ontology could be verified with no history at all.
    const aside = `${repo()}-aside`;
    fs.renameSync(repo(), aside);
    try {
      await expect(importHistories(config.dataDir)).rejects.toThrow(`${p.slug}: no repository`);
      await expect(verifyImport(source, config.dataDir)).rejects.toThrow(`${p.slug}: no repository`);
    } finally {
      fs.renameSync(aside, repo());
    }
    await recopy();
  });

  it('checks fork branches exactly: a moved, missing or left-over one is refused, and an import puts them right', async () => {
    // Any existing ref passed, a stale one survived re-copies, and export wrote it.
    await setRef(p.slug, 'refs/heads/forks/f', firstRelease);
    await expect(verifyImport(source, config.dataDir)).rejects.toThrow(`refs/heads/forks/f is at ${firstRelease}, not at ${synced}`);
    await setRef(p.slug, 'refs/heads/forks/f', synced);
    await setRef(p.slug, 'refs/heads/forks/ghost', synced);
    await expect(verifyImport(source, config.dataDir)).rejects.toThrow('refs/heads/forks/ghost has no fork record');
    await importHistories(config.dataDir);
    await expect(verifyImport(source, config.dataDir)).resolves.toMatchObject({ id: IMPORT_MARKER });
  });

  it('needs the history of every commit a change request names, including the head it was triaged at', async () => {
    const missing = 'ab'.repeat(20);
    await source.put('changeRequests', { id: `${p.id}-triaged`, ontologyId: p.id, triagedHead: missing }, p.id);
    try {
      await copyDatabase(source);
      await importHistories(config.dataDir);
      await expect(verifyImport(source, config.dataDir)).rejects.toThrow(new RegExp(`object ${missing} is missing .*\\(triaged\\)`));
    } finally {
      await source.remove('changeRequests', `${p.id}-triaged`);
    }
    await recopy();
  });

  it('refuses an extra document called ontology-import outside kv, and documents out of their source’s order', async () => {
    await put('users', { id: IMPORT_MARKER, name: 'Not the marker' });
    await expect(verifyImport(source, config.dataDir)).rejects.toThrow(`users ${IMPORT_MARKER}`);
    await remove('users', IMPORT_MARKER);
    // Two documents created in the same millisecond: list() orders them by insertion, so the copy must too.
    const at = '2026-02-02 02:02:02.002';
    const row = (id: string): StoredRow => ({ collection: 'kv', id, parent: null, data: JSON.stringify({ id }), createdAt: at });
    await source.putRows([row('order-a'), row('order-b')]);
    try {
      await recopy();
      const target = await rawStore();
      await target.remove('kv', 'order-a');
      await target.putRows([(await source.rows()).find((r) => r.id === 'order-a')!]);
      await expect(verifyImport(source, config.dataDir)).rejects.toThrow("aren't in their source's order, from kv order-a");
    } finally {
      await source.remove('kv', 'order-a');
      await source.remove('kv', 'order-b');
    }
    await recopy();
  });

  it('accepts the working draft an import takes from the repository when the source never recorded it', async () => {
    // The import adds this row for a repository older than the record, and verify then refused it as extra.
    const original = (await source.rows()).find((r) => r.collection === 'kv' && r.id === `draft-head:${p.slug}`)!;
    await source.remove('kv', original.id);
    try {
      const marker = await recopy();
      expect(marker.id).toBe(IMPORT_MARKER);
      expect(await get('kv', original.id)).toMatchObject({ sha: inRepo('rev-parse', 'HEAD') });
    } finally {
      await source.putRows([original]);
    }
    await recopy();
  });

  // Review r2 of #118: pins were left out of the refs recorded at import, so a commit only a pin held (a writer
  // that crashed before the draft took it) was lost from the export.
  it('keeps a commit that only a pin holds, and the pin, through import and export', async () => {
    const orphan = inRepo('commit-tree', (await readCommit(firstRelease)).tree, '-p', firstRelease, '-m', 'A writer crashed before drafting this');
    const pin = `refs/concord/commits/${orphan}-t${Date.now()}-writer-1`;
    inRepo('update-ref', pin, orphan);
    const out = fs.mkdtempSync(path.join(tmpdir(), 'concord-export-'));
    try {
      await recopy();
      await exportHistories(out);
      const git = (...args: string[]) => execFileSync('git', ['--git-dir', path.join(out, 'ontologies', p.slug, '.git'), ...args]).toString().trim();
      expect(git('rev-parse', pin)).toBe(orphan);
      expect(git('cat-file', '-t', orphan)).toBe('commit');
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
      inRepo('update-ref', '-d', pin);
    }
    await recopy();
  });

  it('exports the repository’s other tags and branches too, as they were', async () => {
    // Only fork branches and named commits were written back, so a rollback lost other refs and their history.
    inRepo('tag', '-a', 'workshop-notes', '-m', 'Notes from the workshop', firstRelease);
    inRepo('branch', 'experiment', firstRelease);
    const out = fs.mkdtempSync(path.join(tmpdir(), 'concord-export-'));
    try {
      await expect(verifyImport(source, config.dataDir)).rejects.toThrow('refs changed since the import');
      await recopy();
      await exportHistories(out);
      const git = (...args: string[]) => execFileSync('git', ['--git-dir', path.join(out, 'ontologies', p.slug, '.git'), ...args]).toString().trim();
      expect(git('rev-parse', 'refs/tags/workshop-notes')).toBe(inRepo('rev-parse', 'refs/tags/workshop-notes'));
      expect(git('rev-parse', 'refs/heads/experiment')).toBe(firstRelease);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
      inRepo('tag', '-d', 'workshop-notes');
      inRepo('branch', '-D', 'experiment');
    }
    await recopy();
  });

  it('serves an imported database only once its import is verified; an empty one is marked as having nothing to import', async () => {
    await remove('kv', IMPORT_MARKER);
    expect(await importVerified()).toBe(false);
    await verifyImport(source, config.dataDir);
    expect(await importVerified()).toBe(true);
    // A new, empty database (a fresh install) has nothing to import.
    await closeDb();
    await openDb({ kind: 'pglite' });
    expect(await importVerified()).toBe(true);
    expect(await get('kv', IMPORT_MARKER)).toMatchObject({ ontologies: 0, notes: ['nothing to import'] });
  });
});

describe('read-only while moving (CONCORD_READ_ONLY)', () => {
  it('refuses every write to the database but still reads', async () => {
    const store = readOnlyStore(await rawStore());
    await expect(store.put('kv', { id: 'read-only-test' })).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(store.remove('kv', IMPORT_MARKER)).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(store.putRows([])).rejects.toBeInstanceOf(ReadOnlyError);
    expect(await store.get('kv', IMPORT_MARKER)).toBeDefined();
    expect(await store.transaction(async () => await store.get('kv', IMPORT_MARKER))).toBeDefined();
  });

  // Review r1 of #118: GETs could still write elsewhere than the database (a tester's record mirrored to their
  // pod, pins pruned and refs moved in the repositories) before anything refused.
  it('writes nothing outside the database either: no pod or private files, no repository changes', async () => {
    (config as { readOnly: boolean }).readOnly = true;
    try {
      const userId = `read-only-${Date.now()}`;
      await expect(solid.write(userId, 'concord/test.ttl', '<urn:a> <urn:b> <urn:c> .')).rejects.toBeInstanceOf(ReadOnlyError);
      await mirrorToPod({ id: userId, name: 'Reader' } as never);
      expect(fs.existsSync(path.join(config.dataDir, 'private', userId))).toBe(false);
      const stamp = path.join(config.dataDir, 'ontologies', p.slug, '.git', 'concord-synced');
      const before = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8') : undefined;
      if (before !== undefined) fs.rmSync(stamp);
      await gitStore.ensureSynced(p);
      expect(fs.existsSync(stamp)).toBe(false); // nothing re-synced, re-pinned or moved
      if (before !== undefined) fs.writeFileSync(stamp, before);
    } finally {
      (config as { readOnly: boolean }).readOnly = false;
    }
  });

  it('turns away requests that change something, with a time to try again, and answers the rest', async () => {
    (config as { readOnly: boolean }).readOnly = true;
    try {
      const { createApp } = await import('../src/app.js');
      const app = createApp();
      const res = await request(app).post('/api/ontologies').send({ title: 'During the move' });
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('300');
      expect(res.body.error).toMatch(/read-only for a few minutes/);
      expect((await request(app).get('/healthz')).status).toBe(200);
    } finally {
      (config as { readOnly: boolean }).readOnly = false;
    }
  });
});
