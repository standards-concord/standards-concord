import { OntologyGraph } from '@concord/core';
import type { OntologyProject } from '@concord/shared';
import { clearAll, get, HttpError, put, transaction } from '../db.js';
import {
  countBetween,
  dateOrderLog,
  firstParentLog,
  getRef,
  ident,
  isAncestor,
  isoDate,
  listDir,
  readCommit,
  readFile,
  setRef,
  subject,
  writeCommit,
  entryAt,
  writeTree,
  type Commit,
} from './gitdb.js';
import type { CommitAuthor, OntologyStoreApi } from './ontologyStore.js';

/**
 * The ontology store with no disk and no git (ONTOLOGY_STORE=db, the default on Postgres): each ontology's history
 * is git's own objects, kept in the database by gitdb.ts with their real ids. It behaves as the git-backed store
 * does (ontologyStore.ts), with the same layout (`ontology.ttl` on main, releases under `releases/<version>/`).
 *
 * The working draft is the commit named by the `draft-head:<slug>` row, moved only by `advanceTo`, as in the git
 * store. Objects are written before anything names them and never deleted, so there is nothing to pin, prune or
 * bring in line: no pins, no sync, no claim on the repositories. A fork's branch is a ref row, moved in the same
 * transaction as the fork's record. Release tags are made when the history is published to GitHub (githubOutbox.ts), from the published releases'
 * records, as the git store makes them from the same records.
 */

const FILE = 'ontology.ttl';
const headKey = (project: Pick<OntologyProject, 'slug'>) => `draft-head:${project.slug}`;
const forkBranch = (forkSlug: string) => `forks/${forkSlug}`;
const forkRef = (forkSlug: string) => `refs/heads/${forkBranch(forkSlug)}`;
const graphCache = new Map<string, OntologyGraph>();

const noFolder = () => new Error('With ONTOLOGY_STORE=db ontologies have no repository folder.');

/** As the git store's commits: the author as given, the committer Concord, both now. */
async function buildCommit(base: string, files: Record<string, string | null>, message: string, author: CommitAuthor, opts: { parents?: string[]; always?: boolean } = {}): Promise<string> {
  const from = await readCommit(base);
  const tree = await writeTree(from.tree, files);
  if (!opts.always && !opts.parents?.length && tree === from.tree) return base;
  const now = new Date();
  return await writeCommit({
    tree,
    parents: [base, ...(opts.parents ?? []).filter((p) => p !== base)],
    author: ident(author.name, author.email ?? 'contributor@concord', now),
    committer: ident('Concord', 'concord@localhost', now),
    message,
  });
}

const logEntry = (c: Commit) => ({ sha: c.sha, author: c.author.name, date: isoDate(c.author), subject: subject(c) });

async function must<T>(value: Promise<T | undefined>, what: string): Promise<T> {
  const v = await value;
  if (v === undefined) throw new HttpError(404, what);
  return v;
}

