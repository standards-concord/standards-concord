import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OntologyGraph } from '@concord/core';
import type { OntologyProject } from '@concord/shared';
import { config } from '../config.js';
import { HttpError } from '../db.js';

/**
 * Each ontology is a git repository. The working draft is `ontology.ttl` on
 * `main`; each release is committed under `releases/<version>/` and tagged
 * `v<version>`, so every version IRI keeps resolving and the history is a
 * normal git history that can be pushed to GitHub as-is.
 */
const FILE = 'ontology.ttl';
export const ONTOLOGY_FILE = FILE;

function repoDir(project: Pick<OntologyProject, 'slug'>) {
  return path.join(config.dataDir, 'ontologies', project.slug);
}

function git(dir: string, args: string[], env: Record<string, string> = {}, input?: string): string {
  const { name, email, ...extra } = env;
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: name ?? 'Concord',
      GIT_AUTHOR_EMAIL: email ?? 'concord@localhost',
      GIT_COMMITTER_NAME: 'Concord',
      GIT_COMMITTER_EMAIL: 'concord@localhost',
      ...extra,
    },
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  }).trim();
}

/** Fork branches live under refs/heads/forks/. */
const FORK_PREFIX = 'forks/';
const forkBranch = (forkSlug: string) => `${FORK_PREFIX}${forkSlug}`;

