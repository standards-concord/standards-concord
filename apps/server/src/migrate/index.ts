import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import type { ChangeRequest, OntologyFork, OntologyProject, Release } from '@concord/shared';
import { get, list, put, rawStore, remove, transaction } from '../db.js';
import { getRef, hashObject, listRefs, parseTree, readObject, setRef, writeObject, type ObjectType } from '../services/gitdb.js';
import type { Collection } from '../db.js';
import type { DocStore, StoredRow } from '../store/types.js';

/**
 * Moving a Concord database from the VM (SQLite, and a git repository per ontology) to Postgres with the
 * database-backed ontology store (ONTOLOGY_STORE=db), and back. Used once, at cutover; see docs/cutover.md.
 *
 * - `copyDatabase` copies every document, byte for byte with its creation time, into the open database, replacing
 *   everything there except stored git objects (which never change, so a second run only adds new ones).
 * - `importHistories` stores every object of every ontology repository, rehashed, and builds the refs the database
 *   store keeps (fork branches) from the database's records.
 * - `verifyImport` checks that every commit the records name is there with everything it needs, that git itself
 *   accepts the result (`git fsck --strict` on a repository written from the database), and that the copy matches
 *   its source; only then does it record the import as verified, which the database store needs before it serves an
 *   imported database.
 * - `exportHistories` writes the database's histories back into git repositories, for rolling back to the VM.
 * - `importPrivateFiles` / `exportPrivateFiles` move the server's own private files (data dir `private/`, for
 *   accounts with no pod) into `privateFiles` rows and back; `verifyImport` checks them byte for byte. With the
 *   VM's Solid server's data directory (`podsDir`), the import also takes what Concord kept in the pods it made for
 *   people (each pod's `concord/` folder), where Concord read it first: on Vercel there is no such server, so
 *   Google and GitHub accounts' data stays in the database, and Solid accounts' moves into their own pod at their
 *   next Solid sign-in (services/ownPods.ts `carryIntoOwnPod`).
 */

/** Recorded once an import is verified (or a database store started with nothing to import). */
export const IMPORT_MARKER = 'ontology-import';
export interface ImportMarker {
  id: typeof IMPORT_MARKER;
  verifiedAt: string;
  ontologies: number;
  objects: number;
  /** Anything worth a look that didn't fail verification (an id-like value no record explains, say). */
  notes: string[];
}

/** Collections only the database store has: kept by a copy, never compared with the source. */
const TARGET_ONLY: Collection[] = ['gitObjects', 'gitRefs'];
/** Rows that come from files in the data directory, not from the source database: checked against the files. */
const FROM_FILES: Collection[] = ['privateFiles'];

/** Every private file under `dataDir/private/<user id>/`, as its owner and path within that folder. */
function* privateFilesIn(dataDir: string): Generator<PrivateSourceFile> {
  const root = path.join(dataDir, 'private');
  if (!fs.existsSync(root)) return;
  for (const userId of fs.readdirSync(root)) {
    const base = path.join(root, userId);
    if (!fs.statSync(base).isDirectory()) continue;
    for (const rel of fs.readdirSync(base, { recursive: true, encoding: 'utf8' })) {
      const file = path.join(base, rel);
      // A leftover temporary file from a crash (services/privateStore.ts) isn't data.
      if (!fs.statSync(file).isFile() || path.basename(file).endsWith('.concord-tmp')) continue;
      yield { userId, relPath: rel.split(path.sep).join('/'), file };
    }
  }
}

interface PrivateSourceFile {
  userId: string;
  relPath: string;
  file: string;
}

/** A pod this server made for someone on its Solid server (services/solid.ts `provision`). */
interface PodRecord {
  id: string;
  podUrl: string;
}

/**
 * What Concord kept in the pods it made on the VM's Solid server, read from that server's data directory (the
 * Community Solid Server's file backend: a pod's resources are files under a folder named by the pod's path). A
 * resource whose name doesn't give its type is stored as `<name>$.<ext>`, which is taken back off; access control and
 * metadata files (`.acl`, `.meta`) aren't data.
 */
