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
  ConnectedAppGithub,
  OntologyProject,
  PendingAppChecks,
  Review,
  TimelineEvent,
  User,
  Vote,
} from '@concord/shared';
import { clock } from '../clock.js';
import { get, HttpError, list, mustGet, put, remove, transaction } from '../db.js';
import { newId } from '../ids.js';
import { addReview, addVote, advance, changeCR, getCR, listCRs, mergeContext, peopleWhoSpoke, reviewsFor, sayIsCurrent, votesFor } from './changeRequests.js';
import { canVote, effectiveRule } from './governance.js';
import { getProject, rolesFor, setRoles } from './ontologies.js';
import { ontologyStore } from './ontologyStore.js';
import { consumeRunProof, runAudience, verifyGithubRun, type VerifiedRun } from './ciIdentity.js';
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

export interface AppDoc extends ConnectedApp {
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
      /** Hashes of each change's key, which its result from this run presents to count as verified. */
      keys?: Record<string, string>;
      /** When those keys stop working. */
      keysUntil?: string;
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
  /** Connected through the Concord GitHub App (services/appGithub.ts). */
  github?: GithubLink;
  /**
   * Short-lived tokens (their hashes) that runs of an app connected through GitHub got in exchange
   * for GitHub's proof that they run in its repository. They work like the app token until `until` (ms).
   */
  runTokens?: { hash: string; until: number }[];
}

export interface GithubLink extends ConnectedAppGithub {
  installationId: string;
  repoId: string;
  /** What the last run Concord started was for (the draft and every open change's revision). */
  fingerprint?: string;
  /** When Concord last asked GitHub to start a run, and the earliest it tries again after a failure (ms). */
  dispatchAt?: number;
  retryAt?: number;
}

const RUNS_KEPT = 20;
/**
 * How long a verified run's change keys work. Concord's own limit, chosen to cover a long test run
 * (it matches GitHub-hosted runners' six-hour job limit; self-hosted runners can run longer, and a
 * run that outlasts its keys reports its working-draft result again for new ones).
 */
const RUN_KEY_HOURS = 6;

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

async function publicApp(doc: AppDoc): Promise<ConnectedApp> {
  const { tokenHash: _h, attempts: _a, runs: _r, passingSince: _p, repoId: _i, github, runTokens: _t, ...rest } = doc;
  const baseline = rest.baseline && { ...rest.baseline, current: rest.baseline.revision === (await baselineRevision(await getProject(doc.ontologyId))) };
  return { ...rest, baseline, owner: publicUser(await getUser(doc.ownerId)), ...(github && { github: publicGithub(github) }) };
}

const publicGithub = ({ installationId: _i, repoId: _r, fingerprint: _f, dispatchAt: _d, retryAt: _a, ...rest }: GithubLink): ConnectedAppGithub => rest;

export const listApps = async (ontologyId: string) => Promise.all((await list<AppDoc>('apps', ontologyId)).map(publicApp));
export const getAppDoc = (id: string) => mustGet<AppDoc>('apps', id);
export const saveApp = (doc: AppDoc) => put('apps', doc, doc.ontologyId);
export const publicAppById = async (id: string) => publicApp(await getAppDoc(id));

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
  if (!(await rolesFor(project.id, owner.id)).length) await setRoles(project.id, owner.id, ['contributor']);
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
  await saveApp(doc);
  await logActivity({ ontologyId: project.id, actorId: owner.id, type: 'app.connected', message: `connected the app ${doc.name} to test it against proposed changes`, link: `/o/${project.id}/apps` });
  // Autopilot waits for every app with autopilot on, so a new one holds back any yes until it reports.
  if (doc.autopilot.enabled) await reconcile(project.id, [owner.id]);
  return { ...(await publicApp(await getAppDoc(doc.id))), token };
}

export async function ownApp(id: string, actor: User): Promise<AppDoc> {
  const doc = await getAppDoc(id);
  if (doc.ownerId !== actor.id && !actor.isPlatformAdmin) throw new HttpError(403, 'Only the person who connected this app can change it');
  return doc;
}

/** The app's owner, or the ontology's owners and stewards, who can disconnect any app on it. */
async function manageApp(id: string, actor: User): Promise<AppDoc> {
  const doc = await getAppDoc(id);
  if (doc.ownerId === actor.id || actor.isPlatformAdmin || (await rolesFor(doc.ontologyId, actor.id)).some((r) => r === 'owner' || r === 'steward')) return doc;
  throw new HttpError(403, 'Only the person who connected this app, or the ontology’s owners and stewards, can disconnect it');
}

