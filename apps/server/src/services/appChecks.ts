import { createHash, randomBytes } from 'node:crypto';
import { applyChangeOps, FORMAT_INFO, serialize } from '@concord/core';
import type { OutputFormat } from '@concord/core/types';
import type {
  AppCheck,
  AppCheckOutcome,
  AppCheckResult,
  AutopilotMark,
  AutopilotSettings,
  ChangeLevel,
  ChangeRequest,
  ConnectedApp,
  OntologyProject,
  PendingAppChecks,
  Review,
  User,
  Vote,
} from '@concord/shared';
import { clock } from '../clock.js';
import { get, HttpError, list, mustGet, put, remove } from '../db.js';
import { newId } from '../ids.js';
import { addReview, addVote, advance, getCR, governanceFor, listCRs, reviewsFor, saveCR, votesFor } from './changeRequests.js';
import { canVote } from './governance.js';
import { getProject, rolesFor, setRoles } from './ontologies.js';
import { ontologyStore } from './ontologyStore.js';
import { getUser, logActivity, publicUser } from './users.js';

/**
 * Connected apps. Someone building on an ontology connects their application; its CI
 * (the GitHub Action in actions/app-check) asks which changes are open, tests the app
 * against the ontology each change would produce, and reports back with the app's token.
 *
 * Autopilot lets the app's owner hand their say to those results: once all of their
 * autopilot apps pass a change, Concord approves it for them in review (if their role's
 * approvals count) and votes yes in a vote. If an app fails, any autopilot yes is
 * withdrawn and, if they asked for it, autopilot votes no.
 */

interface AppDoc extends ConnectedApp {
  tokenHash: string;
  /** Runs started so far (see pending()). */
  attempts?: number;
}

/**
 * Change request statuses the CI is asked to test. Approved changes are still tested until they
 * are merged, because a failure can still stop the merge.
 */
const CHECKABLE = ['review', 'voting', 'approved'] as const;
const DEFAULT_AUTOPILOT: AutopilotSettings = { enabled: false, levels: ['patch', 'minor'], onFailure: 'report' };
const LEVELS: ChangeLevel[] = ['patch', 'minor', 'major'];

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const newAppToken = () => `cna_${randomBytes(24).toString('base64url')}`;
const checkId = (appId: string, crId: string) => `${appId}:${crId}`;

function publicApp(doc: AppDoc): ConnectedApp {
  const { tokenHash: _h, attempts: _a, ...rest } = doc;
  const baseline = rest.baseline && { ...rest.baseline, current: rest.baseline.revision === baselineRevision(getProject(doc.ontologyId)) };
  return { ...rest, baseline, owner: publicUser(getUser(doc.ownerId)) };
}

export const listApps = (ontologyId: string) => list<AppDoc>('apps', ontologyId).map(publicApp);
const getAppDoc = (id: string) => mustGet<AppDoc>('apps', id);
const saveApp = (doc: AppDoc) => put('apps', doc, doc.ontologyId);

function cleanAutopilot(input: unknown, base: AutopilotSettings = DEFAULT_AUTOPILOT): AutopilotSettings {
  const a = (input && typeof input === 'object' ? input : {}) as Partial<AutopilotSettings>;
  const levels = Array.isArray(a.levels) ? LEVELS.filter((l) => a.levels!.includes(l)) : base.levels;
  return {
    enabled: typeof a.enabled === 'boolean' ? a.enabled : base.enabled,
    levels,
    onFailure: a.onFailure === 'oppose' || a.onFailure === 'report' ? a.onFailure : base.onFailure,
  };
}

function cleanRepo(repo: unknown): string | undefined {
  if (typeof repo !== 'string' || !repo.trim()) return undefined;
  const r = repo.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(r)) throw new HttpError(400, 'repo should look like owner/name');
  return r;
}

function cleanName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'name is required');
  if (name.length > 120) throw new HttpError(400, 'name is too long');
  return name.trim();
}

