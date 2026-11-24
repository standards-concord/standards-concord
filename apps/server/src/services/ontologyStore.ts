import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { OntologyGraph } from '@concord/core';
import type { OntologyProject, Release } from '@concord/shared';
import { config } from '../config.js';
import { clearAll, get, HttpError, list, put, remove, transaction } from '../db.js';
import { dbStore } from './ontologyStoreDb.js';

/**
 * Each ontology is a git repository. The working draft is `ontology.ttl` on
 * `main`; each release is committed under `releases/<version>/` and tagged
 * `v<version>`, so every version IRI keeps resolving and the history is a
 * normal git history that can be pushed to GitHub as-is.
 *
 * Which commit is the working draft is recorded in the database, and only ever
 * moved by `advanceTo`: in one database transaction it checks the draft is still
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
export const ONTOLOGY_FILE = FILE;

function repoDir(project: Pick<OntologyProject, 'slug'>) {
  return path.join(config.dataDir, 'ontologies', project.slug);
}

/** git commands that change nothing (in the repository or anywhere else). Every other one first checks this process may change the repositories. */
const READS = new Set(['rev-parse', 'show', 'ls-tree', 'for-each-ref', 'merge-base', 'diff-index', 'log', 'cat-file']);

async function git(dir: string, args: string[], env: Record<string, string> = {}, opts: { input?: string; extraEnv?: Record<string, string>; raw?: boolean } = {}): Promise<string> {
  if (!READS.has(args[0]) && !(args[0] === 'remote' && args.length === 1)) await assertStoreHeld();
  const out = execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    input: opts.input,
    maxBuffer: 256 * 1024 * 1024,
    // A git that hangs (a stuck disk, a lock) fails the step instead of holding the lock forever.
    // The database never waits on git: commits are built before the draft pointer moves, and
    // brought into the branch after, so a failure here is repaired by the next read.
    timeout: 120_000,
    killSignal: 'SIGKILL',
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
/** Fork branches are refs/heads/forks/<slug>; fork commits not yet on one are held by refs under FORK_PIN (see commitFork). */
const forkBranch = (forkSlug: string) => `forks/${forkSlug}`;
const FORK_PIN = 'refs/concord/fork-pins/';
/** update-ref's "must not exist yet" old value. */
const NO_SHA = '0000000000000000000000000000000000000000';

/**
 * Only one server process may change the repositories at a time: two running
 * different versions could disagree about how pins are named and reclaimed,
 * and nothing is gained from two of the same. So the process claims them at
 * start-up (one claim, with this process's own token) and keeps the claim
 * alive. Every change to the working draft (in its transaction) and every
 * git command or file write that changes anything (immediately before it
 * runs) first checks the claim is still this process's, renewing it if it is
 * more than a few seconds old, so that no other process can take over for
 * the next STORE_CLAIM_MS. If it isn't this process's (it stalled long enough
 * for another to start), it changes nothing and the process exits. What
 * remains is a process that stalls for longer than STORE_CLAIM_MS inside one
 * of those steps, between the check and the write. Upgrades are therefore
 * exclusive (docs/deploy.md). A process that never claimed (tests, scripts)
 * may write only while no live claim exists.
 */
export const STORE_VERSION = 2;
const STORE_KEY = 'git-store';
const STORE_CLAIM_MS = 30_000;
/** A check renews a claim older than this, so every guarded step starts with nearly STORE_CLAIM_MS before anyone else could take over. */
const STORE_RENEW_MS = 5_000;
type StoreClaim = { id: string; owner: string; version: number; until: number };
let ownClaim: { owner: string; onLost: (err: Error) => void; lost: boolean; renewed: number } | undefined;

/**
 * Throws (and, if this process held the claim, reports it lost) unless this
 * process may change the repositories now. Call inside the transaction of a
 * database change it guards, and immediately before any other write.
 */
async function assertStoreHeld(): Promise<void> {
  if (ownClaim) {
    const mine = ownClaim;
    const due = Date.now() - mine.renewed >= STORE_RENEW_MS;
    // Checked, and renewed if it is getting old, in one transaction: still ours means nobody took over (that rewrites the owner).
    const held =
      !mine.lost &&
      await transaction(async () => {
        const claim = await get<StoreClaim>('kv', STORE_KEY);
        if (claim?.owner !== mine.owner) return false;
        if (due) {
          await put('kv', { ...claim, until: Date.now() + STORE_CLAIM_MS });
          mine.renewed = Date.now();
        }
        return true;
      });
    if (held) return;
    const err = new HttpError(503, 'This server lost its hold on the repositories to another one, so it changed nothing and is stopping.');
    if (!ownClaim.lost) {
      ownClaim.lost = true;
      ownClaim.onLost(err);
    }
    throw err;
  }
  const claim = await get<StoreClaim>('kv', STORE_KEY);
  if (claim && claim.until > Date.now()) throw new HttpError(503, `Another Concord server (store v${claim.version}) holds the repositories, so nothing was changed.`);
}

/**
 * Claims the repositories for this process (at start-up), waiting up to
 * `waitMs` for another process's claim to lapse (a stopped one's does within
 * STORE_CLAIM_MS); throws if it doesn't. `onLost` runs once if the claim is
 * ever found to be another's (default: exit). Returns `renew`, to call every
 * few seconds, and `release`, which gives up only this process's own claim.
 */
export async function claimGitStore(opts: { waitMs?: number; onLost?: (err: Error) => void } = {}): Promise<{ renew: () => Promise<void>; release: () => Promise<void> }> {
  const owner = randomUUID();
  const onLost =
    opts.onLost ??
    ((err: Error) => {
      console.error(`[git] ${err.message}`);
      process.exit(1);
    });
  const take = async () =>
    await transaction(async () => {
      const claim = await get<StoreClaim>('kv', STORE_KEY);
      if (claim && claim.owner !== owner && claim.until > Date.now())
        throw new Error(`Another Concord server (store v${claim.version}) is still using these repositories. Stop it before starting this one.`);
      await put('kv', { id: STORE_KEY, owner, version: STORE_VERSION, until: Date.now() + STORE_CLAIM_MS });
    });
  for (const giveUp = Date.now() + (opts.waitMs ?? STORE_CLAIM_MS + 5_000); ; ) {
    try {
      await take();
      break;
    } catch (err) {
      if (Date.now() >= giveUp) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  const mine = { owner, onLost, lost: false, renewed: Date.now() };
  ownClaim = mine;
  return {
    renew: async () => {
      try {
        await transaction(async () => {
          await assertStoreHeld();
          await put('kv', { id: STORE_KEY, owner, version: STORE_VERSION, until: Date.now() + STORE_CLAIM_MS });
          mine.renewed = Date.now();
        });
      } catch {
        /* reported through onLost */
      }
    },
    release: async () => {
      await transaction(async () => {
        if ((await get<StoreClaim>('kv', STORE_KEY))?.owner === owner) await remove('kv', STORE_KEY);
      });
      if (ownClaim === mine) ownClaim = undefined;
    },
  };
}

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
  async take(project: Pick<OntologyProject, 'slug'>, token: string): Promise<boolean> {
    return await transaction(async () => {
      await assertStoreHeld();
      const held = await get<{ token: string; until: number }>('kv', syncKey(project));
      if (held && held.until > Date.now()) return false;
      await put('kv', { id: syncKey(project), token, until: Date.now() + SYNC_LEASE_MS });
      return true;
    });
  },
  /** Throws if this sync has lost the lease; otherwise renews it. */
  async renew(project: Pick<OntologyProject, 'slug'>, token: string): Promise<void> {
    await transaction(async () => {
      await assertStoreHeld();
      if ((await get<{ token: string }>('kv', syncKey(project)))?.token !== token) throw new Error('another sync took over');
      await put('kv', { id: syncKey(project), token, until: Date.now() + SYNC_LEASE_MS });
    });
  },
  async give(project: Pick<OntologyProject, 'slug'>, token: string): Promise<void> {
    await transaction(async () => {
      if ((await get<{ token: string }>('kv', syncKey(project)))?.token === token) await remove('kv', syncKey(project));
    });
  },
};

/** The tags git should have: one per published release, on its recorded commit. */
async function releaseTags(project: Pick<OntologyProject, 'slug'>): Promise<[string, string, string][]> {
  const id = (await list<OntologyProject>('ontologies')).find((p) => p.slug === project.slug)?.id;
  if (!id) return [];
  return (await list<Release>('releases', id))
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
async function checkedOut(dir: string, commit: string): Promise<boolean> {
  try {
    await git(dir, ['diff-index', '--quiet', commit, '--']);
    return true;
  } catch {
    return false;
  }
}

/**
 * A commit on `base` that writes `files` (repository path → content, or null to delete), or `base` itself if nothing changes
 * (unless `always`: a fork records closing it even when nothing changed). `parents` are extra parents (a fork's sync names the
 * upstream draft it took in). Moves nothing.
 */
async function buildCommit(dir: string, base: string, files: Record<string, string | null>, message: string, author: CommitAuthor, opts: { parents?: string[]; always?: boolean } = {}): Promise<string> {
  const index = path.join(dir, '.git', `concord-index-${randomUUID()}`);
  const extraEnv = { GIT_INDEX_FILE: index };
  let tree: string;
  try {
    await git(dir, ['read-tree', base], {}, { extraEnv });
    for (const [file, content] of Object.entries(files)) {
      if (content === null) {
        await git(dir, ['update-index', '--force-remove', file], {}, { extraEnv });
        continue;
      }
      const blob = await git(dir, ['hash-object', '-w', '--stdin'], {}, { input: content });
      await git(dir, ['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], {}, { extraEnv });
    }
    tree = await git(dir, ['write-tree'], {}, { extraEnv });
  } finally {
    // (If this process no longer holds the repositories, the temporary index is left for its successor to ignore.)
    try {
      await assertStoreHeld();
      fs.rmSync(index, { force: true });
    } catch {
      /* the error that matters is already on its way */
    }
  }
  if (!opts.always && !opts.parents?.length && tree === await git(dir, ['rev-parse', `${base}^{tree}`])) return base;
  const parents = [base, ...(opts.parents ?? []).filter((p) => p !== base)].flatMap((p) => ['-p', p]);
  return await git(dir, ['commit-tree', tree, ...parents, '-m', message], { name: author.name, email: author.email ?? 'contributor@concord' });
}

export interface CommitAuthor {
  name: string;
  email?: string;
}

export const gitStore = {
  kind: 'git' as const,

  /** The repository folder, with its checkout brought in line with the database first. */
  async dir(project: Pick<OntologyProject, 'slug'>): Promise<string> {
    await this.ensureSynced(project);
    return repoDir(project);
  },

  async init(project: OntologyProject, turtle: string, readme: string): Promise<string> {
    const dir = repoDir(project);
    await assertStoreHeld();
    fs.mkdirSync(dir, { recursive: true });
    await git(dir, ['init', '-q', '-b', 'main']);
    await assertStoreHeld();
    fs.writeFileSync(path.join(dir, FILE), turtle);
    await assertStoreHeld();
    fs.writeFileSync(path.join(dir, 'README.md'), readme);
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-q', '-m', `Create ${project.title}`]);
    const sha = await git(dir, ['rev-parse', 'HEAD']);
    await transaction(async () => {
      await assertStoreHeld();
      await put('kv', { id: headKey(project), sha });
    });
    return sha;
  },

  /** The commit that is the working draft. */
  async head(project: Pick<OntologyProject, 'slug'>): Promise<string> {
    const stored = await get<{ sha: string }>('kv', headKey(project));
    if (stored) return stored.sha;
    // Not recorded yet (e.g. a repository from before this was): start from the branch.
    const sha = await git(repoDir(project), ['rev-parse', 'HEAD']);
    return await transaction(async () => {
      const now = await get<{ sha: string }>('kv', headKey(project));
      if (now) return now.sha;
      await assertStoreHeld();
      await put('kv', { id: headKey(project), sha });
      return sha;
    });
  },

  /**
   * Makes `commit` the working draft if it is still `base`, together with
   * `record` (database writes, which can throw to refuse; awaited inside the
   * transaction, so it must not wait on anything slow), in one transaction. Throws 409 if the draft has moved, or if this writer took so
   * long that its pin was reclaimed. With commit === base it still checks and
   * records.
   */
  async advanceTo(project: Pick<OntologyProject, 'slug'>, base: string, commit: string, record?: (commit: string) => Promise<void> | void): Promise<void> {
    const dir = repoDir(project);
    // The draft only ever moves forward, which is what lets pins of its ancestors be dropped (see prunePins).
    if (commit !== base) {
      try {
        await git(dir, ['merge-base', '--is-ancestor', base, commit]);
      } catch {
        throw new Error(`${commit} does not build on ${base}`);
      }
    }
    // A new commit is pinned (by a ref only this writer uses) before the database can point at it, and
    // unpinned again if it doesn't. The draft (commit === base) is already held.
    const writer = randomUUID();
    const pin = commit === base ? undefined : `${PIN}${commit}-t${Date.now()}-${writer}`;
    await transaction(assertStoreHeld);
    if (pin) await git(dir, ['update-ref', pin, commit]);
    try {
      await transaction(async () => {
        if (await this.head(project) !== base) throw new HttpError(409, 'The working draft changed while this change was being made, so nothing was committed. Try again.');
        await assertStoreHeld();
        // Reclaiming a pin is recorded in the database first (see prunePins), so either this sees it, or the reclaimer sees this.
        if (pin && await get('kv', revokedKey(writer))) throw new HttpError(409, 'This change took too long to record, so nothing was committed. Try again.');
        await record?.(commit);
        await put('kv', { id: headKey(project), sha: commit });
      });
    } catch (err) {
      try {
        if (pin) await git(dir, ['update-ref', '-d', pin]);
      } catch {
        /* reclaimed later */
      }
      throw err;
    }
    // Done: the rest only brings git in line, and any read repairs it if it fails here.
    try {
      await this.sync(project);
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
  async ensureSynced(project: Pick<OntologyProject, 'slug'>): Promise<void> {
    // Read-only (the cutover): the repositories are left exactly as they are, pins and refs included. Reads go by
    // the database's head and the objects, which don't need the checkout.
    if (config.readOnly) return;
    const dir = repoDir(project);
    const head = await this.head(project);
    let stamp = '';
    try {
      stamp = fs.readFileSync(stampFile(dir), 'utf8').trim();
    } catch {
      /* never synced */
    }
    const tags = await releaseTags(project);
    if (branchSha(dir) === head && stamp === expectedState(head, tags) && tags.every(([name]) => refValue(dir, `refs/tags/${name}`)) && await checkedOut(dir, head)) {
      // In line; but pins of writers that died are only reclaimed once they are old, so look at them now and then.
      if (Date.now() - (lastPruned.get(project.slug) ?? 0) >= PRUNE_EVERY_MS && hasPins(dir)) {
        try {
          await this.prunePins(project);
        } catch (err) {
          console.warn(`[git] ${project.slug}: pin cleanup failed, will retry: ${(err as Error).message}`);
        }
      }
      return;
    }
    try {
      await this.sync(project);
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
  async sync(project: Pick<OntologyProject, 'slug'>): Promise<void> {
    const dir = repoDir(project);
    const token = randomUUID();
    // Someone else is syncing, from a fresh read, so they will finish the job (if they died, their lease lapses).
    if (!await syncLease.take(project, token)) return;
    const owner = async () => await syncLease.renew(project, token);
    try {
      await assertStoreHeld();
      fs.rmSync(stampFile(dir), { force: true });
      const target = await this.head(project);
      const tags = await releaseTags(project);
      await owner();
      if (await git(dir, ['rev-parse', 'HEAD']) !== target) await git(dir, ['update-ref', '-m', 'concord: sync working draft', 'HEAD', target]);
      for (const [name, commit, message] of tags) {
        let at = '';
        try {
          at = await git(dir, ['rev-parse', '-q', '--verify', `refs/tags/${name}^{commit}`]);
        } catch {
          /* missing */
        }
        if (at !== commit) {
          await owner();
          await git(dir, ['tag', '-f', '-a', name, '-m', message, commit]);
        }
      }
      // Checked-out files: reset the index and files to the commit (not just compare refs).
      await owner();
      await this.checkout(project, target);
      await this.prunePins(project);
      await owner();
      fs.writeFileSync(stampFile(dir), `${expectedState(target, tags)}\n`);
    } finally {
      await syncLease.give(project, token);
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
  async prunePins(project: Pick<OntologyProject, 'slug'>): Promise<void> {
    const dir = repoDir(project);
    lastPruned.set(project.slug, Date.now());
    await transaction(assertStoreHeld);
    const has = async (ancestor: string, of: string) => {
      try {
        await git(dir, ['merge-base', '--is-ancestor', ancestor, of]);
        return true;
      } catch {
        return false;
      }
    };
    const head = await this.head(project);
    let draft = '';
    try {
      draft = await git(dir, ['rev-parse', '-q', '--verify', `${DRAFT_REF}^{commit}`]);
    } catch {
      /* not set yet */
    }
    if (draft !== head && (!draft || await has(draft, head))) {
      await git(dir, ['update-ref', '-m', 'concord: working draft', DRAFT_REF, head, draft]);
      draft = head;
    }
    if (!draft) return;
    const held = new Set((await git(dir, ['for-each-ref', `--merged=${draft}`, '--format=%(refname)', PIN])).split('\n').filter(Boolean));
    for (const line of (await git(dir, ['for-each-ref', '--format=%(objectname) %(refname)', PIN])).split('\n').filter(Boolean)) {
      const [sha, ref] = line.split(' ');
      // <sha>-t<time>-<writer>. A pin named any other way was made by a writer that doesn't check for
      // reclaims, so it is never reclaimed: it is only dropped once the draft holds its commit.
      const [, at, writer] = /^[0-9a-f]+-t(\d+)-(.+)$/.exec(ref.slice(PIN.length)) ?? [];
      if (!held.has(ref)) {
        if (!writer || Date.now() - Number(at) < PIN_GRACE_MS) continue;
        const reclaimed = await transaction(async () => {
          await assertStoreHeld();
          const now = await this.head(project);
          if (now === sha || await has(sha, now)) return false;
          await put('kv', { id: revokedKey(writer), at: new Date().toISOString() });
          return true;
        });
        if (!reclaimed) continue;
      }
      await git(dir, ['update-ref', '-d', ref, sha]);
    }
  },

  /** Rewrites the index and checked-out files to match `commit`. */
  async checkout(project: Pick<OntologyProject, 'slug'>, commit: string): Promise<void> {
    await git(repoDir(project), ['read-tree', '--reset', '-u', commit]);
  },

  /** The working draft as committed (git, not the checked-out file, which is only a mirror of it). */
  async readWorkingText(project: Pick<OntologyProject, 'slug'>, commit?: string): Promise<string> {
    if (!commit) await this.ensureSynced(project);
    return await git(repoDir(project), ['show', `${commit ?? await this.head(project)}:${FILE}`], {}, { raw: true });
  },

  async working(project: Pick<OntologyProject, 'slug'>): Promise<OntologyGraph> {
    return (await this.workingAt(project)).graph;
  },

  /** The working draft and the commit it is from, read together. */
  async workingAt(project: Pick<OntologyProject, 'slug'>): Promise<{ graph: OntologyGraph; head: string }> {
    await this.ensureSynced(project);
    const head = await this.head(project);
    const key = `${project.slug}@${head}`;
    let g = graphCache.get(key);
    if (!g) {
      g = await OntologyGraph.fromTurtle(await this.readWorkingText(project, head));
      graphCache.set(key, g);
    }
    return { graph: g, head };
  },

  /** `ref` is 'working' or a released version like '1.2.0'. */
  async at(project: Pick<OntologyProject, 'slug'>, ref: string | undefined): Promise<OntologyGraph> {
    if (!ref || ref === 'working') return this.working(project);
    await this.ensureSynced(project);
    const key = `${project.slug}@v${ref}`;
    let g = graphCache.get(key);
    if (!g) {
      const text = await this.readReleaseFile(project, ref, FILE);
      if (text === undefined) throw new HttpError(404, `Version ${ref} not found`);
      g = await OntologyGraph.fromTurtle(text);
      graphCache.set(key, g);
    }
    return g;
  },

  /** A file stored beside a released version (releases/<version>/<name>) in the working draft, from git. */
  async readReleaseFile(project: Pick<OntologyProject, 'slug'>, version: string, name: string): Promise<string | undefined> {
    if (!/^[\w.-]+$/.test(version) || !/^[\w.-]+(?:\/[\w.-]+)*$/.test(name) || name.split('/').some((part) => part === '.' || part === '..')) return undefined;
    await this.ensureSynced(project);
    try {
      return await git(repoDir(project), ['show', `${await this.head(project)}:releases/${version}/${name}`], {}, { raw: true });
    } catch {
      return undefined;
    }
  },

  /**
   * Commits a new working draft on top of `base` (default: the current draft),
   * together with `record` (see `advanceTo`). Throws 409, changing nothing, if
   * the draft is no longer `base`, even when the new draft would be identical.
   */
  async commitWorking(project: OntologyProject, graph: OntologyGraph, message: string, author: CommitAuthor, base?: string, record?: (commit: string) => Promise<void> | void): Promise<string> {
    const parent = base ?? await this.head(project);
    const commit = await buildCommit(repoDir(project), parent, { [FILE]: await graph.toTurtle() }, message, author);
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
    /** Runs inside the transaction that moves the draft (see advanceTo): throwing writes nothing. */
    record?: (commit: string) => Promise<void> | void,
  ): Promise<string> {
    const dir = repoDir(project);
    const parent = base ?? await this.head(project);
    const turtle = await graph.toTurtle();
    let prev = '';
    try {
      prev = (await git(dir, ['show', `${parent}:CHANGELOG.md`], {}, { raw: true })).replace(/^# Changelog\n+/, '');
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
    const commit = await buildCommit(dir, parent, all, `Release ${version}`, { name: author.name, email: author.email ?? 'steward@concord' });
    // The release's own bookkeeping (record, which marks it published on this commit, and so tags it) is part of the same advance.
    await this.advanceTo(project, parent, commit, record);
    return commit;
  },

  /** Rewrites files beside released versions (releases/<version>/<name>) in one commit; tags stay where they were. */
  async updateReleaseFiles(project: Pick<OntologyProject, 'slug'>, files: Record<string, Record<string, string | null>>, message: string): Promise<string> {
    const all: Record<string, string | null> = {};
    for (const [version, named] of Object.entries(files)) for (const [name, content] of Object.entries(named)) all[`releases/${version}/${name}`] = content;
    const parent = await this.head(project);
    const commit = await buildCommit(repoDir(project), parent, all, message, { name: 'Concord', email: 'steward@concord' });
    if (commit !== parent) await this.advanceTo(project, parent, commit);
    return commit;
  },

  /** A root file as committed, optionally at a particular commit rather than the working draft. */
  async readRepoFile(project: Pick<OntologyProject, 'slug'>, name: string, commit?: string): Promise<string | undefined> {
    if (!/^[\w.-]+$/.test(name)) return undefined;
    await this.ensureSynced(project);
    const head = commit ?? await this.head(project);
    try {
      return await git(repoDir(project), ['show', `${head}:${name}`], {}, { raw: true });
    } catch {
      return undefined;
    }
  },

  /** Rewrites one root file in its own commit, only if the draft is still `base` when given. */
  async updateRepoFile(project: Pick<OntologyProject, 'slug'>, name: string, content: string, message: string, base?: string): Promise<string> {
    if (!/^[\w.-]+$/.test(name) || name === FILE) throw new Error(`Not a repository file Concord rewrites: ${name}`);
    const parent = base ?? await this.head(project);
    const commit = await buildCommit(repoDir(project), parent, { [name]: content }, message, { name: 'Concord', email: 'steward@concord' });
    if (commit !== parent || base !== undefined) await this.advanceTo(project, parent, commit);
    return commit;
  },

  /** Drops cached released graphs, after their files were rewritten. */
  forgetReleases(project: Pick<OntologyProject, 'slug'>) {
    for (const key of [...graphCache.keys()]) if (key.startsWith(`${project.slug}@v`)) graphCache.delete(key);
  },

  /** Deletes one ontology's repository (an interrupted demo seed's: simulation.ts), the way `wipe` deletes them all. */
  async forget(project: Pick<OntologyProject, 'slug'>): Promise<void> {
    const dir = repoDir(project);
    const trash = path.join(config.dataDir, `.ontologies-deleted-${randomUUID()}`);
    await transaction(async () => {
      await assertStoreHeld();
      if (fs.existsSync(dir)) fs.renameSync(dir, trash);
    });
    fs.rmSync(trash, { recursive: true, force: true });
    for (const key of [...graphCache.keys()]) if (key.startsWith(project.slug)) graphCache.delete(key);
    lastPruned.delete(project.slug);
  },

  async versions(project: Pick<OntologyProject, 'slug'>): Promise<string[]> {
    await this.ensureSynced(project);
    const files = (await git(repoDir(project), ['ls-tree', '-r', '--name-only', await this.head(project), '--', 'releases'])).split('\n');
    return files.map((f) => f.match(/^releases\/([^/]+)\/ontology\.ttl$/)?.[1]).filter((v): v is string => !!v);
  },

  async log(project: Pick<OntologyProject, 'slug'>, limit = 50) {
    await this.ensureSynced(project);
    const out = await git(repoDir(project), ['log', `-${limit}`, '--format=%H%x1f%an%x1f%aI%x1f%s', await this.head(project)]);
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [sha, author, date, subject] = l.split('\x1f');
        // Newer git writes UTC as Z; keep +00:00, as older git (and the database store) write it.
        return { sha, author, date: date.replace(/Z$/, '+00:00'), subject };
      });
  },

  /**
   * Deletes every repository and, with `clear` (which empties the database,
   * in this transaction), every database row (a demo reset), keeping this
   * process's hold on the repositories: only while it has it.
   */
  async wipe(clear: () => Promise<void> = clearAll): Promise<void> {
    // The repositories are moved out of the way inside the checked transaction (a takeover needs that write lock,
    // so can't happen in between), to a place only this process uses; deleting them afterwards can't touch a successor's.
    const repos = path.join(config.dataDir, 'ontologies');
    const trash = path.join(config.dataDir, `.ontologies-deleted-${randomUUID()}`);
    await transaction(async () => {
      await assertStoreHeld();
      const claim = await get<StoreClaim>('kv', STORE_KEY);
      await clear();
      if (claim) await put('kv', claim);
      if (fs.existsSync(repos)) fs.renameSync(repos, trash);
    });
    fs.rmSync(trash, { recursive: true, force: true });
    graphCache.clear();
    lastPruned.clear();
  },

  /**
   * At start-up: undoes a wipe that a crash interrupted before its
   * transaction committed. That case is unambiguous only when there is exactly
   * one moved-aside folder, no repositories folder, and the database still
   * has its ontologies: then the folder is moved back. Anything else is left
   * where it is, with a warning, for someone to look at; nothing is deleted.
   */
  async recoverWipe(): Promise<void> {
    const repos = path.join(config.dataDir, 'ontologies');
    let trash: string[];
    try {
      trash = fs.readdirSync(config.dataDir).filter((name) => name.startsWith('.ontologies-deleted-'));
    } catch {
      return;
    }
    if (!trash.length) return;
    await assertStoreHeld();
    if (trash.length === 1 && !fs.existsSync(repos) && (await list('ontologies')).length) {
      fs.renameSync(path.join(config.dataDir, trash[0]), repos);
      console.warn(`[git] restored the repositories from an interrupted reset (${trash[0]})`);
      return;
    }
    console.warn(`[git] left ${trash.join(', ')} in ${config.dataDir}: repositories moved aside by a reset that may have finished. Delete them once you have checked nothing in them is needed.`);
  },

  /* ---------------------------------------------------------------------- */
  /* Development forks                                                      */
  /* ---------------------------------------------------------------------- */
  /*
   * As with the working draft, the database is the truth: a fork's record
   * (forks collection) names its head commit, and every change to a fork is a
   * conditional write of that record. Git only holds the commits: each new one
   * is pinned (refs/concord/fork-pins/<slug>/<sha>) before the record can name
   * it, then the fork's branch (refs/heads/forks/<slug>, for people looking at
   * the repository) is moved forward to it and the pin dropped. A commit whose
   * record write failed loses its pin; one whose writer stopped in between
   * keeps it, which costs a ref and nothing else. Nothing here touches the
   * checked-out files or the working draft.
   */

  forkBranch,

  /** Whether git has a branch for a fork of this name (a name in use, even if its record was never saved). */
  async hasForkBranch(project: Pick<OntologyProject, 'slug'>, forkSlug: string): Promise<boolean> {
    return !!refValue(repoDir(project), `refs/heads/${forkBranch(forkSlug)}`);
  },

  /** ontology.ttl exactly as committed at `commit` (a fork's head or base). */
  async readAt(project: Pick<OntologyProject, 'slug'>, commit: string): Promise<string> {
    if (!/^[0-9a-f]{7,64}$/.test(commit)) throw new HttpError(404, `No ontology at ${commit || 'an empty commit'}`);
    try {
      return await git(repoDir(project), ['show', `${commit}:${FILE}`], {}, { raw: true });
    } catch {
      throw new HttpError(404, `No ontology at ${commit}`);
    }
  },

  async commitOf(project: Pick<OntologyProject, 'slug'>, commit: string): Promise<{ parent?: string; subject: string }> {
    if (!/^[0-9a-f]{7,64}$/.test(commit)) throw new HttpError(404, `No commit ${commit || '(empty)'}`);
    let out: string;
    try {
      // Labelled lines: output is trimmed, which would drop a first commit's empty parent line.
      out = await git(repoDir(project), ['log', '-1', '--format=parents %P%nsubject %s', commit]);
    } catch {
      throw new HttpError(404, `No commit ${commit}`);
    }
    const line = (k: string) => out.split('\n').find((l) => l.startsWith(`${k} `))?.slice(k.length + 1) ?? '';
    return { parent: line('parents').split(' ').filter(Boolean)[0], subject: line('subject') };
  },

  /** The ontology at a commit (a fork's head, or the draft it was based on, for three-way comparisons). */
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
   * Commits `graph` to a fork on top of `parent` (the head the caller read the
   * fork at), runs `record` (the conditional write of the fork record that
   * makes the commit its head, which throws if the fork moved on), and only
   * then moves the fork's branch. `create` starts the fork's branch, refusing
   * if one of that name exists. `extraParents`: a sync names the upstream
   * draft it took in. Every call makes a commit, even if nothing changed.
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
    const dir = repoDir(project);
    const branch = `refs/heads/${forkBranch(forkSlug)}`;
    const commit = await buildCommit(dir, opts.parent, { [FILE]: await graph.toTurtle() }, message, { name: author.name, email: author.email ?? 'developer@concord' }, { parents: opts.extraParents, always: true });
    // Hold the commit before anything can name it: a new fork's branch (which must not exist yet), otherwise a pin.
    const hold = opts.create ? branch : `${FORK_PIN}${forkSlug}/${commit}`;
    try {
      await git(dir, ['update-ref', hold, commit, opts.create ? '' : NO_SHA]);
    } catch {
      throw new HttpError(409, opts.create ? `A fork called “${forkSlug}” already exists. Pick another name.` : 'The fork changed while this edit was being prepared. Reload it and try again.');
    }
    try {
      await record(commit);
    } catch (err) {
      try {
        await git(dir, ['update-ref', '-d', hold, commit]);
      } catch {
        /* a leftover ref holds an unused commit, nothing more */
      }
      throw err;
    }
    if (!opts.create) await this.holdFork(project, forkSlug, commit);
    return commit;
  },

  /** Moves the fork's branch forward to `commit` (the fork's head) if it isn't already there, then drops the pins it now holds. Never moves it back. */
  async holdFork(project: Pick<OntologyProject, 'slug'>, forkSlug: string, commit: string): Promise<void> {
    const dir = repoDir(project);
    const branch = `refs/heads/${forkBranch(forkSlug)}`;
    const ancestor = async (a: string, b: string) => {
      try {
        await git(dir, ['merge-base', '--is-ancestor', a, b]);
        return true;
      } catch {
        return false;
      }
    };
    try {
      const at = refValue(dir, branch);
      if (!at) await git(dir, ['update-ref', branch, commit, '']);
      else if (at !== commit && await ancestor(at, commit)) await git(dir, ['update-ref', branch, commit, at]);
      for (const line of (await git(dir, ['for-each-ref', `--merged=${branch}`, '--format=%(objectname) %(refname)', `${FORK_PIN}${forkSlug}/`])).split('\n').filter(Boolean)) {
        const [sha, ref] = line.split(' ');
        await git(dir, ['update-ref', '-d', ref, sha]);
      }
    } catch (err) {
      // The pin still holds the commit; the next change to the fork tries again.
      console.warn(`[git] ${project.slug}: fork ${forkSlug}'s branch not moved yet: ${(err as Error).message}`);
    }
  },

  /** How many commits the working draft has gained since `commit` (how far a fork has fallen behind). */
  async commitsSince(project: Pick<OntologyProject, 'slug'>, commit: string): Promise<number> {
    try {
      return Number(await git(repoDir(project), ['rev-list', '--count', `${commit}..${await this.head(project)}`]));
    } catch {
      return 0;
    }
  },

  /** A fork's own commits from `head` (newest first), not the upstream ones it was synced with. */
  async forkLog(project: Pick<OntologyProject, 'slug'>, head: string, limit = 50) {
    const out = await git(repoDir(project), ['log', `-${limit}`, '--first-parent', '--format=%H%x1f%an%x1f%aI%x1f%s', head, `^${await this.head(project)}`]);
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [sha, author, date, subject] = l.split('\x1f');
        // Newer git writes UTC as Z; keep +00:00, as older git (and the database store) write it.
        return { sha, author, date: date.replace(/Z$/, '+00:00'), subject };
      });
  },

  /** Push main and tags to a GitHub remote using a token. */
  async push(project: OntologyProject, remoteUrl: string) {
    const dir = repoDir(project);
    const remotes = await git(dir, ['remote']);
    if (remotes.split('\n').includes('origin')) await git(dir, ['remote', 'set-url', 'origin', remoteUrl]);
    else await git(dir, ['remote', 'add', 'origin', remoteUrl]);
    await this.sync(project);
    await git(dir, ['push', '-q', 'origin', 'main', '--follow-tags']);
  },

  /** Publishes main and the release tags to a GitHub repository (owner/name). */
  async publish(project: OntologyProject, target: { repo: string; token: string }): Promise<void> {
    await this.push(project, `https://x-access-token:${target.token}@github.com/${target.repo}.git`);
  },
};
gitStore satisfies OntologyStoreApi;

/** What every ontology store provides: the git-backed one above, or the database-backed one (ontologyStoreDb.ts). */
export interface OntologyStoreApi {
  kind: 'git' | 'db';
  dir(project: Pick<OntologyProject, 'slug'>): Promise<string>;
  init(project: OntologyProject, turtle: string, readme: string): Promise<string>;
  head(project: Pick<OntologyProject, 'slug'>): Promise<string>;
  advanceTo(project: Pick<OntologyProject, 'slug'>, base: string, commit: string, record?: (commit: string) => Promise<void> | void): Promise<void>;
  ensureSynced(project: Pick<OntologyProject, 'slug'>): Promise<void>;
  sync(project: Pick<OntologyProject, 'slug'>): Promise<void>;
  prunePins(project: Pick<OntologyProject, 'slug'>): Promise<void>;
  recoverWipe(): Promise<void>;
  checkout(project: Pick<OntologyProject, 'slug'>, commit: string): Promise<void>;
  readWorkingText(project: Pick<OntologyProject, 'slug'>, commit?: string): Promise<string>;
  working(project: Pick<OntologyProject, 'slug'>): Promise<OntologyGraph>;
  workingAt(project: Pick<OntologyProject, 'slug'>): Promise<{ graph: OntologyGraph; head: string }>;
  at(project: Pick<OntologyProject, 'slug'>, ref: string | undefined): Promise<OntologyGraph>;
  readReleaseFile(project: Pick<OntologyProject, 'slug'>, version: string, name: string): Promise<string | undefined>;
  commitWorking(project: OntologyProject, graph: OntologyGraph, message: string, author: CommitAuthor, base?: string, record?: (commit: string) => Promise<void> | void): Promise<string>;
  writeRelease(
    project: OntologyProject,
    version: string,
    graph: OntologyGraph,
    files: Record<string, string>,
    notes: string,
    author: CommitAuthor,
    base?: string,
    record?: (commit: string) => Promise<void> | void,
  ): Promise<string>;
  updateReleaseFiles(project: Pick<OntologyProject, 'slug'>, files: Record<string, Record<string, string | null>>, message: string): Promise<string>;
  readRepoFile(project: Pick<OntologyProject, 'slug'>, name: string, commit?: string): Promise<string | undefined>;
  updateRepoFile(project: Pick<OntologyProject, 'slug'>, name: string, content: string, message: string, base?: string): Promise<string>;
  forgetReleases(project: Pick<OntologyProject, 'slug'>): void;
  forget(project: Pick<OntologyProject, 'slug'>): Promise<void>;
  versions(project: Pick<OntologyProject, 'slug'>): Promise<string[]>;
  log(project: Pick<OntologyProject, 'slug'>, limit?: number): Promise<{ sha: string; author: string; date: string; subject: string }[]>;
  wipe(clear?: () => Promise<void>): Promise<void>;
  forkBranch(forkSlug: string): string;
  hasForkBranch(project: Pick<OntologyProject, 'slug'>, forkSlug: string): Promise<boolean>;
  readAt(project: Pick<OntologyProject, 'slug'>, commit: string): Promise<string>;
  /** A commit's first parent (none for the first commit) and the first line of its message. */
  commitOf(project: Pick<OntologyProject, 'slug'>, commit: string): Promise<{ parent?: string; subject: string }>;
  graphAt(project: Pick<OntologyProject, 'slug'>, commit: string): Promise<OntologyGraph>;
  commitFork(
    project: Pick<OntologyProject, 'slug'>,
    forkSlug: string,
    graph: OntologyGraph,
    message: string,
    author: CommitAuthor,
    opts: { parent: string; extraParents?: string[]; create?: boolean },
    record: (commit: string) => Promise<void>,
  ): Promise<string>;
  holdFork(project: Pick<OntologyProject, 'slug'>, forkSlug: string, commit: string): Promise<void>;
  commitsSince(project: Pick<OntologyProject, 'slug'>, commit: string): Promise<number>;
  forkLog(project: Pick<OntologyProject, 'slug'>, head: string, limit?: number): Promise<{ sha: string; author: string; date: string; subject: string }[]>;
  publish(project: OntologyProject, target: { repo: string; token: string }): Promise<void>;
}

/** The store this deployment uses (config.ontologyStore). */
export const ontologyStore: OntologyStoreApi = config.ontologyStore === 'db' ? dbStore : gitStore;
