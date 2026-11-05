import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { OntologyGraph } from '@concord/core';
import type { OntologyProject, Release } from '@concord/shared';
import { config } from '../config.js';
import { get, HttpError, list, put, remove, transaction } from '../db.js';

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
 * The database is the only source of truth; git is a projection of it.
 * Every new commit is pinned by a ref of its writer's own
 * (refs/concord/commits/<sha>-t<time>-<writer>) before the pointer can name it,
 * so git gc never removes it. The draft itself is held by refs/concord/draft,
 * which only ever moves forward to the draft the database names; a pin is
 * dropped once that ref holds its commit, by its writer if its advance is
 * refused, or, if its writer never finished, once it is reclaimed (see
 * prunePins). So pins never pile up. `sync` (idempotent; run at start-up, after
 * every advance, and by every read that finds git out of line) brings the
 * branch, the release tags (from the published releases' records) and the
 * checked-out files in line with the database. Reads of content go to git
 * objects, never to the checked-out files.
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
/** Holds the working draft (and so all its history) for git: moved only forward, to the database's draft. */
const DRAFT_REF = 'refs/concord/draft';
/** A pin this old whose commit never became the draft belongs to a writer that died or stalled; it is reclaimed. */
export const PIN_GRACE_MS = 10 * 60 * 1000;
const revokedKey = (writer: string) => `pin-revoked:${writer}`;
/** When a pin from an earlier version (with no writer or time in its name) was first seen. */
const seenKey = (project: Pick<OntologyProject, 'slug'>, ref: string) => `pin-seen:${project.slug}:${ref.slice(PIN.length)}`;
/** Pins are looked at by ordinary reads at most this often per repository (a throttle only: correctness never depends on it). */
const PRUNE_EVERY_MS = 60_000;
const lastPruned = new Map<string, number>();

/** Whether any pins exist, read from the files (no git process). */
function hasPins(dir: string): boolean {
  try {
    if (fs.readdirSync(path.join(dir, '.git', PIN)).length) return true;
  } catch {
    /* none loose */
  }
  try {
    return fs.readFileSync(path.join(dir, '.git', 'packed-refs'), 'utf8').includes(` ${PIN}`);
  } catch {
    return false;
  }
}
const syncKey = (project: Pick<OntologyProject, 'slug'>) => `git-sync:${project.slug}`;
/** A sync that hasn't shown it is alive for this long is presumed dead, and its lease can be taken over. */
export const SYNC_LEASE_MS = 30_000;

/**
 * Who is syncing a repository: a lease in the database, so taking it, renewing
 * it and giving it up are each atomic across processes. A sync checks it still
 * holds the lease before each change it makes to git, and only ever gives up
 * its own, so one that was presumed dead and replaced stops instead of undoing
 * its successor's work, and can't release its successor's lease.
 */
const syncLease = {
  take(project: Pick<OntologyProject, 'slug'>, token: string): boolean {
    return transaction(() => {
      const held = get<{ token: string; until: number }>('kv', syncKey(project));
      if (held && held.until > Date.now()) return false;
      put('kv', { id: syncKey(project), token, until: Date.now() + SYNC_LEASE_MS });
      return true;
    });
  },
  /** Throws if this sync has lost the lease; otherwise renews it. */
  renew(project: Pick<OntologyProject, 'slug'>, token: string): void {
    transaction(() => {
      if (get<{ token: string }>('kv', syncKey(project))?.token !== token) throw new Error('another sync took over');
      put('kv', { id: syncKey(project), token, until: Date.now() + SYNC_LEASE_MS });
    });
  },
  give(project: Pick<OntologyProject, 'slug'>, token: string): void {
    transaction(() => {
      if (get<{ token: string }>('kv', syncKey(project))?.token === token) remove('kv', syncKey(project));
    });
  },
};

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

/** Whether the index and checked-out files are exactly `commit`'s (git compares them; the stamp alone can't show it). */
function checkedOut(dir: string, commit: string): boolean {
  try {
    git(dir, ['diff-index', '--quiet', commit, '--']);
    return true;
  } catch {
    return false;
  }
}

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
   * transaction. Throws 409 if the draft has moved, or if this writer took so
   * long that its pin was reclaimed. With commit === base it still checks and
   * records.
   */
  advanceTo(project: Pick<OntologyProject, 'slug'>, base: string, commit: string, record?: (commit: string) => void): void {
    const dir = repoDir(project);
    // The draft only ever moves forward, which is what lets pins of its ancestors be dropped (see prunePins).
    if (commit !== base) {
      try {
        git(dir, ['merge-base', '--is-ancestor', base, commit]);
      } catch {
        throw new Error(`${commit} does not build on ${base}`);
      }
    }
    // A new commit is pinned (by a ref only this writer uses) before the database can point at it, and
    // unpinned again if it doesn't. The draft (commit === base) is already held.
    const writer = randomUUID();
    const pin = commit === base ? undefined : `${PIN}${commit}-t${Date.now()}-${writer}`;
    if (pin) git(dir, ['update-ref', pin, commit]);
    try {
      transaction(() => {
        if (this.head(project) !== base) throw new HttpError(409, 'The working draft changed while this change was being made, so nothing was committed. Try again.');
        // Reclaiming a pin is recorded in the database first (see prunePins), so either this sees it, or the reclaimer sees this.
        if (pin && get('kv', revokedKey(writer))) throw new HttpError(409, 'This change took too long to record, so nothing was committed. Try again.');
        record?.(commit);
        put('kv', { id: headKey(project), sha: commit });
      });
    } catch (err) {
      try {
        if (pin) git(dir, ['update-ref', '-d', pin]);
      } catch {
        /* reclaimed later */
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
   * Brings git in line with the database if it isn't: checks the branch, the
   * tags, the record of the last completed sync and the checked-out files
   * themselves against the database (not anything cached in this process), so
   * it notices another process's half-done, older or overtaken sync. Every
   * read calls it.
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
    if (branchSha(dir) === head && stamp === expectedState(head, tags) && tags.every(([name]) => refValue(dir, `refs/tags/${name}`)) && checkedOut(dir, head)) {
      // In line; but pins of writers that died are only reclaimed once they are old, so look at them now and then.
      if (Date.now() - (lastPruned.get(project.slug) ?? 0) >= PRUNE_EVERY_MS && hasPins(dir)) {
        try {
          this.prunePins(project);
        } catch (err) {
          console.warn(`[git] ${project.slug}: pin cleanup failed, will retry: ${(err as Error).message}`);
        }
      }
      return;
    }
    try {
      this.sync(project);
    } catch (err) {
      console.warn(`[git] ${project.slug}: sync failed, will retry: ${(err as Error).message}`);
    }
  },

  /**
   * Idempotently brings the git branch, release tags and checked-out files in
   * line with the database. Safe to run any time, from any process: syncs run
   * one at a time (see `syncLease`) and each reads the database afresh, so an
   * older one can't undo a newer one, and the record of the last completed
   * sync says exactly what it synced. Whatever a sync that was overtaken
   * writes anyway is caught by the next read (see `ensureSynced`).
   */
  sync(project: Pick<OntologyProject, 'slug'>): void {
    const dir = repoDir(project);
    const token = randomUUID();
    // Someone else is syncing, from a fresh read, so they will finish the job (if they died, their lease lapses).
    if (!syncLease.take(project, token)) return;
    const owner = () => syncLease.renew(project, token);
    try {
      fs.rmSync(stampFile(dir), { force: true });
      const target = this.head(project);
      const tags = releaseTags(project);
      owner();
      if (git(dir, ['rev-parse', 'HEAD']) !== target) git(dir, ['update-ref', '-m', 'concord: sync working draft', 'HEAD', target]);
      for (const [name, commit, message] of tags) {
        let at = '';
        try {
          at = git(dir, ['rev-parse', '-q', '--verify', `refs/tags/${name}^{commit}`]);
        } catch {
          /* missing */
        }
        if (at !== commit) {
          owner();
          git(dir, ['tag', '-f', '-a', name, '-m', message, commit]);
        }
      }
      // Checked-out files: reset the index and files to the commit (not just compare refs).
      owner();
      this.checkout(project, target);
      this.prunePins(project);
      owner();
      fs.writeFileSync(stampFile(dir), `${expectedState(target, tags)}\n`);
    } finally {
      syncLease.give(project, token);
    }
  },

  /**
   * Moves refs/concord/draft forward to the database's draft, then drops every
   * pin it now holds, and reclaims pins whose writer never finished.
   *
   * The ref only moves forward (to a descendant, compare-and-swapped), so
   * however stale the caller, it holds only commits the draft has held, and
   * dropping their pins is safe. A pin outside it that is older than
   * PIN_GRACE_MS is reclaimed in a database transaction that first checks the
   * draft still doesn't include its commit and records the reclaim, which its
   * writer checks in its own transaction: so either the writer recorded its
   * commit first (and it is kept), or it never will.
   */
  prunePins(project: Pick<OntologyProject, 'slug'>): void {
    const dir = repoDir(project);
    lastPruned.set(project.slug, Date.now());
    const has = (ancestor: string, of: string) => {
      try {
        git(dir, ['merge-base', '--is-ancestor', ancestor, of]);
        return true;
      } catch {
        return false;
      }
    };
    const head = this.head(project);
    let draft = '';
    try {
      draft = git(dir, ['rev-parse', '-q', '--verify', `${DRAFT_REF}^{commit}`]);
    } catch {
      /* not set yet */
    }
    if (draft !== head && (!draft || has(draft, head))) {
      git(dir, ['update-ref', '-m', 'concord: working draft', DRAFT_REF, head, draft]);
      draft = head;
    }
    if (!draft) return;
    const held = new Set(git(dir, ['for-each-ref', `--merged=${draft}`, '--format=%(refname)', PIN]).split('\n').filter(Boolean));
    for (const line of git(dir, ['for-each-ref', '--format=%(objectname) %(refname)', PIN]).split('\n').filter(Boolean)) {
      const [sha, ref] = line.split(' ');
      // <sha>-t<time>-<writer>. A pin from an earlier version has neither, and its writer (which may still be
      // running, e.g. during a deploy) doesn't check for reclaims: its grace period runs from when it was first seen.
      const [, at, writer] = /^[0-9a-f]+-t(\d+)-(.+)$/.exec(ref.slice(PIN.length)) ?? [];
      if (!held.has(ref)) {
        const since = writer
          ? Number(at)
          : transaction(() => {
              const seen = get<{ at: number }>('kv', seenKey(project, ref));
              if (seen) return seen.at;
              put('kv', { id: seenKey(project, ref), at: Date.now() });
              return Date.now();
            });
        if (Date.now() - since < PIN_GRACE_MS) continue;
        const reclaimed = transaction(() => {
          const now = this.head(project);
          if (now === sha || has(sha, now)) return false;
          if (writer) put('kv', { id: revokedKey(writer), at: new Date().toISOString() });
          return true;
        });
        if (!reclaimed) continue;
      }
      git(dir, ['update-ref', '-d', ref, sha]);
      if (!writer) remove('kv', seenKey(project, ref));
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
