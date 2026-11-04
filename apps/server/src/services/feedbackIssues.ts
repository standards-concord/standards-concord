import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { PUBLIC_NOTICE_VERSION, publicSummary, type FeedbackPublicationState, type FeedbackPublicationStatus } from '@concord/shared';
import { config } from '../config.js';
import { get, HttpError, list, put, transaction } from '../db.js';
import { newId } from '../ids.js';

/**
 * Opt-in public feedback summaries, filed as GitHub issues.
 *
 * Nothing a tester says is published unless they tick "post a public summary"
 * and write (or accept) a short summary, which they see exactly as it will be
 * posted. Only that summary is sent: no answers, name, email, role, date,
 * version or feedback id. Each issue carries a random publication id instead.
 *
 * Delivery is a durable queue in the database, so it survives restarts and is
 * safe with several server processes on one database:
 * - jobs are claimed with a lease inside a write transaction;
 * - the hourly cap is a rolling window stored per repository;
 * - GitHub's Retry-After and rate-limit reset headers pause the whole queue;
 * - when a send's outcome is unknown (timeout, dropped connection, 5xx, crash),
 *   the next attempt first looks for the issue by its marker instead of posting again.
 *
 * Enabled by FEEDBACK_GITHUB_TOKEN (a fine-grained token with Issues: read and
 * write on FEEDBACK_GITHUB_REPO). Without it the option isn't offered.
 */

export const FEEDBACK_LABELS = ['feedback', 'needs-triage'];
export const marker = (pubId: string) => `<!-- concord-feedback-publication: ${pubId} -->`;

type Issue = NonNullable<FeedbackPublicationStatus['issue']>;

export interface Publication {
  id: string;
  feedbackId: string;
  /** Exactly what the tester saw and agreed to. */
  summary: string;
  /** Dedupe key: identical summaries share one issue. */
  key: string;
  noticeVersion: number;
  withdrawHash: string;
  state: FeedbackPublicationState;
  attempts: number;
  /** Real (wall-clock) times, not the demo's governance clock. */
  nextAttemptAt: number;
  leaseUntil?: number;
  /** Set just before a POST, so a later attempt knows to look for the issue first. */
  sentAt?: number;
  /** State to return to when a withdrawal is requested mid-send. */
  withdrawRequested?: boolean;
  duplicateOf?: string;
  issue?: Issue;
  lastError?: string;
  createdAt: string;
}

interface Kv<T> {
  id: string;
  value: T;
}

export const MAX_ATTEMPTS = 8;
const LEASE_MS = 2 * 60_000;
const HOUR_MS = 60 * 60_000;
const TITLE_MAX = 80;

/* -------------------------------- time ---------------------------------- */

let nowFn = () => Date.now();
const now = () => nowFn();
/** Test hook: control wall-clock time. */
export function setNow(fn?: () => number) {
  nowFn = fn ?? (() => Date.now());
}

/* ------------------------------- config --------------------------------- */

export const issuesEnabled = () => !!config.feedbackIssues.token && /^[\w.-]+\/[\w.-]+$/.test(config.feedbackIssues.repo);
const repoKey = () => config.feedbackIssues.repo.toLowerCase();
const safeError = (msg: string) => (config.feedbackIssues.token ? msg.split(config.feedbackIssues.token).join('***') : msg).slice(0, 300);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/* ------------------------------ rendering ------------------------------- */

