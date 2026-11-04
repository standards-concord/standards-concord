import type {
  ActivityItem,
  AnonymisedDraft,
  ChangeRequest,
  ChatMessage,
  ElicitedTerm,
  InterviewSession,
  OntologyProject,
  Role,
  UseCase,
  UseCaseLink,
  UseCaseRef,
  UseCaseSections,
  UseCaseSource,
  UseCaseStatus,
  UseCaseVisibility,
  User,
} from '@concord/shared';
import { USE_CASE_STATUS_INFO, useCaseLabel } from '@concord/shared';
import { clock } from '../clock.js';
import { config } from '../config.js';
import { get, HttpError, list, mustGet, put } from '../db.js';
import { newId } from '../ids.js';
import { ontologyDigest, useCaseDigest } from '../llm/context.js';
import { ANONYMISER, INTERVIEWER, SYNTHESISER } from '../llm/prompts.js';
import { llm } from '../llm/provider.js';
import { AnonymisedDraftSchema, InterviewTurnSchema, ProposalSchema, type InterviewTurn, type Proposal } from '../llm/schemas.js';
import { createChangeRequest } from './changeRequests.js';
import { getProject, isGroupMember, members, rolesFor, setRoles } from './ontologies.js';
import { ontologyStore } from './ontologyStore.js';
import { proposalToOps, toLocalName } from './proposals.js';
import { solid, transcriptToTurtle } from './solid.js';
import { syncUseCase } from './traceability.js';
import { getUser, logActivity } from './users.js';

/* ------------------------------------------------------------------------ */
/* Use cases                                                                 */
/* ------------------------------------------------------------------------ */

const LEGACY_STATUS: Record<string, UseCaseStatus> = { eliciting: 'draft', ready: 'triage', synthesised: 'in-progress' };
const TRIAGE_ROLES: Role[] = ['editor', 'steward', 'owner'];

export { isGroupMember };
export const canTriage = (ontologyId: string, user?: User) => !!user && (user.isPlatformAdmin || rolesFor(ontologyId, user.id).some((r) => TRIAGE_ROLES.includes(r)));

/**
 * Can this viewer see the use case at all? A withdrawn one is visible to its
 * author only, and an archived one to its author and the working group.
 */
export function canSee(u: UseCase, viewer?: User): boolean {
  if (viewer && u.authorId === viewer.id) return true;
  if (u.withdrawnAt) return false;
  // Archived ones, and public ones the author hasn't submitted yet, are for the author and the working group.
  if (u.status === 'archived' || u.status === 'draft') return u.visibility !== 'private' && isGroupMember(u.ontologyId, viewer);
  if (u.visibility === 'public') return true;
  if (u.visibility === 'group') return isGroupMember(u.ontologyId, viewer);
  return false;
}

/** Meetings are working group business: members see them, and so does whoever recorded one. */
export const canSeeMeeting = (m: { ontologyId: string; createdBy?: string }, viewer?: User) => !!viewer && (isGroupMember(m.ontologyId, viewer) || m.createdBy === viewer.id);

/**
 * Called when a use case stops being public (made private or group-only,
 * withdrawn or archived), so everything derived from it can be dropped:
 * requirements drafts (services/requirements.ts registers) and its questions in
 * saved validation results (below).
 */
const noLongerPublic: ((u: UseCase) => void)[] = [];
noLongerPublic.push((u) => consentEpochs.set(u.ontologyId, consentEpoch(u.ontologyId) + 1));

const consentLocks = new Map<string, Promise<unknown>>();
/**
 * Runs `fn` exclusively for an ontology. Everything that commits material
 * derived from use cases (a release, a drafted change request) and everything
 * that changes consent (withdrawal, visibility, archiving) goes through it, so a
 * withdrawal can't land between the consent check and the commit: it waits.
 */
export function withConsentLock<T>(ontologyId: string, fn: () => Promise<T> | T): Promise<T> {
  const run = (consentLocks.get(ontologyId) ?? Promise.resolve()).catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  consentLocks.set(ontologyId, tail);
  void tail.then(() => {
    if (consentLocks.get(ontologyId) === tail) consentLocks.delete(ontologyId);
  });
  return run;
}
export const onNoLongerPublic = (fn: (u: UseCase) => void) => void noLongerPublic.push(fn);
/** Public, and fit to derive public material from: not withdrawn, archived, or a draft its author hasn't submitted. */
const isPublic = (u: Pick<UseCase, 'visibility' | 'withdrawnAt' | 'status'>) => u.visibility === 'public' && !u.withdrawnAt && u.status !== 'archived' && u.status !== 'draft';

const consentEpochs = new Map<string, number>();
/** Goes up whenever a use case of the ontology stops being public, so long-running work can tell it must start again. */
export const consentEpoch = (ontologyId: string) => consentEpochs.get(ontologyId) ?? 0;

const questionKey = (q: string) => q.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Remove every question the use case has had while public (including ones since
 * edited) from validation results saved on change requests, and from the SPARQL
 * tests drafted from them, which carry its example data and run again on retriage.
 */
onNoLongerPublic((u) => {
  const questions = new Set([...(u.publicQuestions ?? []), ...u.competencyQuestions.map((q) => q.question)].map(questionKey));
  if (!questions.size) return;
  const gone = (r: { question: string }) => questions.has(questionKey(r.question));
  // Change requests drafted from it quote its title in their own: replaced with a neutral phrase.
  const title = u.sections.name?.trim();
  const titleRe = title && title.length >= 4 ? new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') : undefined;
  const redact = (text?: string) => (text && titleRe ? text.replace(titleRe, 'a use case that is no longer public') : text);
  for (const cr of list<ChangeRequest>('changeRequests', u.ontologyId)) {
    const cqs = cr.validation?.competencyQuestions;
    const inResults = !!cqs?.some(gone);
    const inTests = !!cr.tests?.some(gone);
    const fromIt = !!titleRe && [cr.title, cr.description, cr.analysis?.summary, cr.analysis?.rationale].some((t) => !!t && t.toLowerCase().includes(title!.toLowerCase()));
    if (!inResults && !inTests && !fromIt) continue;
    if (inResults) cr.validation = { ...cr.validation!, competencyQuestions: cqs!.filter((r) => !gone(r)) };
    if (inTests) cr.tests = cr.tests!.filter((t) => !gone(t));
    if (fromIt) {
      cr.title = redact(cr.title)!;
      cr.description = redact(cr.description) ?? '';
      if (cr.analysis) cr.analysis = { ...cr.analysis, summary: redact(cr.analysis.summary)!, rationale: redact(cr.analysis.rationale)! };
    }
    put('changeRequests', cr, cr.ontologyId);
  }
});

/** Bring documents written before sharing modes existed up to date. */
function normalise(u: UseCase): UseCase {
  let dirty = false;
  if (LEGACY_STATUS[u.status as string]) {
    u.status = LEGACY_STATUS[u.status as string];
    dirty = true;
  }
  if (!u.visibility) {
    u.visibility = 'group';
    dirty = true;
  }
  if (dirty) put('useCases', u, u.ontologyId);
  // Follow the linked change requests (in-progress -> addressed -> closed).
  syncUseCase(u);
  return u;
}

/** Numbers are given when a use case is first shared, so gaps never reveal private drafts. */
function ensureNumbers(ontologyId: string, all: UseCase[]) {
  // Fills in numbers missing from older records. Group-only ones numbered before group numbers existed keep theirs.
  let max = all.reduce((m, u) => Math.max(m, u.number ?? 0), 0);
  let maxGroup = all.reduce((m, u) => Math.max(m, u.groupNumber ?? 0), 0);
  for (const u of [...all].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (u.visibility === 'public' && !u.number) u.number = ++max;
    else if (u.visibility === 'group' && !u.number && !u.groupNumber) u.groupNumber = ++maxGroup;
    else continue;
    put('useCases', u, ontologyId);
  }
}

/** The next number in the public (UC-n) or working group (WG-n) sequence. */
const nextNumber = (ontologyId: string, field: 'number' | 'groupNumber' = 'number') => {
  const all = list<UseCase>('useCases', ontologyId);
  ensureNumbers(ontologyId, all);
  return all.reduce((m, u) => Math.max(m, u[field] ?? 0), 0) + 1;
};

const needsNumber = (u: UseCase) => (u.visibility === 'public' && !u.number) || (u.visibility === 'group' && !u.number && !u.groupNumber);

/** Raw access for services (no visibility check). */
export const getUseCase = (id: string) => {
  const u = normalise(mustGet<UseCase>('useCases', id));
  if (needsNumber(u)) ensureNumbers(u.ontologyId, list<UseCase>('useCases', u.ontologyId));
  return mustGet<UseCase>('useCases', id);
};

