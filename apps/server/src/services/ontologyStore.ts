import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { OntologyGraph } from '@concord/core';
import type { OntologyProject, Release } from '@concord/shared';
import { config } from '../config.js';
import { get, HttpError, list, put, transaction } from '../db.js';

/**
 * Each ontology is a git repository. The working draft is `ontology.ttl` on
 * `main`; each release is committed under `releases/<version>/` and tagged
 * `v<version>`, so every version IRI keeps resolving and the history is a
 * normal git history that can be pushed to GitHub as-is.
 *
 * Which commit is the working draft is recorded in the database, and only ever
 * moved by `advanceTo`: in one SQLite transaction it checks the draft is still
 * the commit a change was built on, runs the caller's own checks and writes
 * (e.g. marking a change request merged), and moves the pointer. So a writer
 * that stalled can't overwrite a newer draft, and a merge can't land unless its
 * change request is still exactly as it checked it.
 *
 * The database is the only source of truth; git is a projection of it. Every
 * commit is pinned by a ref (refs/concord/commits/<time>-<sha>) before the
 * pointer can name it, so git gc never removes it; pins are dropped once the
 * branch includes them, or straight away if the advance is refused. `sync`
 * (idempotent; run at start-up, after every advance, and by every read that
 * finds git out of line) brings the branch, the release tags (from the
 * published releases' records) and the checked-out files in line with the
 * database. Reads of content go to git objects, never to the checked-out files.
 */
const FILE = 'ontology.ttl';

function repoDir(project: Pick<OntologyProject, 'slug'>) {
  return path.join(config.dataDir, 'ontologies', project.slug);
}

function git(dir: string, args: string[], env: Record<string, string> = {}, opts: { input?: string; extraEnv?: Record<string, string>; raw?: boolean } = {}): string {
  const out = execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    input: opts.input,
    maxBuffer: 256 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: env.name ?? 'Concord',
      GIT_AUTHOR_EMAIL: env.email ?? 'concord@localhost',
      GIT_COMMITTER_NAME: 'Concord',
      GIT_COMMITTER_EMAIL: 'concord@localhost',
      ...opts.extraEnv,
    },
    stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  return opts.raw ? out : out.trim();
}

const graphCache = new Map<string, OntologyGraph>();
const headKey = (project: Pick<OntologyProject, 'slug'>) => `draft-head:${project.slug}`;
const PIN = 'refs/concord/commits/';
const PIN_GRACE_MS = 10 * 60 * 1000;

