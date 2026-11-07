import { randomUUID, timingSafeEqual } from 'node:crypto';
import type express from 'express';
import { config } from '../config.js';
import { get, put, transaction } from '../db.js';
import { keepAlive } from '../keepAlive.js';
export { setKeepAlive } from '../keepAlive.js';

/**
 * Concord's scheduled work, without a timer of its own on Vercel (docs/deploy.md, issue #112). Each job says how
 * often it is due. Due work runs:
 * - after any request, at most every half minute per instance, when `config.schedule` is 'requests' (Vercel), so
 *   deadlines are met as soon as anyone looks, including on public pages, and failures are retried on the next one;
 * - from a daily Vercel Cron call (`GET /api/cron/daily`, with `CRON_SECRET`), which runs every job, due or not,
 *   to catch up on anything a quiet day missed;
 * - every minute from a long-running server's own timer, when `config.schedule` is 'timer' (the VM).
 *
 * One runner at a time across every instance: a run takes a lease in the database, recording in the same step
 * that the jobs it runs have started. The jobs run side by side in a run, as their separate timers did.
 * Each job must be safe to run again, and late: a run can be cut short, and nothing runs while nobody visits.
 */

export interface ScheduledJob {
  name: string;
  /** How often it is due (ms). */
  every: number;
  run: () => Promise<unknown>;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** The jobs, imported when first run so loading this module loads none of them. */
const defaultJobs = async (): Promise<ScheduledJob[]> => {
  const [{ runTick }, { meetBotTick }, { sweepRuns }, { processOutstanding }, { syncFeedbackSharing }] = await Promise.all([
    import('./simulation.js'),
    import('./meetBot.js'),
    import('./appGithub.js'),
    import('./feedbackIssues.js'),
    import('./feedback.js'),
  ]);
  return [
    // The governance clock: close review periods and votes, auto-merge, auto-draft releases, publish to GitHub.
    { name: 'governance', every: MINUTE, run: runTick },
    // The co-lead bot's calendar: pick up invites to its address and book bots for them.
    { name: 'meet-bot', every: MINUTE, run: () => meetBotTick() },
    // Apps connected through the Concord GitHub App: start runs a request didn't (a gap, a retry due).
    { name: 'github-app', every: MINUTE, run: sweepRuns },
    // Public feedback summaries that couldn't be posted straight away are retried.
    { name: 'feedback', every: MINUTE, run: processOutstanding },
    // Testers' pod feedback folders are shared with exactly ADMIN_WEBIDS.
    { name: 'feedback-sharing', every: DAY, run: syncFeedbackSharing },
  ];
};

let jobs: () => Promise<ScheduledJob[]> = defaultJobs;
/** Replaces the jobs (tests); returns a function that puts them back. */
export function useJobs(list: ScheduledJob[]): () => void {
  jobs = async () => list;
  return () => (jobs = defaultJobs);
}

interface SchedulerState {
  id: string;
  lease?: { token: string; until: number };
  /** When each job last started, by name (ms). */
  lastRun: Record<string, number>;
}
const STATE = 'scheduler';
/**
 * How long a run's lease lasts without renewal. A live run renews it every LEASE_MS / 3, so it runs out only when
 * its runner has died or stalled for that long (an instance frozen, a server gone): only then can another run start.
 */
export const LEASE_MS = 5 * MINUTE;

export interface RunResult {
  ran: string[];
  failed: { name: string; error: string }[];
  /** Another runner held the lease, so nothing ran. */
  busy?: boolean;
  /** This run's lease ran out while its jobs were running, so another run may have started beside it (logged). */
  lostLease?: boolean;
}

/**
 * Runs every job that is due (all of them with `force`), unless another runner is at it. Resolves once they have
 * finished; a job that fails is logged, recorded in the result, and tried again when it is next due.
 *
 * The lease is renewed while the jobs run. It is not a fence: a runner that stalls past LEASE_MS (renewals
 * failing, or the instance frozen) and then resumes carries on beside the run that took over, until its jobs
 * end. That window is an accepted limit; each job is safe to run twice at once, since it does its own
 * check-then-act in transactions or under its own leases (the governance tick, bot lanes, the calendar).
 */
export async function runDue(opts: { force?: boolean; now?: () => number; renewEvery?: number } = {}): Promise<RunResult> {
  // Read-only (the cutover): no scheduled work at all, since jobs call out (Recall.ai, GitHub, pods) before they
  // write to the database, which would refuse.
  if (config.readOnly) return { ran: [], failed: [] };
  const now = opts.now ?? Date.now;
  const list = await jobs();
  const isDue = (s: SchedulerState | undefined, j: ScheduledJob) => opts.force || now() - (s?.lastRun[j.name] ?? 0) >= j.every - 1000;
  // Cheaply first: most requests find nothing due.
  const seen = await get<SchedulerState>('kv', STATE);
  if (!list.some((j) => isDue(seen, j))) return { ran: [], failed: [] };
  const token = randomUUID();
  const due = await transaction(async () => {
    const s = await get<SchedulerState>('kv', STATE);
    if (s?.lease && s.lease.until > now()) return undefined;
    const d = list.filter((j) => isDue(s, j));
    const started = now();
    await put<SchedulerState>('kv', { id: STATE, lease: { token, until: started + LEASE_MS }, lastRun: { ...s?.lastRun, ...Object.fromEntries(d.map((j) => [j.name, started])) } });
    return d;
  });
  if (!due) return { ran: [], failed: [], busy: true };
  let lostLease = false;
  const renew = async () => {
    try {
      await transaction(async () => {
        const s = await get<SchedulerState>('kv', STATE);
        if (s?.lease?.token !== token) {
          if (!lostLease) console.warn(`[schedule] this run's lease ran out and was taken over; ${due.map((j) => j.name).join(', ')} carry on beside the new run`);
          lostLease = true;
          return;
        }
        await put<SchedulerState>('kv', { ...s, lease: { token, until: now() + LEASE_MS } });
      });
    } catch (err) {
      console.warn(`[schedule] couldn't renew the lease: ${(err as Error).message}`);
    }
  };
  let renewing = Promise.resolve();
  const timer = setInterval(() => (renewing = renewing.then(renew)), opts.renewEvery ?? LEASE_MS / 3);
  timer.unref?.();
  const failed: RunResult['failed'] = [];
  try {
    await Promise.all(
      due.map(async (j) => {
        try {
          await j.run();
        } catch (err) {
          const error = (err as Error).message;
          failed.push({ name: j.name, error });
          console.warn(`[schedule] ${j.name}: ${error}`);
        }
      }),
    );
  } finally {
    clearInterval(timer);
    await renewing;
  }
  // Let the lease go, if it is still this run's.
  await transaction(async () => {
    const s = await get<SchedulerState>('kv', STATE);
    if (s?.lease?.token === token) await put<SchedulerState>('kv', { ...s, lease: undefined });
    else lostLease = true;
  });
  return { ran: due.map((j) => j.name), failed, ...(lostLease ? { lostLease } : {}) };
}

const running = new Set<Promise<unknown>>();
/** Resolves once work started after requests has finished (tests, shutdown). */
export const scheduledIdle = async () => {
  while (running.size) await Promise.allSettled([...running]);
};

/** How often one instance looks for due work after requests. */
export const CHECK_EVERY_MS = 30_000;
let checkAfter = 0;
/** Looks for due work after a request, at most every CHECK_EVERY_MS per instance; never throws. */
export function kickScheduled(now = Date.now()) {
  if (now < checkAfter) return;
  checkAfter = now + CHECK_EVERY_MS;
  const work = runDue()
    .catch((err) => console.warn('[schedule]', (err as Error).message))
    .finally(() => running.delete(work));
  running.add(work);
  keepAlive(work);
}
/** Forgets when this instance last looked (tests). */
export const resetKick = () => (checkAfter = 0);

/** Middleware: after each response, looks for due work ('requests' scheduling only). */
export const scheduleAfterRequests: express.RequestHandler = (_req, res, next) => {
  res.once('finish', () => kickScheduled());
  next();
};

/** The daily Vercel Cron call: runs every job, due or not. Vercel sends `Authorization: Bearer $CRON_SECRET`. */
export const dailyCron: express.RequestHandler = async (req, res) => {
  const secret = config.cronSecret;
  const given = Buffer.from(req.get('authorization') ?? '');
  const want = Buffer.from(`Bearer ${secret}`);
  if (!secret || given.length !== want.length || !timingSafeEqual(given, want)) return void res.status(401).json({ error: 'Not allowed' });
  if (config.readOnly) return void res.status(503).json({ error: 'Concord is read-only while it moves, so scheduled work is paused.' });
  res.json(await runDue({ force: true }));
};