/** Raw list for services (no visibility check). */
export function allUseCases(ontologyId: string): UseCase[] {
  const all = list<UseCase>('useCases', ontologyId);
  ensureNumbers(ontologyId, all);
  return all.map(normalise).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The use cases a viewer may see, redacted for them. */
export const listUseCases = (ontologyId: string, viewer?: User) =>
  allUseCases(ontologyId)
    .filter((u) => canSee(u, viewer))
    .map((u) => present(u, viewer));

/**
 * A use case as one viewer may see it. Authors get their own record. Everyone
 * else gets a copy built field by field: no private storage details, links only
 * to things they may see, no meeting details unless they may see the meeting,
 * and for an anonymous use case nothing that points back at its author.
 * `present` is not an access check: callers filter with canSee first.
 */
export function present(u: UseCase, viewer?: User): UseCase {
  if (viewer && viewer.id === u.authorId) return u;
  const meetingOk = (id?: string) => {
    if (!id) return false;
    const m = get<{ ontologyId: string; createdBy?: string }>('meetings', id);
    return !!m && canSeeMeeting(m, viewer);
  };
  const linkOk = (l: UseCaseLink) => {
    if (l.type === 'url' || l.type === 'change-request') return true;
    if (l.type === 'meeting') return meetingOk(l.id);
    const t = l.id ? get<UseCase>('useCases', l.id) : undefined;
    return !!t && canSee(t, viewer);
  };
  const fromMeeting = u.source === 'meeting' && meetingOk(u.sourceRef);
  const group = isGroupMember(u.ontologyId, viewer);
  const out: UseCase = {
    id: u.id,
    number: u.number,
    ...(u.groupNumber && isGroupMember(u.ontologyId, viewer) ? { groupNumber: u.groupNumber } : {}),
    ontologyId: u.ontologyId,
    authorId: u.anonymous ? 'anonymous' : u.authorId,
    source: u.source,
    ...(fromMeeting ? { sourceRef: u.sourceRef, sourceLines: u.sourceLines } : {}),
    status: u.status,
    visibility: u.visibility,
    ...(u.anonymous ? { anonymous: true } : {}),
    // Notes on a call's use case name the call and its speakers: only for those who may see the call.
    sections: u.source === 'meeting' && !fromMeeting ? { ...u.sections, notes: undefined } : u.sections,
    // Drafted SPARQL and example data are working material for the group; others get the questions and answers.
    competencyQuestions: group ? u.competencyQuestions : u.competencyQuestions.map(({ id, question, exampleAnswer, status }) => ({ id, question, ...(exampleAnswer ? { exampleAnswer } : {}), status })),
    // Evidence quotes can name people: dropped for anonymous use cases, and for a call's use cases when the viewer can't see the call.
    terms: u.anonymous || (u.source === 'meeting' && !fromMeeting) ? u.terms.map(({ label, kind, definition, existingIri }) => ({ label, kind, definition, existingIri })) : u.terms,
    links: (u.links ?? []).filter((l) => linkOk(l) && (l.type !== 'change-request' || !!viewer)).map((l) => (u.anonymous ? { type: l.type, id: l.id, url: l.url, label: l.label, relation: l.relation, at: l.at } : l)) as UseCaseLink[],
    // Change requests are behind sign-in, and so is which ones a use case led to.
    ...(viewer ? { changeRequestIds: u.changeRequestIds } : {}),
    // Who triaged an anonymous use case could be its author, so that is left out.
    resolution: u.resolution && (u.anonymous ? { ...u.resolution, by: undefined } : u.resolution),
    completeness: u.completeness,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
  return out;
}

/** Fetch for a viewer: 404 rather than 403 for private ones, so their existence is not revealed. */
export function getUseCaseFor(id: string, viewer?: User): UseCase {
  const u = getUseCase(id);
  if (!canSee(u, viewer)) throw new HttpError(404, `useCase ${id} not found`);
  return u;
}

export const refOf = (u: UseCase): UseCaseRef => ({
  id: u.id,
  number: u.number,
  ...(u.groupNumber && u.visibility === 'group' ? { groupNumber: u.groupNumber } : {}),
  title: u.sections.name || 'Untitled use case',
  status: u.status,
  visibility: u.visibility,
  ...(u.anonymous ? { anonymous: true } : {}),
});

export function useCaseRefs(ids: string[], viewer?: User): UseCaseRef[] {
  return ids
    .map((id) => get<UseCase>('useCases', id))
    .filter((u): u is UseCase => !!u && canSee(normalise(u), viewer))
    .map((u) => refOf(normalise(u)))
    .sort((a, b) => a.number - b.number);
}

/** Weighted completeness against Kendall's template (competency questions count most). */
export function completeness(u: Pick<UseCase, 'sections' | 'competencyQuestions'>): number {
  const s = u.sections;
  const has = (v: unknown) => (Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim().length > 0 : !!v);
  const checks: [boolean, number][] = [
    [has(s.name), 0.5],
    [has(s.goal), 1],
    [has(s.actors), 1],
    [has(s.stakeholders), 0.5],
    [has(s.description), 1],
    [(s.usageScenarios?.length ?? 0) >= 2, 1],
    [has(s.basicFlow), 1],
    [has(s.alternateFlows), 0.5],
    [u.competencyQuestions.length >= 2, 2],
    [u.competencyQuestions.filter((q) => q.exampleAnswer).length >= 2, 1],
    [has(s.dataSources), 0.75],
    [has(s.externalOntologies), 0.25],
    [has(s.scope), 0.5],
    [has(s.triggers) || has(s.preconditions), 0.25],
    [has(s.openIssues) || has(s.assumptions), 0.25],
  ];
  const total = checks.reduce((n, [, w]) => n + w, 0);
  return Math.round((checks.reduce((n, [ok, w]) => n + (ok ? w : 0), 0) / total) * 100) / 100;
}

function saveUseCase(u: UseCase) {
  const before = get<UseCase>('useCases', u.id);
  // A withdrawal is final: a save from work that started earlier (an interview turn, drafting) never undoes it.
  if (before?.withdrawnAt && !u.withdrawnAt) Object.assign(u, { withdrawnAt: before.withdrawnAt, visibility: before.visibility, status: before.status });
  if (isPublic(u)) u.publicQuestions = [...new Set([...(before?.publicQuestions ?? []), ...(u.publicQuestions ?? []), ...u.competencyQuestions.map((q) => q.question)])];
  if (u.visibility === 'public' && !u.number) u.number = nextNumber(u.ontologyId);
  else if (u.visibility === 'group' && !u.number && !u.groupNumber) u.groupNumber = nextNumber(u.ontologyId, 'groupNumber');
  u.completeness = completeness(u);
  u.updatedAt = clock.iso();
  put('useCases', u, u.ontologyId);
  if (u.visibility === 'private') void mirrorToPod(u);
  if (before && isPublic(before) && !isPublic(u)) for (const fn of noLongerPublic) fn(u);
  return u;
}

/**
 * Private use cases are mirrored to the author's Solid pod, so the author keeps
 * their own copy of anything they chose not to share.
 */
async function mirrorToPod(u: UseCase) {
  try {
    const esc = (x: string) => x.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
    const turtle = `@prefix schema: <http://schema.org/> .
@prefix dct: <http://purl.org/dc/terms/> .

<> a schema:CreativeWork ;
  schema:name """${esc(u.sections.name ?? 'Untitled use case')}""" ;
  schema:description """${esc(u.sections.goal ?? '')}""" ;
  dct:modified "${u.updatedAt}" ;
  schema:encodingFormat "application/json" ;
  schema:text """${esc(JSON.stringify({ sections: u.sections, competencyQuestions: u.competencyQuestions, terms: u.terms }))}""" .
`;
    const stored = await solid.write(u.authorId, `use-cases/${u.id}.ttl`, turtle);
    if (stored.url && u.podUrl !== stored.url) {
      const fresh = get<UseCase>('useCases', u.id);
      if (fresh) put('useCases', { ...fresh, podUrl: stored.url }, u.ontologyId);
    }
  } catch (err) {
    console.warn(`[use case] could not copy ${u.id} to the pod: ${(err as Error).message}`);
  }
}

const defaultVisibility = (source: UseCaseSource): UseCaseVisibility => (source === 'chat' ? 'private' : 'group');

export function createUseCase(
  project: OntologyProject,
  author: User,
  init: Partial<
    Pick<UseCase, 'sections' | 'competencyQuestions' | 'terms' | 'source' | 'sourceRef' | 'sourceLines' | 'status' | 'visibility' | 'anonymous' | 'resolution' | 'changeRequestIds'>
  >,
): UseCase {
  const now = clock.iso();
  // Anyone describing a use case becomes a contributor.
  if (!rolesFor(project.id, author.id).length) setRoles(project.id, author.id, ['contributor']);
  const source = init.source ?? 'chat';
  const visibility = init.visibility ?? defaultVisibility(source);
  return saveUseCase({
    id: newId('uc'),
    number: visibility === 'public' ? nextNumber(project.id) : 0,
    ...(visibility === 'group' ? { groupNumber: nextNumber(project.id, 'groupNumber') } : {}),
    ontologyId: project.id,
    authorId: author.id,
    source,
    sourceRef: init.sourceRef,
    sourceLines: init.sourceLines,
    status: init.status ?? 'draft',
    visibility,
    anonymous: init.anonymous,
    sections: init.sections ?? {},
    competencyQuestions: init.competencyQuestions ?? [],
    terms: init.terms ?? [],
    changeRequestIds: init.changeRequestIds,
    resolution: init.resolution,
    completeness: 0,
    createdAt: now,
    updatedAt: now,
  });
}

const isAuthor = (u: UseCase, actor: User) => u.authorId === actor.id;

const NOT_PUBLIC =
  'Change requests are public, so they can only draw on public use cases. Make the use case public (only its author can), or publish an anonymised version of a private one, and use that.';

/**
 * Activity items a viewer may see. Items about a use case or a meeting follow
 * that thing's current visibility (read from the item's link, which covers items
 * written before this check existed). Anonymous use cases never show an actor.
 */
export function visibleActivity(items: ActivityItem[], viewer?: User): ActivityItem[] {
  return items.flatMap((a) => {
    const uc = a.link?.match(/\/use-cases\/([^/?#]+)/)?.[1];
    if (uc) {
      const u = get<UseCase>('useCases', uc);
      if (!u || !canSee(u, viewer)) return [];
      if (u.anonymous && !(viewer && viewer.id === u.authorId)) return [{ ...a, actorId: undefined, actorName: undefined }];
    }
    const mtg = a.link?.match(/\/meetings\/([^/?#]+)/)?.[1];
    if (mtg) {
      const m = get<{ ontologyId: string; createdBy?: string }>('meetings', mtg);
      if (!m || !canSeeMeeting(m, viewer)) return [];
    }
    return [a];
  });
}

/** Author or editor edits the content. */
export function updateUseCase(
  u: UseCase,
  actor: User,
  patch: Partial<Pick<UseCase, 'sections' | 'competencyQuestions' | 'status' | 'terms' | 'visibility'>> & { links?: UseCaseLink[] },
) {
  if (!canSee(u, actor)) throw new HttpError(404, `useCase ${u.id} not found`);
  const editor = canTriage(u.ontologyId, actor);
  if (!isAuthor(u, actor) && !editor) throw new HttpError(403, 'Only the author or an editor can change this use case');
  if (patch.sections) u.sections = { ...u.sections, ...patch.sections };
  if (patch.competencyQuestions) u.competencyQuestions = patch.competencyQuestions.map((q) => ({ ...q, id: q.id || newId('cq'), status: q.status ?? 'draft' }));
  if (patch.terms) u.terms = patch.terms;
  if (patch.links) u.links = patch.links;
  if (patch.visibility && patch.visibility !== u.visibility) setVisibility(u, actor, patch.visibility, false);
  if (patch.status && patch.status !== u.status) {
    if (['accepted', 'deferred', 'out-of-scope', 'closed'].includes(patch.status)) return triageUseCase(u, actor, patch.status);
    if (patch.status === 'triage') submitUseCase(u, actor, false);
    else if (patch.status === 'archived') u.status = 'archived';
    else if (patch.status === 'draft' && isAuthor(u, actor)) u.status = 'draft';
    else throw new HttpError(409, `A use case can't be moved to ${patch.status} by hand`);
  }
  return saveUseCase(u);
}

/** Who can see it. Only the author decides. An anonymised version is public, or withdrawn. */
export function setVisibility(u: UseCase, actor: User, visibility: UseCaseVisibility, save = true) {
  if (!isAuthor(u, actor)) throw new HttpError(403, 'Only the author can change who sees a use case');
  if (!['private', 'group', 'public'].includes(visibility)) throw new HttpError(400, 'visibility must be private, group or public');
  if (u.anonymous && visibility === 'group') throw new HttpError(409, 'An anonymised use case is either public or withdrawn.');
  if (u.anonymous && visibility === 'private') return withdrawUseCase(u, actor);
  const from = u.visibility;
  u.visibility = visibility;
  if (visibility !== 'private') u.withdrawnAt = undefined;
  // Sharing a finished private draft submits it for triage.
  if (from === 'private' && visibility !== 'private' && u.status === 'draft' && interviewDone(u)) u.status = 'triage';
  if (save) saveUseCase(u);
  if (from === 'private' && visibility !== 'private') {
    logActivity({ ontologyId: u.ontologyId, actorId: actor.id, type: 'usecase.shared', message: `shared ${useCaseLabel(u)} ${u.sections.name ?? ''} with ${visibility === 'public' ? 'everyone' : 'the working group'}`.trim(), link: `/o/${u.ontologyId}/use-cases/${u.id}` });
  }
  return u;
}

/**
 * The author takes a shared, public or anonymised use case back. From then on
 * only they can see it: every read, list, activity item, requirements draft and
 * public page leaves it out, and its questions leave saved validation results.
 * Files already released to GitHub can't be recalled.
 */
export function withdrawUseCase(u: UseCase, actor: User) {
  if (!isAuthor(u, actor)) throw new HttpError(404, `useCase ${u.id} not found`);
  u.withdrawnAt = clock.iso();
  u.visibility = 'private';
  u.status = 'archived';
  saveUseCase(u);
  for (const fn of noLongerPublic) fn(u);
  if (u.anonymous) {
    const original = list<UseCase>('useCases', u.ontologyId).find((o) => o.anonymisation?.publishedId === u.id);
    if (original) {
      original.anonymisation = { ...original.anonymisation!, status: 'withdrawn', decidedAt: clock.iso(), publishedId: undefined };
      saveUseCase(original);
    }
  }
  return u;
}

const interviewDone = (u: UseCase) =>
  u.source !== 'chat' || list<InterviewSession>('interviews', u.ontologyId).some((s) => s.useCaseId === u.id && s.done) || u.completeness >= 0.5;

/** The author submits a draft for triage. Private ones must be shared (or anonymised) first. */
export function submitUseCase(u: UseCase, actor: User, save = true) {
  if (!isAuthor(u, actor) && !canTriage(u.ontologyId, actor)) throw new HttpError(403, 'Only the author can submit this use case');
  if (u.visibility === 'private') throw new HttpError(409, 'Private use cases are not triaged. Share it with the working group, make it public, or publish an anonymised version.');
  if (u.status !== 'draft' && u.status !== 'archived' && u.status !== 'deferred') return u;
  u.status = 'triage';
  u.resolution = undefined;
  if (save) saveUseCase(u);
  return u;
}

/** Editors and stewards decide what happens to a submitted use case. */
export function triageUseCase(u: UseCase, actor: User, status: UseCaseStatus, note?: string) {
  if (!canTriage(u.ontologyId, actor)) throw new HttpError(403, 'Only editors, stewards and owners triage use cases');
  if (u.visibility === 'private') throw new HttpError(409, 'Private use cases are not triaged');
  if (!['accepted', 'deferred', 'out-of-scope', 'closed', 'triage'].includes(status)) throw new HttpError(400, 'status must be accepted, deferred, out-of-scope, closed or triage');
  const project = getProject(u.ontologyId);
  u.status = status;
  u.resolution =
    status === 'triage'
      ? undefined
      : { status, note: note?.trim() || undefined, by: actor.id, at: clock.iso(), ...(status === 'closed' ? { version: project.currentVersion !== '0.0.0' ? project.currentVersion : undefined } : {}) };
  saveUseCase(u);
  // Accepting a use case that already has changes in flight picks their status up straight away.
  if (status === 'accepted') syncUseCase(u);
  const label = USE_CASE_STATUS_INFO[status].label.toLowerCase();
  logActivity({ ontologyId: u.ontologyId, actorId: actor.id, type: 'usecase.triaged', message: `marked ${useCaseLabel(u)} ${u.sections.name ?? ''} as ${label}`.replace('  ', ' '), link: `/o/${u.ontologyId}/use-cases/${u.id}` });
  return u;
}

/** Add a related link (use case, meeting, change request or URL). */
export function addLink(u: UseCase, actor: User, link: Omit<UseCaseLink, 'at' | 'addedBy'>) {
  if (!canSee(u, actor)) throw new HttpError(404, `useCase ${u.id} not found`);
  if (!isAuthor(u, actor) && !isGroupMember(u.ontologyId, actor)) throw new HttpError(403, 'Only the author or working group members can link use cases');
  if (!['use-case', 'meeting', 'change-request', 'url'].includes(link.type)) throw new HttpError(400, 'Unknown link type');
  if (!['related', 'duplicate-of', 'depends-on', 'refines'].includes(link.relation)) throw new HttpError(400, 'Unknown relation');
  if (link.type === 'url') {
    if (!link.url || !/^https?:\/\//.test(link.url)) throw new HttpError(400, 'A link needs an http(s) URL');
  } else {
    if (!link.id) throw new HttpError(400, 'A link needs a target id');
    if (link.type === 'use-case') {
      if (link.id === u.id) throw new HttpError(400, 'A use case cannot link to itself');
      const target = get<UseCase>('useCases', link.id);
      if (!target || target.ontologyId !== u.ontologyId || !canSee(target, actor)) throw new HttpError(404, 'No such use case');
    } else {
      const target = get<{ ontologyId: string; createdBy?: string }>(link.type === 'meeting' ? 'meetings' : 'changeRequests', link.id);
      if (!target || target.ontologyId !== u.ontologyId || (link.type === 'meeting' && !canSeeMeeting(target, actor))) throw new HttpError(404, `No such ${link.type.replace('-', ' ')}`);
    }
  }
  u.links = [...(u.links ?? []).filter((l) => !(l.type === link.type && (l.id ?? l.url) === (link.id ?? link.url))), { ...link, addedBy: actor.id, at: clock.iso() }];
  return saveUseCase(u);
}

export function removeLink(u: UseCase, actor: User, target: string) {
  if (!canSee(u, actor)) throw new HttpError(404, `useCase ${u.id} not found`);
  if (!isAuthor(u, actor) && !isGroupMember(u.ontologyId, actor)) throw new HttpError(403, 'Only the author or working group members can unlink use cases');
  u.links = (u.links ?? []).filter((l) => (l.id ?? l.url) !== target);
  return saveUseCase(u);
}

/** Record that a change request addresses some use cases (both directions), and move them along. */
export function linkChangeRequest(cr: ChangeRequest, useCaseIds: string[], actor: User) {
  const ucs = useCaseIds.map((id) => getUseCaseFor(id, actor)).filter((u) => u.ontologyId === cr.ontologyId);
  // Change requests are public records: they may only cite public use cases.
  if (ucs.some((u) => !isPublic(u))) throw new HttpError(409, NOT_PUBLIC);
  cr.useCaseIds = [...new Set([...(cr.useCaseIds ?? []), ...ucs.map((u) => u.id)])];
  put('changeRequests', cr, cr.ontologyId);
  for (const u of ucs) {
    u.changeRequestIds = [...new Set([...(u.changeRequestIds ?? []), cr.id])];
    if (['triage', 'draft'].includes(u.status)) u.status = 'accepted';
    saveUseCase(u);
    syncUseCase(u, [cr]);
  }
  return cr;
}

/**
 * A change request as a viewer may see it: use case ids (in its links and its
 * origin) are kept only for use cases the viewer can see.
 */
export function crForViewer<T extends ChangeRequest>(cr: T, viewer?: User): T {
  const ok = (id: string) => {
    const u = get<UseCase>('useCases', id);
    return !!u && canSee(u, viewer);
  };
  const origin =
    cr.origin.type === 'synthesis'
      ? { ...cr.origin, useCaseIds: cr.origin.useCaseIds.filter(ok) }
      : cr.origin.type === 'chat' && cr.origin.useCaseId && !ok(cr.origin.useCaseId)
        ? { ...cr.origin, useCaseId: undefined }
        : cr.origin.type === 'meeting' && !canSeeMeeting(get<{ ontologyId: string; createdBy?: string }>('meetings', cr.origin.meetingId) ?? { ontologyId: cr.ontologyId, createdBy: '' }, viewer)
          ? { type: 'meeting' as const, meetingId: '' }
          : cr.origin;
  return { ...cr, origin, ...(cr.useCaseIds ? { useCaseIds: cr.useCaseIds.filter(ok) } : {}) } as T;
}

/* ------------------------------------------------------------------------ */
/* Anonymised synthetic versions of private use cases                       */
/* ------------------------------------------------------------------------ */

const FICTIONAL_PLACES = ['Anytown', 'Riverton', 'Hillford', 'Lakeside', 'Oakbridge', 'Westmere', 'Eastholm', 'Northcombe'];
const FICTIONAL_ORGS = ['Brightwater Trust', 'Hillcrest Community Group', 'Greenway Volunteer Centre', 'Meadowbank Foundation'];
const FICTIONAL = new Set([...FICTIONAL_PLACES, ...FICTIONAL_ORGS.flatMap((o) => o.split(' '))]);
const COMMON = new Set(
  'The This That They These Those There When Then What Which Where Who Whom How Why We Our Us And But Or So For With If Each Every Some Many Most It Its A An In On At To Of From By As Is Are Was Be Can Could Would Should Will Also Yes No Not Please Thanks Thank Hi Hello I Im My Me You Your Sometimes Usually Often Today Now Students Teachers Volunteers Volunteer Charity Charities Platform Platforms Paid Our Every Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September October November December UK DBS GDPR API CSV JSON RDF OWL SPARQL URL CRM Excel Email Call See Tell Coordinators Coordinator People Residents Organisations Organisation Find Publish Record Report Show Help Make Let Search Sign Join Get Give Use Using After Before During Once Today Tomorrow Yesterday Weekly Daily Monthly Funders Funder Staff Users User Data Admins Admin Managers Manager Officers Officer Council Councils Schools School Local National Public Private Shared New Old First Second Third Next Last One Two Three All Any Both Either Neither Other Another Such Only Just Even Still Already Again Here Where While Because Although Since Until Unless Whether An Am Do Does Did Has Have Had Not Nor Yet Than Into Onto Over Under About Above Below Between Through Without Within Across Along Around Behind Beyond Like Near Off Out Up Down Per Via Step Steps Goal Actors Scenario Scenarios Example Examples E.g'.split(' '),
);
const escRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every string in a value, deeply. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  return out;
}

/**
 * The only fields an anonymised version can carry. The same allowlist shapes the
 * proposal (from the model or the offline stand-in), what the author is shown and
 * can edit, and what is published, so nothing unseen goes public.
 */
export function restrictDraft(d: Partial<AnonymisedDraft>): AnonymisedDraft {
  const str = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : undefined);
  const s = (d.sections ?? {}) as UseCaseSections;
  const sections: UseCaseSections = {
    name: str(s.name),
    goal: str(s.goal),
    actors: str(s.actors),
    description: str(s.description),
    requirements: str(s.requirements),
    scope: str(s.scope),
    usageScenarios: (s.usageScenarios ?? []).map(str).filter((x): x is string => !!x),
    basicFlow: (s.basicFlow ?? []).map((f, i) => ({ step: i + 1, description: str(f?.description) ?? '' })).filter((f) => f.description),
  };
  for (const k of Object.keys(sections) as (keyof UseCaseSections)[]) {
    const v = sections[k];
    if (v === undefined || (Array.isArray(v) && !v.length)) delete sections[k];
  }
  return {
    sections,
    competencyQuestions: (d.competencyQuestions ?? []).map((q) => ({ question: str(q?.question) ?? '', ...(str(q?.exampleAnswer) ? { exampleAnswer: str(q.exampleAnswer) } : {}) })).filter((q) => q.question),
    terms: (d.terms ?? []).map((t) => ({ label: str(t?.label) ?? '', kind: t?.kind ?? 'class', ...(str(t?.definition) ? { definition: str(t.definition) } : {}) })).filter((t) => t.label) as ElicitedTerm[],
    changes: (d.changes ?? []).filter((c) => typeof c === 'string'),
    warnings: [],
  };
}

/** Names that must never appear: the author, their organisation, and the people in this ontology's group. */
function knownIdentifiers(ontologyId: string, author: User): string[] {
  const people = members(ontologyId)
    .map((m) => getUserName(m.userId))
    .filter((x): x is string => !!x);
  return [...new Set([author.name, author.organisation, ...people].filter((x): x is string => !!x && x.trim().length >= 2))];
}
const getUserName = (id: string) => get<User>('users', id)?.name;

/**
 * Check every field of an anonymised version for things that may still identify
 * someone. It can't prove a text is anonymous; it lists what to look at.
 */
export function identifyingWarnings(d: AnonymisedDraft, known: string[] = []): string[] {
  const text = strings([d.sections, d.competencyQuestions, d.terms.map((t) => [t.label, t.definition])]);
  const all = text.join('\n');
  const lowerWords = new Set((all.match(/\b[a-z][a-z'’]+\b/g) ?? []).map((w) => w.toLowerCase()));
  const found = new Map<string, string>();
  const add = (what: string, why: string) => found.has(what) || found.set(what, why);
  for (const k of known)
    for (const part of [k, ...k.split(/\s+/).filter((p) => p.length >= 3)])
      if (new RegExp(`\\b${escRe(part)}\\b`, 'i').test(all)) add(part, 'a name from your profile or working group');
  for (const t of text) {
    for (const m of t.matchAll(/\b[A-Z][A-Za-z'’]+\b/g)) {
      const w = m[0].replace(/['’]s$/, '');
      if (COMMON.has(w) || FICTIONAL.has(w) || lowerWords.has(w.toLowerCase())) continue;
      add(w, /^[A-Z]{2,}$/.test(w) ? 'an organisation or code name' : /[a-z][A-Z]/.test(w) ? 'a product or organisation name' : 'possibly a name');
    }
    for (const m of t.matchAll(/\b[a-z]+[A-Z][A-Za-z]*\b/g)) add(m[0], 'a product or organisation name');
    for (const m of t.matchAll(/\b\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?\b|\b(?:19|20)\d{2}\b/g)) add(m[0], 'a date');
    for (const m of t.matchAll(/\b\d{4,}\b/g)) if (!/^(?:19|20)\d{2}$/.test(m[0])) add(m[0], 'a distinctive number');
    for (const m of t.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+|https?:\/\/\S+/g)) add(m[0], 'contact details or a link');
  }
  return [...found].slice(0, 20).map(([w, why]) => `“${w}”: ${why}`);
}

/**
 * Offline anonymiser, used when no model is configured or a model call fails.
 * It swaps names of people, places and organisations it can find for fictional
 * ones, removes contact details, dates and distinctive numbers, and drops term
 * labels that look like names. It is only a proposal: the author reads every
 * field (and the warnings) before anything is published.
 */
export function heuristicAnonymise(u: Pick<UseCase, 'sections' | 'competencyQuestions' | 'terms'>, authorName?: string, known: string[] = []): AnonymisedDraft {
  const counts = { emails: 0, phones: 0, urls: 0, dates: 0, numbers: 0 };
  const base = restrictDraft({ sections: u.sections, competencyQuestions: u.competencyQuestions, terms: u.terms });
  const texts = strings([base.sections, base.competencyQuestions, base.terms.map((t) => t.definition)]);
  const all = texts.join('\n');
  const lowerWords = new Set((all.match(/\b[a-z][a-z'’]+\b/g) ?? []).map((w) => w.toLowerCase()));
  const proper = new Set<string>();
  for (const text of texts) {
    // Capitalised phrases anywhere, including at the start of a sentence, unless the word is common or also used in lower case.
    for (const m of text.matchAll(/\b((?:St\.? )?[A-Z][a-z'’]+(?:\s+(?:of\s+)?[A-Z][a-z'’]+)*)\b/g)) {
      const words = m[1].split(/\s+/).filter((w) => w !== 'of');
      const keep = words.filter((w) => !COMMON.has(w.replace(/['’]s$/, '')) && !lowerWords.has(w.toLowerCase().replace(/['’]s$/, '')));
      if (!keep.length) continue;
      const trimmed = words[0] && COMMON.has(words[0]) ? m[1].split(/\s+/).slice(1).join(' ') : m[1];
      if (trimmed.length > 2) proper.add(trimmed);
    }
    // Acronyms and mixed-case names (IBM, acmeCorp, DataHub).
    for (const m of text.matchAll(/\b(?:[A-Z]{2,}|[a-z]+[A-Z][A-Za-z]*|[A-Z][a-z]+[A-Z][A-Za-z]*)\b/g)) if (!COMMON.has(m[0])) proper.add(m[0]);
  }
  for (const k of known) if (new RegExp(`\\b${escRe(k)}\\b`, 'i').test(all)) proper.add(k);
  const map = new Map<string, string>();
  let place = 0;
  let org = 0;
  // Longest first, so "Northvale Food Bank" wins over "Northvale".
  for (const name of [...proper].sort((a, b) => b.length - a.length)) {
    const looksLikeOrg =
      /^[A-Z]{2,}$/.test(name) || /[a-z][A-Z]/.test(name) || /(Trust|Council|Charity|Foundation|Fund|Hospice|Hospital|Centre|Center|Group|Ltd|Limited|Society|Network|Association|Church|School|College|University|Bank|Impact|Club|Corp|Inc)$/.test(name);
    const isPerson = known.some((k) => k.toLowerCase() === name.toLowerCase()) && !looksLikeOrg;
    map.set(name, isPerson ? 'a coordinator' : looksLikeOrg ? FICTIONAL_ORGS[org++ % FICTIONAL_ORGS.length] : FICTIONAL_PLACES[place++ % FICTIONAL_PLACES.length]);
  }
  const author = (authorName ?? '').trim();
  const authorParts = author.split(/\s+/).filter((p) => p.length >= 2);
  const scrub = (text: string): string => {
    let t = text;
    t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, () => (counts.emails++, 'an email address'));
    t = t.replace(/https?:\/\/\S+/g, () => (counts.urls++, 'a website'));
    t = t.replace(/(?:\+44\s?|0)\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}/g, () => (counts.phones++, 'a phone number'));
    t = t.replace(/\b\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+(?:19|20)\d{2})?\b|\b(?:19|20)\d{2}\b/g, () => (counts.dates++, 'a date'));
    t = t.replace(/\b\d{4,}\b/g, () => (counts.numbers++, 'a number'));
    if (author) t = t.replace(new RegExp(`\\b${escRe(author)}\\b`, 'gi'), 'a coordinator');
    for (const part of authorParts) t = t.replace(new RegExp(`\\b${escRe(part)}\\b`, 'g'), 'a coordinator');
    for (const [name, fake] of map) t = t.replace(new RegExp(`\\b${escRe(name)}\\b`, 'gi'), fake);
    return t.replace(/\b(a|the) a coordinator\b/gi, 'a coordinator').replace(/\b(a coordinator)(\s+a coordinator)+/g, '$1').replace(/\bthe (a|an) /gi, 'the ').replace(/(^|[.!?]\s+)a coordinator/g, '$1A coordinator');
  };
  const deep = <T>(v: T): T => {
    if (typeof v === 'string') return scrub(v) as T;
    if (Array.isArray(v)) return v.map(deep) as T;
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'step' ? x : deep(x)])) as T;
    return v;
  };
  // Terms whose labels are themselves names (e.g. "riverside youth trust", "acmeCorp") are dropped, not renamed.
  const isName = (label: string) =>
    /[a-z][A-Z]|^[A-Z]{2,}$/.test(label) || [...map.keys()].some((n) => label.toLowerCase().includes(n.toLowerCase())) || authorParts.some((p) => label.toLowerCase().includes(p.toLowerCase()));
  const draft: AnonymisedDraft = {
    sections: deep(base.sections),
    competencyQuestions: base.competencyQuestions.map((q) => ({ question: scrub(q.question), ...(q.exampleAnswer ? { exampleAnswer: scrub(q.exampleAnswer) } : {}) })),
    terms: base.terms.filter((t) => !isName(t.label)).map((t) => ({ label: t.label, kind: t.kind, ...(t.definition ? { definition: scrub(t.definition) } : {}) })),
    changes: [],
  };
  const changes: string[] = [];
  if (map.size) changes.push(`Replaced ${map.size} name${map.size === 1 ? '' : 's'} of people, places or organisations (${[...map.values()].filter((x, i, a) => a.indexOf(x) === i).slice(0, 4).map((x) => `“${x}”`).join(', ')}${map.size > 4 ? ', …' : ''}).`);
  if (author) changes.push('Took out your name. It is published with no name attached.');
  const removed = [
    counts.emails && `${counts.emails} email address${counts.emails === 1 ? '' : 'es'}`,
    counts.phones && `${counts.phones} phone number${counts.phones === 1 ? '' : 's'}`,
    counts.urls && `${counts.urls} link${counts.urls === 1 ? '' : 's'}`,
    counts.dates && `${counts.dates} date${counts.dates === 1 ? '' : 's'}`,
    counts.numbers && `${counts.numbers} distinctive number${counts.numbers === 1 ? '' : 's'}`,
  ].filter(Boolean);
  if (removed.length) changes.push(`Removed ${removed.join(', ')}.`);
  if (u.terms.length > draft.terms.length) changes.push(`Left out ${u.terms.length - draft.terms.length} term${u.terms.length - draft.terms.length === 1 ? '' : 's'} that looked like names.`);
  changes.push('Kept only the title, goal, actors, description, requirements, scope, scenarios, main steps, questions and terms. Your notes, stakeholders, data sources, references and evidence quotes are left out.');
  draft.changes = changes;
  return draft;
}

/** Ask the model (or the offline stand-in) for an anonymised synthetic version, and store it as a proposal for the author. */
export async function proposeAnonymised(u: UseCase, actor: User): Promise<UseCase> {
  if (!isAuthor(u, actor)) throw new HttpError(404, `useCase ${u.id} not found`);
  if (u.visibility !== 'private') throw new HttpError(409, 'Only private use cases get an anonymised version; this one is already shared.');
  if (u.anonymous) throw new HttpError(409, 'This is already an anonymised version.');
  const project = getProject(u.ontologyId);
  const known = knownIdentifiers(project.id, actor);
  const { value } = await llm.json<AnonymisedDraft>({
    task: 'anonymise',
    system: ANONYMISER,
    schema: AnonymisedDraftSchema,
    effort: 'medium',
    maxTokens: 8000,
    messages: [
      {
        role: 'user',
        content: `Ontology: ${project.title}${project.domain ? ` (domain: ${project.domain})` : ''}.\nNames that must not appear (the author, their organisation, and the working group): ${known.join('; ')}.\n\nPrivate use case (JSON):\n${JSON.stringify({ sections: restrictDraft({ sections: u.sections }).sections, competencyQuestions: u.competencyQuestions.map(({ question, exampleAnswer }) => ({ question, exampleAnswer })), terms: u.terms.map(({ label, kind, definition }) => ({ label, kind, definition })) })}\n\nWrite the anonymised synthetic version.`,
      },
    ],
    fallback: () => heuristicAnonymise(u, actor.name, known),
  });
  // Whatever wrote it, the proposal is cut to the allowlist and checked field by field.
  const draft = restrictDraft(value);
  draft.warnings = identifyingWarnings(draft, known);
  u.anonymisation = { status: 'proposed', draft, proposedAt: clock.iso() };
  return saveUseCase(u);
}

/**
 * The author consents: publish exactly the version they reviewed (with their
 * edits) as a new public use case with no name attached. The client sends the
 * whole draft it showed; the server cuts it to the same allowlist.
 */
export function publishAnonymised(u: UseCase, actor: User, edited?: Partial<AnonymisedDraft>): { original: UseCase; published: UseCase } {
  if (!isAuthor(u, actor)) throw new HttpError(404, `useCase ${u.id} not found`);
  if (u.visibility !== 'private' || u.anonymous) throw new HttpError(409, 'Only private use cases get an anonymised version');
  const draft = u.anonymisation?.draft;
  if (!draft) throw new HttpError(409, 'There is no anonymised version to publish yet');
  if (u.anonymisation?.status === 'published' && u.anonymisation.publishedId) throw new HttpError(409, 'An anonymised version is already published');
  const final = restrictDraft({
    sections: edited?.sections ?? draft.sections,
    competencyQuestions: edited?.competencyQuestions ?? draft.competencyQuestions,
    terms: edited?.terms ?? draft.terms,
    changes: draft.changes,
  });
  final.warnings = identifyingWarnings(final, knownIdentifiers(u.ontologyId, actor));
  const project = getProject(u.ontologyId);
  const published = createUseCase(project, actor, {
    source: u.source,
    visibility: 'public',
    anonymous: true,
    status: 'triage',
    sections: { ...final.sections, notes: 'An anonymised, synthetic version of a use case a participant described privately.' },
    competencyQuestions: final.competencyQuestions.map((q) => ({ id: newId('cq'), question: q.question, exampleAnswer: q.exampleAnswer, status: 'untested' as const })),
    terms: final.terms,
  });
  u.anonymisation = { ...u.anonymisation!, status: 'published', draft: final, decidedAt: clock.iso(), publishedId: published.id };
  saveUseCase(u);
  // No actor on the activity item: naming the author would undo the anonymisation.
  logActivity({ ontologyId: u.ontologyId, type: 'usecase.anonymised', message: `An anonymised use case was published: ${useCaseLabel(published)} ${published.sections.name ?? ''}`.trim(), link: `/o/${u.ontologyId}/use-cases/${published.id}` });
  return { original: u, published };
}

export function declineAnonymised(u: UseCase, actor: User) {
  if (!isAuthor(u, actor)) throw new HttpError(404, `useCase ${u.id} not found`);
  if (!u.anonymisation) throw new HttpError(409, 'There is no anonymised version to decline');
  if (u.anonymisation.status === 'published') throw new HttpError(409, 'The anonymised version is already published; withdraw it instead');
  u.anonymisation = { ...u.anonymisation, status: 'declined', decidedAt: clock.iso() };
  return saveUseCase(u);
}

function mergeTurn(u: UseCase, turn: Pick<InterviewTurn, 'sectionUpdates' | 'newCompetencyQuestions' | 'newTerms'>) {
  for (const [k, v] of Object.entries(turn.sectionUpdates ?? {})) {
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) continue;
    (u.sections as Record<string, unknown>)[k] = v;
  }
  const seenQ = new Set(u.competencyQuestions.map((q) => q.question.toLowerCase()));
  for (const q of turn.newCompetencyQuestions ?? []) {
    if (seenQ.has(q.question.toLowerCase())) continue;
    seenQ.add(q.question.toLowerCase());
    u.competencyQuestions.push({ id: newId('cq'), question: q.question, exampleAnswer: q.exampleAnswer, status: 'untested' });
  }
  const seenT = new Map(u.terms.map((t) => [t.label.toLowerCase(), t]));
  for (const t of turn.newTerms ?? []) {
    const existing = seenT.get(t.label.toLowerCase());
    if (existing) {
      existing.definition ||= t.definition;
      existing.evidence = [...new Set([...(existing.evidence ?? []), ...(t.evidence ?? [])])];
    } else {
      const term: ElicitedTerm = { ...t };
      u.terms.push(term);
      seenT.set(t.label.toLowerCase(), term);
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Interviews                                                                */
/* ------------------------------------------------------------------------ */

export const getInterview = (id: string) => mustGet<InterviewSession>('interviews', id);
const saveInterview = (s: InterviewSession) => {
  s.updatedAt = clock.iso();
  return put('interviews', s, s.ontologyId);
};
const msg = (role: ChatMessage['role'], content: string, targets?: ChatMessage['targets']): ChatMessage => ({
  id: newId('msg'),
  role,
  content,
  at: clock.iso(),
  targets,
});

/**
 * Scripted interviewer used when no model is configured. It walks Kendall's
 * template in order and files each answer under the section it asked about.
 */
const SCRIPT: { target: keyof UseCaseSections | 'competencyQuestions' | 'terms'; ask: (p: OntologyProject) => string }[] = [
  { target: 'goal', ask: (p) => `Hi! I'm helping gather requirements for **${p.title}**. To start: what are you trying to achieve where shared data about ${p.domain ?? 'this area'} would help? A sentence or two is plenty.` },
  { target: 'actors', ask: () => 'Who is involved? Think about the people, organisations and systems that take part, and which of them would actually use the data.' },
  { target: 'usageScenarios', ask: () => 'Can you walk me through a real situation where this happens? A specific example, with names of places or kinds of people if you can.' },
  { target: 'usageScenarios', ask: () => 'Thanks. Is there a second, different situation? Ideally one that is harder, or involves someone else.' },
  { target: 'basicFlow', ask: () => 'What are the main steps, in order? For each step, say who does it, a person or a system. A short numbered list works well.' },
  { target: 'alternateFlows', ask: () => 'What goes wrong, or happens differently? For example missing information, cancellations or exceptions.' },
  { target: 'competencyQuestions', ask: () => 'Now the most important part. What questions would you want to ask of the data? Please give at least two, each with an example answer, e.g. “Which opportunities near Leeds this weekend need first-aid skills? → the Saturday food bank shift at …”.' },
  { target: 'dataSources', ask: () => 'Where does the data come from today? Any systems, spreadsheets, APIs, or existing standards and vocabularies you already use?' },
  { target: 'scope', ask: () => 'Is there anything that is definitely out of scope, or anything you are unsure about that the group should discuss?' },
];

function heuristicTurn(project: OntologyProject, session: InterviewSession, u: UseCase, answer: string): InterviewTurn {
  const asked = session.messages.filter((m) => m.role === 'assistant');
  const lastTarget = asked.at(-1)?.targets?.[0];
  const state = session as InterviewSession & { scriptStep?: number };
  const step = state.scriptStep ?? 0;
  const updates: InterviewTurn['sectionUpdates'] = {};
  const cqs: InterviewTurn['newCompetencyQuestions'] = [];
  const text = answer.trim();
  const s = u.sections;
  switch (lastTarget) {
    case 'goal':
      updates.goal = text;
      updates.name = s.name ?? text.split(/[.!?]/)[0].slice(0, 80);
      break;
    case 'actors':
      updates.actors = text;
      updates.stakeholders = s.stakeholders ?? text;
      break;
    case 'usageScenarios':
      updates.usageScenarios = [...(s.usageScenarios ?? []), text];
      updates.description = s.description ?? text;
      break;
    case 'basicFlow':
      updates.basicFlow = text
        .split(/\n|(?<=\.)\s+(?=\d+[.)])/)
        .map((l) => l.replace(/^\s*\d+[.)]\s*/, '').trim())
        .filter(Boolean)
        .map((description, i) => ({ step: i + 1, description }));
      break;
    case 'alternateFlows':
      updates.alternateFlows = [...(s.alternateFlows ?? []), { title: text.split(/[.!?]/)[0].slice(0, 60), steps: [{ step: 1, description: text }] }];
      break;
    case 'competencyQuestions':
      for (const part of text.split(/\n+|(?<=\?)\s*(?=[A-Z])/)) {
        const m = part.match(/^\s*(?:\d+[.)]\s*)?(.+?\?)\s*(?:[-–—→:>]+|answer:?|e\.g\.?)?\s*(.*)$/i);
        if (m) cqs.push({ question: m[1].trim(), exampleAnswer: m[2]?.trim() || undefined });
      }
      break;
    case 'dataSources':
      updates.dataSources = text
        .split(/,|;|\n| and /)
        .map((x) => x.trim())
        .filter((x) => x.length > 1)
        .map((name) => ({ name }));
      break;
    case 'notes':
      updates.notes = [s.notes, text].filter(Boolean).join('\n\n');
      break;
    case 'scope':
      updates.scope = text;
      updates.openIssues = text;
      break;
  }
  const next = SCRIPT[step + 1];
  const newTerms = candidateTerms(text);
  if (lastTarget === 'competencyQuestions' && cqs.length < 2 && u.competencyQuestions.length + cqs.length < 2) {
    return {
      reply: `Thanks${cqs.length ? `, I've noted “${cqs[0].question}”` : ''}. Could you give ${cqs.length ? 'one more question' : 'two questions'}, each ending in a question mark and followed by an example answer?`,
      targets: ['competencyQuestions'],
      sectionUpdates: updates,
      newCompetencyQuestions: cqs,
      newTerms,
      done: false,
    };
  }
  if (!next) {
    const q = [...u.competencyQuestions, ...cqs];
    return {
      reply: `Thank you, that's really useful. Here's what I captured:\n\n- **Goal:** ${updates.goal ?? s.goal ?? '—'}\n- **Actors:** ${s.actors ?? '—'}\n- **Scenarios:** ${(s.usageScenarios ?? []).length}\n- **Competency questions:** ${q.map((x) => x.question).join(' / ') || '—'}\n\nYou can edit any of this in the use case panel. Next, you choose who can see it: it stays private to you unless you share it.`,
      targets: [],
      sectionUpdates: updates,
      newCompetencyQuestions: cqs,
      newTerms,
      done: true,
    };
  }
  state.scriptStep = step + 1;
  const mentioned = newTerms.slice(0, 2).map((t) => `“${t.label}”`);
  const followUp = mentioned.length && lastTarget !== 'competencyQuestions' ? ` (I've noted ${mentioned.join(' and ')} as possible terms.)` : '';
  return { reply: `Got it.${followUp} ${next.ask(project)}`, targets: [next.target], sectionUpdates: updates, newCompetencyQuestions: cqs, newTerms, done: false };
}

/** Cheap noun-phrase spotting: quoted phrases and Capitalised Multi Words. */
function candidateTerms(text: string): InterviewTurn['newTerms'] {
  const found = new Map<string, string>();
  for (const m of text.matchAll(/["“']([^"”']{3,40})["”']/g)) found.set(m[1].toLowerCase(), m[0]);
  for (const m of text.matchAll(/(?<![.!?]\s)(?<!^)\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g)) {
    if (m[1].length > 3 && !/^(The|This|That|They|When|Then|What|Which|Where|Who|We|Our|And|But|For|With|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/.test(m[1]))
      found.set(m[1].toLowerCase(), m[0]);
  }
  return [...found.entries()].slice(0, 5).map(([label, quote]) => ({ label, kind: 'class' as const, evidence: [quote] }));
}

export async function startInterview(project: OntologyProject, user: User, useCaseId?: string): Promise<InterviewSession> {
  const u = useCaseId ? getUseCase(useCaseId) : createUseCase(project, user, { source: 'chat' });
  // Not found, rather than forbidden, so the answer doesn't reveal that someone else's use case exists.
  if (u.authorId !== user.id) throw new HttpError(404, `useCase ${useCaseId} not found`);
  const first = SCRIPT[0];
  let opening = first.ask(project);
  if (useCaseId && u.sections.goal) opening = `Welcome back. Last time we covered “${u.sections.name ?? u.sections.goal}”. What would you like to add or change?`;
  const now = clock.iso();
  const session: InterviewSession = {
    id: newId('int'),
    ontologyId: project.id,
    useCaseId: u.id,
    userId: user.id,
    messages: [msg('assistant', opening, [useCaseId ? 'notes' : first.target])],
    storage: { kind: 'local', url: '' },
    done: false,
    createdAt: now,
    updatedAt: now,
  };
  saveInterview(session);
  await persistTranscript(session, u);
  return session;
}

/** Private transcripts live in the participant's Solid pod; only the structured use case is shared. */
async function persistTranscript(session: InterviewSession, u: UseCase) {
  try {
    const turtle = transcriptToTurtle(session.id, `Requirements interview: ${u.sections.name ?? 'use case'}`, session.messages);
    session.storage = await solid.write(session.userId, `interviews/${session.id}.ttl`, turtle);
    u.transcriptUrl = session.storage.url;
    put('useCases', u, u.ontologyId);
    put('interviews', session, session.ontologyId);
  } catch (err) {
    console.warn(`[interview] could not store transcript: ${(err as Error).message}`);
  }
}

export async function interviewTurn(session: InterviewSession, user: User, content: string) {
  if (session.userId !== user.id) throw new HttpError(404, `interview ${session.id} not found`);
  const project = getProject(session.ontologyId);
  const u = getUseCase(session.useCaseId);
  session.messages.push(msg('user', content));
  const graph = await ontologyStore.working(project);
  const { value: turn } = await llm.json<InterviewTurn>({
    task: 'interview',
    system: `${INTERVIEWER}\n\nOntology: ${project.title}${project.domain ? ` (domain: ${project.domain})` : ''}. ${project.description}`,
    schema: InterviewTurnSchema,
    effort: 'medium',
    maxTokens: 6000,
    messages: [
      {
        role: 'user',
        content: `Use case captured so far (JSON):\n${JSON.stringify({ sections: u.sections, competencyQuestions: u.competencyQuestions.map(({ question, exampleAnswer }) => ({ question, exampleAnswer })), terms: u.terms.map((t) => t.label) })}\n\nTerms already in the ontology (to recognise synonyms; do not mention unless relevant):\n${ontologyDigest(graph, 120)}\n\nConversation so far:\n${session.messages.map((m) => `${m.role === 'assistant' ? 'Interviewer' : 'Participant'}: ${m.content}`).join('\n\n')}\n\nReturn the next interviewer turn.`,
      },
    ],
    fallback: () => heuristicTurn(project, session, u, content),
  });
  mergeTurn(u, turn);
  session.messages.push(msg('assistant', turn.reply, turn.targets as ChatMessage['targets']));
  saveUseCase(u);
  if (turn.done) await completeInterview(session, u, user);
  saveInterview(session);
  await persistTranscript(session, u);
  return { session, useCase: getUseCase(u.id) };
}

export async function finishInterview(session: InterviewSession, user: User) {
  if (session.userId !== user.id) throw new HttpError(404, `interview ${session.id} not found`);
  const u = getUseCase(session.useCaseId);
  if (!session.done) await completeInterview(session, u, user);
  saveInterview(session);
  await persistTranscript(session, u);
  return { useCase: getUseCase(u.id) };
}

/**
 * When an interview ends: a shared use case goes to triage; a private one stays
 * with its author, and the interviewer offers an anonymised synthetic version
 * that could be published with no name attached, asking for consent first.
 */
async function completeInterview(session: InterviewSession, u: UseCase, user: User) {
  session.done = true;
  if (u.visibility === 'private') {
    if (!u.anonymisation || u.anonymisation.status === 'declined') {
      const proposed = await proposeAnonymised(u, user);
      Object.assign(u, proposed);
    }
    const name = u.anonymisation?.draft?.sections.name ?? u.sections.name ?? 'your use case';
    session.messages.push(
      msg(
        'assistant',
        `This use case is **private**: only you can see it, and your copy is kept in ${session.storage.kind === 'solid' ? 'your Solid pod' : 'your private storage'}.\n\nSo that it can still shape the ontology, I've drafted an **anonymised, synthetic version**, “${name}”. It keeps your requirements and competency questions but swaps out names, places and anything that could identify you, and it would be published with **no name attached**. It would give the working group a use case to justify adding these terms.\n\nAre you happy for this synthetic version to be made public? You can read and edit it first, keep everything private, or share the original instead.`,
      ),
    );
  } else {
    if (u.status === 'draft') u.status = 'triage';
    saveUseCase(u);
    logActivity({ ontologyId: u.ontologyId, actorId: user.id, type: 'usecase.ready', message: `described ${useCaseLabel(u)}: ${u.sections.name ?? 'untitled'}`, link: `/o/${u.ontologyId}/use-cases/${u.id}` });
  }
}

/* ------------------------------------------------------------------------ */
/* Synthesis: use cases -> proposed change request                          */
/* ------------------------------------------------------------------------ */

export async function synthesise(project: OntologyProject, actor: User, useCaseIds?: string[]) {
  const picked = (useCaseIds?.length ? useCaseIds.map((id) => getUseCaseFor(id, actor)) : allUseCases(project.id).filter((u) => ['triage', 'accepted'].includes(u.status) && isPublic(u))).filter(
    (u) => u.ontologyId === project.id,
  );
  // A change request is public: its title, description, terms, definitions and tests are
  // derived from the use cases, so only public ones (including anonymised versions) are used.
  if (useCaseIds?.length && picked.some((u) => !isPublic(u))) throw new HttpError(409, NOT_PUBLIC);
  const ucs = picked.filter((u) => isPublic(u) && u.status !== 'out-of-scope');
  if (!ucs.length) throw new HttpError(409, 'No public use cases are ready to draft changes from. Make a use case public, or publish an anonymised version of a private one, first.');
  const graph = await ontologyStore.working(project);
  const { value } = await llm.json<Proposal>({
    task: 'synthesise',
    system: SYNTHESISER,
    schema: ProposalSchema,
    maxTokens: 24000,
    messages: [
      {
        role: 'user',
        content: `Current ontology:\n\n${ontologyDigest(graph)}\n\nUse cases:\n\n${ucs.map(useCaseDigest).join('\n\n')}\n\nPropose the changes. Write one SPARQL test per competency question (SELECT, using the ontology's terms) with small example Turtle data that should make it return rows.`,
      },
    ],
    fallback: () => heuristicSynthesis(graph.view().classes.map((c) => c.label?.toLowerCase() ?? ''), ucs),
  });
  // From the consent check to the change request being stored, no use case can be withdrawn (it waits).
  return withConsentLock(project.id, async () => {
    // The model can take a while: if a use case was withdrawn or made non-public meanwhile, nothing is drafted from it.
    if (ucs.some((u) => { const now = get<UseCase>('useCases', u.id); return !now || !isPublic(now) || !canSee(now, actor); }))
      throw new HttpError(409, 'A use case changed while the changes were being drafted (it may have been withdrawn). Try again.');
    // The ontology is published, but use cases may be private: its annotations
    // cite use cases only by their (sign-in only) link, never their title or author.
    const terms = redactUseCases(value.terms, ucs);
    const sources = ucs.map((u) => `${config.publicUrl}/o/${encodeURIComponent(project.slug)}/use-cases/${encodeURIComponent(u.id)}`);
    const cr = await createChangeRequest(project, actor, {
      title: value.title,
      description: `${value.summary}\n\n**Rationale.** ${value.rationale}\n\nFrom use cases: ${ucs.map((u) => u.sections.name ?? u.id).join('; ')}${value.conflicts.length ? `\n\n**Terminology conflicts.**\n${value.conflicts.map((c) => `- ${c}`).join('\n')}` : ''}`,
      kind: 'feature',
      origin: { type: 'synthesis', useCaseIds: ucs.map((u) => u.id) },
      ops: proposalToOps(graph, terms, sources).ops,
      tests: value.competencyQuestionTests,
      analysis: { summary: value.summary, rationale: value.rationale, risks: value.risks, recommendation: 'change-ontology' },
    });
    // Carry the drafted SPARQL back onto the use cases so the tests keep running on every future change.
    // Each use case is read again and only the fields synthesis owns are changed, so an edit or
    // withdrawal made while drafting is never overwritten.
    const linked: string[] = [];
    for (const stale of ucs) {
      const u = get<UseCase>('useCases', stale.id);
      if (!u || !isPublic(u)) continue;
      linked.push(u.id);
      for (const q of u.competencyQuestions) {
        const t = value.competencyQuestionTests.find((x) => x.question.toLowerCase() === q.question.toLowerCase());
        if (t) {
          q.sparql = t.sparql;
          q.exampleData = t.exampleData;
        }
      }
      u.changeRequestIds = [...new Set([...(u.changeRequestIds ?? []), cr.id])];
      if (['triage', 'accepted', 'draft'].includes(u.status)) u.status = 'accepted';
      saveUseCase(u);
      syncUseCase(u, [cr]);
    }
    cr.useCaseIds = linked;
    put('changeRequests', cr, cr.ontologyId);
    return cr;
  });
}

/**
 * Replaces use case titles and contributor names in the text that becomes
 * ontology annotations (definitions, comments, editorial notes) with a neutral
 * reference, in case the model quoted them.
 */
export function redactUseCases(terms: Proposal['terms'], ucs: UseCase[]): Proposal['terms'] {
  const pattern = (values: (string | undefined)[]) => {
    const words = [...new Set(values.map((v) => v?.trim()).filter((v): v is string => !!v && v.length >= 4))].sort((a, b) => b.length - a.length);
    return words.length ? new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi') : undefined;
  };
  const titles = pattern(ucs.map((u) => u.sections.name));
  const people = pattern(ucs.map((u) => getUser(u.authorId)?.name));
  const clean = (text?: string) => {
    if (text === undefined) return text;
    const t = titles ? text.replace(titles, 'a use case') : text;
    return people ? t.replace(people, 'a participant') : t;
  };
  return terms.map((t) => ({ ...t, definition: clean(t.definition), comment: clean(t.comment), reason: clean(t.reason) }));
}

/** Offline synthesis: each candidate class term not yet in the ontology becomes a new class. */
function heuristicSynthesis(existingLabels: string[], ucs: UseCase[]): Proposal {
  const have = new Set(existingLabels);
  const terms: Proposal['terms'] = [];
  for (const u of ucs) {
    for (const t of u.terms) {
      if (have.has(t.label.toLowerCase()) || t.existingIri) continue;
      have.add(t.label.toLowerCase());
      const kind = t.kind;
      terms.push({
        action: 'add',
        kind,
        localName: toLocalName(t.label, kind),
        label: t.label.toLowerCase(),
        definition: t.definition ?? `A ${t.label.toLowerCase()}. (Definition to be refined by an editor.)`,
        range: kind === 'datatypeProperty' ? ['xsd:string'] : undefined,
        evidence: t.evidence,
        reason: 'Needed by a use case (see source).',
      });
    }
  }
  return {
    title: `Add terms from ${ucs.length} use case${ucs.length > 1 ? 's' : ''}`,
    summary: terms.length ? `Adds ${terms.length} candidate term(s) elicited from the use cases.` : 'All candidate terms already exist in the ontology.',
    rationale: 'Drafted offline from the candidate terms participants used. An editor should check definitions and place new classes in the hierarchy.',
    terms,
    competencyQuestionTests: [],
    conflicts: [],
    risks: terms.length ? ['New classes have no superclass yet; place them in the hierarchy before approval.'] : [],
  };
}