const escapeMarkdown = (s: string) => s.replace(/([\\`*_{}[\]()#+!|<>~=-])/g, '\\$1');

export function issueTitle(summary: string): string {
  const first = summary.split('\n')[0].trim();
  return `Feedback: ${first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1).trimEnd()}…` : first}`;
}

export function issueBody(pub: Pick<Publication, 'id' | 'summary'>): string {
  return [
    marker(pub.id),
    '_A tester of Concord chose to post this summary publicly. It is exactly what they wrote and reviewed; nothing else from their feedback is included._',
    '',
    ...pub.summary.split('\n').map((l) => `> ${escapeMarkdown(l)}`),
  ].join('\n');
}

const dedupeKey = (summary: string) => sha(summary.toLowerCase().replace(/\s+/g, ' ').trim()).slice(0, 32);

/* ------------------------------ enqueueing ------------------------------ */

/**
 * Queue a summary the tester opted in to. `summary` must already be exactly
 * what publicSummary() makes of it, which is what their preview showed.
 * Returns the status, with the token that lets them withdraw it.
 */
export function checkPublicSummary(summary: unknown): asserts summary is string {
  if (!issuesEnabled()) throw new HttpError(409, 'Posting feedback publicly is not switched on');
  if (typeof summary !== 'string' || !summary.trim()) throw new HttpError(400, 'Write a short summary to post, or untick the option');
  if (publicSummary(summary) !== summary) throw new HttpError(400, 'The summary changed when links and contact details were removed. Check the preview and send it again.');
}

export function queuePublication(feedbackId: string, summary: string): FeedbackPublicationStatus {
  checkPublicSummary(summary);
  const token = randomBytes(24).toString('base64url');
  const key = dedupeKey(summary);
  const pub = transaction(() => {
    const keyId = `feedback-publication-key:${repoKey()}:${key}`;
    const holder = get<Kv<string>>('kv', keyId);
    const original = holder ? get<Publication>('feedbackPublications', holder.value) : undefined;
    const live = original && original.state !== 'withdrawn' && original.state !== 'withdrawing' && original.state !== 'failed';
    const p: Publication = {
      id: newId('pub'),
      feedbackId,
      summary,
      key,
      noticeVersion: PUBLIC_NOTICE_VERSION,
      withdrawHash: sha(token),
      state: live ? 'duplicate' : 'queued',
      duplicateOf: live ? original.id : undefined,
      attempts: 0,
      nextAttemptAt: now(),
      createdAt: new Date(now()).toISOString(),
    };
    put('feedbackPublications', p, feedbackId);
    if (!live) put('kv', { id: keyId, value: p.id });
    return p;
  });
  return { ...status(pub), withdrawToken: token };
}

/** Public status of a publication (a duplicate reports the original's issue). */
export function status(pub: Publication): FeedbackPublicationStatus {
  if (pub.state === 'duplicate' && pub.duplicateOf) {
    const original = get<Publication>('feedbackPublications', pub.duplicateOf);
    return { state: 'duplicate', issue: original?.state === 'filed' ? original.issue : undefined };
  }
  return { state: pub.state, issue: pub.state === 'filed' ? pub.issue : undefined };
}

export const publicationFor = (feedbackId: string) => list<Publication>('feedbackPublications', feedbackId)[0];

/* ------------------------------- GitHub --------------------------------- */

class GitHubError extends Error {
  constructor(
    message: string,
    /** The request may have taken effect (timeout, dropped connection, 5xx). */
    readonly ambiguous: boolean,
    /** Wall-clock time before which GitHub asked us not to call again. */
    readonly retryAt?: number,
  ) {
    super(message);
  }
}

async function github(method: string, path: string, body?: unknown): Promise<unknown> {
  const { apiUrl, token } = config.feedbackIssues;
  let res: Response;
  try {
    res = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'concord-feedback',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new GitHubError(`GitHub request failed: ${(err as Error).message}`, true);
  }
  if (res.ok) return res.status === 204 ? undefined : res.json();
  // https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#handle-rate-limit-errors-appropriately
  const retryAfter = Number(res.headers.get('retry-after'));
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  const limited = res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || !!retryAfter));
  const retryAt = limited ? (retryAfter > 0 ? now() + retryAfter * 1000 : reset > 0 ? reset * 1000 : now() + 60_000) : undefined;
  throw new GitHubError(`GitHub answered ${res.status}`, res.status >= 500, retryAt);
}

/** Look for an issue already carrying this publication's marker (a send whose answer was lost). */
async function findExisting(pub: Publication): Promise<Issue | undefined> {
  const since = new Date((pub.sentAt ?? now()) - 10 * 60_000).toISOString();
  for (let page = 1; page <= 5; page++) {
    const issues = (await github('GET', `/repos/${config.feedbackIssues.repo}/issues?labels=feedback&state=all&since=${encodeURIComponent(since)}&per_page=100&page=${page}`)) as {
      number: number;
      html_url: string;
      body?: string;
    }[];
    const hit = issues.find((i) => i.body?.includes(marker(pub.id)));
    if (hit) return { number: hit.number, url: hit.html_url };
    if (issues.length < 100) break;
  }
  return undefined;
}

/* -------------------------------- queue --------------------------------- */

const pauseId = () => `feedback-issues:pause:${repoKey()}`;
const rateId = () => `feedback-issues:rate:${repoKey()}`;

function pausedUntil(): number {
  return get<Kv<number>>('kv', pauseId())?.value ?? 0;
}

