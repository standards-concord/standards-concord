import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
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
import { get, HttpError, list, mustGet, put, remove, transaction } from '../db.js';
import { newId } from '../ids.js';
import { addReview, addVote, advance, getCR, governanceFor, listCRs, reviewsFor, saveCR, votesFor } from './changeRequests.js';
import { canVote, effectiveRule } from './governance.js';
import { getProject, rolesFor, setRoles } from './ontologies.js';
import { ontologyStore } from './ontologyStore.js';
import { runAudience, verifyGithubRun, type VerifiedRun } from './ciIdentity.js';
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
  /** What the most recent runs were asked to test: the baseline revision and each change's revision. */
  runs?: {
    attempt: number;
    baseline: string;
    targets: Record<string, string>;
    /** What this run found on the working draft, and with which app commit. Its change results are tied to it. */
    reported?: {
      outcome: AppCheckOutcome;
      commit?: string;
      verified?: boolean;
      /** The GitHub token that proved the run, so a retry of the same report may bring it again. */
      jti?: string;
      /** Hash of the key change results from this run present to count as verified. */
      keyHash?: string;
    };
    /** The run asked to test everything again (recheck). */
    all?: boolean;
  }[];
  /**
   * The run from which the app has passed the current working draft without a break (same
   * draft, same app commit). Results for changes count only from this run on, so a result
   * from before the app broke, or from another version of the app, never comes back into force.
   */
  passingSince?: number;
  /** The GitHub repository's id, pinned by the first verified run (a re-created repository has a new one). */
  repoId?: string;
}

const RUNS_KEPT = 20;

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
  const { tokenHash: _h, attempts: _a, runs: _r, passingSince: _p, repoId: _i, ...rest } = doc;
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

/** The app's owner, or the ontology's owners and stewards, who can disconnect any app on it. */
function manageApp(id: string, actor: User): AppDoc {
  const doc = getAppDoc(id);
  if (doc.ownerId === actor.id || actor.isPlatformAdmin || rolesFor(doc.ontologyId, actor.id).some((r) => r === 'owner' || r === 'steward')) return doc;
  throw new HttpError(403, 'Only the person who connected this app, or the ontology’s owners and stewards, can disconnect it');
}

export async function updateApp(id: string, actor: User, patch: { name?: unknown; repo?: unknown; autopilot?: unknown }): Promise<ConnectedApp> {
  const doc = ownApp(id, actor);
  if (patch.name !== undefined) doc.name = cleanName(patch.name);
  if (patch.repo !== undefined) {
    const repo = cleanRepo(patch.repo);
    if (repo?.toLowerCase() !== doc.repo?.toLowerCase()) doc.repoId = undefined;
    doc.repo = repo;
  }
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
  const doc = manageApp(id, actor);
  for (const c of list<AppCheck>('appChecks').filter((x) => x.appId === id)) remove('appChecks', c.id);
  remove('apps', id);
  if (doc.ownerId !== actor.id)
    logActivity({ ontologyId: doc.ontologyId, actorId: actor.id, type: 'app.disconnected', message: `disconnected ${getUser(doc.ownerId)?.name ?? 'someone'}’s app ${doc.name}, so its token no longer works`, link: `/o/${doc.ontologyId}/apps` });
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
  stillConnected(doc);
  doc.lastSeenAt = clock.iso();
  saveApp(doc);
  return doc;
}

/** An app works only while the person who connected it is still a member of the ontology. */
function stillConnected(doc: AppDoc) {
  if (!rolesFor(doc.ontologyId, doc.ownerId).length) throw new HttpError(401, 'This app’s owner is no longer a member of the ontology, so the app is disconnected');
}

