import { randomUUID } from 'node:crypto';
import type { OntologyProject, Release, UseCase } from '@concord/shared';
import { config } from '../config.js';
import { get, list, put, reserveCounters, transaction } from '../db.js';
import { anyHeld, historyApproved } from '../public/holds.js';
import { isAncestor } from './gitdb.js';
import { publishToGitHub, PublishPaused, PublishRefused } from './githubPublisher.js';
import { onNoLongerPublic } from './useCases.js';

/**
 * Publishing to GitHub from the database store, as an outbox: a release records that its ontology should be
 * published in the same transaction that publishes it, and workers (straight after the release, then on every
 * governance tick) carry the job out, a lease at a time.
 *
 * - One job per ontology. It names the repository and the commit main should reach, and a newer release moves that
 *   commit forward (the draft only moves forward, so the new target descends from the old).
 * - A worker takes the job's lease (a token and an expiry, set in a transaction), and renews it at every checkpoint;
 *   every write it makes to the job is conditional on still holding it. GitHub is never called in a transaction.
 * - At every checkpoint, before each write, it checks again that publishing is allowed: the ontology still publishes
 *   to the same repository, the token is still set, nothing is held for a steward's approval, the history was made
 *   under the approval rules, and no use case stopped being public while some of its history wasn't on GitHub yet.
 *   If not, the job is cancelled.
 * - A use case withdrawn (or made non-public) while a published release isn't on GitHub yet blocks publishing that
 *   ontology for good: the release's files (its use cases, its notes) were written with the use case's consent then,
 *   and history can't change. The block is recorded in the withdrawal's own transaction; a write already on its way
 *   to GitHub then is the only one that still goes (each write is checked first). Once a job is done every release
 *   is on GitHub, and a release made later is prepared under the consent lock without the use case, so a
 *   withdrawal then blocks nothing (as with the git store, what was already on GitHub can't be recalled).
 * - Writes are counted against an hourly budget shared by every worker and ontology (one token), and GitHub's own
 *   rate limits set when to try again. Something publishing again won't fix quarantines the job, with its reason,
 *   until a newer release (or an operator) starts it again; other ontologies carry on.
 * - Done means GitHub's refs were read back at the target. Only then does each release get its GitHub link, set on
 *   the release as stored now.
 */

export interface GitHubPublishJob {
  id: string;
  ontologyId: string;
  repo: string;
  /** The commit main should reach. */
  commit: string;
  /** Bumped by every new target, so finishing an older one can't mark a newer one done. */
  seq: number;
  /** Releases waiting for their GitHub link. */
  releaseIds: string[];
  status: 'pending' | 'done' | 'quarantined' | 'cancelled';
  reason?: string;
  notBefore?: number;
  lease?: { token: string; until: number };
  updatedAt: string;
}

export const OUTBOX = 'github-publish';
const jobId = (ontologyId: string) => `github-publish:${ontologyId}`;
const blockId = (ontologyId: string) => `github-publish-block:${ontologyId}`;
export const LEASE_MS = 2 * 60_000;
/** Most writes per hour for the publish token, across all ontologies (GitHub allows about 500 content writes an hour). */
export const WRITES_PER_HOUR = Number(process.env.GITHUB_PUBLISH_WRITES_PER_HOUR ?? 400);

/**
 * Records that `project` should be published up to `release` (call inside the transaction that publishes it, so the
 * job exists exactly when the release does). Does nothing unless the ontology publishes to GitHub.
 */
export async function enqueueGitHubPublish(project: OntologyProject, release: Pick<Release, 'id' | 'commit'>): Promise<void> {
  if (!project.github || !release.commit) return;
  const now = new Date().toISOString();
  const job = await get<GitHubPublishJob>('kv', jobId(project.id));
  const sameRepo = job?.repo === project.github.repo;
  await put<GitHubPublishJob>(
    'kv',
    {
      id: jobId(project.id),
      ontologyId: project.id,
      repo: project.github.repo,
      commit: release.commit,
      seq: (job?.seq ?? 0) + 1,
      releaseIds: [...new Set([...(sameRepo && job.status !== 'done' ? job.releaseIds : []), release.id])],
      // A newer release is a fresh start for a job that had stopped. A worker still running keeps its lease, and
      // finishes only the older target (seq), so the job stays pending for this one.
      status: 'pending',
      lease: job?.lease,
      updatedAt: now,
    },
    OUTBOX,
  );
}

interface PublishBlock {
  id: string;
  ontologyId: string;
  useCaseId: string;
  reason: string;
}

// Runs in the transaction that makes the use case non-public, so the block exists exactly when the withdrawal does.
onNoLongerPublic(async (u: UseCase) => {
  const [job, project] = await Promise.all([get<GitHubPublishJob>('kv', jobId(u.ontologyId)), get<OntologyProject>('ontologies', u.ontologyId)]);
  const allSent = job?.status === 'done' && job.repo === project?.github?.repo;
  if (allSent || (await get<PublishBlock>('kv', blockId(u.ontologyId)))) return;
  if (!(await list<Release>('releases', u.ontologyId)).some((r) => r.status === 'published')) return;
  await put<PublishBlock>('kv', { id: blockId(u.ontologyId), ontologyId: u.ontologyId, useCaseId: u.id, reason: 'a use case stopped being public before its history was all on GitHub' }, OUTBOX);
});

