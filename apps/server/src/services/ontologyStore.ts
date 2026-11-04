import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { OntologyGraph } from '@concord/core';
import type { OntologyProject } from '@concord/shared';
import { config } from '../config.js';
import { get, HttpError, put, transaction } from '../db.js';

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
 * commit gets a durable ref (refs/concord/commits/<sha>) before the pointer can
 * name it, so git gc never removes it, and `sync` (idempotent; run at start-up,
 * after every advance, and before anything reads the checkout) brings the
 * branch, release tags and checked-out files in line with the database. Reads
 * of content go to git objects, never to the checked-out files.
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
const tagsKey = (project: Pick<OntologyProject, 'slug'>) => `draft-tags:${project.slug}`;
/** The draft commit this process last fully synced the checkout to, per ontology. */
const syncedTo = new Map<string, string>();

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
   * still checks and records. `tag` records a release tag to create on it.
   */
  advanceTo(project: Pick<OntologyProject, 'slug'>, base: string, commit: string, record?: (commit: string) => void, tag?: { name: string; message: string }): void {
    // Durable before the database can point at it.
    git(repoDir(project), ['update-ref', `refs/concord/commits/${commit}`, commit]);
    transaction(() => {
      if (this.head(project) !== base) throw new HttpError(409, 'The working draft changed while this change was being made, so nothing was committed. Try again.');
      record?.(commit);
      put('kv', { id: headKey(project), sha: commit });
      if (tag) {
        const tags = get<{ tags: Record<string, { commit: string; message: string }> }>('kv', tagsKey(project))?.tags ?? {};
        put('kv', { id: tagsKey(project), tags: { ...tags, [tag.name]: { commit, message: tag.message } } });
      }
    });
    // Done: the rest only brings git in line, and is repaired later if it fails here.
    try {
      this.sync(project);
    } catch (err) {
      console.warn(`[git] ${project.slug}: sync after commit failed, will repair: ${(err as Error).message}`);
    }
  },

  /** Brings the checkout in line with the database, unless this process already has for the current draft. */
  ensureSynced(project: Pick<OntologyProject, 'slug'>): void {
    if (syncedTo.get(project.slug) === this.head(project)) return;
    try {
      this.sync(project);
    } catch (err) {
      console.warn(`[git] ${project.slug}: sync failed, will retry: ${(err as Error).message}`);
    }
  },

  /**
   * Idempotently brings the git branch, release tags and checked-out files in
   * line with the database. Safe to run any time, from any process.
   */
  sync(project: Pick<OntologyProject, 'slug'>): void {
    const dir = repoDir(project);
    syncedTo.delete(project.slug);
    // Branch: read it before the pointer (which only moves forwards), then compare-and-swap, so a slower syncer can't move it back.
    let target = '';
    for (let i = 0; i < 5; i++) {
      const branch = git(dir, ['rev-parse', 'HEAD']);
      target = this.head(project);
      if (branch === target) break;
      try {
        git(dir, ['update-ref', '-m', 'concord: sync working draft', 'HEAD', target, branch]);
        break;
      } catch {
        if (i === 4) throw new Error('could not move the branch');
      }
    }
    // Release tags.
    const tags = get<{ tags: Record<string, { commit: string; message: string }> }>('kv', tagsKey(project))?.tags ?? {};
    for (const [name, t] of Object.entries(tags)) {
      let at = '';
      try {
        at = git(dir, ['rev-parse', '-q', '--verify', `refs/tags/${name}^{commit}`]);
      } catch {
        /* missing */
      }
      if (at !== t.commit) git(dir, ['tag', '-f', '-a', name, '-m', t.message, t.commit]);
    }
    // Checked-out files: reset the index and files to the commit (not just compare refs).
    this.checkout(project, target);
    syncedTo.set(project.slug, target);
  },

  /** Rewrites the index and checked-out files to match `commit`. */
  checkout(project: Pick<OntologyProject, 'slug'>, commit: string): void {
    git(repoDir(project), ['read-tree', '--reset', '-u', commit]);
  },

  /** The working draft as committed (git, not the checked-out file, which is only a mirror of it). */
  readWorkingText(project: Pick<OntologyProject, 'slug'>, commit = 'HEAD'): string {
    return git(repoDir(project), ['show', `${commit}:${FILE}`], {}, { raw: true });
  },

  async working(project: Pick<OntologyProject, 'slug'>): Promise<OntologyGraph> {
    return (await this.workingAt(project)).graph;
  },

  /** The working draft and the commit it is from, read together. */
  async workingAt(project: Pick<OntologyProject, 'slug'>): Promise<{ graph: OntologyGraph; head: string }> {
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
    // The release's own bookkeeping (record) and its tag are part of the same advance.
    this.advanceTo(project, parent, commit, record, { name: `v${version}`, message: `Release ${version}` });
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
    const files = git(repoDir(project), ['ls-tree', '-r', '--name-only', this.head(project), '--', 'releases']).split('\n');
    return files.map((f) => f.match(/^releases\/([^/]+)\/ontology\.ttl$/)?.[1]).filter((v): v is string => !!v);
  },

  log(project: Pick<OntologyProject, 'slug'>, limit = 50) {
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