/** The app a signed-in person reports for themselves (their own CI, or a simulated run). */
export function appForOwner(appId: unknown, actor: User): AppDoc {
  if (typeof appId !== 'string' || !appId) throw new HttpError(400, 'Send appId, or the app token as Authorization: Bearer cna_…');
  const doc = getAppDoc(appId);
  if (doc.ownerId !== actor.id) throw new HttpError(403, 'Only the person who connected this app can report for it without its token');
  stillConnected(doc);
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
/** Whether CI may test (and so download) this change: only while it's in review, a vote, or approved. */
export const openForChecks = isOpen;

/**
 * When the app's results for changes count from: the run since which it has passed the
 * current working draft. Undefined while it doesn't pass the current draft.
 */
function countsFrom(app: AppDoc, project = getProject(app.ontologyId)): number | undefined {
  if (app.baseline?.revision !== baselineRevision(project) || app.baseline.outcome !== 'passed') return undefined;
  return app.passingSince ?? app.baseline.attempt ?? 0;
}

/** The app's result for this version of a change, if it counts (see passingSince). */
function resultFor(app: AppDoc, cr: ChangeRequest, revision: string, project = getProject(cr.ontologyId)): AppCheck | undefined {
  const from = countsFrom(app, project);
  const c = latestCheck(app.id, cr.id);
  if (from === undefined || c?.revision !== revision || (c.attempt ?? 0) < from) return undefined;
  const base = app.baseline!;
  // With an app commit, results carry over between runs of that same commit. Without one there
  // is no telling app versions apart, so only the run whose draft result is in force counts.
  const sameApp = base.commit ? c.commit === base.commit : c.attempt === base.attempt;
  return sameApp ? c : undefined;
}

type Target = PendingAppChecks['targets'][number];

/**
 * Whether the app has a result for this change that counts now (and isn't an error). For a
 * verified run, an unverified result doesn't settle anything: the run tests the change again.
 */
function settled(app: AppDoc, cr: ChangeRequest, revision: string, project: OntologyProject, needVerified = false) {
  const counted = resultFor(app, cr, revision, project);
  return !!counted && counted.outcome !== 'error' && (!needVerified || !!counted.verified);
}

/**
 * Changes to test, first come first served: each waits from when the app last tested it (or, if
 * it never has, from when the change was proposed). A run that can only test some of them takes
 * those waiting longest, and testing one sends it to the back, so neither a backlog nor a steady
 * stream of new changes can starve a change whose earlier result stopped counting.
 */
function targetsFor(app: AppDoc, project: OntologyProject, crIds?: Record<string, string>, needVerified = false): (Target & { settled: boolean; waitingSince: string })[] {
  return listCRs(project.id)
    .filter(isOpen)
    .filter((cr) => !crIds || crIds[cr.id] === revisionOf(cr, project))
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
        lastTestedAt: last?.at,
        settled: settled(app, cr, revision, project, needVerified),
        waitingSince: last?.at ?? cr.createdAt,
      };
    })
    .sort((x, y) => x.waitingSince.localeCompare(y.waitingSince) || x.number - y.number);
}

/**
 * Start a run: a new attempt number, and a record of exactly what this run may test (every open
 * change). The targets listed are a first guess: the run's own result for the working draft
 * decides which earlier results still count, so the reply to that result says what to test.
 */
