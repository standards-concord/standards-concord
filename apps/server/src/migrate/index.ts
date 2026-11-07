import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import type { ChangeRequest, OntologyFork, OntologyProject, Release } from '@concord/shared';
import { get, list, put, rawStore, transaction } from '../db.js';
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

export async function copyDatabase(source: DocStore): Promise<{ rows: number }> {
  const rows = (await source.rows()).filter((r) => !TARGET_ONLY.includes(r.collection));
  const target = await rawStore();
  await transaction(async () => {
    await target.clearAll(TARGET_ONLY);
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
  const ontologies = await list<OntologyProject>('ontologies');
  for (const p of ontologies) {
    const dir = repoDirOf(dataDir, p.slug);
    if (!fs.existsSync(dir)) {
      notes.push(`${p.slug}: no repository at ${dir}`);
      continue;
    }
    let batch: { sha: string; type: ObjectType; body: Buffer }[] = [];
    const flush = async () => {
      const b = batch;
      batch = [];
      await transaction(async () => {
        for (const o of b) await writeObject(o.type, o.body);
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
      const sha = execFileSync('git', ['--git-dir', dir, 'rev-parse', 'HEAD']).toString().trim();
      await put('kv', { id: `draft-head:${p.slug}`, sha });
      notes.push(`${p.slug}: the working draft wasn't recorded; took its branch (${sha})`);
    }
    // Fork branches: from the fork records (a branch on disk can lag its record after a crash); a branch with no
    // record (a fork whose creation never finished) is kept as it is, so its name stays taken, as in the git store.
    const forks = await list<OntologyFork>('forks', p.id);
    const onDisk = gitRefs(dir, 'refs/heads/forks/');
    for (const name of new Set([...forks.map((f) => `refs/heads/forks/${f.slug}`), ...onDisk.keys()])) {
      const record = forks.find((f) => `refs/heads/forks/${f.slug}` === name);
      const sha = record?.head ?? onDisk.get(name)!;
      await transaction(async () => {
        if ((await getRef(p.slug, name)) !== sha) await setRef(p.slug, name, sha);
      });
    }
  }
  return { ontologies: ontologies.length, objects, notes };
}

function gitRefs(dir: string, prefix: string): Map<string, string> {
  const out = execFileSync('git', ['--git-dir', dir, 'for-each-ref', '--format=%(refname) %(objectname)', prefix]).toString();
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
  add((await get<{ sha?: string }>('kv', `draft-head:${p.slug}`))?.sha, 'the working draft');
  for (const f of await list<OntologyFork>('forks', p.id)) {
    add(f.head, `fork ${f.slug}`);
    add(f.baseCommit, `fork ${f.slug}'s base`);
  }
  for (const r of await list<Release>('releases', p.id)) add(r.commit, `release ${r.version}`);
  for (const cr of await list<ChangeRequest>('changeRequests', p.id)) {
    add(cr.baseCommit, `change request ${cr.id}`);
    add(cr.mergedCommit, `change request ${cr.id}`);
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

export async function verifyImport(source: DocStore | undefined, dataDir: string | undefined): Promise<ImportMarker> {
  const notes: string[] = [];
  // The documents, row for row, against their source.
  if (source) {
    const want = (await source.rows()).filter((r) => !TARGET_ONLY.includes(r.collection));
    const have = new Map((await (await rawStore()).rows()).map((r) => [`${r.collection} ${r.id}`, r] as [string, StoredRow]));
    for (const r of want) {
      const t = have.get(`${r.collection} ${r.id}`);
      if (!t || t.data !== r.data || t.parent !== r.parent || t.createdAt !== r.createdAt) throw new Error(`${r.collection} ${r.id} doesn't match its source`);
      have.delete(`${r.collection} ${r.id}`);
    }
    const extra = [...have.values()].filter((r) => !TARGET_ONLY.includes(r.collection) && r.id !== IMPORT_MARKER);
    if (extra.length) throw new Error(`${extra.length} document(s) aren't in the source, such as ${extra[0].collection} ${extra[0].id}`);
  }
  const ontologies = await list<OntologyProject>('ontologies');
  let objects = 0;
  const scratch = fs.mkdtempSync(path.join(tmpdir(), 'concord-verify-'));
  try {
    for (const p of ontologies) {
      const named = await namedCommits(p);
      const all = await closure(named.keys()).catch((err: Error) => {
        throw new Error(`${p.slug}: ${err.message} (needed by ${[...named].map(([, why]) => why).join('; ')})`);
      });
      for (const [sha, why] of named) if (all.get(sha)?.type !== 'commit') throw new Error(`${p.slug}: ${sha} (${why}) isn't a commit`);
      objects += all.size;
      // git itself must accept every object and link.
      const refs = new Map([...named.keys()].map((sha, i) => [`refs/concord/verify/${i}`, sha] as [string, string]));
      const dir = path.join(scratch, p.slug);
      writeRepository(dir, all, refs);
      try {
        execFileSync('git', ['--git-dir', dir, 'fsck', '--strict', '--no-dangling', '--no-progress'], { stdio: 'pipe' });
      } catch (err) {
        throw new Error(`${p.slug}: git fsck refused the imported history: ${String((err as { stderr?: Buffer }).stderr ?? err).trim()}`);
      }
      // Against the source repository: every object it has, and its release tags on the releases' commits.
      if (dataDir) {
        const src = repoDirOf(dataDir, p.slug);
        if (fs.existsSync(src)) {
          for (const o of repositoryObjects(src)) if (!(await readObject(o.sha))) throw new Error(`${p.slug}: ${o.type} ${o.sha} from its repository wasn't imported`);
          const releases = await list<Release>('releases', p.id);
          for (const [name] of gitRefs(src, 'refs/tags/')) {
            const at = execFileSync('git', ['--git-dir', src, 'rev-parse', `${name}^{commit}`]).toString().trim();
            const r = releases.find((x) => `refs/tags/v${x.version}` === name);
            if (r && r.commit !== at) throw new Error(`${p.slug}: ${name} is on ${at}, but release ${r.version} is ${r.commit}`);
          }
          for (const [name, sha] of gitRefs(src, 'refs/heads/forks/')) {
            const ref = await getRef(p.slug, name);
            if (!ref) throw new Error(`${p.slug}: ${name} wasn't imported`);
            if (ref !== sha) notes.push(`${p.slug}: ${name} was at ${sha} on disk; it is at its record's head ${ref}`);
          }
        }
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

/**
 * Writes each ontology's history from the database into a git repository under `dataDir/ontologies`, for rolling
 * back to the VM's git store: every object its records name, the draft (refs/concord/draft and main) and fork
 * branches. The git store's start-up sync then checks out the draft and makes release tags, as after a crash.
 */
export async function exportHistories(dataDir: string): Promise<{ ontologies: number; objects: number }> {
  let objects = 0;
  const ontologies = await list<OntologyProject>('ontologies');
  for (const p of ontologies) {
    const dir = path.join(dataDir, 'ontologies', p.slug);
    if (fs.existsSync(dir)) throw new Error(`${dir} already exists: export into an empty data directory`);
    const all = await closure((await namedCommits(p)).keys());
    const draft = (await get<{ sha?: string }>('kv', `draft-head:${p.slug}`))?.sha;
    const refs = new Map((await listRefs(p.slug)).map((r) => [r.name, r.sha] as [string, string]));
    if (draft) {
      refs.set('refs/concord/draft', draft);
      refs.set('refs/heads/main', draft);
    }
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