export async function updateApp(id: string, actor: User, patch: { name?: unknown; repo?: unknown; autopilot?: unknown }): Promise<ConnectedApp> {
  // Read, change and save in one transaction, so nothing written meanwhile (a new token, a result) is lost.
  const { doc, wasOn } = await transaction(async () => {
    const doc = await ownApp(id, actor);
    if (patch.name !== undefined) doc.name = cleanName(patch.name);
    if (patch.repo !== undefined) {
      const repo = cleanRepo(patch.repo);
      if (repo?.toLowerCase() !== doc.repo?.toLowerCase()) doc.repoId = undefined;
      doc.repo = repo;
    }
    const wasOn = doc.autopilot.enabled;
    if (patch.autopilot !== undefined) doc.autopilot = cleanAutopilot(patch.autopilot, doc.autopilot);
    await saveApp(doc);
    return { doc, wasOn };
  });
  if (doc.autopilot.enabled !== wasOn)
    await logActivity({ ontologyId: doc.ontologyId, actorId: doc.ownerId, type: 'app.autopilot', message: `turned autopilot ${doc.autopilot.enabled ? 'on' : 'off'} for ${doc.name}`, link: `/o/${doc.ontologyId}/apps` });
  // Settings changed: results already in may now call for (or no longer allow) an autopilot say.
  await reconcile(doc.ontologyId, [doc.ownerId]);
  return publicApp(await getAppDoc(id));
}

export async function rotateToken(id: string, actor: User): Promise<ConnectedApp> {
  return transaction(async () => {
    const doc = await ownApp(id, actor);
    const token = newAppToken();
    doc.tokenPrefix = token.slice(0, 10);
    doc.tokenHash = hash(token);
    await saveApp(doc);
    return { ...(await publicApp(doc)), token };
  });
}

export async function deleteApp(id: string, actor: User) {
  const doc = await transaction(async () => {
    const doc = await manageApp(id, actor);
    for (const c of (await list<AppCheck>('appChecks')).filter((x) => x.appId === id)) await remove('appChecks', c.id);
    await remove('apps', id);
    return doc;
  });
  if (doc.ownerId !== actor.id)
    await logActivity({ ontologyId: doc.ontologyId, actorId: actor.id, type: 'app.disconnected', message: `disconnected ${(await getUser(doc.ownerId))?.name ?? 'someone'}’s app ${doc.name}, so its token no longer works`, link: `/o/${doc.ontologyId}/apps` });
  // Anything autopilot said on the strength of this app no longer stands.
  await reconcile(doc.ontologyId, [doc.ownerId]);
}

/** The hash of the app token (cna_…) or run token (cnr_…) in an `Authorization: Bearer` header. */
export function bearerHash(authorization: string | undefined): string {
  const token = authorization?.match(/^Bearer\s+(cn[ar]_\S+)$/i)?.[1];
  if (!token) throw new HttpError(401, 'Send the app token as Authorization: Bearer cna_…');
  return hash(token);
}

/** Is `h` the app's token, or a run token of its that hasn't run out? */
const tokenFits = (app: AppDoc, h: string) => app.tokenHash === h || !!app.runTokens?.some((t) => t.hash === h && t.until > Date.now());

/** The app a CI request is for, from its `Authorization: Bearer cna_…` (or run token `cnr_…`) header. */
export async function appForToken(authorization: string | undefined): Promise<AppDoc> {
  const h = bearerHash(authorization);
  const doc = (await list<AppDoc>('apps')).find((a) => tokenFits(a, h));
  if (!doc) throw new HttpError(401, 'Unknown or replaced app token');
  await stillConnected(doc);
  await touchSeen(doc);
  return doc;
}

/**
 * Note when an app was last heard from: that one field only, so a token replaced, an app
 * removed or a result recorded since `doc` was read is never written back over.
 */
export async function touchSeen(doc: AppDoc) {
  const at = clock.iso();
  doc.lastSeenAt = at;
  await transaction(async () => {
    const now = await get<AppDoc>('apps', doc.id);
    if (now) await put('apps', { ...now, lastSeenAt: at }, now.ontologyId);
  });
}

/**
 * The app as stored now, for a request that came in as `by`: still there, still with the token
 * the request used (or still owned by the person who sent it), and still connected. Call it
 * inside the transaction that changes the app.
 */
async function currentApp(appId: string, by: ReportedBy): Promise<AppDoc> {
  const app = await get<AppDoc>('apps', appId);
  if (!app) throw new HttpError(401, 'This app was disconnected');
  if (by.tokenHash !== undefined && !tokenFits(app, by.tokenHash)) throw new HttpError(401, 'This app token was replaced');
  if (by.ownerId !== undefined && app.ownerId !== by.ownerId) throw new HttpError(403, 'Only the person who connected this app can report for it without its token');
  await stillConnected(app);
  return app;
}

/** An app works only while the person who connected it is still a member of the ontology. */
export async function stillConnected(doc: AppDoc) {
  if (!(await rolesFor(doc.ontologyId, doc.ownerId)).length) throw new HttpError(401, 'This app’s owner is no longer a member of the ontology, so the app is disconnected');
}

/** The app a signed-in person reports for themselves (their own CI, or a simulated run). */
export async function appForOwner(appId: unknown, actor: User): Promise<AppDoc> {
  if (typeof appId !== 'string' || !appId) throw new HttpError(400, 'Send appId, or the app token as Authorization: Bearer cna_…');
  const doc = await getAppDoc(appId);
  if (doc.ownerId !== actor.id) throw new HttpError(403, 'Only the person who connected this app can report for it without its token');
  await stillConnected(doc);
  return doc;
}