export async function createApp(project: OntologyProject, owner: User, input: { name: unknown; repo?: unknown; autopilot?: unknown }): Promise<ConnectedApp> {
  // Anyone can connect an app; they join as a contributor if they weren't a member.
  if (!rolesFor(project.id, owner.id).length) setRoles(project.id, owner.id, ['contributor']);
  const token = newAppToken();
  const doc: AppDoc = {
    id: newId('app'),
    ontologyId: project.id,
    ownerId: owner.id,
    name: cleanName(input.name),
    repo: cleanRepo(input.repo),
    tokenPrefix: token.slice(0, 10),
    tokenHash: hash(token),
    autopilot: cleanAutopilot(input.autopilot),
    createdAt: clock.iso(),
  };
  saveApp(doc);
  logActivity({ ontologyId: project.id, actorId: owner.id, type: 'app.connected', message: `connected the app ${doc.name} to test it against proposed changes`, link: `/o/${project.id}/apps` });
  // Autopilot waits for every app with autopilot on, so a new one holds back any yes until it reports.
  if (doc.autopilot.enabled) await reconcile(project.id, [owner.id]);
  return { ...publicApp(getAppDoc(doc.id)), token };
}

function ownApp(id: string, actor: User): AppDoc {
  const doc = getAppDoc(id);
  if (doc.ownerId !== actor.id && !actor.isPlatformAdmin) throw new HttpError(403, 'Only the person who connected this app can change it');
  return doc;
}

export async function updateApp(id: string, actor: User, patch: { name?: unknown; repo?: unknown; autopilot?: unknown }): Promise<ConnectedApp> {
  const doc = ownApp(id, actor);
  if (patch.name !== undefined) doc.name = cleanName(patch.name);
  if (patch.repo !== undefined) doc.repo = cleanRepo(patch.repo);
  const wasOn = doc.autopilot.enabled;
  if (patch.autopilot !== undefined) doc.autopilot = cleanAutopilot(patch.autopilot, doc.autopilot);
  saveApp(doc);
  if (doc.autopilot.enabled !== wasOn)
    logActivity({ ontologyId: doc.ontologyId, actorId: doc.ownerId, type: 'app.autopilot', message: `turned autopilot ${doc.autopilot.enabled ? 'on' : 'off'} for ${doc.name}`, link: `/o/${doc.ontologyId}/apps` });
  // Settings changed: results already in may now call for (or no longer allow) an autopilot say.
  await reconcile(doc.ontologyId, [doc.ownerId]);
  return publicApp(getAppDoc(id));
}

export function rotateToken(id: string, actor: User): ConnectedApp {
  const doc = ownApp(id, actor);
  const token = newAppToken();
  doc.tokenPrefix = token.slice(0, 10);
  doc.tokenHash = hash(token);
  saveApp(doc);
  return { ...publicApp(doc), token };
}

export async function deleteApp(id: string, actor: User) {
  const doc = ownApp(id, actor);
  for (const c of list<AppCheck>('appChecks').filter((x) => x.appId === id)) remove('appChecks', c.id);
  remove('apps', id);
  // Anything autopilot said on the strength of this app no longer stands.
  await reconcile(doc.ontologyId, [doc.ownerId]);
}

/** The app a CI request is for, from its `Authorization: Bearer cna_…` header. */
export function appForToken(authorization: string | undefined): AppDoc {
  const token = authorization?.match(/^Bearer\s+(cna_\S+)$/i)?.[1];
  if (!token) throw new HttpError(401, 'Send the app token as Authorization: Bearer cna_…');
  const h = hash(token);
  const doc = list<AppDoc>('apps').find((a) => a.tokenHash === h);
  if (!doc) throw new HttpError(401, 'Unknown or replaced app token');
  doc.lastSeenAt = clock.iso();
  saveApp(doc);
  return doc;
}

/* ------------------------------------------------------------------------ */
/* What a change would produce                                               */
/* ------------------------------------------------------------------------ */