/** Reserve one issue creation in the rolling hour, shared by every process. Returns when the next slot frees up if full. */
function reserveSlot(): { ok: true } | { ok: false; at: number } {
  return transaction(() => {
    const t = now();
    const recent = (get<Kv<number[]>>('kv', rateId())?.value ?? []).filter((x) => x > t - HOUR_MS);
    if (recent.length >= config.feedbackIssues.perHour) {
      put('kv', { id: rateId(), value: recent });
      return { ok: false as const, at: Math.min(...recent) + HOUR_MS };
    }
    put('kv', { id: rateId(), value: [...recent, t] });
    return { ok: true as const };
  });
}

const backoff = (attempts: number) => Math.min(5 * 60_000 * 2 ** Math.max(0, attempts - 1), 6 * HOUR_MS);

function update(id: string, change: (p: Publication) => Partial<Publication> | undefined): Publication | undefined {
  return transaction(() => {
    const p = get<Publication>('feedbackPublications', id);
    if (!p) return undefined;
    const c = change(p);
    if (!c) return undefined;
    const next = { ...p, ...c };
    put('feedbackPublications', next, p.feedbackId);
    return next;
  });
}

/** Claim a job for this process, with a lease. A send whose lease ran out has an unknown outcome. */
function claimJob(id: string): Publication | undefined {
  return update(id, (p) => {
    const t = now();
    let state = p.state;
    if (state === 'sending' && (p.leaseUntil ?? 0) < t) state = 'unknown';
    if (state === 'withdrawing' && (p.leaseUntil ?? 0) >= t) return undefined;
    if (!['queued', 'unknown', 'withdrawing'].includes(state)) return undefined;
    if (p.nextAttemptAt > t || pausedUntil() > t) return undefined;
    if (!get('feedback', p.feedbackId)) return { state: 'withdrawn', lastError: 'feedback deleted' };
    return { state: state === 'withdrawing' ? 'withdrawing' : 'sending', leaseUntil: t + LEASE_MS, attempts: p.attempts + 1, sentAt: state === 'unknown' ? (p.sentAt ?? t) : p.sentAt };
  });
}

function onError(id: string, err: unknown, wasWithdrawing: boolean) {
  const e = err instanceof GitHubError ? err : new GitHubError((err as Error).message, true);
  if (e.retryAt) put('kv', { id: pauseId(), value: Math.max(e.retryAt, pausedUntil()) });
  const p = update(id, (p) => {
    const rateLimited = !!e.retryAt;
    const attempts = rateLimited ? p.attempts - 1 : p.attempts;
    const exhausted = attempts >= MAX_ATTEMPTS;
    return {
      state: wasWithdrawing ? 'withdrawing' : exhausted ? 'failed' : e.ambiguous && p.sentAt ? 'unknown' : 'queued',
      attempts,
      leaseUntil: undefined,
      nextAttemptAt: e.retryAt ?? now() + backoff(attempts),
      lastError: safeError(e.message),
    };
  });
  console.warn(`[feedback] could not ${wasWithdrawing ? 'withdraw' : 'post'} public summary ${id}: ${safeError(e.message)}${p?.state === 'failed' ? ' (giving up; an administrator can retry it)' : ''}`);
}

/** Replace a posted summary and close its issue. GitHub keeps the edit history. */
async function retract(issue: Issue) {
  await github('PATCH', `/repos/${config.feedbackIssues.repo}/issues/${issue.number}`, {
    title: 'Withdrawn feedback',
    body: 'The tester withdrew this feedback.',
    state: 'closed',
    state_reason: 'not_planned',
  });
}

const running = new Map<string, Promise<void>>();

/** Work one job as far as it can go now. Never throws. */
export function processPublication(id: string): Promise<void> {
  const existing = running.get(id);
  if (existing) return existing;
  let release!: () => void;
  const done = new Promise<void>((r) => (release = r));
  // Registered before any work starts, removed when it settles.
  running.set(id, done);
  void (async () => {
    try {
      await step(id);
    } catch (err) {
      console.warn(`[feedback] ${safeError((err as Error).message)}`);
    } finally {
      running.delete(id);
      release();
    }
  })();
  return done;
}