/** The tags git should have: one per published release, on its recorded commit. */
function releaseTags(project: Pick<OntologyProject, 'slug'>): [string, string, string][] {
  const id = list<OntologyProject>('ontologies').find((p) => p.slug === project.slug)?.id;
  if (!id) return [];
  return list<Release>('releases', id)
    .filter((r) => r.status === 'published' && r.commit)
    .map((r): [string, string, string] => [`v${r.version}`, r.commit!, `Release ${r.version}`])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

/** What the repository should look like, as one string: the draft commit and the release tags. */
const expectedState = (head: string, tags: [string, string, string][]) => `${head} ${createHash('sha1').update(JSON.stringify(tags)).digest('hex')}`;

/** A ref's value, read from the files (no git process), or undefined if it has none. */
function refValue(dir: string, ref: string): string | undefined {
  try {
    const loose = path.join(dir, '.git', ref);
    if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf8').trim();
    const packed = fs.readFileSync(path.join(dir, '.git', 'packed-refs'), 'utf8');
    return packed.split('\n').find((l) => l.endsWith(` ${ref}`))?.split(' ')[0];
  } catch {
    return undefined;
  }
}

/** The branch's commit, read from the files, or undefined if it can't be. */
function branchSha(dir: string): string | undefined {
  try {
    const head = fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8').trim();
    return head.startsWith('ref: ') ? refValue(dir, head.slice(5)) : head;
  } catch {
    return undefined;
  }
}
const stampFile = (dir: string) => path.join(dir, '.git', 'concord-synced');
const syncLockFile = (dir: string) => path.join(dir, '.git', 'concord-sync.lock');

/** A commit on `base` that writes `files` (repository path → content, or null to delete), or `base` itself if nothing changes. Moves nothing. */
function buildCommit(dir: string, base: string, files: Record<string, string | null>, message: string, author: CommitAuthor): string {
  const index = path.join(dir, '.git', `concord-index-${randomUUID()}`);
  const extraEnv = { GIT_INDEX_FILE: index };
  let tree: string;
  try {
    git(dir, ['read-tree', base], {}, { extraEnv });
    for (const [file, content] of Object.entries(files)) {
      if (content === null) {
        git(dir, ['update-index', '--force-remove', file], {}, { extraEnv });
        continue;
      }
      const blob = git(dir, ['hash-object', '-w', '--stdin'], {}, { input: content });
      git(dir, ['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], {}, { extraEnv });
    }
    tree = git(dir, ['write-tree'], {}, { extraEnv });
  } finally {
    fs.rmSync(index, { force: true });
  }
  if (tree === git(dir, ['rev-parse', `${base}^{tree}`])) return base;
  return git(dir, ['commit-tree', tree, '-p', base, '-m', message], { name: author.name, email: author.email ?? 'contributor@concord' });
}

export interface CommitAuthor {
  name: string;
  email?: string;
}

export const ontologyStore = {
  /** The repository folder, with its checkout brought in line with the database first. */
  dir(project: Pick<OntologyProject, 'slug'>): string {
    this.ensureSynced(project);
    return repoDir(project);
  },

  async init(project: OntologyProject, turtle: string, readme: string): Promise<string> {
    const dir = repoDir(project);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(dir, FILE), turtle);
    fs.writeFileSync(path.join(dir, 'README.md'), readme);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', `Create ${project.title}`]);
    const sha = git(dir, ['rev-parse', 'HEAD']);
    put('kv', { id: headKey(project), sha });
    return sha;
  },

  /** The commit that is the working draft. */
  head(project: Pick<OntologyProject, 'slug'>): string {
    const stored = get<{ sha: string }>('kv', headKey(project));
    if (stored) return stored.sha;
    // Not recorded yet (e.g. a repository from before this was): start from the branch.
    const sha = git(repoDir(project), ['rev-parse', 'HEAD']);
    return transaction(() => {
      const now = get<{ sha: string }>('kv', headKey(project));
      if (now) return now.sha;
      put('kv', { id: headKey(project), sha });
      return sha;
    });
  },

  /**
   * Makes `commit` the working draft if it is still `base`, together with
   * `record` (synchronous database writes, which can throw to refuse), in one
   * transaction. Throws 409 if the draft has moved. With commit === base it
   * still checks and records.
   */
  advanceTo(project: Pick<OntologyProject, 'slug'>, base: string, commit: string, record?: (commit: string) => void): void {
    const dir = repoDir(project);
    // Pinned before the database can point at it; unpinned again if it doesn't.
    const pin = `${PIN}${Date.now()}-${commit}`;
    git(dir, ['update-ref', pin, commit]);
    try {
      transaction(() => {
        if (this.head(project) !== base) throw new HttpError(409, 'The working draft changed while this change was being made, so nothing was committed. Try again.');
        record?.(commit);
        put('kv', { id: headKey(project), sha: commit });
      });
    } catch (err) {
      try {
        git(dir, ['update-ref', '-d', pin]);
      } catch {
        /* pruned later */
      }
      throw err;
    }
    // Done: the rest only brings git in line, and any read repairs it if it fails here.
    try {
      this.sync(project);
    } catch (err) {
      console.warn(`[git] ${project.slug}: sync after commit failed, will repair: ${(err as Error).message}`);
    }
  },

  /**
   * Brings git in line with the database if it isn't: checks the branch and
   * the record of the last completed sync against the database (not anything
   * cached in this process), so it notices another process's half-done or
   * older sync. Every read calls it.
   */
  ensureSynced(project: Pick<OntologyProject, 'slug'>): void {
    const dir = repoDir(project);
    const head = this.head(project);
    let stamp = '';
    try {
      stamp = fs.readFileSync(stampFile(dir), 'utf8').trim();
    } catch {
      /* never synced */
    }
    const tags = releaseTags(project);
    if (branchSha(dir) === head && stamp === expectedState(head, tags) && tags.every(([name]) => refValue(dir, `refs/tags/${name}`))) return;
    try {
      this.sync(project);
    } catch (err) {
      console.warn(`[git] ${project.slug}: sync failed, will retry: ${(err as Error).message}`);
    }
  },

  /**
   * Idempotently brings the git branch, release tags and checked-out files in
   * line with the database. Safe to run any time, from any process: syncs run
   * one at a time and each reads the database afresh, so an older one can't
   * undo a newer one, and the record of the last completed sync says exactly
   * what it synced.
   */
  sync(project: Pick<OntologyProject, 'slug'>): void {
    const dir = repoDir(project);
    const lock = syncLockFile(dir);
    try {
      fs.writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Someone else is syncing (from a fresh read, so they will finish the job), unless they died doing it.
      if (Date.now() - fs.statSync(lock).mtimeMs < 30_000) return;
      fs.rmSync(lock, { force: true });
      fs.writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' });
    }
    try {
      fs.rmSync(stampFile(dir), { force: true });
      const target = this.head(project);
      const tags = releaseTags(project);
      if (git(dir, ['rev-parse', 'HEAD']) !== target) git(dir, ['update-ref', '-m', 'concord: sync working draft', 'HEAD', target]);
      for (const [name, commit, message] of tags) {
        let at = '';
        try {
          at = git(dir, ['rev-parse', '-q', '--verify', `refs/tags/${name}^{commit}`]);
        } catch {
          /* missing */
        }
        if (at !== commit) git(dir, ['tag', '-f', '-a', name, '-m', message, commit]);
      }
      // Checked-out files: reset the index and files to the commit (not just compare refs).
      this.checkout(project, target);
      this.prunePins(project, target);
      fs.writeFileSync(stampFile(dir), `${expectedState(target, tags)}\n`);
    } finally {
      fs.rmSync(lock, { force: true });
    }
  },

  /** Drops pins the branch now includes, and pins of advances that never happened (after a grace period for ones in flight). */
  prunePins(project: Pick<OntologyProject, 'slug'>, branch: string): void {
    const dir = repoDir(project);
    const merged = new Set(git(dir, ['for-each-ref', `--merged=${branch}`, '--format=%(refname)', PIN]).split('\n').filter(Boolean));
    for (const ref of git(dir, ['for-each-ref', '--format=%(refname)', PIN]).split('\n').filter(Boolean)) {
      const at = Number(ref.slice(PIN.length).split('-')[0]);
      if (merged.has(ref) || !(Date.now() - at < PIN_GRACE_MS)) git(dir, ['update-ref', '-d', ref]);
    }
  },

  /** Rewrites the index and checked-out files to match `commit`. */
  checkout(project: Pick<OntologyProject, 'slug'>, commit: string): void {
    git(repoDir(project), ['read-tree', '--reset', '-u', commit]);
  },

  /** The working draft as committed (git, not the checked-out file, which is only a mirror of it). */
  readWorkingText(project: Pick<OntologyProject, 'slug'>, commit?: string): string {
    if (!commit) this.ensureSynced(project);
    return git(repoDir(project), ['show', `${commit ?? this.head(project)}:${FILE}`], {}, { raw: true });
  },

  async working(project: Pick<OntologyProject, 'slug'>): Promise<OntologyGraph> {
    return (await this.workingAt(project)).graph;
  },

  /** The working draft and the commit it is from, read together. */
  async workingAt(project: Pick<OntologyProject, 'slug'>): Promise<{ graph: OntologyGraph; head: string }> {
    this.ensureSynced(project);
    const head = this.head(project);
    const key = `${project.slug}@${head}`;
    let g = graphCache.get(key);
    if (!g) {
      g = await OntologyGraph.fromTurtle(this.readWorkingText(project, head));
      graphCache.set(key, g);
    }
    return { graph: g, head };
  },

  /** `ref` is 'working' or a released version like '1.2.0'. */
  async at(project: Pick<OntologyProject, 'slug'>, ref: string | undefined): Promise<OntologyGraph> {
    if (!ref || ref === 'working') return this.working(project);
    this.ensureSynced(project);
    const key = `${project.slug}@v${ref}`;
    let g = graphCache.get(key);
    if (!g) {
      const text = this.readReleaseFile(project, ref, FILE);
      if (text === undefined) throw new HttpError(404, `Version ${ref} not found`);
      g = await OntologyGraph.fromTurtle(text);
      graphCache.set(key, g);
    }
    return g;
  },

  /** A file stored beside a released version (releases/<version>/<name>) in the working draft, from git. */
  readReleaseFile(project: Pick<OntologyProject, 'slug'>, version: string, name: string): string | undefined {
    if (!/^[\w.-]+$/.test(version) || !/^[\w.-]+$/.test(name)) return undefined;
    this.ensureSynced(project);
    try {
      return git(repoDir(project), ['show', `${this.head(project)}:releases/${version}/${name}`], {}, { raw: true });
    } catch {
      return undefined;
    }
  },

  /**
   * Commits a new working draft on top of `base` (default: the current draft),
   * together with `record` (see `advanceTo`). Throws 409, changing nothing, if
   * the draft is no longer `base`, even when the new draft would be identical.
   */
  async commitWorking(project: OntologyProject, graph: OntologyGraph, message: string, author: CommitAuthor, base?: string, record?: (commit: string) => void): Promise<string> {
    const parent = base ?? this.head(project);
    const commit = buildCommit(repoDir(project), parent, { [FILE]: await graph.toTurtle() }, message, author);
    this.advanceTo(project, parent, commit, record);
    return commit;
  },

  async writeRelease(
    project: OntologyProject,
    version: string,
    graph: OntologyGraph,
    files: Record<string, string>,
    notes: string,
    author: CommitAuthor,
    base?: string,
    record?: (commit: string) => void,
  ): Promise<string> {
    const dir = repoDir(project);
    const parent = base ?? this.head(project);
    const turtle = await graph.toTurtle();
    let prev = '';
    try {
      prev = git(dir, ['show', `${parent}:CHANGELOG.md`], {}, { raw: true }).replace(/^# Changelog\n+/, '');
    } catch {
      /* first release */
    }
    // The released file and the working draft are identical at release time.
    const all: Record<string, string> = {
      [FILE]: turtle,
      [`releases/${version}/${FILE}`]: turtle,
      'CHANGELOG.md': `# Changelog\n\n## ${version} — ${new Date().toISOString().slice(0, 10)}\n\n${notes.trim()}\n\n${prev}`,
    };
    for (const [name, content] of Object.entries(files)) all[`releases/${version}/${name}`] = content;
    const commit = buildCommit(dir, parent, all, `Release ${version}`, { name: author.name, email: author.email ?? 'steward@concord' });
    // The release's own bookkeeping (record, which marks it published on this commit, and so tags it) is part of the same advance.
    this.advanceTo(project, parent, commit, record);
    return commit;
  },

  /** Rewrites files beside released versions (releases/<version>/<name>) in one commit; tags stay where they were. */
  updateReleaseFiles(project: Pick<OntologyProject, 'slug'>, files: Record<string, Record<string, string | null>>, message: string): string {
    const all: Record<string, string | null> = {};
    for (const [version, named] of Object.entries(files)) for (const [name, content] of Object.entries(named)) all[`releases/${version}/${name}`] = content;
    const parent = this.head(project);
    const commit = buildCommit(repoDir(project), parent, all, message, { name: 'Concord', email: 'steward@concord' });
    if (commit !== parent) this.advanceTo(project, parent, commit);
    return commit;
  },

  versions(project: Pick<OntologyProject, 'slug'>): string[] {
    this.ensureSynced(project);
    const files = git(repoDir(project), ['ls-tree', '-r', '--name-only', this.head(project), '--', 'releases']).split('\n');
    return files.map((f) => f.match(/^releases\/([^/]+)\/ontology\.ttl$/)?.[1]).filter((v): v is string => !!v);
  },

  log(project: Pick<OntologyProject, 'slug'>, limit = 50) {
    this.ensureSynced(project);
    const out = git(repoDir(project), ['log', `-${limit}`, '--format=%H%x1f%an%x1f%aI%x1f%s', this.head(project)]);
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [sha, author, date, subject] = l.split('\x1f');
        return { sha, author, date, subject };
      });
  },

  /** Push main and tags to a GitHub remote using a token. */
  push(project: OntologyProject, remoteUrl: string) {
    const dir = repoDir(project);
    const remotes = git(dir, ['remote']);
    if (remotes.split('\n').includes('origin')) git(dir, ['remote', 'set-url', 'origin', remoteUrl]);
    else git(dir, ['remote', 'add', 'origin', remoteUrl]);
    this.sync(project);
    git(dir, ['push', '-q', 'origin', 'main', '--follow-tags']);
  },
};