/** Fingerprint of the working draft. */
export const baselineRevision = (project: OntologyProject) => ontologyStore.head(project).slice(0, 12);

/**
 * Fingerprint of the ontology a change request would produce: the working draft it would be
 * merged into plus its edits. It moves when either changes, so results for older revisions
 * no longer count.
 */
export function revisionOf(cr: ChangeRequest, project = getProject(cr.ontologyId)): string {
  return hash(`${ontologyStore.head(project)}\n${cr.id}\n${cr.opsUpdatedAt ?? cr.createdAt}\n${JSON.stringify(cr.ops)}`).slice(0, 16);
}

const proposedCache = new Map<string, string>();

/** The ontology as it would be with this change merged, in any output format. */
export async function proposedSource(cr: ChangeRequest, format: OutputFormat): Promise<{ text: string; revision: string; filename: string }> {
  const project = getProject(cr.ontologyId);
  const revision = revisionOf(cr, project);
  const filename = `${project.slug}-cr${cr.number}-${revision.slice(0, 7)}.${FORMAT_INFO[format].extension}`;
  const key = `${revision}:${format}`;
  const cached = proposedCache.get(key);
  if (cached !== undefined) return { text: cached, revision, filename };
  const working = await ontologyStore.working(project);
  let graph;
  try {
    graph = applyChangeOps(working, cr.ops, { author: getUser(cr.authorId)?.name, date: clock.iso().slice(0, 10), source: `${project.slug}#${cr.number}` }).graph;
  } catch (err) {
    throw new HttpError(409, `This change can't be applied to the current working draft: ${(err as Error).message}`);
  }
  const text = await serialize(graph, format);
  if (proposedCache.size > 200) proposedCache.clear();
  proposedCache.set(key, text);
  return { text, revision, filename };
}

/* ------------------------------------------------------------------------ */
/* CI: what to test, and results                                             */
/* ------------------------------------------------------------------------ */

const latestCheck = (appId: string, crId: string) => get<AppCheck>('appChecks', checkId(appId, crId));
const isOpen = (cr: ChangeRequest) => (CHECKABLE as readonly string[]).includes(cr.status);

/** Each call starts a run: results are reported with its attempt number, and newer attempts win. */
function nextAttempt(app: AppDoc): number {
  app.attempts = (app.attempts ?? 0) + 1;
  saveApp(app);
  return app.attempts;
}

export function pending(app: AppDoc, all: boolean): PendingAppChecks {
  const project = getProject(app.ontologyId);
  const base = baselineRevision(project);
  const attempt = nextAttempt(app);
  const targets = listCRs(project.id)
    .filter(isOpen)
    .sort((a, b) => a.number - b.number)
    .map((cr) => {
      const revision = revisionOf(cr, project);
      const last = latestCheck(app.id, cr.id);
      return {
        changeRequestId: cr.id,
        number: cr.number,
        title: cr.title,
        kind: cr.kind,
        level: cr.classification?.level,
        status: cr.status,
        revision,
        source: `/api/change-requests/${cr.id}/proposed`,
        page: `/o/${project.id}/changes/${cr.id}`,
        lastOutcome: last?.revision === revision ? last.outcome : undefined,
        // 'error' means the run broke before testing anything, so it's worth another go.
        done: last?.revision === revision && last.outcome !== 'error',
      };
    })
    .filter((t) => all || !t.done)
    .map(({ done: _d, ...t }) => t);
  return {
    app: { id: app.id, name: app.name },
    attempt,
    ontology: { id: project.id, slug: project.slug, title: project.title, ontologyIRI: project.ontologyIRI },
    formats: Object.keys(FORMAT_INFO) as OutputFormat[],
    baseline: {
      revision: base,
      source: `/api/ontologies/${project.id}/source?ref=working`,
      outcome: app.baseline?.revision === base ? app.baseline.outcome : undefined,
    },
    targets,
  };
}