/** Why publishing isn't allowed right now, or undefined if it is. */
async function notAllowed(job: GitHubPublishJob): Promise<string | undefined> {
  const project = await get<OntologyProject>('ontologies', job.ontologyId);
  if (!project) return 'the ontology no longer exists';
  const block = await get<PublishBlock>('kv', blockId(job.ontologyId));
  if (block) return block.reason;
  if (project.github?.repo !== job.repo) return `the ontology no longer publishes to ${job.repo}`;
  if (!config.github.publishToken) return 'no GitHub publish token is set';
  if (await anyHeld(project)) return 'a version is waiting for a steward’s approval';
  if (!(await historyApproved(project))) return 'its history predates publication approval';
  return undefined;
}

/** Changes the job (and anything else `change` writes) only while `token` holds an unexpired lease. False if not. */
async function whileHeld(id: string, token: string, change: (job: GitHubPublishJob) => GitHubPublishJob | undefined | Promise<GitHubPublishJob | undefined>): Promise<boolean> {
  return await transaction(async () => {
    const job = await get<GitHubPublishJob>('kv', id);
    if (!job || job.lease?.token !== token || job.lease.until <= Date.now()) return false;
    const next = await change(job);
    if (next) await put('kv', { ...next, updatedAt: new Date().toISOString() }, OUTBOX);
    return true;
  });
}

class LeaseLost extends Error {}
class Cancelled extends Error {}

type RunOptions = { api?: string; every?: number };

/** Carries out every job that is due (each governance tick). `api`: GitHub's API root, if not config's (tests). */
export async function runGitHubPublishes(opts: RunOptions = {}): Promise<void> {
  for (const job of await list<GitHubPublishJob>('kv', OUTBOX)) await runGitHubPublish(job.ontologyId, opts);
}

/** Carries out one ontology's job, if it is due; logs rather than throws. */
export async function runGitHubPublish(ontologyId: string, opts: RunOptions = {}): Promise<void> {
  try {
    await runJob(jobId(ontologyId), opts);
  } catch (err) {
    const token = config.github.publishToken;
    const message = (err as Error).message;
    console.warn(`[github] ${ontologyId}: ${token ? message.replaceAll(token, '***') : message}`);
  }
}

export const githubPublishJob = async (ontologyId: string) => await get<GitHubPublishJob>('kv', jobId(ontologyId));

async function runJob(id: string, opts: RunOptions): Promise<void> {
  const token = randomUUID();
  // Take the lease, if the job is due and nobody holds it.
  const job = await transaction(async () => {
    const j = await get<GitHubPublishJob>('kv', id);
    const now = Date.now();
    if (!j || j.status !== 'pending' || (j.notBefore ?? 0) > now || (j.lease && j.lease.until > now)) return undefined;
    const claimed = { ...j, lease: { token, until: now + LEASE_MS }, updatedAt: new Date().toISOString() };
    await put('kv', claimed, OUTBOX);
    return claimed;
  });
  if (!job) return;
  const stop = (status: GitHubPublishJob['status'], reason?: string, notBefore?: number) =>
    whileHeld(id, token, (j) => ({ ...j, status: j.seq === job.seq || status === 'pending' ? status : 'pending', reason, notBefore, lease: undefined }));

  const checkpoint = async () => {
    const why = await notAllowed(job);
    if (why) throw new Cancelled(why);
    if (!(await whileHeld(id, token, (j) => ({ ...j, lease: { token, until: Date.now() + LEASE_MS } })))) throw new LeaseLost('another worker took over this job');
  };
  try {
    await checkpoint();
    const releases = [];
    for (const r of await list<Release>('releases', job.ontologyId))
      if (r.status === 'published' && r.commit && r.publishedAt && (r.commit === job.commit || (await isAncestor(r.commit, job.commit)))) releases.push(r);
    releases.sort((a, b) => a.version.localeCompare(b.version));
    // Each write counts against the hour it is made in.
    const spend = async () => await reserveCounters([{ id: `github-writes:${new Date().toISOString().slice(0, 13)}`, max: WRITES_PER_HOUR }], OUTBOX);
    await publishToGitHub({ repo: job.repo, token: config.github.publishToken!, commit: job.commit, releases }, { api: opts.api ?? config.github.publishApi, every: opts.every, checkpoint, spend });
    // Done: in one transaction, and only while this worker still holds the job, give each release its link (on the
    // release as it is now) and close the job, unless a newer target came.
    const closed = await whileHeld(id, token, async (j) => {
      for (const releaseId of job.releaseIds) {
        const r = await get<Release>('releases', releaseId);
        if (r?.status === 'published' && !r.githubUrl) await put('releases', { ...r, githubUrl: `https://github.com/${job.repo}/releases/tag/v${r.version}` }, r.ontologyId);
      }
      return j.seq === job.seq ? { ...j, status: 'done', reason: undefined, notBefore: undefined, lease: undefined, releaseIds: [] } : { ...j, releaseIds: j.releaseIds.filter((r) => !job.releaseIds.includes(r)), lease: undefined };
    });
    if (!closed) throw new LeaseLost('another worker took over this job');
  } catch (err) {
    if (err instanceof LeaseLost) return;
    if (err instanceof PublishPaused) await stop('pending', err.message, err.notBefore);
    else if (err instanceof Cancelled) await stop('cancelled', err.message);
    else if (err instanceof PublishRefused) await stop('quarantined', err.message);
    else await stop('pending', (err as Error).message, Date.now() + 5 * 60_000);
    throw err;
  }
}