/** A file's content at a commit, exactly (untrimmed), or undefined if it isn't there. */
function show(dir: string, spec: string): string | undefined {
  try {
    return execFileSync('git', ['show', spec], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

/**
 * Write a commit whose tree is `parent`'s with `files` (path → content)
 * replaced (null removes one), without touching the checkout, the index or any branch. Returns
 * undefined when nothing would change, unless `allowEmpty`.
 */
function commitFiles(dir: string, parent: string, files: Record<string, string | null>, message: string, author: CommitAuthor, allowEmpty = false): string | undefined {
  const index = path.join(dir, '.git', `concord-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.index`);
  try {
    const env = { GIT_INDEX_FILE: index };
    git(dir, ['read-tree', parent], env);
    for (const [file, content] of Object.entries(files)) {
      if (content === null) {
        git(dir, ['update-index', '--force-remove', '--', file], env);
        continue;
      }
      const blob = git(dir, ['hash-object', '-w', '--stdin'], env, content);
      git(dir, ['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], env);
    }
    const tree = git(dir, ['write-tree'], env);
    if (!allowEmpty && tree === git(dir, ['rev-parse', `${parent}^{tree}`])) return undefined;
    return git(dir, ['commit-tree', tree, '-p', parent, '-m', message], { name: author.name, email: author.email ?? 'contributor@concord' });
  } finally {
    fs.rmSync(index, { force: true });
  }
}

/** Move main from `from` to `commit` only if it is still at `from` (atomic across processes). */
function casMain(dir: string, commit: string, from: string): boolean {
  try {
    git(dir, ['update-ref', git(dir, ['symbolic-ref', 'HEAD']), commit, from]);
    return true;
  } catch {
    return false;
  }
}

/*
 * Nothing commits from the checkout or its index: every commit on main is
 * built from an exact parent commit and lands with a compare-and-swap on the
 * branch, and readers read commits, not files. The checkout is only kept up
 * to date for people browsing the repository, so updating it never blocks a
 * request for long and never fails one.
 *
 * Updates run under a lock directory (it holds across processes) naming its
 * holder by host, process and a random token. The holder rechecks that it
 * still holds the lock right before writing, and keeps going until the
 * checkout matches HEAD as it is after the write. A
 * lock is taken over when its holder is a process on this host that has
 * died, or when it is far older than any update takes (a holder on another
 * host, or a reused process id).
 */
const LOCK_STALE_MS = 5 * 60_000;
const LOCK_WAIT_MS = 250;
const HOST = os.hostname();
const sleeper = new Int32Array(new SharedArrayBuffer(4));

function lockAbandoned(lock: string): boolean {
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) return true;
    const [host, pid] = fs.readFileSync(path.join(lock, 'owner'), 'utf8').split(':');
    if (host !== HOST) return false; // Can't tell from here: wait for it to go stale.
    try {
      process.kill(Number(pid), 0);
      return false;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ESRCH';
    }
  } catch {
    return false; // Released meanwhile, or the holder hasn't written its name yet.
  }
}

/** Runs `fn(stillHeld)` holding the lock, or returns false without running it if the lock stays busy. */
function withCheckoutLock(dir: string, fn: (stillHeld: () => boolean) => void): boolean {
  const lock = path.join(dir, '.git', 'concord-checkout.lock');
  const owner = path.join(lock, 'owner');
  const token = `${HOST}:${process.pid}:${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const held = () => {
    try {
      return fs.readFileSync(owner, 'utf8') === token;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(owner, token);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (lockAbandoned(lock)) {
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) return false;
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
  try {
    fn(held);
    return true;
  } finally {
    // Only give back our own lock (it may have been taken over).
    if (held()) fs.rmSync(lock, { recursive: true, force: true });
  }
}

/** For tests: runs just before the checkout is written, to reproduce a takeover at that moment. */
export const checkoutTestHooks: { beforeWrite?: () => void } = {};

/**
 * Make the checkout (files and index) match whatever HEAD is now. Best
 * effort: see above. Checking the lock and writing are two steps, so a
 * holder that was taken over in between may write an older checkout over
 * the new holder's. So every write is checked afterwards: a holder carries
 * on until the index matches HEAD's tree (which also undoes a displaced
 * holder's late write while it still holds the lock), and a holder that
 * finds it was displaced takes the lock again and repairs the checkout.
 */
function syncCheckout(dir: string, attempt = 0): void {
  const inSync = () => {
    try {
      return git(dir, ['write-tree']) === git(dir, ['rev-parse', 'HEAD^{tree}']);
    } catch {
      return false;
    }
  };
  let displaced = false;
  try {
    const done = withCheckoutLock(dir, (stillHeld) => {
      for (let i = 0; i < 5; i++) {
        const head = git(dir, ['rev-parse', 'HEAD']);
        if (!stillHeld()) return void (displaced = true);
        checkoutTestHooks.beforeWrite?.();
        git(dir, ['read-tree', '-u', '--reset', head]);
        if (!stillHeld()) return void (displaced = true); // Our write may have landed after the new holder's.
        if (inSync()) return;
      }
    });
    // Busy for longer than a request should wait: the holder, the next update or the next start catches it up.
    if (!done) console.warn(`[ontology] the checkout in ${dir} is being updated by another process`);
  } catch (err) {
    console.warn(`[ontology] could not update the checkout in ${dir}: ${(err as Error).message}`);
  }
  if (displaced && attempt < 3) syncCheckout(dir, attempt + 1);
}

const graphCache = new Map<string, OntologyGraph>();

export interface CommitAuthor {
  name: string;
  email?: string;
}

export const ontologyStore = {
  dir: repoDir,

  async init(project: OntologyProject, turtle: string, readme: string): Promise<string> {
    const dir = repoDir(project);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(dir, FILE), turtle);
    fs.writeFileSync(path.join(dir, 'README.md'), readme);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', `Create ${project.title}`]);
    return this.head(project);
  },

  head(project: Pick<OntologyProject, 'slug'>): string {
    return git(repoDir(project), ['rev-parse', 'HEAD']);
  },

  /** The working draft's Turtle, read from the commit HEAD points at (never from the checkout, which may lag behind). */
  readWorkingText(project: Pick<OntologyProject, 'slug'>): string {
    return this.readAt(project, this.head(project));
  },

  async working(project: Pick<OntologyProject, 'slug'>): Promise<OntologyGraph> {
    return this.graphAt(project, this.head(project));
  },

  /** `ref` is 'working', a released version like '1.2.0', or a development fork 'forks/<fork-slug>'. */
  async at(project: Pick<OntologyProject, 'slug'>, ref: string | undefined): Promise<OntologyGraph> {
    if (!ref || ref === 'working') return this.working(project);
    if (ref.startsWith(FORK_PREFIX)) return this.forkGraph(project, ref.slice(FORK_PREFIX.length));
    const key = `${project.slug}@v${ref}`;
    let g = graphCache.get(key);
    if (!g) {
      const turtle = this.releaseFile(project, ref, FILE);
      if (turtle === undefined) throw new HttpError(404, `Version ${ref} not found`);
      g = await OntologyGraph.fromTurtle(turtle);
      graphCache.set(key, g);
    }
    return g;
  },

  /** Commit a new working draft on top of whatever is there now (seeding and tests; merges use commitWorkingIf). */
  async commitWorking(project: OntologyProject, graph: OntologyGraph, message: string, author: CommitAuthor): Promise<string> {
    return this.commitWorkingIf(project, graph, message, author, this.head(project));
  },

  /**
   * Write a commit of `graph` on top of `parent` without moving any branch.
   * The commit only becomes part of the draft once advanceWorking moves the
   * branch to it, so a merge can record the exact commit it is about to make
   * before making it (and anyone can finish or recognise it after a crash).
   */
  async prepareWorkingCommit(project: Pick<OntologyProject, 'slug'>, graph: OntologyGraph, message: string, author: CommitAuthor, parent: string): Promise<string> {
    return commitFiles(repoDir(project), parent, { [FILE]: await graph.toTurtle() }, message, author, true)!;
  },

  /** Move the draft from `from` to `commit`, only if it is still at `from`. Returns whether it moved. */
  advanceWorking(project: Pick<OntologyProject, 'slug'>, commit: string, from: string): boolean {
    const dir = repoDir(project);
    if (!casMain(dir, commit, from)) return false;
    syncCheckout(dir);
    return true;
  },

  /** Bring the checkout up to HEAD (after a crash, for instance). Nothing depends on it but people browsing the repository. */
  syncCheckout(project: Pick<OntologyProject, 'slug'>): void {
    syncCheckout(repoDir(project));
  },

  /** Is `commit` part of the working draft's history? (A merge that already happened.) */
  inWorking(project: Pick<OntologyProject, 'slug'>, commit: string): boolean {
    try {
      git(repoDir(project), ['merge-base', '--is-ancestor', commit, 'HEAD']);
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Commit a new working draft on top of `expectedHead`, only if the draft is
   * still there. On a 409 nothing is written.
   */
  async commitWorkingIf(project: OntologyProject, graph: OntologyGraph, message: string, author: CommitAuthor, expectedHead: string): Promise<string> {
    const commit = await this.prepareWorkingCommit(project, graph, message, author, expectedHead);
    if (!this.advanceWorking(project, commit, expectedHead)) throw new HttpError(409, 'The working draft changed while this was being merged. Nothing was merged; try again.');
    return commit;
  },

  /**
   * Commit a release on top of `expectedHead` (the draft the release was made
   * from; the current head if not given) and tag it. If anything was merged
   * since, nothing is written (409), so a release can never undo a merge.
   */
  async writeRelease(
    project: OntologyProject,
    version: string,
    graph: OntologyGraph,
    files: Record<string, string>,
    notes: string,
    author: CommitAuthor,
    opts: {
      /** The draft the release was made from (default: the current head). If main moved since, nothing is written. */
      expectedHead?: string;
      /** Runs after the last await, just before anything is written: throwing writes nothing. */
      beforeWrite?: () => void;
    } = {},
  ): Promise<string> {
    const dir = repoDir(project);
    const parent = opts.expectedHead ?? this.head(project);
    const turtle = await graph.toTurtle();
    // From here to the branch update nothing awaits, so nothing else in this process runs in between.
    opts.beforeWrite?.();
    const prev = (show(dir, `${parent}:CHANGELOG.md`) ?? '').replace(/^# Changelog\n+/, '');
    const entries: Record<string, string> = {
      // The released file and the working draft are identical at release time.
      [FILE]: turtle,
      [`releases/${version}/${FILE}`]: turtle,
      'CHANGELOG.md': `# Changelog\n\n## ${version} — ${new Date().toISOString().slice(0, 10)}\n\n${notes.trim()}\n\n${prev}`,
    };
    for (const [name, content] of Object.entries(files)) entries[`releases/${version}/${name}`] = content;
    const commit = commitFiles(dir, parent, entries, `Release ${version}`, { name: author.name, email: author.email ?? 'steward@concord' }, true)!;
    if (!this.advanceWorking(project, commit, parent))
      throw new HttpError(409, 'The working draft changed while this release was being prepared. Nothing was published; try again.');
    git(dir, ['tag', '-a', `v${version}`, commit, '-m', `Release ${version}`]);
    return commit;
  },

  /**
   * Commit `files` (path → content, null removes it) on top of the latest
   * draft without touching the checkout. Built on the head it read, so a merge
   * landing meanwhile makes it try again on top of that.
   */
  commitOnMain(project: Pick<OntologyProject, 'slug'>, files: Record<string, string | null>, message: string): string {
    const dir = repoDir(project);
    for (let attempt = 0; attempt < 5; attempt++) {
      const parent = this.head(project);
      const commit = commitFiles(dir, parent, files, message, { name: 'Concord', email: 'steward@concord' });
      if (!commit) return parent;
      if (this.advanceWorking(project, commit, parent)) return commit;
    }
    throw new HttpError(409, 'The ontology kept changing while this was being saved. Try again.');
  },

  /** Rewrites files beside released versions (releases/<version>/<name>; null removes one) in one commit; tags stay where they were. */
  updateReleaseFiles(project: Pick<OntologyProject, 'slug'>, files: Record<string, Record<string, string | null>>, message: string): string {
    const entries: Record<string, string | null> = {};
    for (const [version, named] of Object.entries(files)) for (const [name, content] of Object.entries(named)) entries[`releases/${version}/${name}`] = content;
    return this.commitOnMain(project, entries, message);
  },

  /** Rewrites one file at the root of the repository (e.g. CHANGELOG.md) in its own commit. */
  updateRepoFile(project: Pick<OntologyProject, 'slug'>, name: string, content: string, message: string): string {
    return this.commitOnMain(project, { [name]: content }, message);
  },

  /** A file stored beside a released version (releases/<version>/<name>), as committed. */
  releaseFile(project: Pick<OntologyProject, 'slug'>, version: string, name: string): string | undefined {
    if (!/^[\w.+-]+$/.test(version) || !/^[\w.+-]+$/.test(name)) return undefined;
    return show(repoDir(project), `HEAD:releases/${version}/${name}`);
  },



  /** Drops cached released graphs, after their files were rewritten. */
  forgetReleases(project: Pick<OntologyProject, 'slug'>) {
    for (const key of [...graphCache.keys()]) if (key.startsWith(`${project.slug}@v`)) graphCache.delete(key);
  },

  versions(project: Pick<OntologyProject, 'slug'>): string[] {
    const files = git(repoDir(project), ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'releases']);
    return files
      .split('\n')
      .map((f) => /^releases\/([^/]+)\/ontology\.ttl$/.exec(f)?.[1])
      .filter((v): v is string => !!v);
  },

  log(project: Pick<OntologyProject, 'slug'>, limit = 50) {
    const out = git(repoDir(project), ['log', `-${limit}`, '--format=%H%x1f%an%x1f%aI%x1f%s']);
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [sha, author, date, subject] = l.split('\x1f');
        return { sha, author, date, subject };
      });
  },

  /* ---------------------------------------------------------------------- */
  /* Development forks: branches that never touch the working tree          */
  /* ---------------------------------------------------------------------- */

  forkBranch,

  /** Start a fork branch at the current head of main. Returns the commit it starts from. */
  createFork(project: Pick<OntologyProject, 'slug'>, forkSlug: string): string {
    const dir = repoDir(project);
    const head = this.head(project);
    git(dir, ['branch', forkBranch(forkSlug), head]);
    return head;
  },

  forkExists(project: Pick<OntologyProject, 'slug'>, forkSlug: string): boolean {
    try {
      git(repoDir(project), ['rev-parse', '--verify', '--quiet', `refs/heads/${forkBranch(forkSlug)}`]);
      return true;
    } catch {
      return false;
    }
  },

  forkHead(project: Pick<OntologyProject, 'slug'>, forkSlug: string): string {
    if (!this.forkExists(project, forkSlug)) throw new HttpError(404, `Fork ${forkSlug} not found`);
    return git(repoDir(project), ['rev-parse', `refs/heads/${forkBranch(forkSlug)}`]);
  },

  /** ontology.ttl exactly as committed at `commit`. */
  readAt(project: Pick<OntologyProject, 'slug'>, commit: string): string {
    const text = show(repoDir(project), `${commit}:${FILE}`);
    if (text === undefined) throw new HttpError(404, `No ontology at ${commit}`);
    return text;
  },

  async forkGraph(project: Pick<OntologyProject, 'slug'>, forkSlug: string): Promise<OntologyGraph> {
    const head = this.forkHead(project, forkSlug);
    const key = `${project.slug}@${head}`;
    let g = graphCache.get(key);
    if (!g) {
      g = await OntologyGraph.fromTurtle(this.readAt(project, head));
      graphCache.set(key, g);
    }
    return g;
  },

  /** The ontology as it was at a commit (a fork's base, for three-way comparisons). */
  async graphAt(project: Pick<OntologyProject, 'slug'>, commit: string): Promise<OntologyGraph> {
    const key = `${project.slug}@${commit}`;
    let g = graphCache.get(key);
    if (!g) {
      g = await OntologyGraph.fromTurtle(this.readAt(project, commit));
      graphCache.set(key, g);
    }
    return g;
  },

  /**
   * Commit a new ontology.ttl to a fork branch without checking it out: the
   * blob goes into a throwaway index built from the branch's tree, so main's
   * working tree is never touched. `expectedParent` is the head the caller
   * read the fork's graph at: the ref only moves if it is still there, so an
   * edit based on a stale graph fails instead of overwriting a newer one. A
   * sync passes the upstream head in `extraParents` so the history shows it.
   */
  async commitFork(
    project: Pick<OntologyProject, 'slug'>,
    forkSlug: string,
    graph: OntologyGraph,
    message: string,
    author: CommitAuthor,
    opts: { expectedParent: string; extraParents?: string[] },
  ): Promise<string> {
    const dir = repoDir(project);
    const branch = forkBranch(forkSlug);
    const parent = opts.expectedParent;
    const index = path.join(dir, '.git', `concord-fork-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.index`);
    try {
      const env = { GIT_INDEX_FILE: index };
      const blob = git(dir, ['hash-object', '-w', '--stdin'], env, await graph.toTurtle());
      git(dir, ['read-tree', parent], env);
      git(dir, ['update-index', '--add', '--cacheinfo', `100644,${blob},${FILE}`], env);
      const tree = git(dir, ['write-tree'], env);
      const parents = [parent, ...(opts.extraParents ?? []).filter((p) => p !== parent)].flatMap((p) => ['-p', p]);
      const commit = git(dir, ['commit-tree', tree, ...parents, '-m', message], { name: author.name, email: author.email ?? 'developer@concord' });
      try {
        git(dir, ['update-ref', `refs/heads/${branch}`, commit, parent]);
      } catch {
        throw new HttpError(409, 'The fork changed while this edit was being prepared. Reload it and try again.');
      }
      return commit;
    } finally {
      fs.rmSync(index, { force: true });
    }
  },

  /**
   * Move a fork branch back from `from` to `to`, only if it is still at
   * `from`: undoes a commit whose fork record could not be saved.
   */
  rewindFork(project: Pick<OntologyProject, 'slug'>, forkSlug: string, to: string, from: string): boolean {
    try {
      git(repoDir(project), ['update-ref', `refs/heads/${forkBranch(forkSlug)}`, to, from]);
      return true;
    } catch {
      return false;
    }
  },

  /** Commits on main since `commit` (how far a fork has fallen behind). */
  commitsSince(project: Pick<OntologyProject, 'slug'>, commit: string): number {
    try {
      return Number(git(repoDir(project), ['rev-list', '--count', `${commit}..main`]));
    } catch {
      return 0;
    }
  },

  /** The fork's own commits (newest first), not the upstream ones it was synced with. */
  forkLog(project: Pick<OntologyProject, 'slug'>, forkSlug: string, limit = 50) {
    const out = git(repoDir(project), ['log', `-${limit}`, '--first-parent', '--format=%H%x1f%an%x1f%aI%x1f%s', `refs/heads/${forkBranch(forkSlug)}`, '^refs/heads/main']);
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
    git(dir, ['push', '-q', 'origin', 'main', '--follow-tags']);
  },
};