export const dbStore = {
  kind: 'db' as const,

  async dir(): Promise<string> {
    throw noFolder();
  },

  async init(project: OntologyProject, turtle: string, readme: string): Promise<string> {
    const tree = await writeTree(undefined, { [FILE]: turtle, 'README.md': readme });
    const who = ident('Concord', 'concord@localhost');
    const sha = await writeCommit({ tree, parents: [], author: who, committer: who, message: `Create ${project.title}` });
    await transaction(async () => {
      await put('kv', { id: headKey(project), sha });
    });
    return sha;
  },

  async head(project: Pick<OntologyProject, 'slug'>): Promise<string> {
    const stored = await get<{ sha: string }>('kv', headKey(project));
    if (!stored) throw new HttpError(404, `No history for ${project.slug}`);
    return stored.sha;
  },

  /** As the git store's: moves the draft from `base` to `commit` (a descendant), with `record`, in one transaction. */
  async advanceTo(project: Pick<OntologyProject, 'slug'>, base: string, commit: string, record?: (commit: string) => Promise<void> | void): Promise<void> {
    if (commit !== base && !(await isAncestor(base, commit))) throw new Error(`${commit} does not build on ${base}`);
    await transaction(async () => {
      if ((await this.head(project)) !== base) throw new HttpError(409, 'The working draft changed while this change was being made, so nothing was committed. Try again.');
      await record?.(commit);
      await put('kv', { id: headKey(project), sha: commit });
    });
  },

  /** Nothing to bring in line: the database is the repository. */
  async ensureSynced(): Promise<void> {},
  async sync(): Promise<void> {},
  async prunePins(): Promise<void> {},
  async recoverWipe(): Promise<void> {},
  async checkout(): Promise<void> {
    throw noFolder();
  },

  async readWorkingText(project: Pick<OntologyProject, 'slug'>, commit?: string): Promise<string> {
    const at = commit ?? (await this.head(project));
    return await must(readFile(at, FILE), `No ontology at ${at}`);
  },

  async working(project: Pick<OntologyProject, 'slug'>): Promise<OntologyGraph> {
    return (await this.workingAt(project)).graph;
  },

  async workingAt(project: Pick<OntologyProject, 'slug'>): Promise<{ graph: OntologyGraph; head: string }> {
    const head = await this.head(project);
    return { graph: await this.graphAt(project, head), head };
  },

  async at(project: Pick<OntologyProject, 'slug'>, ref: string | undefined): Promise<OntologyGraph> {
    if (!ref || ref === 'working') return this.working(project);
    // Keyed by the release file's own id, not its name: another instance can reset the demo and release the same
    // version again with other content, and only this instance's cache would be cleared.
    const entry = /^[\w.-]+$/.test(ref) ? await entryAt((await readCommit(await this.head(project))).tree, `releases/${ref}/${FILE}`) : undefined;
    if (!entry) throw new HttpError(404, `Version ${ref} not found`);
    const key = `${project.slug}@v${ref}@${entry.sha}`;
    let g = graphCache.get(key);
    if (!g) {
      const text = await this.readReleaseFile(project, ref, FILE);
      if (text === undefined) throw new HttpError(404, `Version ${ref} not found`);
      g = await OntologyGraph.fromTurtle(text);
      graphCache.set(key, g);
    }
    return g;
  },

  async readReleaseFile(project: Pick<OntologyProject, 'slug'>, version: string, name: string): Promise<string | undefined> {
    if (!/^[\w.-]+$/.test(version) || !/^[\w.-]+$/.test(name)) return undefined;
    return await readFile(await this.head(project), `releases/${version}/${name}`);
  },

  async commitWorking(project: OntologyProject, graph: OntologyGraph, message: string, author: CommitAuthor, base?: string, record?: (commit: string) => Promise<void> | void): Promise<string> {
    const parent = base ?? (await this.head(project));
    const commit = await buildCommit(parent, { [FILE]: await graph.toTurtle() }, message, author);
    await this.advanceTo(project, parent, commit, record);
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
    record?: (commit: string) => Promise<void> | void,
  ): Promise<string> {
    const parent = base ?? (await this.head(project));
    const turtle = await graph.toTurtle();
    const prev = ((await readFile(parent, 'CHANGELOG.md')) ?? '').replace(/^# Changelog\n+/, '');
    const all: Record<string, string> = {
      [FILE]: turtle,
      [`releases/${version}/${FILE}`]: turtle,
      'CHANGELOG.md': `# Changelog\n\n## ${version} — ${new Date().toISOString().slice(0, 10)}\n\n${notes.trim()}\n\n${prev}`,
    };
    for (const [name, content] of Object.entries(files)) all[`releases/${version}/${name}`] = content;
    const commit = await buildCommit(parent, all, `Release ${version}`, { name: author.name, email: author.email ?? 'steward@concord' });
    await this.advanceTo(project, parent, commit, record);
    return commit;
  },

  async updateReleaseFiles(project: Pick<OntologyProject, 'slug'>, files: Record<string, Record<string, string | null>>, message: string): Promise<string> {
    const all: Record<string, string | null> = {};
    for (const [version, named] of Object.entries(files)) for (const [name, content] of Object.entries(named)) all[`releases/${version}/${name}`] = content;
    const parent = await this.head(project);
    const commit = await buildCommit(parent, all, message, { name: 'Concord', email: 'steward@concord' });
    if (commit !== parent) await this.advanceTo(project, parent, commit);
    return commit;
  },

  async updateRepoFile(project: Pick<OntologyProject, 'slug'>, name: string, content: string, message: string): Promise<string> {
    if (!/^[\w.-]+$/.test(name) || name === FILE) throw new Error(`Not a repository file Concord rewrites: ${name}`);
    const parent = await this.head(project);
    const commit = await buildCommit(parent, { [name]: content }, message, { name: 'Concord', email: 'steward@concord' });
    if (commit !== parent) await this.advanceTo(project, parent, commit);
    return commit;
  },

  forgetReleases(project: Pick<OntologyProject, 'slug'>) {
    for (const key of [...graphCache.keys()]) if (key.startsWith(`${project.slug}@v`)) graphCache.delete(key);
  },

  async versions(project: Pick<OntologyProject, 'slug'>): Promise<string[]> {
    const head = await this.head(project);
    const out: string[] = [];
    for (const e of await listDir(head, 'releases')) if ((await listDir(head, `releases/${e.name}`)).some((f) => f.name === FILE)) out.push(e.name);
    return out;
  },

  async log(project: Pick<OntologyProject, 'slug'>, limit = 50) {
    return (await dateOrderLog([await this.head(project)], { limit })).map(logEntry);
  },

  /** Empties the database (by default; `clear` runs in the transaction), which holds every repository too. */
  async wipe(clear: () => Promise<void> = clearAll): Promise<void> {
    await transaction(clear);
    graphCache.clear();
  },

  forkBranch,

  async hasForkBranch(project: Pick<OntologyProject, 'slug'>, forkSlug: string): Promise<boolean> {
    return (await getRef(project.slug, forkRef(forkSlug))) !== undefined;
  },

  async readAt(project: Pick<OntologyProject, 'slug'>, commit: string): Promise<string> {
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new HttpError(404, `No ontology at ${commit || 'an empty commit'}`);
    try {
      return await must(readFile(commit, FILE), `No ontology at ${commit}`);
    } catch {
      throw new HttpError(404, `No ontology at ${commit}`);
    }
  },

  async commitOf(project: Pick<OntologyProject, 'slug'>, commit: string): Promise<{ parent?: string; subject: string }> {
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new HttpError(404, `No commit ${commit || '(empty)'}`);
    let c: Commit;
    try {
      c = await readCommit(commit);
    } catch {
      throw new HttpError(404, `No commit ${commit}`);
    }
    return { parent: c.parents[0], subject: subject(c) };
  },

  async graphAt(project: Pick<OntologyProject, 'slug'>, commit: string): Promise<OntologyGraph> {
    const key = `${project.slug}@${commit}`;
    let g = graphCache.get(key);
    if (!g) {
      g = await OntologyGraph.fromTurtle(await this.readAt(project, commit));
      graphCache.set(key, g);
    }
    return g;
  },

  /**
   * As the git store's: commits `graph` on `parent` and runs `record`. Here the fork's branch moves in the same
   * transaction as `record`: a new fork's branch must not exist yet, and an existing one moves only from `parent`.
   */
  async commitFork(
    project: Pick<OntologyProject, 'slug'>,
    forkSlug: string,
    graph: OntologyGraph,
    message: string,
    author: CommitAuthor,
    opts: { parent: string; extraParents?: string[]; create?: boolean },
    record: (commit: string) => Promise<void>,
  ): Promise<string> {
    const commit = await buildCommit(opts.parent, { [FILE]: await graph.toTurtle() }, message, { name: author.name, email: author.email ?? 'developer@concord' }, { parents: opts.extraParents, always: true });
    await transaction(async () => {
      const at = await getRef(project.slug, forkRef(forkSlug));
      // (The fork's record is what decides whether `parent` is still its head; this is the second line of defence.)
      const moved = opts.create ? at !== undefined : at !== undefined && at !== opts.parent && !(await isAncestor(at, opts.parent));
      if (moved)
        throw new HttpError(409, opts.create ? `A fork called “${forkSlug}” already exists. Pick another name.` : 'The fork changed while this edit was being prepared. Reload it and try again.');
      await record(commit);
      await setRef(project.slug, forkRef(forkSlug), commit);
    });
    return commit;
  },

  async holdFork(): Promise<void> {},

  async commitsSince(project: Pick<OntologyProject, 'slug'>, commit: string): Promise<number> {
    try {
      return await countBetween(commit, await this.head(project));
    } catch {
      return 0;
    }
  },

  async forkLog(project: Pick<OntologyProject, 'slug'>, head: string, limit = 50) {
    return (await firstParentLog(head, { limit, exclude: [await this.head(project)] })).map(logEntry);
  },

  /** Publishing from the database store is a job recorded with each release (githubOutbox.ts), not a call. */
  async publish(project: OntologyProject): Promise<void> {
    throw new Error(`${project.slug}: with ONTOLOGY_STORE=db, releases are published to GitHub by the outbox (githubOutbox.ts).`);
  },
} satisfies OntologyStoreApi;
