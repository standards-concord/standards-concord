import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
      const file = path.join(repoDir(project), 'releases', ref, FILE);
      if (!fs.existsSync(file)) throw new HttpError(404, `Version ${ref} not found`);
      g = await OntologyGraph.fromTurtle(fs.readFileSync(file, 'utf8'));
      graphCache.set(key, g);
    }
    return g;
  },

  /**
   * Commits a new working draft on top of `base` (default: the current head).
   * The branch only moves if it is still at `base` (an atomic compare-and-swap
   * of the ref), so a writer that computed its change from an older draft can
   * never overwrite a commit made since: it gets a 409 and nothing changes.
   */
  async commitWorking(project: OntologyProject, graph: OntologyGraph, message: string, author: CommitAuthor, base?: string): Promise<string> {
    const dir = repoDir(project);
    const parent = base ?? this.head(project);
    const blob = git(dir, ['hash-object', '-w', '--stdin'], {}, { input: await graph.toTurtle() });
    const index = path.join(dir, '.git', `concord-index-${randomUUID()}`);
    let tree: string;
    try {
      const extraEnv = { GIT_INDEX_FILE: index };
      git(dir, ['read-tree', parent], {}, { extraEnv });
      git(dir, ['update-index', '--add', '--cacheinfo', `100644,${blob},${FILE}`], {}, { extraEnv });
      tree = git(dir, ['write-tree'], {}, { extraEnv });
    } finally {
      fs.rmSync(index, { force: true });
    }
    if (tree === git(dir, ['rev-parse', `${parent}^{tree}`])) return parent; // nothing changed
    const commit = git(dir, ['commit-tree', tree, '-p', parent, '-m', message], { name: author.name, email: author.email ?? 'contributor@concord' });
    try {
      git(dir, ['update-ref', '-m', 'concord: commit working draft', 'HEAD', commit, parent]);
    } catch {
      throw new HttpError(409, 'The working draft changed while this change was being made, so nothing was committed. Try again.');
    }
    // Bring the checked-out file in line with whatever the branch now holds.
    git(dir, ['checkout', '-q', 'HEAD', '--', FILE]);
    return commit;
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

  /** Push main and tags to a GitHub remote using a token. */
  push(project: OntologyProject, remoteUrl: string) {
    const dir = repoDir(project);
    const remotes = git(dir, ['remote']);
    if (remotes.split('\n').includes('origin')) git(dir, ['remote', 'set-url', 'origin', remoteUrl]);
    else git(dir, ['remote', 'add', 'origin', remoteUrl]);
    git(dir, ['push', '-q', 'origin', 'main', '--follow-tags']);
  },
};