export function pending(app: AppDoc, all: boolean, commitParam?: unknown): PendingAppChecks {
  // A result can carry over to this run only if it tests the same app commit as the one behind
  // the draft result in force.
  const commit = short(commitParam, 64);
  const carriesOver = !!commit && commit === app.baseline?.commit;
  const project = getProject(app.ontologyId);
  const base = baselineRevision(project);
  const open = targetsFor(app, project);
  const targets = open.filter((t) => all || !(carriesOver && t.settled)).map(({ settled: _s, waitingSince: _w, ...t }) => t);
  app.attempts = (app.attempts ?? 0) + 1;
  const attempt = app.attempts;
  app.runs = [...(app.runs ?? []), { attempt, all, baseline: base, targets: Object.fromEntries(open.map((t) => [t.changeRequestId, t.revision])) }].slice(-RUNS_KEPT);
  saveApp(app);
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

/** After a run's draft result is in: the changes this run should test, given what counts now. */
function retestsFor(app: AppDoc, run: NonNullable<AppDoc['runs']>[number], project: OntologyProject): Target[] {
  if (run.reported?.outcome !== 'passed') return [];
  return targetsFor(app, project, run.targets, !!run.reported.verified)
    .filter((t) => run.all || !t.settled)
    .map(({ settled: _s, waitingSince: _w, ...t }) => t);
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
  /** With the working draft result: a GitHub Actions OIDC token proving the run (see ciIdentity). */
  oidc?: unknown;
  /** With a change's result: the key the run's verified working-draft result was answered with. */
  runKey?: unknown;
}

/** How a report was made: with the app token alone, or by something that vouches for the run. */
export interface ReportedBy {
  /** The app's owner reported it signed in, or the demo's simulated CI did. */
  trusted?: boolean;
  /** The token the report came with (its hash): it must still be the app's when the report lands. */
  tokenHash?: string;
  /** The signed-in owner the report came from: they must still own the app when it lands. */
  ownerId?: string;
}

/**
 * Is this result older than the one already stored? Results for the current revision beat
 * results for an older one, verified results beat unverified ones, and otherwise a later run
 * beats an earlier one. The same
 * run reporting the same thing again is a replay; reporting something different is a conflict.
 */
function ordering(
  previous: { revision: string; attempt?: number; outcome: AppCheckOutcome; verified?: boolean } | undefined,
  next: { revision: string; attempt: number; outcome: AppCheckOutcome; verified: boolean },
  current: string,
): 'newer' | 'stale' | 'replay' {
  if (next.revision !== current) return 'stale';
  if (!previous || previous.revision !== current) return 'newer';
  // For one revision, a verified result is replaced only by another verified one, so a report
  // made with the app token alone can't undo (or get in ahead of) what a verified run found.
  if (!!previous.verified !== next.verified) return next.verified ? 'newer' : 'stale';
  const prev = previous.attempt ?? 0;
  if (next.attempt > prev) return 'newer';
  if (next.attempt < prev) return 'stale';
  if (previous.outcome === next.outcome) return 'replay';
  throw new HttpError(409, `Run ${next.attempt} already reported ${previous.outcome} for this; a run reports each target once`);
}

export async function report(appIn: AppDoc, input: ReportInput, by: ReportedBy = {}) {
  const appId = appIn.id;
  // GitHub's proof is the one thing a report waits for, so it is checked first. Everything after
  // works on the app as stored once the proof is in, in one transaction: a disconnection, a new
  // token or a newer result that landed meanwhile is never overwritten by what was read before.
  const attempt = Number(input.attempt);
  const proof =
    input.target === 'baseline' && input.oidc !== undefined
      ? await verifyGithubRun(input.oidc, runAudience(appId), {
          // The same report retried (say after a dropped connection) may bring the same proof again.
          mayReuse: (jti) => get<AppDoc>('apps', appId)?.runs?.find((r) => r.attempt === attempt)?.reported?.jti === jti,
        })
      : undefined;
  const step = transaction(() => applyReport(appId, input, by, proof));
  if (step.kind === 'done') return step.reply;
  if (step.kind === 'baseline') {
    // The baseline decides whether this app's results mean anything, so re-decide everywhere.
    await reconcile(step.ontologyId, [step.ownerId]);
    // Everything this result left without a result that counts gets tested in this same run.
    const app = get<AppDoc>('apps', appId);
    const run = app?.runs?.find((r) => r.attempt === step.attempt);
    return { ...step.reply, targets: app && run ? retestsFor(app, run, getProject(app.ontologyId)) : [] };
  }
  const autopilot = await applyAutopilot(step.crId, step.ownerId);
  return { ...step.reply, autopilot };
}

type Step =
  | { kind: 'done'; reply: Record<string, unknown> }
  | { kind: 'baseline'; reply: Record<string, unknown>; ontologyId: string; ownerId: string; attempt: number }
  | { kind: 'change'; reply: Record<string, unknown>; crId: string; ownerId: string };

const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The synchronous part of a report, run in one transaction on the app as it is stored now. */
function applyReport(appId: string, input: ReportInput, by: ReportedBy, proof: VerifiedRun | undefined): Step {
  const app = get<AppDoc>('apps', appId);
  if (!app) throw new HttpError(401, 'This app was disconnected');
  if (by.tokenHash !== undefined && app.tokenHash !== by.tokenHash) throw new HttpError(401, 'This app token was replaced');
  if (by.ownerId !== undefined && app.ownerId !== by.ownerId) throw new HttpError(403, 'Only the person who connected this app can report for it without its token');
  stillConnected(app);

  const outcome = input.outcome as AppCheckOutcome;
  if (!OUTCOMES.includes(outcome)) throw new HttpError(400, `outcome must be one of ${OUTCOMES.join(', ')}`);
  const revision = short(input.revision, 64);
  if (!revision) throw new HttpError(400, 'revision is required: send the one you were given with the target');
  const attempt = Number(input.attempt);
  if (!Number.isInteger(attempt) || attempt < 1) throw new HttpError(400, 'attempt is required: send the one GET /api/app-checks/pending gave this run');
  if (attempt > (app.attempts ?? 0)) throw new HttpError(400, `attempt ${attempt} was never issued to this app`);
  const project = getProject(app.ontologyId);
  const run = app.runs?.find((r) => r.attempt === attempt);
  // Too old to remember what it was asked: it is out of date whatever it says.
  if (!run) return { kind: 'done', reply: { stale: true } };
  const asked = input.target === 'baseline' ? run.baseline : typeof input.target === 'string' ? run.targets[input.target] : undefined;
  if (asked !== revision) throw new HttpError(400, `Run ${attempt} wasn't asked to test ${input.target === 'baseline' ? 'the working draft' : 'that change'} at revision ${revision}`);
  const summary = short(input.summary, 2000);
  const runUrl = cleanUrl(input.runUrl);
  const at = clock.iso();

  if (input.target === 'baseline') {
    let commit = short(input.commit, 64);
    // A run is verified when GitHub vouches that it ran in the app's repository, or its owner
    // reported it signed in. Only verified results move autopilot, so a leaked token can't.
    let verified = !!by.trusted;
    let jti: string | undefined;
    let keyHash: string | undefined;
    let runKey: string | undefined;
    if (proof) {
      if (!app.repo) throw new HttpError(400, 'Set the app’s GitHub repository on Concord, so it can check the run comes from there');
      if (proof.repository.toLowerCase() !== app.repo.toLowerCase()) throw new HttpError(400, `The run is from ${proof.repository}, not this app’s repository ${app.repo}`);
      // The repository's id is pinned on first use, so a deleted and re-created repository of the same name doesn't count.
      if (app.repoId && app.repoId !== proof.repositoryId)
        throw new HttpError(400, `${app.repo} isn’t the repository this app first ran from (its id changed). If you re-created it, set the repository on Concord again.`);
      if (commit && commit !== proof.sha) throw new HttpError(400, `The run tested commit ${proof.sha}, not ${commit}`);
      commit = proof.sha;
      app.repoId = proof.repositoryId;
      verified = true;
      jti = proof.jti;
      // Results for changes in this run prove they belong to it with this key, which only the
      // caller holding GitHub's proof gets back.
      runKey = `crk_${randomBytes(24).toString('base64url')}`;
      keyHash = hash(runKey);
    }
    const prior = run.reported;
    // A verified report replaces an unverified one for the same run (which anyone with the token could have sent first).
    if (prior && !(verified && !prior.verified)) {
      if (prior.outcome !== outcome || prior.commit !== commit)
        throw new HttpError(409, `Run ${attempt} already reported ${prior.outcome} for the working draft; a run reports it once`);
      verified = !!prior.verified;
      if (!proof) {
        jti = prior.jti;
        keyHash = prior.keyHash;
      }
    }
    run.reported = { outcome, commit, verified, jti, keyHash };
    saveApp(app);
    const keyReply = runKey ? { runKey } : {};
    const order = ordering(app.baseline, { revision, attempt, outcome, verified }, baselineRevision(project));
    if (order === 'stale') return { kind: 'done', reply: { stale: true, verified, ...keyReply, targets: [] } };
    if (order === 'replay') return { kind: 'done', reply: { stale: false, replay: true, verified, ...keyReply, targets: retestsFor(app, run, project) } };
    const before = app.baseline?.revision === revision ? app.baseline.outcome : undefined;
    // Still passing the same draft with the same app: earlier results for changes still count.
    const unbroken = outcome === 'passed' && app.baseline?.revision === revision && app.baseline.outcome === 'passed' && app.baseline.commit === commit;
    if (outcome === 'passed' && !unbroken) app.passingSince = attempt;
    app.baseline = { revision, outcome, summary, runUrl, at, attempt, commit, verified };
    saveApp(app);
    if (before !== outcome && outcome === 'failed')
      logActivity({ ontologyId: project.id, actorId: app.ownerId, type: 'app.baseline-failed', message: `reports that their app ${app.name} fails against the current working draft`, link: `/o/${project.id}/apps` });
    return { kind: 'baseline', reply: { stale: false, verified, ...keyReply }, ontologyId: project.id, ownerId: app.ownerId, attempt };
  }

  if (typeof input.target !== 'string') throw new HttpError(400, "target must be 'baseline' or a change request id");
  const cr = getCR(input.target);
  if (cr.ontologyId !== app.ontologyId) throw new HttpError(404, `change request ${input.target} not found`);
  // A change's result means something only next to a pass on the working draft from the same run.
  if (run.reported?.outcome !== 'passed')
    throw new HttpError(409, `Report run ${attempt}'s result for the working draft first; change results only count from a run that passed it`);
  const commit = run.reported.commit;
  if (input.commit !== undefined && short(input.commit, 64) !== commit) throw new HttpError(400, `Run ${attempt} tested app commit ${commit ?? '(none)'} on the working draft`);
  // Each result is verified on its own: the run must be verified, and this report must prove it
  // belongs to that run, with the run's key or by the owner signed in. The attempt number alone
  // proves nothing: anyone holding the app token can learn it.
  let verified = false;
  if (input.runKey !== undefined) {
    if (!run.reported.keyHash || !sameHash(hash(String(input.runKey)), run.reported.keyHash)) throw new HttpError(401, `That isn’t run ${attempt}’s key`);
    verified = !!run.reported.verified;
  } else if (by.trusted) verified = !!run.reported.verified;
  const previous = latestCheck(app.id, cr.id);
  const order = ordering(previous, { revision, attempt, outcome, verified }, revisionOf(cr, project));
  if (order !== 'newer') return { kind: 'done', reply: { check: previous, stale: order === 'stale', replay: order === 'replay' } };
  const check: AppCheck = {
    id: checkId(app.id, cr.id),
    appId: app.id,
    ontologyId: app.ontologyId,
    changeRequestId: cr.id,
    revision,
    outcome,
    summary,
    runUrl,
    commit,
    attempt,
    verified,
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
  return { kind: 'change', reply: { check, stale: false }, crId: cr.id, ownerId: app.ownerId };
}

/** Report a result as an app, without its token (the demo's simulated CI, which is trusted). */
export function reportAs(appId: string, input: ReportInput) {
  return report(getAppDoc(appId), input, { trusted: true });
}

/** Who a token-authenticated report comes from: the app, as long as that token is still its token. */
export const byToken = (app: AppDoc): ReportedBy => ({ tokenHash: app.tokenHash });

/** Start a run as an app, without its token (the demo's simulated CI). */
export const startRunAs = (appId: string) => pending(getAppDoc(appId), true).attempt;

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
        // Counts only for this version of the change, from a run tied to the app's current baseline.
        current: resultFor(a, cr, current, project)?.id === c.id,
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
type Stage = 'review' | 'voting';
const isYes = (x: Say) => ('decision' in x ? x.decision === 'approve' : x.choice === 'yes');
const stageOf = (x: Say): Stage => ('decision' in x ? 'review' : 'voting');

interface Decision {
  say: 'yes' | 'no' | 'none';
  why: string;
  apps: AppDoc[];
}

/** People who reviewed (not just commented) or voted on this version of the change themselves. */
export function peopleWhoSpoke(cr: ChangeRequest): Set<string> {
  const since = cr.opsUpdatedAt ?? cr.createdAt;
  const ids = new Set<string>();
  for (const r of reviewsFor(cr.id)) if (!r.autopilot && r.decision !== 'comment' && r.at >= since) ids.add(r.userId);
  for (const v of votesFor(cr.id)) if (!v.autopilot && v.at >= since) ids.add(v.userId);
  return ids;
}

/**
 * What autopilot should be saying for this person on this change, at this stage, right now.
 * Checks every prerequisite directly, so governance can use it to decide whether a say
 * autopilot made earlier still counts.
 */
function decide(cr: ChangeRequest, userId: string, stage: Stage, spoke = peopleWhoSpoke(cr)): Decision {
  const none = (why: string): Decision => ({ say: 'none', why, apps: [] });
  const project = getProject(cr.ontologyId);
  if (project.governance.automation.appAutopilot === false) return none('this ontology’s governance policy has autopilot turned off');
  if (spoke.has(userId)) return none('they reviewed or voted on this change themselves');
  const apps = list<AppDoc>('apps', cr.ontologyId)
    .filter((a) => a.ownerId === userId && a.autopilot.enabled)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!apps.length) return none('no app has autopilot on');
  const level = cr.classification?.level ?? 'minor';
  const rule = effectiveRule(project.governance, level, 'change');
  const roles = rolesFor(cr.ontologyId, userId);
  // Only people whose say counts at this stage get one from autopilot, yes or no.
  if (stage === 'voting' && !canVote(rule, roles)) return none('their role doesn’t vote on this change');
  if (stage === 'review') {
    if (cr.authorId === userId) return none('authors can’t approve their own change');
    if (!rule.approverRoles.some((r) => roles.includes(r))) return none('their role’s approvals don’t count for this change, so autopilot will vote if it goes to a vote');
  }
  const names = (as: AppDoc[]) => as.map((a) => a.name).join(', ');
  // An app that fails (or hasn't been tested on) the working draft says nothing about a change.
  const base = baselineRevision(project);
  const brokenBase = apps.filter((a) => a.baseline?.revision === base && a.baseline.outcome !== 'passed');
  if (brokenBase.length) return none(`${names(brokenBase)} doesn’t pass the working draft, so its results don’t say anything about this change`);
  const untestedBase = apps.filter((a) => a.baseline?.revision !== base);
  if (untestedBase.length) return none(`waiting for ${names(untestedBase)} to test the current working draft`);
  const verifiedRun = 'from GitHub Actions in its repository, or reported by its owner signed in';
  const unverifiedBase = apps.filter((a) => !a.baseline?.verified);
  if (unverifiedBase.length) return none(`waiting for a verified run of ${names(unverifiedBase)} (${verifiedRun})`);

  const revision = revisionOf(cr, project);
  const counted = (a: AppDoc) => resultFor(a, cr, revision, project);
  const result = (a: AppDoc) => counted(a)?.outcome;
  const failed = apps.filter((a) => result(a) === 'failed');
  if (failed.length) {
    // Only a verified failure votes no; any failure stops a yes.
    const opposing = failed.filter((a) => a.autopilot.onFailure === 'oppose' && counted(a)?.verified);
    if (stage === 'voting' && opposing.length) return { say: 'no', why: `${names(opposing)} failed against this change`, apps: opposing };
    return none(`${names(failed)} failed against this change`);
  }
  const waiting = apps.filter((a) => result(a) !== 'passed');
  if (waiting.length) return none(`waiting for ${names(waiting)} to test this version of the change`);
  const unverified = apps.filter((a) => !counted(a)?.verified);
  if (unverified.length) return none(`waiting for a verified run of ${names(unverified)} on this change (${verifiedRun})`);
  const notFor = apps.filter((a) => !a.autopilot.levels.includes(level));
  if (notFor.length) return none(`autopilot for ${names(notFor)} isn’t on for ${level} changes`);
  return { say: 'yes', why: `${names(apps)} passed against this change`, apps };
}

/** Does this autopilot say match what autopilot would say now: same answer, same apps, same version? */
function matches(x: Say, d: Decision, revision: string): boolean {
  if (x.withdrawnAt || !x.autopilot || x.autopilot.revision !== revision || d.say === 'none') return false;
  if (isYes(x) !== (d.say === 'yes')) return false;
  const ids = x.autopilot.apps.map((a) => a.id).sort();
  return ids.length === d.apps.length && d.apps.every((a, i) => a.id === ids[i]);
}

/**
 * Whether a review or vote autopilot made still stands: autopilot, deciding afresh from
 * everything as it is now, would say the same thing for the same version on the strength of
 * the same apps. Governance counts an autopilot say only while this holds, so a result, a
 * person's own review, or a settings change takes effect at once, even while a merge is being
 * prepared, without waiting for autopilot to catch up.
 */
export function autopilotStands(x: Say, cr: ChangeRequest, revision: string, spoke?: Set<string>): boolean {
  if (!x.autopilot) return true;
  return matches(x, decide(cr, x.userId, stageOf(x), spoke), revision);
}

/**
 * Make autopilot's say for one person on one change match what decide() says now. Safe to call
 * any time. It says yes or no through a normal review or vote (marked as autopilot), and takes
 * its say back by marking it withdrawn, so an older review or vote never comes back into force.
 */
export async function applyAutopilot(crId: string, userId: string, depth = 0): Promise<AutopilotResult> {
  const none = (message: string): AutopilotResult => ({ action: 'none', message });
  let cr = getCR(crId);
  const stage = cr.status === 'approved' ? cr.approvedFrom : cr.status;
  if (stage !== 'review' && stage !== 'voting') return none(`The change request is ${cr.status}.`);
  const user = getUser(userId);
  if (!user) return none('Unknown person.');

  const since = cr.opsUpdatedAt ?? cr.createdAt;
  const revision = revisionOf(cr);
  const spoke = peopleWhoSpoke(cr);
  const mine = <T extends Say>(xs: T[]) => xs.filter((x) => x.userId === userId && x.at >= since && x.autopilot);
  const says = [...mine(reviewsFor(cr.id)), ...mine(votesFor(cr.id))];
  const d = decide(cr, userId, stage, spoke);
  const why = d.why.charAt(0).toUpperCase() + d.why.slice(1);
  const canSay = d.say !== 'none' && cr.status === stage;
  const sayIn: 'review' | 'vote' = stage === 'voting' ? 'vote' : 'review';

  // Autopilot's says that are still in force (current version, not withdrawn) but that it
  // wouldn't make now. A new say in the same place replaces the person's latest one by itself;
  // anything else is withdrawn.
  const latestIn = (where: 'review' | 'vote') => says.filter((x) => ('decision' in x ? 'review' : 'vote') === where).at(-1);
  const inForce = [latestIn('review'), latestIn('vote')].filter((x): x is Say => !!x && !x.withdrawnAt && x.autopilot!.revision === revision);
  const replaced = (x: Say) => canSay && ('decision' in x ? 'review' : 'vote') === sayIn;
  const wrong = inForce.filter((x) => !autopilotStands(x, cr, revision, spoke) && !replaced(x));
  if (wrong.length && depth < 3) {
    const at = clock.iso();
    for (const x of wrong) put('decision' in x ? 'reviews' : 'votes', { ...x, withdrawnAt: at }, cr.id);
    cr = getCR(cr.id);
    cr.timeline.push({ at, type: 'app-check', message: `Autopilot withdrew ${user.name}’s ${wrong.some(isYes) ? 'yes' : 'no'}: ${d.why}.` });
    saveCR(cr);
    // Withdrawing can move the change (an approval that no longer holds goes back a stage),
    // so decide again from where it ends up.
    await advance(getCR(cr.id));
    const then = await applyAutopilot(crId, userId, depth + 1);
    return then.action === 'none' ? { action: 'withdrew', message: `Withdrew the autopilot ${wrong.some(isYes) ? 'yes' : 'no'}. ${why}.` } : then;
  }
  if (!canSay) return none(`${why}.`);

  const latest = latestIn(sayIn);
  if (latest && matches(latest, d, revision)) return none(`Autopilot already ${d.say === 'yes' ? (sayIn === 'vote' ? 'voted yes' : 'approved this') : 'voted no'}.`);
  const mark: AutopilotMark = { revision, apps: d.apps.map((a) => ({ id: a.id, name: a.name, runUrl: latestCheck(a.id, cr.id)?.runUrl })) };
  if (sayIn === 'vote') {
    await addVote(cr, user, d.say === 'yes' ? 'yes' : 'no', `Autopilot: ${d.why}.`, mark);
    return { action: d.say === 'yes' ? 'voted-yes' : 'voted-no', message: `Voted ${d.say}. ${why}.` };
  }
  await addReview(cr, user, 'approve', `Autopilot: ${d.why}.`, mark);
  return { action: 'approved', message: `Approved. ${why}.` };
}

/** Everyone autopilot might speak for on a change: app owners, and anyone it has spoken for. */
function autopilotPeople(cr: ChangeRequest): string[] {
  const ids = new Set(list<AppDoc>('apps', cr.ontologyId).map((a) => a.ownerId));
  for (const x of [...reviewsFor(cr.id), ...votesFor(cr.id)]) if (x.autopilot) ids.add(x.userId);
  return [...ids];
}

const autopilotStage = (cr: ChangeRequest) => cr.status === 'review' || cr.status === 'voting' || (cr.status === 'approved' && !!cr.approvedFrom);

/** One person's autopilot never stops anyone else's: errors are logged and the rest carry on. */
async function applyFor(crId: string, userIds: string[]) {
  for (const userId of userIds) {
    try {
      await applyAutopilot(crId, userId);
    } catch (err) {
      console.warn(`autopilot for ${userId} on ${crId}:`, (err as Error).message);
    }
  }
}

/** Bring autopilot up to date on every open change of an ontology, for some people or everyone. */
export async function reconcile(ontologyId: string, userIds?: string[]) {
  for (const { id } of listCRs(ontologyId)) {
    const cr = getCR(id);
    if (autopilotStage(cr)) await applyFor(id, userIds ?? autopilotPeople(cr));
  }
}

/** When a change enters review or a vote, act on any results that are already in. */
export async function onStatusChanged(cr: ChangeRequest) {
  if (cr.status === 'review' || cr.status === 'voting') await applyFor(cr.id, autopilotPeople(cr));
}
