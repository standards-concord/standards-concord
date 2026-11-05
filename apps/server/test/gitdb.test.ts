import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, openDb } from '../src/db.js';
import {
  countBetween,
  EMPTY_TREE,
  firstParentLog,
  getRef,
  hashObject,
  ident,
  isAncestor,
  listDir,
  listRefs,
  mergeBase,
  peel,
  readCommit,
  readFile,
  serialiseTag,
  setRef,
  subject,
  writeCommit,
  writeTag,
  writeTree,
  type Person,
} from '../src/services/gitdb.js';

/**
 * The database-backed git objects must have the ids git itself gives them: Concord shows commit ids, links them
 * to GitHub, and will recreate the history there. Each case builds the same thing with the git command line and
 * compares.
 */

const dir = mkdtempSync(join(tmpdir(), 'gitdb-'));
// On a real Postgres server when there is one (CI): text there can't hold every byte SQLite accepts.
const pgUrl = process.env.TEST_DATABASE_URL;
beforeAll(async () => {
  if (pgUrl) await openDb({ kind: 'postgres', url: pgUrl, max: 4 });
});
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  if (pgUrl) await closeDb();
});
execFileSync('git', ['init', '-q', dir]);

const who: Person = { name: 'Priya Shah', email: 'priya@example.org', time: 1_762_300_000, tz: '+0000' };
const env = (p: Person) => ({
  ...process.env,
  GIT_AUTHOR_NAME: p.name,
  GIT_AUTHOR_EMAIL: p.email,
  GIT_AUTHOR_DATE: `${p.time} ${p.tz}`,
  GIT_COMMITTER_NAME: p.name,
  GIT_COMMITTER_EMAIL: p.email,
  GIT_COMMITTER_DATE: `${p.time} ${p.tz}`,
});
const git = (args: string[], input?: string, p = who) => execFileSync('git', ['-C', dir, ...args], { input, env: env(p) }).toString().trim();