async function step(id: string) {
  if (!issuesEnabled()) return;
  const job = claimJob(id);
  if (!job || job.state === 'withdrawn') return;
  const withdrawing = job.state === 'withdrawing';
  try {
    if (withdrawing) {
      // Withdrawn after a send began: find out whether the issue exists, then retract it.
      const issue = job.issue ?? (job.sentAt ? await findExisting(job) : undefined);
      if (issue) await retract(issue);
      update(id, () => ({ state: 'withdrawn', leaseUntil: undefined, issue: undefined, lastError: undefined }));
      return;
    }
    let issue = job.sentAt ? await findExisting(job) : undefined;
    if (!issue) {
      const slot = reserveSlot();
      if (!slot.ok) {
        update(id, (p) => ({ state: p.sentAt ? 'unknown' : 'queued', attempts: p.attempts - 1, leaseUntil: undefined, nextAttemptAt: slot.at }));
        return;
      }
      // Persist that we're about to send before sending, so a crash or lost answer is reconciled rather than repeated.
      const mine = update(id, (p) => (p.state === 'sending' && p.leaseUntil === job.leaseUntil ? { sentAt: now() } : undefined));
      if (!mine) return;
      const created = (await github('POST', `/repos/${config.feedbackIssues.repo}/issues`, { title: issueTitle(job.summary), body: issueBody(job), labels: FEEDBACK_LABELS })) as { number: number; html_url: string };
      issue = { number: created.number, url: created.html_url };
    }
    const after = update(id, (p) => (p.withdrawRequested ? { state: 'withdrawing', issue, leaseUntil: undefined, nextAttemptAt: now() } : { state: 'filed', issue, leaseUntil: undefined, lastError: undefined }));
    if (after?.state === 'withdrawing') await step(id);
  } catch (err) {
    onError(id, err, withdrawing);
  }
}

/** Wait briefly for the job so the tester can be told; it carries on in the background if GitHub is slow. */
export async function processWithin(id: string, ms = 4000): Promise<Publication | undefined> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([processPublication(id), new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
  clearTimeout(timer);
  return get<Publication>('feedbackPublications', id);
}

/** Work every job that is due. Run on a timer. */
export async function processOutstanding(): Promise<number> {
  if (!issuesEnabled()) return 0;
  let n = 0;
  for (const p of list<Publication>('feedbackPublications')) {
    if (!['queued', 'unknown', 'sending', 'withdrawing'].includes(p.state)) continue;
    await processPublication(p.id);
    if (get<Publication>('feedbackPublications', p.id)?.state === 'filed') n++;
  }
  return n;
}

/* ----------------------------- withdrawing ------------------------------ */

const tokenMatches = (pub: Publication, token: unknown) => {
  if (typeof token !== 'string' || !token) return false;
  const a = Buffer.from(sha(token));
  const b = Buffer.from(pub.withdrawHash);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** The tester takes their public summary back: never posted if it wasn't yet, retracted if it was. */
export async function withdrawPublication(feedbackId: string, token: unknown): Promise<FeedbackPublicationStatus> {
  const pub = publicationFor(feedbackId);
  if (!pub || !tokenMatches(pub, token)) throw new HttpError(403, 'That withdrawal link is not valid');
  const next = update(pub.id, (p) => {
    switch (p.state) {
      case 'queued':
      case 'duplicate':
      case 'failed':
        return { state: 'withdrawn' };
      case 'unknown':
        return { state: 'withdrawing', nextAttemptAt: now(), leaseUntil: undefined };
      case 'sending':
        return { withdrawRequested: true };
      case 'filed':
        return { state: 'withdrawing', nextAttemptAt: now(), leaseUntil: undefined };
      default:
        return undefined;
    }
  });
  if (next?.state === 'withdrawn' && pub.state !== 'duplicate') releaseKey(pub);
  if (next?.state === 'withdrawing') await processWithin(pub.id);
  return status(get<Publication>('feedbackPublications', pub.id)!);
}

function releaseKey(pub: Publication) {
  transaction(() => {
    const keyId = `feedback-publication-key:${repoKey()}:${pub.key}`;
    if (get<Kv<string>>('kv', keyId)?.value === pub.id) put('kv', { id: keyId, value: '' });
  });
}

/** Administrators: try a job that gave up again. */
export function retryPublication(id: string): FeedbackPublicationStatus {
  const p = update(id, (p) => (p.state === 'failed' ? { state: p.sentAt ? 'unknown' : 'queued', attempts: 0, nextAttemptAt: now(), lastError: undefined } : undefined));
  if (!p) throw new HttpError(409, 'Only a publication that gave up can be retried');
  void processPublication(id);
  return status(p);
}