/* ------------------------------------------------------------------------ */
/* What a change would produce                                               */
/* ------------------------------------------------------------------------ */

/** Fingerprint of the working draft. */
export const baselineRevision = async (project: OntologyProject) => (await ontologyStore.head(project)).slice(0, 12);

/**
 * Fingerprint of the ontology a change request would produce: the working draft it would be
 * merged into plus its edits. It moves when either changes, so results for older revisions
 * no longer count.
 */
export async function revisionOf(cr: ChangeRequest, projectIn?: OntologyProject): Promise<string> {
  const project = projectIn ?? (await getProject(cr.ontologyId));
  return hash(`${await ontologyStore.head(project)}\n${cr.id}\n${cr.opsUpdatedAt ?? cr.createdAt}\n${JSON.stringify(cr.ops)}`).slice(0, 16);
}

const proposedCache = new Map<string, string>();

/** The ontology as it would be with this change merged, in any output format. */
export async function proposedSource(cr: ChangeRequest, format: OutputFormat): Promise<{ text: string; revision: string; filename: string }> {
  const project = await getProject(cr.ontologyId);
  const revision = await revisionOf(cr, project);
  const filename = `${project.slug}-cr${cr.number}-${revision.slice(0, 7)}.${FORMAT_INFO[format].extension}`;
  const key = `${revision}:${format}`;
  const cached = proposedCache.get(key);
  if (cached !== undefined) return { text: cached, revision, filename };
  const working = await ontologyStore.working(project);
  let graph;
  try {
    graph = applyChangeOps(working, cr.ops, { author: (await getUser(cr.authorId))?.name, date: clock.iso().slice(0, 10), source: `${project.slug}#${cr.number}` }).graph;
  } catch (err) {
    throw new HttpError(409, `This change can't be applied to the current working draft: ${(err as Error).message}`);
  }
  const text = await serialize(graph, format);
  if (proposedCache.size > 200) proposedCache.clear();
  proposedCache.set(key, text);
  return { text, revision, filename };
}

/**
 * The ontology file before and after this change, for the change request's Diff tab. A merged (or
 * released) change shows its merge commit against the draft it was committed on: exactly the bytes
 * it changed. An open one shows the working draft now, and with the edits applied as merge() would
 * apply them (mergeContext: today's date and the generated provenance), serialized as merge() writes it.
 */