async function* podFilesIn(podsDir: string): AsyncGenerator<PrivateSourceFile> {
  const root = path.resolve(podsDir);
  const pods = (await (await rawStore()).rows())
    .filter((r) => r.collection === 'kv' && r.id.startsWith('pod:'))
    .map((r) => JSON.parse(r.data) as PodRecord)
    .filter((r) => typeof r.podUrl === 'string');
  for (const rec of pods) {
    const userId = rec.id.slice('pod:'.length);
    const folder = path.resolve(root, ...new URL(rec.podUrl).pathname.split('/').filter(Boolean).map(decodeURIComponent));
    if (!folder.startsWith(root + path.sep)) throw new Error(`${rec.id}: its pod ${rec.podUrl} isn't a folder of ${root}`);
    if (!fs.existsSync(folder)) throw new Error(`${rec.id}: its pod ${rec.podUrl} isn't in ${root} (is that the Solid server's data directory?)`);
    const base = path.join(folder, 'concord');
    if (!fs.existsSync(base)) continue; // nothing kept there yet
    for (const rel of fs.readdirSync(base, { recursive: true, encoding: 'utf8' })) {
      const file = path.join(base, rel);
      const name = path.basename(file);
      if (!fs.lstatSync(file).isFile() || /(^|\.)(acl|meta)$/.test(name)) continue;
      yield { userId, relPath: rel.split(path.sep).join('/').replace(/\$\.[^/]*$/, ''), file };
    }
  }
}

/**
 * Every private file to import: the data directory's, and with `podsDir` what the pods held, which wins over a
 * file kept for the same path on disk (the server read the pod first). Refuses when the database names pods this
 * server made and `podsDir` isn't given: their data would be left behind.
 */
async function privateSources(dataDir: string, podsDir: string | undefined): Promise<Map<string, PrivateSourceFile>> {
  const all = new Map<string, PrivateSourceFile>();
  for (const f of privateFilesIn(dataDir)) all.set(privateRowId(f.userId, f.relPath), f);
  if (podsDir) for await (const f of podFilesIn(podsDir)) all.set(privateRowId(f.userId, f.relPath), f);
  else {
    const pods = (await (await rawStore()).rows()).filter((r) => r.collection === 'kv' && r.id.startsWith('pod:')).length;
    if (pods) throw new Error(`${pods} account(s) have pods on the VM's Solid server: give its data directory (--pods) so what Concord kept there comes too`);
  }
  return all;
}

const privateRowId = (userId: string, relPath: string) => `${userId}/${relPath}`;

/** Stores every private file (see privateSources) as a `privateFiles` row (replacing the rows there). */
export async function importPrivateFiles(dataDir: string, podsDir?: string): Promise<{ files: number }> {
  await unverify();
  const target = await rawStore();
  const now = new Date().toISOString();
  const rows: StoredRow[] = [...(await privateSources(dataDir, podsDir)).values()].map((f) => ({
    collection: 'privateFiles',
    id: privateRowId(f.userId, f.relPath),
    parent: f.userId,
    data: JSON.stringify({ id: privateRowId(f.userId, f.relPath), data: fs.readFileSync(f.file).toString('base64') }),
    createdAt: now,
  }));
  await transaction(async () => {
    for (const r of (await target.rows()).filter((x) => x.collection === 'privateFiles')) await target.remove('privateFiles', r.id);
    await target.putRows(rows);
  });
  return { files: rows.length };
}

/** Writes the `privateFiles` rows back as files under `dataDir/private/`, readable by the server only. */
export async function exportPrivateFiles(dataDir: string): Promise<{ files: number }> {
  const rows = (await (await rawStore()).rows()).filter((r) => r.collection === 'privateFiles');
  for (const r of rows) {
    const rel = r.id.slice((r.parent ?? '').length + 1);
    const file = path.join(dataDir, 'private', r.parent ?? '', rel);
    if (!r.parent || !file.startsWith(path.join(dataDir, 'private', r.parent) + path.sep)) throw new Error(`privateFiles ${r.id} has no owner or leaves its folder`);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, Buffer.from((JSON.parse(r.data) as { data: string }).data, 'base64'), { flag: 'wx', mode: 0o600 });
  }
  return { files: rows.length };
}

