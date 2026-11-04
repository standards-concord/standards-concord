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
}

/** Change request statuses the CI is asked to test, and autopilot acts on. */
const CHECKABLE = ['review', 'voting'] as const;
const DEFAULT_AUTOPILOT: AutopilotSettings = { enabled: false, levels: ['patch', 'minor'], onFailure: 'report' };
const LEVELS: ChangeLevel[] = ['patch', 'minor', 'major'];

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const newAppToken = () => `cna_${randomBytes(24).toString('base64url')}`;
const checkId = (appId: string, crId: string) => `${appId}:${crId}`;

function publicApp(doc: AppDoc): ConnectedApp {
  const { tokenHash: _h, ...rest } = doc;
  return { ...rest, owner: publicUser(getUser(doc.ownerId)) };
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

export function createApp(project: OntologyProject, owner: User, input: { name: unknown; repo?: unknown; autopilot?: unknown }): ConnectedApp {
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
  return { ...publicApp(doc), token };
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
  for (const cr of listCRs(doc.ontologyId).filter((c) => (CHECKABLE as readonly string[]).includes(c.status))) await applyAutopilot(cr.id, doc.ownerId);
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

export function deleteApp(id: string, actor: User) {
  const doc = ownApp(id, actor);
  for (const c of list<AppCheck>('appChecks').filter((x) => x.appId === id)) remove('appChecks', c.id);
  remove('apps', id);
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

export function pending(app: AppDoc, all: boolean): PendingAppChecks {
  const project = getProject(app.ontologyId);
  const base = baselineRevision(project);
  const targets = listCRs(project.id)
    .filter((cr) => (CHECKABLE as readonly string[]).includes(cr.status))
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
  outcome: unknown;
  summary?: unknown;
  runUrl?: unknown;
  commit?: unknown;
}

export async function report(app: AppDoc, input: ReportInput) {
  const outcome = input.outcome as AppCheckOutcome;
  if (!OUTCOMES.includes(outcome)) throw new HttpError(400, `outcome must be one of ${OUTCOMES.join(', ')}`);
  const revision = short(input.revision, 64);
  if (!revision) throw new HttpError(400, 'revision is required: send the one you were given with the target');
  const project = getProject(app.ontologyId);
  const summary = short(input.summary, 2000);
  const runUrl = cleanUrl(input.runUrl);
  const at = clock.iso();

  if (input.target === 'baseline') {
    const stale = revision !== baselineRevision(project);
    if (!stale) {
      const before = app.baseline?.outcome;
      app.baseline = { revision, outcome, summary, runUrl, at };
      saveApp(app);
      if (before !== outcome && outcome === 'failed')
        logActivity({ ontologyId: project.id, actorId: app.ownerId, type: 'app.baseline-failed', message: `reports that their app ${app.name} fails against the current working draft`, link: `/o/${project.id}/apps` });
      // A failing baseline means the app's results say nothing about the changes; re-decide.
      for (const cr of listCRs(project.id).filter((c) => (CHECKABLE as readonly string[]).includes(c.status))) await applyAutopilot(cr.id, app.ownerId);
    }
    return { stale };
  }

  if (typeof input.target !== 'string') throw new HttpError(400, "target must be 'baseline' or a change request id");
  const cr = getCR(input.target);
  if (cr.ontologyId !== app.ontologyId) throw new HttpError(404, `change request ${input.target} not found`);
  const current = revisionOf(cr, project);
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
    at,
  };
  const stale = revision !== current;
  // A late result for an old revision doesn't replace a result for the current one.
  const previous = latestCheck(app.id, cr.id);
  if (stale && previous?.revision === current) return { check: previous, stale };
  put('appChecks', check, cr.id);
  const changed = !previous || previous.outcome !== outcome || previous.revision !== revision;
  if (!stale && changed && outcome !== 'error') {
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
  const autopilot = stale ? undefined : await applyAutopilot(cr.id, app.ownerId);
  return { check, stale, autopilot };
}

/** Report a result as an app, without its token (the demo's simulated CI). */
export const reportAs = (appId: string, input: ReportInput) => report(getAppDoc(appId), input);

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

const isAutopilotYes = (x: Review | Vote | undefined) => !!x?.autopilot && ('decision' in x ? x.decision === 'approve' : x.choice === 'yes');

/**
 * Decide what autopilot should say for one person on one change, and say it. Safe to call
 * any time: it only acts when the decision differs from what autopilot last said, and it
 * never overrides a review or vote the person made themselves on this version of the change.
 */
export async function applyAutopilot(crId: string, userId: string): Promise<AutopilotResult> {
  const none = (message: string): AutopilotResult => ({ action: 'none', message });
  const cr = getCR(crId);
  if (!(CHECKABLE as readonly string[]).includes(cr.status)) return none(`The change request is ${cr.status}.`);
  const project = getProject(cr.ontologyId);
  if (project.governance.automation.appAutopilot === false) return none('This ontology’s governance policy has autopilot turned off.');
  const user = getUser(userId);
  if (!user) return none('Unknown person.');
  const level = cr.classification?.level ?? 'minor';
  const revision = revisionOf(cr, project);
  const base = baselineRevision(project);
  const apps = list<AppDoc>('apps', cr.ontologyId).filter((a) => a.ownerId === userId && a.autopilot.enabled);
  if (!apps.length) return none('No app has autopilot on.');

  const since = cr.opsUpdatedAt ?? cr.createdAt;
  const myReviews = reviewsFor(cr.id).filter((r) => r.userId === userId && r.at >= since && r.decision !== 'comment');
  const myVotes = votesFor(cr.id).filter((v) => v.userId === userId && v.at >= since);
  const lastReview = myReviews.at(-1);
  const lastVote = myVotes.at(-1);
  // People always win: autopilot never overrides what someone said themselves.
  if (cr.status === 'review' && lastReview && !lastReview.autopilot) return none('You reviewed this change yourself.');
  if (cr.status === 'voting' && lastVote && !lastVote.autopilot) return none('You voted on this change yourself.');

  const results = apps.map((a) => ({ app: a, check: latestCheck(a.id, cr.id) }));
  const failed = results.filter((r) => r.check?.revision === revision && r.check.outcome === 'failed');
  const passed = results.filter((r) => r.check?.revision === revision && r.check.outcome === 'passed');
  const brokenBaseline = apps.filter((a) => a.baseline?.revision === base && a.baseline.outcome === 'failed');
  const mark = (rs: typeof results): AutopilotMark => ({ revision, apps: rs.map((r) => ({ id: r.app.id, name: r.app.name, runUrl: r.check?.runUrl })) });
  const names = (rs: typeof results) => rs.map((r) => r.app.name).join(', ');
  const g = governanceFor(cr);
  const roles = rolesFor(cr.ontologyId, userId);

  if (failed.length) {
    // Take back any yes autopilot gave on this person's behalf.
    const withdrew = withdrawYes(cr, userId, lastReview, lastVote, `${names(failed)} failed against this change`);
    const opposeApps = failed.filter((r) => r.app.autopilot.onFailure === 'oppose');
    if (cr.status === 'voting' && opposeApps.length && canVote(g.rule, roles) && !(lastVote?.autopilot && lastVote.choice === 'no')) {
      await addVote(getCR(cr.id), user, 'no', `Autopilot: ${names(opposeApps)} failed against this change.`, mark(opposeApps));
      return { action: 'voted-no', message: `Voted no: ${names(opposeApps)} failed.` };
    }
    if (withdrew) {
      await advance(getCR(cr.id));
      return { action: 'withdrew', message: `Withdrew the autopilot yes: ${names(failed)} failed.` };
    }
    return none(`${names(failed)} failed against this change.`);
  }
  if (brokenBaseline.length) return none(`${brokenBaseline.map((a) => a.name).join(', ')} fails against the working draft too, so its results don't say anything about this change.`);
  const eligible = apps.filter((a) => a.autopilot.levels.includes(level));
  if (!eligible.length) return none(`Autopilot isn’t on for ${level} changes.`);
  if (results.some((r) => !(r.check?.revision === revision && (r.check.outcome === 'passed' || r.check.outcome === 'failed'))))
    return none('Waiting for all of your autopilot apps to test this version of the change.');
  // Everything passed: say yes in the way this stage allows.
  if (cr.status === 'voting') {
    if (!canVote(g.rule, roles)) return none('Your role doesn’t vote on this change.');
    if (isAutopilotYes(lastVote) && lastVote!.autopilot!.revision === revision) return none('Autopilot already voted yes.');
    await addVote(getCR(cr.id), user, 'yes', `Autopilot: ${names(passed)} passed against this change.`, mark(passed));
    return { action: 'voted-yes', message: `Voted yes: ${names(passed)} passed.` };
  }
  if (cr.authorId === userId) return none('Authors can’t approve their own change.');
  if (!g.rule.approverRoles.some((r) => roles.includes(r))) return none('Your role’s approvals don’t count for this change, so autopilot will vote if it goes to a vote.');
  if (isAutopilotYes(lastReview)) return none('Autopilot already approved this.');
  await addReview(getCR(cr.id), user, 'approve', `Autopilot: ${names(passed)} passed against this change.`, mark(passed));
  return { action: 'approved', message: `Approved: ${names(passed)} passed.` };
}

/** Remove autopilot's yes for this person, if that is their latest say. Returns whether it did. */
function withdrawYes(cr: ChangeRequest, userId: string, lastReview: Review | undefined, lastVote: Vote | undefined, why: string): boolean {
  let did = false;
  if (isAutopilotYes(lastReview)) {
    remove('reviews', lastReview!.id);
    did = true;
  }
  if (isAutopilotYes(lastVote)) {
    remove('votes', lastVote!.id);
    did = true;
  }
  if (did) {
    const fresh = getCR(cr.id);
    fresh.timeline.push({ at: clock.iso(), type: 'app-check', message: `Autopilot withdrew ${getUser(userId)?.name ?? 'their'}’s yes: ${why}.` });
    saveCR(fresh);
  }
  return did;
}

/** When a change enters review or a vote, act on any results that are already in. */
export async function onStatusChanged(cr: ChangeRequest) {
  if (!(CHECKABLE as readonly string[]).includes(cr.status)) return;
  const owners = new Set(list<AppDoc>('apps', cr.ontologyId).filter((a) => a.autopilot.enabled).map((a) => a.ownerId));
  for (const userId of owners) await applyAutopilot(cr.id, userId);
}