export async function turtleDiff(cr: ChangeRequest): Promise<{ before: string; after: string } | { error: string }> {
  const project = await getProject(cr.ontologyId);
  if (cr.status === 'merged' || cr.status === 'released') {
    if (!cr.mergedCommit) return { error: 'This change was merged before Concord kept a record of its commit, so there is no diff to show.' };
    const commit = await ontologyStore.commitOf(project, cr.mergedCommit);
    const after = await ontologyStore.readAt(project, cr.mergedCommit);
    // A change that left the file as it was made no commit of its own: its "commit" is the draft it merged into.
    if (!commit.parent || !commit.subject.startsWith(`#${cr.number} `)) return { before: after, after };
    return { before: await ontologyStore.readAt(project, commit.parent), after };
  }
  const working = await ontologyStore.working(project);
  let after;
  try {
    after = applyChangeOps(working, cr.ops, mergeContext(project, cr, clock.iso().slice(0, 10))).graph;
  } catch (err) {
    return { error: `This change can't be applied to the current working draft: ${(err as Error).message}` };
  }
  const [before, text] = await Promise.all([working.toTurtle(), after.toTurtle()]);
  return { before, after: text };
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
async function countsFrom(app: AppDoc, project: OntologyProject): Promise<number | undefined> {
  if (app.baseline?.revision !== (await baselineRevision(project)) || app.baseline.outcome !== 'passed') return undefined;
  return app.passingSince ?? app.baseline.attempt ?? 0;
}

/** The app's result for this version of a change, if it counts (see passingSince). */
async function resultFor(app: AppDoc, cr: ChangeRequest, revision: string, project: OntologyProject): Promise<AppCheck | undefined> {
  const from = await countsFrom(app, project);
  const c = await latestCheck(app.id, cr.id);
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
async function settled(app: AppDoc, cr: ChangeRequest, revision: string, project: OntologyProject, needVerified = false) {
  const counted = await resultFor(app, cr, revision, project);
  return !!counted && counted.outcome !== 'error' && (!needVerified || !!counted.verified);
}

/**
 * Changes to test, first come first served: each waits from when the app last tested it (or, if
 * it never has, from when the change was proposed). A run that can only test some of them takes
 * those waiting longest, and testing one sends it to the back, so neither a backlog nor a steady
 * stream of new changes can starve a change whose earlier result stopped counting.
 */
async function targetsFor(app: AppDoc, project: OntologyProject, crIds?: Record<string, string>, needVerified = false): Promise<(Target & { settled: boolean; waitingSince: string })[]> {
  const out: (Target & { settled: boolean; waitingSince: string })[] = [];
  for (const cr of (await listCRs(project.id)).filter(isOpen)) {
    const revision = await revisionOf(cr, project);
    if (crIds && crIds[cr.id] !== revision) continue;
    const last = await latestCheck(app.id, cr.id);
    out.push({
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
        settled: await settled(app, cr, revision, project, needVerified),
        waitingSince: last?.at ?? cr.createdAt,
    });
  }
  return out.sort((x, y) => x.waitingSince.localeCompare(y.waitingSince) || x.number - y.number);
}

/**
 * Start a run: a new attempt number, and a record of exactly what this run may test (every open
 * change). The targets listed are a first guess: the run's own result for the working draft
 * decides which earlier results still count, so the reply to that result says what to test.
 */
export async function pending(appIn: AppDoc, all: boolean, commitParam?: unknown, by: ReportedBy = {}): Promise<PendingAppChecks> {
  // A new run changes the app record, so it reads and saves it in one transaction.
  return transaction(async () => startRun(await currentApp(appIn.id, by), all, commitParam));
}

async function startRun(app: AppDoc, all: boolean, commitParam: unknown): Promise<PendingAppChecks> {
  // A result can carry over to this run only if it tests the same app commit as the one behind
  // the draft result in force.
  const commit = short(commitParam, 64);
  const carriesOver = !!commit && commit === app.baseline?.commit;
  const project = await getProject(app.ontologyId);
  const base = await baselineRevision(project);
  const open = await targetsFor(app, project);
  const targets = open.filter((t) => all || !(carriesOver && t.settled)).map(({ settled: _s, waitingSince: _w, ...t }) => t);
  app.attempts = (app.attempts ?? 0) + 1;
  const attempt = app.attempts;
  app.runs = [...(app.runs ?? []), { attempt, all, baseline: base, targets: Object.fromEntries(open.map((t) => [t.changeRequestId, t.revision])) }].slice(-RUNS_KEPT);
  await saveApp(app);
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
async function retestsFor(app: AppDoc, run: NonNullable<AppDoc['runs']>[number], project: OntologyProject): Promise<Target[]> {
  if (run.reported?.outcome !== 'passed') return [];
  return (await targetsFor(app, project, run.targets, !!run.reported.verified))
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
  /** With a change's result: that change's key, from the reply to the run's verified working-draft result. */
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
  // (using the proof up included) works on the app as stored once the proof is in, in one
  // transaction: a disconnection, a new token or a newer result that landed meanwhile is never
  // overwritten by what was read before, and a report that fails leaves its proof unused.
  const proof = input.target === 'baseline' && input.oidc !== undefined ? await verifyGithubRun(input.oidc, runAudience(appId)) : undefined;
  const step = await transaction(() => applyReport(appId, input, by, proof));
  // What a stored result sets off (the change's timeline note, autopilot) runs after its
  // transaction, from a follow-up recorded with it. If that fails part way (the database busy,
  // the process stopped), the same report sent again finishes it, and so does the sweep.
  const followUp = await get<FollowUp>('appFollowUps', followUpId(appId, input.target));
  if (step.kind === 'done') {
    if (!followUp || !step.reply.replay) return step.reply;
    const { autopilot } = await finishFollowUp(followUp);
    return autopilot ? { ...step.reply, autopilot } : step.reply;
  }
  const { autopilot } = followUp ? await finishFollowUp(followUp) : { autopilot: undefined };
  if (step.kind === 'baseline') {
    // Everything this result left without a result that counts gets tested in this same run.
    const app = await get<AppDoc>('apps', appId);
    const run = app?.runs?.find((r) => r.attempt === step.attempt);
    return { ...step.reply, targets: app && run ? await retestsFor(app, run, await getProject(app.ontologyId)) : [] };
  }
  return { ...step.reply, autopilot };
}

/** Work a stored result still has to set off. Removed only once all of it is done. */
interface FollowUp {
  id: string;
  appId: string;
  ontologyId: string;
  ownerId: string;
  /** For a change's result; absent for the working draft's. */
  crId?: string;
  /** The timeline note still to add to the change, if any. */
  note?: TimelineEvent;
  at: string;
}

const followUpId = (appId: string, target: unknown) => (target === 'baseline' ? `${appId}#baseline` : checkId(appId, String(target)));

/**
 * Finish a result's follow-up. Each step can safely run again: the note is added under the
 * request's lock only if the follow-up still holds it, and autopilot and reconcile bring things
 * to how they should be now. The follow-up goes only if no newer result replaced it meanwhile.
 */
async function finishFollowUp(f: FollowUp): Promise<{ autopilot?: AutopilotResult }> {
  let autopilot: AutopilotResult | undefined;
  if (f.crId && !(await get('changeRequests', f.crId))) {
    await remove('appFollowUps', f.id);
    return {};
  }
  if (f.crId) {
    const crId = f.crId;
    if (f.note && (await get('changeRequests', crId)))
      await changeCR(crId, async (c) => {
        const now = await get<FollowUp>('appFollowUps', f.id);
        if (!now?.note || now.at !== f.at) return;
        c.timeline.push(now.note);
        await put('appFollowUps', { ...now, note: undefined }, now.ontologyId);
      });
    autopilot = await applyAutopilot(crId, f.ownerId);
  } else {
    // The working draft's result decides whether this app's results mean anything, so re-decide everywhere.
    await reconcile(f.ontologyId, [f.ownerId]);
  }
  await transaction(async () => {
    if ((await get<FollowUp>('appFollowUps', f.id))?.at === f.at) await remove('appFollowUps', f.id);
  });
  return { autopilot };
}

/** The sweep: finish follow-ups a failed or stopped request left (after a minute, so in-flight ones finish themselves). */
export async function finishFollowUps(olderThanMs = 60_000) {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  for (const f of (await list<FollowUp>('appFollowUps')).filter((x) => x.at < cutoff)) {
    try {
      await finishFollowUp(f);
    } catch (err) {
      console.warn(`app check follow-up ${f.id}:`, (err as Error).message);
    }
  }
}

type Step =
  | { kind: 'done'; reply: Record<string, unknown> }
  | { kind: 'baseline'; reply: Record<string, unknown>; ontologyId: string; ownerId: string; attempt: number }
  | { kind: 'change'; reply: Record<string, unknown>; crId: string; ownerId: string };

const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The database part of a report, run in one transaction on the app as it is stored now. */
async function applyReport(appId: string, input: ReportInput, by: ReportedBy, proof: VerifiedRun | undefined): Promise<Step> {
  const app = await currentApp(appId, by);

  const outcome = input.outcome as AppCheckOutcome;
  if (!OUTCOMES.includes(outcome)) throw new HttpError(400, `outcome must be one of ${OUTCOMES.join(', ')}`);
  const revision = short(input.revision, 64);
  if (!revision) throw new HttpError(400, 'revision is required: send the one you were given with the target');
  const attempt = Number(input.attempt);
  if (!Number.isInteger(attempt) || attempt < 1) throw new HttpError(400, 'attempt is required: send the one GET /api/app-checks/pending gave this run');
  if (attempt > (app.attempts ?? 0)) throw new HttpError(400, `attempt ${attempt} was never issued to this app`);
  const project = await getProject(app.ontologyId);
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
    let keys: Record<string, string> | undefined;
    let keysUntil: string | undefined;
    let runKeys: Record<string, string> | undefined;
    if (proof) {
      if (!app.repo) throw new HttpError(400, 'Set the app’s GitHub repository on Concord, so it can check the run comes from there');
      if (proof.repository.toLowerCase() !== app.repo.toLowerCase()) throw new HttpError(400, `The run is from ${proof.repository}, not this app’s repository ${app.repo}`);
      // The repository's id is pinned on first use, so a deleted and re-created repository of the same name doesn't count.
      if (app.repoId && app.repoId !== proof.repositoryId)
        throw new HttpError(400, `${app.repo} isn’t the repository this app first ran from (its id changed). If you re-created it, set the repository on Concord again.`);
      if (commit && commit !== proof.sha) throw new HttpError(400, `The run tested commit ${proof.sha}, not ${commit}`);
      // Used once, in this transaction; the same report retried with the same proof may use it again.
      await consumeRunProof(proof, run.reported?.jti === proof.jti);
      commit = proof.sha;
      app.repoId = proof.repositoryId;
      verified = true;
      jti = proof.jti;
      // Each change in this run gets its own key, which only the caller holding GitHub's proof
      // gets back: a change's result counts as verified only with that change's key, until the
      // keys expire after Concord's key lifetime (RUN_KEY_HOURS).
      runKeys = Object.fromEntries(Object.keys(run.targets).map((id) => [id, `crk_${randomBytes(24).toString('base64url')}`]));
      keys = Object.fromEntries(Object.entries(runKeys).map(([id, k]) => [id, hash(k)]));
      keysUntil = new Date(clock.now().getTime() + RUN_KEY_HOURS * 3600_000).toISOString();
    }
    const prior = run.reported;
    // A verified report replaces an unverified one for the same run (which anyone with the token could have sent first).
    if (prior && !(verified && !prior.verified)) {
      if (prior.outcome !== outcome || prior.commit !== commit)
        throw new HttpError(409, `Run ${attempt} already reported ${prior.outcome} for the working draft; a run reports it once`);
      verified = !!prior.verified;
      if (!proof) {
        jti = prior.jti;
        keys = prior.keys;
        keysUntil = prior.keysUntil;
      }
    }
    run.reported = { outcome, commit, verified, jti, keys, keysUntil };
    await saveApp(app);
    const keyReply = runKeys ? { runKeys, runKeysUntil: keysUntil } : {};
    const order = ordering(app.baseline, { revision, attempt, outcome, verified }, await baselineRevision(project));
    if (order === 'stale') return { kind: 'done', reply: { stale: true, verified, ...keyReply, targets: [] } };
    if (order === 'replay') return { kind: 'done', reply: { stale: false, replay: true, verified, ...keyReply, targets: await retestsFor(app, run, project) } };
    await put('appFollowUps', { id: followUpId(app.id, 'baseline'), appId: app.id, ontologyId: app.ontologyId, ownerId: app.ownerId, at: new Date().toISOString() } satisfies FollowUp, app.ontologyId);
    const before = app.baseline?.revision === revision ? app.baseline.outcome : undefined;
    // Still passing the same draft with the same app: earlier results for changes still count.
    const unbroken = outcome === 'passed' && app.baseline?.revision === revision && app.baseline.outcome === 'passed' && app.baseline.commit === commit;
    if (outcome === 'passed' && !unbroken) app.passingSince = attempt;
    app.baseline = { revision, outcome, summary, runUrl, at, attempt, commit, verified };
    await saveApp(app);
    if (before !== outcome && outcome === 'failed')
      await logActivity({ ontologyId: project.id, actorId: app.ownerId, type: 'app.baseline-failed', message: `reports that their app ${app.name} fails against the current working draft`, link: `/o/${project.id}/apps` });
    return { kind: 'baseline', reply: { stale: false, verified, ...keyReply }, ontologyId: project.id, ownerId: app.ownerId, attempt };
  }

  if (typeof input.target !== 'string') throw new HttpError(400, "target must be 'baseline' or a change request id");
  const cr = await getCR(input.target);
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
    const expected = run.reported.keys?.[cr.id];
    if (!expected || !sameHash(hash(String(input.runKey)), expected)) throw new HttpError(401, `That isn’t run ${attempt}’s key for this change`);
    if (!run.reported.keysUntil || clock.iso() > run.reported.keysUntil) throw new HttpError(401, `Run ${attempt}’s keys have expired; start a new run`);
    verified = !!run.reported.verified;
  } else if (by.trusted) verified = !!run.reported.verified;
  const previous = await latestCheck(app.id, cr.id);
  const order = ordering(previous, { revision, attempt, outcome, verified }, await revisionOf(cr, project));
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
  await put('appChecks', check, cr.id);
  const changed = !previous || previous.outcome !== outcome || previous.revision !== revision;
  let note: TimelineEvent | undefined;
  if (changed && outcome !== 'error') {
    const owner = (await getUser(app.ownerId))?.name ?? 'Someone';
    note = {
      at,
      type: 'app-check',
      message:
        outcome === 'passed'
          ? `${owner}’s app ${app.name} passed its checks against this change.`
          : `${owner}’s app ${app.name} failed its checks against this change${summary ? `: ${summary.split('\n')[0].slice(0, 200)}` : '.'}`,
    };
    if (outcome === 'failed')
      await logActivity({ ontologyId: cr.ontologyId, actorId: app.ownerId, type: 'app.failed', message: `reports that their app ${app.name} breaks with #${cr.number} ${cr.title}`, link: `/o/${cr.ontologyId}/changes/${cr.id}` });
  }
  await put('appFollowUps', { id: followUpId(app.id, cr.id), appId: app.id, ontologyId: app.ontologyId, ownerId: app.ownerId, crId: cr.id, note, at: new Date().toISOString() } satisfies FollowUp, app.ontologyId);
  return { kind: 'change', reply: { check, stale: false }, crId: cr.id, ownerId: app.ownerId };
}

/** Report a result as an app, without its token (the demo's simulated CI, which is trusted). */
export async function reportAs(appId: string, input: ReportInput) {
  return report(await getAppDoc(appId), input, { trusted: true });
}

/** Who a token-authenticated report comes from: the app, as long as that token is still its token. */
export const byToken = (authorization: string | undefined): ReportedBy => ({ tokenHash: bearerHash(authorization) });

/** How long a run token from GitHub's proof works: GitHub-hosted jobs stop after six hours. */
const RUN_TOKEN_MS = RUN_KEY_HOURS * 60 * 60 * 1000;

/**
 * A run of an app connected through the GitHub App signs in with GitHub's proof that it runs in
 * the app's repository (pinned by its numeric id when the App was installed), and gets a run
 * token that works like the app token for the rest of the run. The proof is used up here; the
 * run asks GitHub for a fresh one to report its working-draft result, as runs with a token do.
 */
export async function exchangeRunProof(appId: unknown, oidc: unknown): Promise<{ token: string; expiresAt: string }> {
  if (typeof appId !== 'string' || !appId) throw new HttpError(400, 'Send app: the app’s id, from the workflow file');
  const before = await get<AppDoc>('apps', appId);
  if (!before?.github) throw new HttpError(401, 'This app isn’t connected through GitHub; use its app token');
  const proof = await verifyGithubRun(oidc, runAudience(appId));
  return transaction(async () => {
    const app = await get<AppDoc>('apps', appId);
    if (!app?.github) throw new HttpError(401, 'This app isn’t connected through GitHub any more; use its app token');
    if (proof.repositoryId !== app.github.repoId) throw new HttpError(403, `This run is in ${proof.repository}, not the repository this app was connected through (${app.github.repo})`);
    await stillConnected(app);
    await consumeRunProof(proof, false);
    const token = `cnr_${randomBytes(24).toString('base64url')}`;
    const until = Date.now() + RUN_TOKEN_MS;
    app.runTokens = [...(app.runTokens ?? []).filter((t) => t.until > Date.now()), { hash: hash(token), until }].slice(-10);
    await saveApp(app);
    return { token, expiresAt: new Date(until).toISOString() };
  });
}

/** Start a run as an app, without its token (the demo's simulated CI). */
export const startRunAs = async (appId: string) => (await pending(await getAppDoc(appId), true)).attempt;

/** Results for the change request page. */
export async function checksFor(cr: ChangeRequest): Promise<AppCheckResult[]> {
  const project = await getProject(cr.ontologyId);
  const current = await revisionOf(cr, project);
  const apps = new Map((await list<AppDoc>('apps', cr.ontologyId)).map((a) => [a.id, a]));
  const out: AppCheckResult[] = [];
  for (const c of await list<AppCheck>('appChecks', cr.id)) {
    const a = apps.get(c.appId);
    if (!a) continue;
    out.push({
      ...c,
      // Counts only for this version of the change, from a run tied to the app's current baseline.
      current: (await resultFor(a, cr, current, project))?.id === c.id,
      app: { id: a.id, name: a.name, repo: a.repo, ownerId: a.ownerId, owner: publicUser(await getUser(a.ownerId)), autopilot: a.autopilot.enabled },
    });
  }
  return out.sort((a, b) => a.app.name.localeCompare(b.app.name));
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

export { peopleWhoSpoke };

/**
 * What autopilot should be saying for this person on this change, at this stage, right now.
 * Checks every prerequisite directly, so governance can use it to decide whether a say
 * autopilot made earlier still counts.
 */
async function decide(cr: ChangeRequest, userId: string, stage: Stage, spokeIn?: Set<string>): Promise<Decision> {
  const none = (why: string): Decision => ({ say: 'none', why, apps: [] });
  const project = await getProject(cr.ontologyId);
  if (project.governance.automation.appAutopilot === false) return none('this ontology’s governance policy has autopilot turned off');
  const spoke = spokeIn ?? (await peopleWhoSpoke(cr));
  if (spoke.has(userId)) return none('they reviewed or voted on this change themselves');
  const apps = (await list<AppDoc>('apps', cr.ontologyId))
    .filter((a) => a.ownerId === userId && a.autopilot.enabled)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!apps.length) return none('no app has autopilot on');
  const level = cr.classification?.level ?? 'minor';
  const rule = effectiveRule(project.governance, level, 'change');
  const roles = await rolesFor(cr.ontologyId, userId);
  // Only people whose say counts at this stage get one from autopilot, yes or no.
  if (stage === 'voting' && !canVote(rule, roles)) return none('their role doesn’t vote on this change');
  if (stage === 'review') {
    if (cr.authorId === userId) return none('authors can’t approve their own change');
    if (!rule.approverRoles.some((r) => roles.includes(r))) return none('their role’s approvals don’t count for this change, so autopilot will vote if it goes to a vote');
  }
  const names = (as: AppDoc[]) => as.map((a) => a.name).join(', ');
  // An app that fails (or hasn't been tested on) the working draft says nothing about a change.
  const base = await baselineRevision(project);
  const brokenBase = apps.filter((a) => a.baseline?.revision === base && a.baseline.outcome !== 'passed');
  if (brokenBase.length) return none(`${names(brokenBase)} doesn’t pass the working draft, so its results don’t say anything about this change`);
  const untestedBase = apps.filter((a) => a.baseline?.revision !== base);
  if (untestedBase.length) return none(`waiting for ${names(untestedBase)} to test the current working draft`);
  const verifiedRun = 'from GitHub Actions in its repository, or reported by its owner signed in';
  const unverifiedBase = apps.filter((a) => !a.baseline?.verified);
  if (unverifiedBase.length) return none(`waiting for a verified run of ${names(unverifiedBase)} (${verifiedRun})`);

  const revision = await revisionOf(cr, project);
  // Each app's result that counts for this version, looked up once.
  const results = new Map<string, AppCheck | undefined>();
  for (const a of apps) results.set(a.id, await resultFor(a, cr, revision, project));
  const counted = (a: AppDoc) => results.get(a.id);
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
export async function autopilotStands(x: Say, cr: ChangeRequest, revision: string, spoke?: Set<string>): Promise<boolean> {
  if (!x.autopilot) return true;
  return matches(x, await decide(cr, x.userId, stageOf(x), spoke), revision);
}

/**
 * Make autopilot's say for one person on one change match what decide() says now. Safe to call
 * any time. It says yes or no through a normal review or vote (marked as autopilot), and takes
 * its say back by marking it withdrawn, so an older review or vote never comes back into force.
 */
export async function applyAutopilot(crId: string, userId: string, depth = 0): Promise<AutopilotResult> {
  const none = (message: string): AutopilotResult => ({ action: 'none', message });
  const cr = await getCR(crId);
  const stage = cr.status === 'approved' ? cr.approvedFrom : cr.status;
  if (stage !== 'review' && stage !== 'voting') return none(`The change request is ${cr.status}.`);
  const user = await getUser(userId);
  if (!user) return none('Unknown person.');

  const revision = await revisionOf(cr);
  const spoke = await peopleWhoSpoke(cr);
  // Only says given on the request as it is now (this review round, these edits) can be in force.
  const mine = <T extends Say>(xs: T[]) => xs.filter((x) => x.userId === userId && x.autopilot && sayIsCurrent(cr, x));
  const says = [...mine(await reviewsFor(cr.id)), ...mine(await votesFor(cr.id))];
  const d = await decide(cr, userId, stage, spoke);
  const why = d.why.charAt(0).toUpperCase() + d.why.slice(1);
  const canSay = d.say !== 'none' && cr.status === stage;
  const sayIn: 'review' | 'vote' = stage === 'voting' ? 'vote' : 'review';

  // Autopilot's says that are still in force (current version, not withdrawn) but that it
  // wouldn't make now. A new say in the same place replaces the person's latest one by itself;
  // anything else is withdrawn.
  const latestIn = (where: 'review' | 'vote') => says.filter((x) => ('decision' in x ? 'review' : 'vote') === where).at(-1);
  const inForce = [latestIn('review'), latestIn('vote')].filter((x): x is Say => !!x && !x.withdrawnAt && x.autopilot!.revision === revision);
  const replaced = (x: Say) => canSay && ('decision' in x ? 'review' : 'vote') === sayIn;
  const wrong: Say[] = [];
  for (const x of inForce) if (!replaced(x) && !(await autopilotStands(x, cr, revision, spoke))) wrong.push(x);
  if (wrong.length && depth < 3) {
    const at = clock.iso();
    // The withdrawals and the note are saved together, as the request's own change, and only
    // for says that, read again under the lock, still don't stand.
    await changeCR(cr.id, async (c) => {
      const rev = await revisionOf(c);
      const who = await peopleWhoSpoke(c);
      const still: Say[] = [];
      for (const x of wrong) {
        const now = await get<Say>('decision' in x ? 'reviews' : 'votes', x.id);
        if (now && !now.withdrawnAt && !(await autopilotStands(now, c, rev, who))) still.push(x);
      }
      if (!still.length) return;
      for (const x of still) await put('decision' in x ? 'reviews' : 'votes', { ...x, withdrawnAt: at }, c.id);
      c.timeline.push({ at, type: 'app-check', message: `Autopilot withdrew ${user.name}’s ${still.some(isYes) ? 'yes' : 'no'}: ${d.why}.` });
    });
    // Withdrawing can move the change (an approval that no longer holds goes back a stage),
    // so decide again from where it ends up.
    await advance(await getCR(cr.id));
    const then = await applyAutopilot(crId, userId, depth + 1);
    return then.action === 'none' ? { action: 'withdrew', message: `Withdrew the autopilot ${wrong.some(isYes) ? 'yes' : 'no'}. ${why}.` } : then;
  }
  if (!canSay) return none(`${why}.`);

  const latest = latestIn(sayIn);
  if (latest && matches(latest, d, revision)) return none(`Autopilot already ${d.say === 'yes' ? (sayIn === 'vote' ? 'voted yes' : 'approved this') : 'voted no'}.`);
  const mark: AutopilotMark = { revision, apps: [] };
  for (const a of d.apps) mark.apps.push({ id: a.id, name: a.name, runUrl: (await latestCheck(a.id, cr.id))?.runUrl });
  // Decided before getting the request's lock: decide again under it, on the latest copy, and
  // write only if autopilot would still say the same (the person may have spoken themselves).
  let changed = false;
  const stillMeant = async (c: ChangeRequest) => {
    const ok = c.status === stage && (await revisionOf(c)) === revision && (await decide(c, userId, stage)).say === d.say;
    if (!ok) changed = true;
    return ok;
  };
  const again = () => (depth < 3 ? applyAutopilot(crId, userId, depth + 1) : Promise.resolve(none('The change kept changing; autopilot will look again.')));
  if (sayIn === 'vote') {
    await addVote(cr, user, d.say === 'yes' ? 'yes' : 'no', `Autopilot: ${d.why}.`, undefined, mark, stillMeant);
    if (changed) return again();
    return { action: d.say === 'yes' ? 'voted-yes' : 'voted-no', message: `Voted ${d.say}. ${why}.` };
  }
  await addReview(cr, user, 'approve', `Autopilot: ${d.why}.`, undefined, mark, stillMeant);
  if (changed) return again();
  return { action: 'approved', message: `Approved. ${why}.` };
}

/** Everyone autopilot might speak for on a change: app owners, and anyone it has spoken for. */
async function autopilotPeople(cr: ChangeRequest): Promise<string[]> {
  const ids = new Set((await list<AppDoc>('apps', cr.ontologyId)).map((a) => a.ownerId));
  for (const x of [...(await reviewsFor(cr.id)), ...(await votesFor(cr.id))]) if (x.autopilot) ids.add(x.userId);
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
  for (const { id } of await listCRs(ontologyId)) {
    const cr = await getCR(id);
    if (autopilotStage(cr)) await applyFor(id, userIds ?? (await autopilotPeople(cr)));
  }
}

/** When a change enters review or a vote, act on any results that are already in. */
export async function onStatusChanged(cr: ChangeRequest) {
  if (cr.status === 'review' || cr.status === 'voting') await applyFor(cr.id, await autopilotPeople(cr));
}