/** The verified marker belongs to the database it was recorded in: never copied, exported or compared. */
const isMarker = (r: { collection: Collection; id: string }) => r.collection === 'kv' && r.id === IMPORT_MARKER;
/** Every ref of each source repository, recorded at import (`kv import-refs:<slug>`), for verify and export. */
const IMPORT_REFS = 'import-refs:';
interface ImportRefs {
  id: string;
  refs: Record<string, string>;
}
/** Rows the import itself writes, which the source doesn't have (or needn't match): checked on their own. */
const madeByImport = (r: { collection: Collection; id: string }) => r.collection === 'kv' && r.id.startsWith(IMPORT_REFS);

/** Forgets that this database was verified: before anything changes what was verified, and before verifying again. */
const unverify = () => remove('kv', IMPORT_MARKER);

export async function copyDatabase(source: DocStore): Promise<{ rows: number }> {
  const rows = (await source.rows()).filter((r) => !TARGET_ONLY.includes(r.collection) && !isMarker(r));
  const target = await rawStore();
  await transaction(async () => {
    await target.clearAll(TARGET_ONLY); // the marker too
    await target.putRows(rows);
  });
  return { rows: rows.length };
}

/** Every object in a git repository: `git cat-file --batch-all-objects --batch`, split by byte counts. */
export function* repositoryObjects(dir: string): Generator<{ sha: string; type: ObjectType; body: Buffer }> {
  const out = execFileSync('git', ['--git-dir', dir, 'cat-file', '--batch-all-objects', '--batch', '--unordered'], { maxBuffer: 1 << 30 });
  let at = 0;
  while (at < out.length) {
    const nl = out.indexOf(10, at);
    const [sha, type, size] = out.subarray(at, nl).toString('utf8').split(' ');
    const start = nl + 1;
    const body = out.subarray(start, start + Number(size));
    if (body.length !== Number(size) || out[start + Number(size)] !== 10) throw new Error(`${dir}: object ${sha} is cut short`);
    yield { sha, type: type as ObjectType, body };
    at = start + Number(size) + 1;
  }
}

const repoDirOf = (dataDir: string, slug: string) => {
  const dir = path.join(dataDir, 'ontologies', slug);
  return fs.existsSync(path.join(dir, '.git')) ? path.join(dir, '.git') : dir;
};

/** Headers Concord's own commits and tags never have, and GitHub's API can't recreate (see docs/ontology-store.md). */
const UNUSUAL_HEADER = /^(encoding|mergetag|gpgsig|gpgsig-sha256) /m;

export async function importHistories(dataDir: string): Promise<{ ontologies: number; objects: number; notes: string[] }> {
  const notes: string[] = [];
  let objects = 0;
  await unverify();
  const ontologies = await list<OntologyProject>('ontologies');
  for (const p of ontologies) {
    const dir = repoDirOf(dataDir, p.slug);
    // Every ontology the git store made has a repository: one without is a copy from the wrong directory.
    if (!fs.existsSync(dir)) throw new Error(`${p.slug}: no repository at ${dir}`);
    let batch: { sha: string; type: ObjectType; body: Buffer }[] = [];
    const flush = async () => {
      const b = batch;
      batch = [];
      await transaction(async () => {
        for (const o of b) {
          // A copy left by an earlier run that doesn't match (damaged since) is replaced, not kept.
          const had = await readObject(o.sha);
          if (had && (had.type !== o.type || !had.body.equals(o.body))) await put('gitObjects', { id: o.sha, type: o.type, data: o.body.toString('base64') });
          else if (!had) await writeObject(o.type, o.body);
        }
      });
    };
    for (const o of repositoryObjects(dir)) {
      if (hashObject(o.type, o.body) !== o.sha) throw new Error(`${p.slug}: object ${o.sha} doesn't hash to its id`);
      if ((o.type === 'commit' || o.type === 'tag') && UNUSUAL_HEADER.test(o.body.subarray(0, o.body.indexOf('\n\n')).toString('utf8')))
        notes.push(`${p.slug}: ${o.type} ${o.sha} has a header GitHub's API can't recreate`);
      batch.push(o);
      objects++;
      if (batch.length >= 500) await flush();
    }
    await flush();
    // The working draft, if the database never recorded it (a repository older than the record): its checked-out
    // branch, as the git store reads it.
    if (!(await get('kv', `draft-head:${p.slug}`))) {
      const sha = diskHead(dir);
      if (!sha) throw new Error(`${p.slug}: no working draft, recorded or checked out`);
      await put('kv', { id: `draft-head:${p.slug}`, sha });
      notes.push(`${p.slug}: the working draft wasn't recorded; took its branch (${sha})`);
    }
    // Every ref as it is on disk (tags, branches), kept for export (a rollback gets them back) and checked by verify.
    await put<ImportRefs>('kv', { id: `${IMPORT_REFS}${p.slug}`, refs: Object.fromEntries(sourceRefs(dir)) });
    // Fork branches, exactly: from the fork records (a branch on disk can lag its record after a crash); a branch
    // with no record (a fork whose creation never finished) is kept as it is, so its name stays taken, as in the
    // git store; anything else (a ref from an earlier copy) goes.
    const want = await expectedForkRefs(p, dir);
    await transaction(async () => {
      for (const r of await listRefs(p.slug)) if (!want.has(r.name)) await setRef(p.slug, r.name, undefined);
      for (const [name, sha] of want) if ((await getRef(p.slug, name)) !== sha) await setRef(p.slug, name, sha);
    });
  }
  return { ontologies: ontologies.length, objects, notes };
}