/** Writes `files` into git's index from scratch and returns git's tree id. */
function gitTree(files: Record<string, string>): string {
  git(['read-tree', '--empty']);
  for (const [path, content] of Object.entries(files)) {
    const blob = git(['hash-object', '-w', '--stdin'], content);
    git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`]);
  }
  return git(['write-tree']);
}

describe('gitdb', () => {
  it('hashes blobs as git does, including non-ASCII text', () => {
    for (const text of ['', 'hello\n', '@prefix ex: <https://example.org/> .\nex:Café a ex:Thing .\n']) expect(hashObject('blob', text)).toBe(git(['hash-object', '--stdin'], text));
  });

  it('builds nested trees with the ids git gives them, in git’s own entry order', async () => {
    // "a.b" sorts before "a/" (a subtree) but after "a": git compares a subtree's name as if it ended in "/".
    const files = { 'ontology.ttl': 'x\n', 'README.md': '# R\n', 'a.b': '1', 'a/z.txt': '2', a0: '3', 'releases/1.0.0/ontology.ttl': 'v1\n', 'releases/1.0.0/notes.md': 'n' };
    expect(await writeTree(undefined, files)).toBe(gitTree(files));
    expect(await writeTree(undefined, {})).toBe(EMPTY_TREE);
    expect(EMPTY_TREE).toBe(gitTree({}));
  });

  it('changes and removes files on top of a tree, dropping directories left empty', async () => {
    const base = await writeTree(undefined, { 'ontology.ttl': 'x\n', 'releases/1.0.0/ontology.ttl': 'v1\n' });
    const next = await writeTree(base, { 'ontology.ttl': 'y\n', 'releases/1.0.0/ontology.ttl': null, 'releases/2.0.0/ontology.ttl': 'v2\n' });
    expect(next).toBe(gitTree({ 'ontology.ttl': 'y\n', 'releases/2.0.0/ontology.ttl': 'v2\n' }));
    expect(await writeTree(next, { 'releases/2.0.0/ontology.ttl': null })).toBe(gitTree({ 'ontology.ttl': 'y\n' }));
  });

  it('writes commits and annotated tags with git’s ids, and reads them back', async () => {
    const files = { 'ontology.ttl': 'x\n' };
    const tree = await writeTree(undefined, files);
    const root = await writeCommit({ tree, parents: [], author: who, committer: who, message: 'Create ontology' });
    expect(root).toBe(git(['commit-tree', gitTree(files), '-m', 'Create ontology']));

    const later = { ...who, name: 'Tom Okafor', email: 'tom@example.org', time: who.time + 60, tz: '+0100' };
    const tree2 = await writeTree(tree, { 'ontology.ttl': 'y\n' });
    const child = await writeCommit({ tree: tree2, parents: [root], author: later, committer: later, message: 'Rename a term\n\nBecause.' });
    expect(child).toBe(git(['commit-tree', gitTree({ 'ontology.ttl': 'y\n' }), '-p', root, '-m', 'Rename a term', '-m', 'Because.'], undefined, later));

    const c = await readCommit(child);
    expect(c).toMatchObject({ tree: tree2, parents: [root], author: later, message: 'Rename a term\n\nBecause.\n' });
    expect(subject(c)).toBe('Rename a term');
    expect(await readFile(child, 'ontology.ttl')).toBe('y\n');
    expect(await readFile(child, 'missing.ttl')).toBeUndefined();

    git(['update-ref', 'refs/heads/main', child]);
    const tag = await writeTag({ object: child, tag: 'v1.0.0', tagger: who, message: 'Release 1.0.0' });
    git(['tag', '-a', 'v1.0.0', '-m', 'Release 1.0.0', child]);
    // Byte for byte first, so a difference shows what differs (r1 review: a signing config gave another id).
    expect(git(['cat-file', 'tag', 'v1.0.0'])).toBe(serialiseTag({ object: child, type: 'commit', tag: 'v1.0.0', tagger: who, message: 'Release 1.0.0' }).trim());
    expect(tag).toBe(git(['rev-parse', 'refs/tags/v1.0.0']));
    expect(await peel(tag)).toBe(child);
  });

  it('cleans names and emails exactly as git does, so the ids still match', async () => {
    // r1 review: JavaScript's \s also trimmed Unicode spaces and inner CRs, which git keeps.
    const tree = await writeTree(undefined, { f: '1' });
    const cases: [string, string][] = [
      ['\u00a0Ana\u00a0', 'ana@example.org'],
      ['Ana\rBell', 'ana@example.org'],
      ['  "Ana" <Bell>, ', ' <ana@example.org>. '],
      ['.Ana. Bell;', "'ana\n@example.org'"],
      ['\tAna\n\nBell\t', 'a<b>c@example.org'],
      ['Zoë Ångström', 'zoë@exämple.org'],
    ];
    for (const [name, email] of cases) {
      const p = { ...ident(name, email), time: who.time };
      const ours = await writeCommit({ tree, parents: [], author: p, committer: p, message: 'm' });
      const env = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
      const theirs = execFileSync('git', ['-C', dir, 'commit-tree', gitTree({ f: '1' }), '-m', 'm'], { env: { ...process.env, ...env, GIT_AUTHOR_DATE: `${who.time} +0000`, GIT_COMMITTER_DATE: `${who.time} +0000` } })
        .toString()
        .trim();
      expect(ours, JSON.stringify([name, email])).toBe(theirs);
    }
  });

  it('keeps an empty commit message empty, as git commit-tree -m "" does', async () => {
    // r1 review: an empty message gained a newline, which changes the id.
    const tree = await writeTree(undefined, { f: '1' });
    expect(await writeCommit({ tree, parents: [], author: who, committer: who, message: '' })).toBe(git(['commit-tree', gitTree({ f: '1' }), '-m', '']));
  });

  it('lists a directory at a commit', async () => {
    const tree = await writeTree(undefined, { 'releases/1.0.0/ontology.ttl': 'a', 'releases/1.1.0/ontology.ttl': 'b', 'ontology.ttl': 'c' });
    const commit = await writeCommit({ tree, parents: [], author: who, committer: who, message: 'm' });
    expect((await listDir(commit, 'releases')).map((e) => e.name)).toEqual(['1.0.0', '1.1.0']);
    expect(await listDir(commit, 'ontology.ttl')).toEqual([]);
  });

  it('walks history: first-parent log, counts, ancestry and merge bases', async () => {
    const tree = await writeTree(undefined, { f: '0' });
    const commit = (parents: string[], message: string) => writeCommit({ tree, parents, author: who, committer: who, message });
    const a = await commit([], 'a');
    const b = await commit([a], 'b');
    const c = await commit([b], 'c'); // main
    const f1 = await commit([b], 'f1'); // a fork from b
    const f2 = await commit([f1], 'f2');
    const m = await commit([c, f2], 'merge'); // the fork merged back

    expect((await firstParentLog(m)).map(subject)).toEqual(['merge', 'c', 'b', 'a']);
    expect((await firstParentLog(m, { limit: 2 })).map(subject)).toEqual(['merge', 'c']);
    expect((await firstParentLog(f2, { exclude: [c] })).map(subject)).toEqual(['f2', 'f1']);
    expect(await countBetween(c, f2)).toBe(2);
    expect(await countBetween(f2, c)).toBe(1);
    expect(await countBetween(c, m)).toBe(3);
    expect(await isAncestor(b, f2)).toBe(true);
    expect(await isAncestor(c, f2)).toBe(false);
    expect(await mergeBase(c, f2)).toBe(b);
    expect(await mergeBase(m, f2)).toBe(f2);
    expect(await mergeBase(a, await commit([], 'unrelated'))).toBeUndefined();
  });

  it('moves refs only from the value the caller expects', async () => {
    const tree = await writeTree(undefined, { f: '1' });
    const one = await writeCommit({ tree, parents: [], author: who, committer: who, message: 'one' });
    const two = await writeCommit({ tree, parents: [one], author: who, committer: who, message: 'two' });
    const three = await writeCommit({ tree, parents: [one], author: who, committer: who, message: 'three' });
    const repo = `repo-${Date.now()}`;

    await setRef(repo, 'refs/heads/main', one, { sha: undefined });
    await expect(setRef(repo, 'refs/heads/main', two, { sha: undefined })).rejects.toMatchObject({ status: 409 });
    expect(await getRef(repo, 'refs/heads/main')).toBe(one);

    // Two writers that both read `one`: the first wins and the second changes nothing.
    const results = await Promise.allSettled([setRef(repo, 'refs/heads/main', two, { sha: one }), setRef(repo, 'refs/heads/main', three, { sha: one })]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await getRef(repo, 'refs/heads/main')).toBe(results[0].status === 'fulfilled' ? two : three);

    await setRef(repo, 'refs/tags/v1', one);
    expect((await listRefs(repo)).map((r) => r.name)).toEqual(['refs/heads/main', 'refs/tags/v1']);
    expect((await listRefs(repo, 'refs/tags/')).map((r) => r.sha)).toEqual([one]);
    await setRef(repo, 'refs/tags/v1', undefined);
    expect(await getRef(repo, 'refs/tags/v1')).toBeUndefined();
  });
});
