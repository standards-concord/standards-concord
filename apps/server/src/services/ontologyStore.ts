import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
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

  readWorkingText(project: Pick<OntologyProject, 'slug'>): string {
    return fs.readFileSync(path.join(repoDir(project), FILE), 'utf8');
  },

  async working(project: Pick<OntologyProject, 'slug'>): Promise<OntologyGraph> {
    const key = `${project.slug}@${this.head(project)}`;
    let g = graphCache.get(key);
    if (!g) {
      g = await OntologyGraph.fromTurtle(this.readWorkingText(project));
      graphCache.set(key, g);
    }
    return g;
  },

  /** `ref` is 'working', a released version like '1.2.0', or a development fork 'forks/<fork-slug>'. */
  async at(project: Pick<OntologyProject, 'slug'>, ref: string | undefined): Promise<OntologyGraph> {
    if (!ref || ref === 'working') return this.working(project);
    if (ref.startsWith(FORK_PREFIX)) return this.forkGraph(project, ref.slice(FORK_PREFIX.length));
    const key = `${project.slug}@v${ref}`;
    let g = graphCache.get(key);
    if (!g) {
      const file = path.join(repoDir(project), 'releases', ref, FILE);
      if (!fs.existsSync(file)) throw new HttpError(404, `Version ${ref} not found`);
      g = await OntologyGraph.fromTurtle(fs.readFileSync(file, 'utf8'));
      graphCache.set(key, g);
    }
    return g;
  },

  async commitWorking(project: OntologyProject, graph: OntologyGraph, message: string, author: CommitAuthor): Promise<string> {
    const dir = repoDir(project);
    fs.writeFileSync(path.join(dir, FILE), await graph.toTurtle());
    git(dir, ['add', FILE]);
    const status = git(dir, ['status', '--porcelain']);
    if (status) git(dir, ['commit', '-q', '-m', message], { name: author.name, email: author.email ?? 'contributor@concord' });
    return this.head(project);
  },

  async writeRelease(
    project: OntologyProject,
    version: string,
    graph: OntologyGraph,
    files: Record<string, string>,
    notes: string,
    author: CommitAuthor,
  ): Promise<string> {
    const dir = repoDir(project);
    const relDir = path.join(dir, 'releases', version);
    fs.mkdirSync(relDir, { recursive: true });
    const turtle = await graph.toTurtle();
    // The released file and the working draft are identical at release time.
    fs.writeFileSync(path.join(dir, FILE), turtle);
    fs.writeFileSync(path.join(relDir, FILE), turtle);
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(relDir, name), content);
    const changelog = path.join(dir, 'CHANGELOG.md');
    const prev = fs.existsSync(changelog) ? fs.readFileSync(changelog, 'utf8').replace(/^# Changelog\n+/, '') : '';
    fs.writeFileSync(changelog, `# Changelog\n\n## ${version} — ${new Date().toISOString().slice(0, 10)}\n\n${notes.trim()}\n\n${prev}`);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', `Release ${version}`], { name: author.name, email: author.email ?? 'steward@concord' });
    git(dir, ['tag', '-a', `v${version}`, '-m', `Release ${version}`]);
    return this.head(project);
  },

  /** Rewrites files beside released versions (releases/<version>/<name>) in one commit; tags stay where they were. */
  updateReleaseFiles(project: Pick<OntologyProject, 'slug'>, files: Record<string, Record<string, string>>, message: string): string {
    const dir = repoDir(project);
    for (const [version, named] of Object.entries(files))
      for (const [name, content] of Object.entries(named)) fs.writeFileSync(path.join(dir, 'releases', version, name), content);
    git(dir, ['add', 'releases']);
    if (git(dir, ['status', '--porcelain'])) git(dir, ['commit', '-q', '-m', message], { name: 'Concord', email: 'steward@concord' });
    return this.head(project);
  },

  versions(project: Pick<OntologyProject, 'slug'>): string[] {
    const relRoot = path.join(repoDir(project), 'releases');
    if (!fs.existsSync(relRoot)) return [];
    return fs.readdirSync(relRoot).filter((v) => fs.existsSync(path.join(relRoot, v, FILE)));
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

  readAt(project: Pick<OntologyProject, 'slug'>, commit: string): string {
    return git(repoDir(project), ['show', `${commit}:${FILE}`]);
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