/** The commit the repository has checked out, if any. */
const diskHead = (dir: string) => {
  try {
    return execFileSync('git', ['--git-dir', dir, 'rev-parse', '-q', '--verify', 'HEAD^{commit}'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || undefined;
  } catch {
    return undefined;
  }
};

/**
 * All of a repository's refs, the git store's pins included: a pin can be all that holds a writer's commit (one
 * that crashed before the draft took it), and the git store reclaims or drops pins itself once it runs again.
 */
const sourceRefs = (dir: string) => gitRefs(dir, '');

/** The fork branches the database store must have: each record's head, and branches on disk with no record. */
async function expectedForkRefs(p: OntologyProject, dir: string | undefined): Promise<Map<string, string>> {
  const want = new Map<string, string>();
  if (dir) for (const [name, sha] of gitRefs(dir, 'refs/heads/forks/')) want.set(name, sha);
  for (const f of await list<OntologyFork>('forks', p.id)) {
    const name = `refs/heads/forks/${f.slug}`;
    if (f.head) want.set(name, f.head);
    else if (!want.has(name) && (await getRef(p.slug, name))) want.set(name, (await getRef(p.slug, name))!);
  }
  return want;
}

function gitRefs(dir: string, prefix: string): Map<string, string> {
  const out = execFileSync('git', ['--git-dir', dir, 'for-each-ref', '--format=%(refname) %(objectname)', ...(prefix ? [prefix] : [])]).toString();
  return new Map(
    out
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split(' ') as [string, string]),
  );
}

/** Every commit an ontology's records name, with what names it. */
async function namedCommits(p: OntologyProject): Promise<Map<string, string>> {
  const named = new Map<string, string>();
  const add = (sha: string | undefined, why: string) => {
    if (sha) named.set(sha, named.has(sha) ? `${named.get(sha)}, ${why}` : why);
  };
  const draft = (await get<{ sha?: string }>('kv', `draft-head:${p.slug}`))?.sha;
  if (!draft) throw new Error(`${p.slug}: has no working draft`);
  add(draft, 'the working draft');
  for (const f of await list<OntologyFork>('forks', p.id)) {
    add(f.head, `fork ${f.slug}`);
    add(f.baseCommit, `fork ${f.slug}'s base`);
  }
  for (const r of await list<Release>('releases', p.id)) add(r.commit, `release ${r.version}`);
  for (const cr of await list<ChangeRequest>('changeRequests', p.id)) {
    add(cr.baseCommit, `change request ${cr.id}`);
    add(cr.mergedCommit, `change request ${cr.id}`);
    add(cr.triagedHead, `change request ${cr.id} (triaged)`);
  }
  for (const ref of await listRefs(p.slug)) add(ref.sha, ref.name);
  return named;
}

/**
 * Every object reachable from `from`, each read from the database and rehashed: the closure a commit needs.
 * Throws naming the first object that is missing or doesn't match its id.
 */
async function closure(from: Iterable<string>, into = new Map<string, { type: ObjectType; body: Buffer }>()) {
  const todo = [...from];
  while (todo.length) {
    const sha = todo.pop()!;
    if (into.has(sha)) continue;
    const o = await readObject(sha);
    if (!o) throw new Error(`object ${sha} is missing`);
    if (hashObject(o.type, o.body) !== sha) throw new Error(`object ${sha} doesn't hash to its id`);
    into.set(sha, o);
    if (o.type === 'commit' || o.type === 'tag') {
      const head = o.body.subarray(0, o.body.indexOf('\n\n')).toString('utf8');
      for (const m of head.matchAll(/^(?:tree|parent|object) ([0-9a-f]{40})$/gm)) todo.push(m[1]);
    } else if (o.type === 'tree') for (const e of parseTree(o.body)) todo.push(e.sha);
  }
  return into;
}

/** Writes objects into a new bare repository as loose objects (as `git hash-object -w` would). */
function writeRepository(dir: string, objects: Map<string, { type: ObjectType; body: Buffer }>, refs: Map<string, string>) {
  execFileSync('git', ['init', '-q', '--bare', dir]);
  for (const [sha, o] of objects) {
    const file = path.join(dir, 'objects', sha.slice(0, 2), sha.slice(2));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, deflateSync(Buffer.concat([Buffer.from(`${o.type} ${o.body.length}\0`), o.body])));
  }
  for (const [name, sha] of refs) execFileSync('git', ['--git-dir', dir, 'update-ref', name, sha]);
}