const OUTCOMES: AppCheckOutcome[] = ['passed', 'failed', 'error'];

function cleanUrl(u: unknown): string | undefined {
  if (typeof u !== 'string' || !u.trim()) return undefined;
  try {
    const url = new URL(u.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
const short = (s: unknown, max: number) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, max) : undefined);

export interface ReportInput {
  target: unknown;
  revision: unknown;
  attempt: unknown;
  outcome: unknown;
  summary?: unknown;
  runUrl?: unknown;
  commit?: unknown;
}

/**
 * Is this result older than the one already stored? Results for the current revision beat
 * results for an older one, and within a revision a later run beats an earlier one. The same
 * run reporting the same thing again is a replay; reporting something different is a conflict.
 */
function ordering(
  previous: { revision: string; attempt?: number; outcome: AppCheckOutcome } | undefined,
  next: { revision: string; attempt: number; outcome: AppCheckOutcome },
  current: string,
): 'newer' | 'stale' | 'replay' {
  if (next.revision !== current) return 'stale';
  if (!previous || previous.revision !== current) return 'newer';
  const prev = previous.attempt ?? 0;
  if (next.attempt > prev) return 'newer';
  if (next.attempt < prev) return 'stale';
  if (previous.outcome === next.outcome) return 'replay';
  throw new HttpError(409, `Run ${next.attempt} already reported ${previous.outcome} for this; a run reports each target once`);
}

export async function report(app: AppDoc, input: ReportInput) {
  const outcome = input.outcome as AppCheckOutcome;
  if (!OUTCOMES.includes(outcome)) throw new HttpError(400, `outcome must be one of ${OUTCOMES.join(', ')}`);
  const revision = short(input.revision, 64);
  if (!revision) throw new HttpError(400, 'revision is required: send the one you were given with the target');
  const attempt = Number(input.attempt);
  if (!Number.isInteger(attempt) || attempt < 1) throw new HttpError(400, 'attempt is required: send the one GET /api/app-checks/pending gave this run');
  if (attempt > (app.attempts ?? 0)) throw new HttpError(400, `attempt ${attempt} was never issued to this app`);
  const project = getProject(app.ontologyId);
  const summary = short(input.summary, 2000);
  const runUrl = cleanUrl(input.runUrl);
  const at = clock.iso();

  if (input.target === 'baseline') {
    const order = ordering(app.baseline, { revision, attempt, outcome }, baselineRevision(project));
    if (order !== 'newer') return { stale: order === 'stale', replay: order === 'replay' };
    const before = app.baseline?.revision === revision ? app.baseline.outcome : undefined;
    app.baseline = { revision, outcome, summary, runUrl, at, attempt };
    saveApp(app);
    if (before !== outcome && outcome === 'failed')
      logActivity({ ontologyId: project.id, actorId: app.ownerId, type: 'app.baseline-failed', message: `reports that their app ${app.name} fails against the current working draft`, link: `/o/${project.id}/apps` });
    // The baseline decides whether this app's results mean anything, so re-decide everywhere.
    await reconcile(project.id, [app.ownerId]);
    return { stale: false };
  }

  if (typeof input.target !== 'string') throw new HttpError(400, "target must be 'baseline' or a change request id");
  const cr = getCR(input.target);
  if (cr.ontologyId !== app.ontologyId) throw new HttpError(404, `change request ${input.target} not found`);
  const previous = latestCheck(app.id, cr.id);
  const order = ordering(previous, { revision, attempt, outcome }, revisionOf(cr, project));
  if (order !== 'newer') return { check: previous, stale: order === 'stale', replay: order === 'replay' };
  const check: AppCheck = {
    id: checkId(app.id, cr.id),
    appId: app.id,
    ontologyId: app.ontologyId,
    changeRequestId: cr.id,
    revision,
    outcome,
    summary,
    runUrl,
    commit: short(input.commit, 64),
    attempt,
    at,
  };
  put('appChecks', check, cr.id);
  const changed = !previous || previous.outcome !== outcome || previous.revision !== revision;
  if (changed && outcome !== 'error') {
    const owner = getUser(app.ownerId)?.name ?? 'Someone';
    cr.timeline.push({
      at,
      type: 'app-check',
      message:
        outcome === 'passed'
          ? `${owner}’s app ${app.name} passed its checks against this change.`
          : `${owner}’s app ${app.name} failed its checks against this change${summary ? `: ${summary.split('\n')[0].slice(0, 200)}` : '.'}`,
    });
    saveCR(cr);
    if (outcome === 'failed')
      logActivity({ ontologyId: cr.ontologyId, actorId: app.ownerId, type: 'app.failed', message: `reports that their app ${app.name} breaks with #${cr.number} ${cr.title}`, link: `/o/${cr.ontologyId}/changes/${cr.id}` });
  }
  const autopilot = await applyAutopilot(cr.id, app.ownerId);
  return { check, stale: false, autopilot };
}

/** Report a result as an app, without its token (the demo's simulated CI). */
export function reportAs(appId: string, input: Omit<ReportInput, 'attempt'>) {
  const app = getAppDoc(appId);
  return report(app, { ...input, attempt: nextAttempt(app) });
}

/** Results for the change request page. */
export function checksFor(cr: ChangeRequest): AppCheckResult[] {
  const project = getProject(cr.ontologyId);
  const current = revisionOf(cr, project);
  const apps = new Map(list<AppDoc>('apps', cr.ontologyId).map((a) => [a.id, a]));
  return list<AppCheck>('appChecks', cr.id)
    .filter((c) => apps.has(c.appId))
    .map((c) => {
      const a = apps.get(c.appId)!;
      return {
        ...c,
        current: c.revision === current,
        app: { id: a.id, name: a.name, repo: a.repo, ownerId: a.ownerId, owner: publicUser(getUser(a.ownerId)), autopilot: a.autopilot.enabled },
      };
    })
    .sort((a, b) => a.app.name.localeCompare(b.app.name));
}

/* ------------------------------------------------------------------------ */
/* Autopilot                                                                 */
/* ------------------------------------------------------------------------ */

export interface AutopilotResult {
  action: 'none' | 'approved' | 'voted-yes' | 'voted-no' | 'withdrew';
  message: string;
}

type Say = Review | Vote;
const isYes = (x: Say) => ('decision' in x ? x.decision === 'approve' : x.choice === 'yes');

/**
 * Whether a review or vote autopilot made still stands: it was made for the change's current
 * revision, autopilot is still allowed and on for every app it relied on, and each of those
 * apps' latest result for this revision still says what it said. Governance counts an
 * autopilot say only while this holds, so a result arriving at any moment (even while a
 * merge is being prepared) takes effect at once, before autopilot itself catches up.
 */
export function autopilotStands(x: Say, cr: ChangeRequest, revision: string): boolean {
  const mark = x.autopilot;
  if (!mark) return true;
  if (x.withdrawnAt || mark.revision !== revision || !mark.apps.length) return false;
  if (getProject(cr.ontologyId).governance.automation.appAutopilot === false) return false;
  const want: AppCheckOutcome = isYes(x) ? 'passed' : 'failed';
  return mark.apps.every((m) => {
    const app = get<AppDoc>('apps', m.id);
    const check = latestCheck(m.id, cr.id);
    return !!app && app.ownerId === x.userId && app.autopilot.enabled && check?.revision === revision && check.outcome === want;
  });
}

interface Decision {
  say: 'yes' | 'no' | 'none';
  why: string;
  apps: AppDoc[];
}

/** What autopilot should be saying for this person on this change right now. */
function decide(cr: ChangeRequest, userId: string, stage: 'review' | 'voting'): Decision {
  const none = (why: string): Decision => ({ say: 'none', why, apps: [] });
  const project = getProject(cr.ontologyId);
  if (project.governance.automation.appAutopilot === false) return none('this ontology’s governance policy has autopilot turned off');
  const apps = list<AppDoc>('apps', cr.ontologyId).filter((a) => a.ownerId === userId && a.autopilot.enabled);
  if (!apps.length) return none('no app has autopilot on');
  const revision = revisionOf(cr, project);
  const base = baselineRevision(project);
  const names = (as: AppDoc[]) => as.map((a) => a.name).join(', ');

  // An app that fails (or hasn't been tested on) the working draft says nothing about a change.
  const brokenBase = apps.filter((a) => a.baseline?.revision === base && a.baseline.outcome !== 'passed');
  if (brokenBase.length) return none(`${names(brokenBase)} doesn’t pass the working draft, so its results don’t say anything about this change`);
  const untestedBase = apps.filter((a) => a.baseline?.revision !== base);
  if (untestedBase.length) return none(`waiting for ${names(untestedBase)} to test the current working draft`);

  const result = (a: AppDoc) => {
    const c = latestCheck(a.id, cr.id);
    return c?.revision === revision ? c.outcome : undefined;
  };
  const failed = apps.filter((a) => result(a) === 'failed');
  if (failed.length) {
    const opposing = failed.filter((a) => a.autopilot.onFailure === 'oppose');
    if (stage === 'voting' && opposing.length) return { say: 'no', why: `${names(opposing)} failed against this change`, apps: opposing };
    return none(`${names(failed)} failed against this change`);
  }
  const waiting = apps.filter((a) => result(a) !== 'passed');
  if (waiting.length) return none(`waiting for ${names(waiting)} to test this version of the change`);
  const level = cr.classification?.level ?? 'minor';
  const notFor = apps.filter((a) => !a.autopilot.levels.includes(level));
  if (notFor.length) return none(`autopilot for ${names(notFor)} isn’t on for ${level} changes`);

  const g = governanceFor(cr, { status: stage });
  const roles = rolesFor(cr.ontologyId, userId);
  if (stage === 'voting') {
    if (!canVote(g.rule, roles)) return none('your role doesn’t vote on this change');
  } else {
    if (cr.authorId === userId) return none('authors can’t approve their own change');
    if (!g.rule.approverRoles.some((r) => roles.includes(r))) return none('your role’s approvals don’t count for this change, so autopilot will vote if it goes to a vote');
  }
  return { say: 'yes', why: `${names(apps)} passed against this change`, apps };
}

/**
 * Make autopilot's say for one person on one change match what their apps found. Safe to call
 * any time. It says yes or no through a normal review or vote (marked as autopilot), and takes
 * its say back by marking it withdrawn, so an older review or vote never comes back into force.
 * Once the person has reviewed or voted on this version of the change themselves, at any stage,
 * autopilot leaves them alone.
 */
export async function applyAutopilot(crId: string, userId: string): Promise<AutopilotResult> {
  const none = (message: string): AutopilotResult => ({ action: 'none', message });
  let cr = getCR(crId);
  const stage = cr.status === 'approved' ? cr.approvedFrom : cr.status;
  if (stage !== 'review' && stage !== 'voting') return none(`The change request is ${cr.status}.`);
  const user = getUser(userId);
  if (!user) return none('Unknown person.');

  const since = cr.opsUpdatedAt ?? cr.createdAt;
  const mine = <T extends Say>(xs: T[]) => xs.filter((x) => x.userId === userId && x.at >= since);
  const reviews = mine(reviewsFor(cr.id)).filter((r) => r.decision !== 'comment');
  const votes = mine(votesFor(cr.id));
  if ([...reviews, ...votes].some((x) => !x.autopilot)) return none('You reviewed or voted on this change yourself, so autopilot leaves it to you.');

  const revision = revisionOf(cr);
  const d = decide(cr, userId, stage);
  const why = d.why.charAt(0).toUpperCase() + d.why.slice(1);
  const active = [...reviews, ...votes].filter((x) => !x.withdrawnAt && x.autopilot!.revision === revision);
  const latestVote = votes.at(-1);
  const latestReview = reviews.at(-1);
  const standing = (x: Say | undefined) => (x && !x.withdrawnAt && x.autopilot!.revision === revision ? x : undefined);

  // Take back anything autopilot said that it wouldn't say now. (A new yes or no replaces an
  // opposite vote by itself, so only a change to "nothing", or from yes to no, needs this.)
  const wrong = d.say === 'yes' ? [] : active.filter((x) => d.say === 'none' || isYes(x));
  if (wrong.length) {
    const at = clock.iso();
    for (const x of wrong) put('decision' in x ? 'reviews' : 'votes', { ...x, withdrawnAt: at }, cr.id);
    cr = getCR(cr.id);
    cr.timeline.push({ at, type: 'app-check', message: `Autopilot withdrew ${user.name}’s ${wrong.some(isYes) ? 'yes' : 'no'}: ${d.why}.` });
    saveCR(cr);
    // Withdrawing can move the change (an approval that no longer holds goes back a stage),
    // so decide again from where it ends up.
    await advance(getCR(cr.id));
    const then = await applyAutopilot(crId, userId);
    return then.action === 'none' ? { action: 'withdrew', message: `Withdrew the autopilot ${wrong.some(isYes) ? 'yes' : 'no'}. ${why}.` } : then;
  }

  const mark = (): AutopilotMark => ({ revision, apps: d.apps.map((a) => ({ id: a.id, name: a.name, runUrl: latestCheck(a.id, cr.id)?.runUrl })) });
  if (d.say === 'yes') {
    if (cr.status === 'voting') {
      const v = standing(latestVote);
      if (v && isYes(v)) return none('Autopilot already voted yes.');
      await addVote(cr, user, 'yes', `Autopilot: ${d.why}.`, mark());
      return { action: 'voted-yes', message: `Voted yes. ${why}.` };
    }
    if (cr.status === 'review') {
      if (standing(latestReview)) return none('Autopilot already approved this.');
      await addReview(cr, user, 'approve', `Autopilot: ${d.why}.`, mark());
      return { action: 'approved', message: `Approved. ${why}.` };
    }
    return none(why);
  }
  if (d.say === 'no' && cr.status === 'voting') {
    const v = standing(latestVote);
    if (v && !isYes(v)) return none('Autopilot already voted no.');
    await addVote(cr, user, 'no', `Autopilot: ${d.why}.`, mark());
    return { action: 'voted-no', message: `Voted no. ${why}.` };
  }
  return none(`${why}.`);
}

/** Everyone autopilot might speak for on a change: app owners, and anyone it has spoken for. */
function autopilotPeople(cr: ChangeRequest): string[] {
  const ids = new Set(list<AppDoc>('apps', cr.ontologyId).map((a) => a.ownerId));
  for (const x of [...reviewsFor(cr.id), ...votesFor(cr.id)]) if (x.autopilot) ids.add(x.userId);
  return [...ids];
}

const autopilotStage = (cr: ChangeRequest) => isOpen(cr) || (cr.status === 'approved' && !!cr.approvedFrom);

/** Bring autopilot up to date on every open change of an ontology, for some people or everyone. */
export async function reconcile(ontologyId: string, userIds?: string[]) {
  for (const { id } of listCRs(ontologyId)) {
    const cr = getCR(id);
    if (!autopilotStage(cr)) continue;
    for (const userId of userIds ?? autopilotPeople(cr)) await applyAutopilot(id, userId);
  }
}

/** When a change enters review or a vote, act on any results that are already in. */
export async function onStatusChanged(cr: ChangeRequest) {
  if (!isOpen(cr)) return;
  for (const userId of autopilotPeople(cr)) await applyAutopilot(cr.id, userId);
}
