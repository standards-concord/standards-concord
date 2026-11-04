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

function git(dir: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: env.name ?? 'Concord',
      GIT_AUTHOR_EMAIL: env.email ?? 'concord@localhost',
      GIT_COMMITTER_NAME: 'Concord',
      GIT_COMMITTER_EMAIL: 'concord@localhost',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
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

  async commitWorking(project: OntologyProject, graph: OntologyGraph, message: string, author: CommitAuthor): Promise<string> {
    return this.commitWorkingText(project, await graph.toTurtle(), message, author);
  },

  /** Synchronous, so callers can check state and commit with nothing running in between. */
  commitWorkingText(project: OntologyProject, turtle: string, message: string, author: CommitAuthor): string {
    const dir = repoDir(project);
    fs.writeFileSync(path.join(dir, FILE), turtle);
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