export async function verifyImport(source: DocStore | undefined, dataDir: string | undefined, podsDir?: string): Promise<ImportMarker> {
  const notes: string[] = [];
  // Whatever was verified before no longer counts: only a verification that finishes leaves a marker.
  await unverify();
  // The documents, row for row and in the same order (list() breaks ties between equal creation times by
  // insertion order), against their source.
  if (source) {
    const compared = (r: StoredRow) => !TARGET_ONLY.includes(r.collection) && !FROM_FILES.includes(r.collection) && !isMarker(r) && !madeByImport(r);
    const key = (r: StoredRow) => `${r.collection} ${r.id}`;
    const want = (await source.rows()).filter(compared);
    const haveRows = (await (await rawStore()).rows()).filter(compared);
    const have = new Map(haveRows.map((r) => [key(r), r] as [string, StoredRow]));
    for (const r of want) {
      const t = have.get(key(r));
      if (!t || t.data !== r.data || t.parent !== r.parent || t.createdAt !== r.createdAt) throw new Error(`${r.collection} ${r.id} doesn't match its source`);
      have.delete(key(r));
    }
    // The one row an import may add: a working draft the source never recorded, taken from its repository.
    const extra = [];
    for (const r of have.values()) {
      const slug = r.collection === 'kv' && r.id.startsWith('draft-head:') ? r.id.slice('draft-head:'.length) : undefined;
      const sha = slug && dataDir && fs.existsSync(repoDirOf(dataDir, slug)) ? diskHead(repoDirOf(dataDir, slug)) : undefined;
      if (!sha || (JSON.parse(r.data) as { sha?: string }).sha !== sha) extra.push(r);
    }
    if (extra.length) throw new Error(`${extra.length} document(s) aren't in the source, such as ${extra[0].collection} ${extra[0].id}`);
    const order = new Set(want.map(key));
    const got = haveRows.map(key).filter((k) => order.has(k));
    const i = want.findIndex((r, n) => key(r) !== got[n]);
    if (i >= 0) throw new Error(`the documents aren't in their source's order, from ${key(want[i])}`);
  }
  // Private files, byte for byte against the data directory (and the pods' data directory).
  if (dataDir) {
    const stored = new Map((await (await rawStore()).rows()).filter((r) => r.collection === 'privateFiles').map((r) => [r.id, (JSON.parse(r.data) as { data: string }).data]));
    for (const [id, f] of await privateSources(dataDir, podsDir)) {
      if (stored.get(id) !== fs.readFileSync(f.file).toString('base64')) throw new Error(`private file ${id} wasn't imported as it is on disk`);
      stored.delete(id);
    }
    if (stored.size) throw new Error(`${stored.size} private file(s) aren't in the data directory, such as ${[...stored.keys()][0]}`);
  }
  const ontologies = await list<OntologyProject>('ontologies');
  let objects = 0;
  const scratch = fs.mkdtempSync(path.join(tmpdir(), 'concord-verify-'));
  try {
    for (const p of ontologies) {
      const src = dataDir ? repoDirOf(dataDir, p.slug) : undefined;
      if (src && !fs.existsSync(src)) throw new Error(`${p.slug}: no repository at ${src}`);
      const named = await namedCommits(p);
      const imported = (await get<ImportRefs>('kv', `${IMPORT_REFS}${p.slug}`))?.refs ?? {};
      const all = await closure([...named.keys(), ...Object.values(imported)]).catch((err: Error) => {
        throw new Error(`${p.slug}: ${err.message} (needed by ${[...named].map(([, why]) => why).join('; ')}, or a ref from its repository)`);
      });
      for (const [sha, why] of named) if (all.get(sha)?.type !== 'commit') throw new Error(`${p.slug}: ${sha} (${why}) isn't a commit`);
      if (src) {
        // Its refs, as recorded for export, are the ones it has now.
        const now = Object.fromEntries(sourceRefs(src));
        if (JSON.stringify(Object.entries(now).sort()) !== JSON.stringify(Object.entries(imported).sort())) throw new Error(`${p.slug}: its repository's refs changed since the import (copy again)`);
        // Every object the repository has, byte for byte (a corrupted copy left by an earlier run doesn't count as
        // there), including those no ref reaches, so git checks them too.
        for (const o of repositoryObjects(src)) {
          const t = await readObject(o.sha);
          if (!t) throw new Error(`${p.slug}: ${o.type} ${o.sha} from its repository wasn't imported`);
          if (t.type !== o.type || !t.body.equals(o.body) || hashObject(t.type, t.body) !== o.sha) throw new Error(`${p.slug}: ${o.type} ${o.sha} doesn't match its repository's copy`);
          all.set(o.sha, t);
        }
        const releases = await list<Release>('releases', p.id);
        for (const [name] of gitRefs(src, 'refs/tags/')) {
          const at = execFileSync('git', ['--git-dir', src, 'rev-parse', `${name}^{commit}`]).toString().trim();
          const r = releases.find((x) => `refs/tags/v${x.version}` === name);
          if (r && r.commit !== at) throw new Error(`${p.slug}: ${name} is on ${at}, but release ${r.version} is ${r.commit}`);
        }
        for (const [name, sha] of gitRefs(src, 'refs/heads/forks/')) {
          const head = (await list<OntologyFork>('forks', p.id)).find((f) => `refs/heads/forks/${f.slug}` === name)?.head;
          if (head && head !== sha) notes.push(`${p.slug}: ${name} was at ${sha} on disk; it is at its record's head ${head}`);
        }
      }
      // The fork branches, exactly: none missing, none moved, none left over from an earlier copy.
      const want = await expectedForkRefs(p, src);
      const have = new Map((await listRefs(p.slug)).map((r) => [r.name, r.sha] as [string, string]));
      for (const [name, sha] of want) if (have.get(name) !== sha) throw new Error(`${p.slug}: ${name} is ${have.get(name) ? `at ${have.get(name)}` : 'missing'}, not at ${sha}`);
      for (const name of have.keys()) if (!want.has(name)) throw new Error(`${p.slug}: ${name} has no fork record or branch to come from`);
      objects += all.size;
      // git itself must accept every object and link.
      const refs = new Map([...named.keys(), ...Object.values(imported)].map((sha, i) => [`refs/concord/verify/${i}`, sha] as [string, string]));
      const dir = path.join(scratch, p.slug);
      writeRepository(dir, all, refs);
      try {
        execFileSync('git', ['--git-dir', dir, 'fsck', '--strict', '--no-dangling', '--no-progress'], { stdio: 'pipe' });
      } catch (err) {
        throw new Error(`${p.slug}: git fsck refused the imported history: ${String((err as { stderr?: Buffer }).stderr ?? err).trim()}`);
      }
      // Anything else in this ontology's records that looks like a commit id and isn't one.
      for (const c of ['useCases', 'meetings', 'changeRequests', 'forks', 'releases'] as Collection[])
        for (const doc of await list<object>(c, p.id))
          for (const m of JSON.stringify(doc).matchAll(/"([0-9a-f]{40})"/g))
            if (!all.has(m[1]) && !(await readObject(m[1]))) notes.push(`${p.slug}: ${c} names ${m[1]}, which isn't in its history`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const marker: ImportMarker = { id: IMPORT_MARKER, verifiedAt: new Date().toISOString(), ontologies: ontologies.length, objects, notes };
  await put('kv', marker);
  return marker;
}

/**
 * For the database store at start: true if it may serve. An imported database needs its verified marker; a
 * database with no ontologies has nothing to import, and is marked so.
 */
export async function importVerified(): Promise<boolean> {
  return await transaction(async () => {
    if (await get<ImportMarker>('kv', IMPORT_MARKER)) return true;
    if ((await list<OntologyProject>('ontologies')).length) return false;
    await put<ImportMarker>('kv', { id: IMPORT_MARKER, verifiedAt: new Date().toISOString(), ontologies: 0, objects: 0, notes: ['nothing to import'] });
    return true;
  });
}

/** The documents an export writes to SQLite: everything but stored git objects and refs, private files (exported as files) and the marker. */
export async function exportRows(): Promise<StoredRow[]> {
  return (await (await rawStore()).rows()).filter((r) => !TARGET_ONLY.includes(r.collection) && !FROM_FILES.includes(r.collection) && !isMarker(r));
}

/**
 * Writes each ontology's history from the database into a git repository under `dataDir/ontologies`, for rolling
 * back to the VM's git store: the draft (refs/concord/draft and main), fork branches, and every other ref its
 * repository had at import (tags, other branches), with everything they reach. The git store's start-up sync then
 * checks out the draft and makes tags for releases published since, as after a crash. Objects no ref reached at
 * import (dangling ones, which git would collect anyway) aren't written.
 */
export async function exportHistories(dataDir: string): Promise<{ ontologies: number; objects: number }> {
  let objects = 0;
  const ontologies = await list<OntologyProject>('ontologies');
  for (const p of ontologies) {
    const dir = path.join(dataDir, 'ontologies', p.slug);
    if (fs.existsSync(dir)) throw new Error(`${dir} already exists: export into an empty data directory`);
    const draft = (await get<{ sha?: string }>('kv', `draft-head:${p.slug}`))?.sha;
    const refs = new Map<string, string>();
    for (const [name, sha] of Object.entries((await get<ImportRefs>('kv', `${IMPORT_REFS}${p.slug}`))?.refs ?? {}))
      if (!name.startsWith('refs/heads/forks/') && name !== 'refs/heads/main' && name !== 'refs/concord/draft') refs.set(name, sha);
    for (const r of await listRefs(p.slug)) refs.set(r.name, r.sha);
    if (draft) {
      refs.set('refs/concord/draft', draft);
      refs.set('refs/heads/main', draft);
    }
    const all = await closure([...(await namedCommits(p)).keys(), ...refs.values()]);
    fs.mkdirSync(dir, { recursive: true });
    const gitDir = path.join(dir, '.git');
    writeRepository(gitDir, all, refs);
    execFileSync('git', ['--git-dir', gitDir, 'config', 'core.bare', 'false']);
    execFileSync('git', ['--git-dir', gitDir, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
    execFileSync('git', ['--git-dir', gitDir, 'fsck', '--strict', '--no-dangling', '--no-progress'], { stdio: 'pipe' });
    objects += all.size;
  }
  return { ontologies: ontologies.length, objects };
}
