import type {
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
import { USE_CASE_STATUS_INFO } from '@concord/shared';
import { clock } from '../clock.js';
import { get, HttpError, list, mustGet, put } from '../db.js';
import { newId } from '../ids.js';
import { ontologyDigest, useCaseDigest } from '../llm/context.js';
import { ANONYMISER, INTERVIEWER, SYNTHESISER } from '../llm/prompts.js';
import { llm } from '../llm/provider.js';
import { AnonymisedDraftSchema, InterviewTurnSchema, ProposalSchema, type InterviewTurn, type Proposal } from '../llm/schemas.js';
import { createChangeRequest } from './changeRequests.js';
import { getProject, rolesFor, setRoles } from './ontologies.js';
import { ontologyStore } from './ontologyStore.js';
import { proposalToOps, toLocalName } from './proposals.js';
import { solid, transcriptToTurtle } from './solid.js';
import { syncUseCase } from './traceability.js';
import { logActivity } from './users.js';

/* ------------------------------------------------------------------------ */
/* Use cases                                                                 */
/* ------------------------------------------------------------------------ */

const LEGACY_STATUS: Record<string, UseCaseStatus> = { eliciting: 'draft', ready: 'triage', synthesised: 'in-progress' };
const GROUP_ROLES: Role[] = ['owner', 'steward', 'editor', 'reviewer', 'member', 'odi'];
const TRIAGE_ROLES: Role[] = ['editor', 'steward', 'owner'];

/** Working group members: anyone with a role beyond contributor or agent. */
export const isGroupMember = (ontologyId: string, user?: User) => !!user && (user.isPlatformAdmin || rolesFor(ontologyId, user.id).some((r) => GROUP_ROLES.includes(r)));
export const canTriage = (ontologyId: string, user?: User) => !!user && (user.isPlatformAdmin || rolesFor(ontologyId, user.id).some((r) => TRIAGE_ROLES.includes(r)));

/** Can this viewer see the use case at all? */
export function canSee(u: UseCase, viewer?: User): boolean {
  if (viewer && u.authorId === viewer.id) return true;
  if (u.visibility === 'public') return true;
  if (u.visibility === 'group') return isGroupMember(u.ontologyId, viewer);
  return false;
}

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

function ensureNumbers(ontologyId: string, all: UseCase[]) {
  let max = all.reduce((m, u) => Math.max(m, u.number ?? 0), 0);
  for (const u of [...all].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (u.number) continue;
    u.number = ++max;
    put('useCases', u, ontologyId);
  }
}

const nextNumber = (ontologyId: string) => {
  const all = list<UseCase>('useCases', ontologyId);
  ensureNumbers(ontologyId, all);
  return all.reduce((m, u) => Math.max(m, u.number ?? 0), 0) + 1;
};

/** Raw access for services (no visibility check). */
export const getUseCase = (id: string) => {
  const u = normalise(mustGet<UseCase>('useCases', id));
  if (!u.number) ensureNumbers(u.ontologyId, list<UseCase>('useCases', u.ontologyId));
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

/** A use case as one viewer may see it: hides the author of anonymous ones and private storage details. */
export function present(u: UseCase, viewer?: User): UseCase {
  const own = !!viewer && viewer.id === u.authorId;
  if (own) return u;
  const out: UseCase = { ...u };
  if (u.anonymous) out.authorId = 'anonymous';
  delete out.anonymisation;
  delete out.podUrl;
  delete out.transcriptUrl;
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
  title: u.sections.name || 'Untitled use case',
  status: u.status,
  visibility: u.visibility,
  ...(u.anonymous ? { anonymous: true } : {}),
});

export function useCaseRefs(ids: string[], viewer?: User): UseCaseRef[] {
  return ids
    .map((id) => get<UseCase>('useCases', id))
    .filter((u): u is UseCase => !!u && canSee(u, viewer))
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
  u.completeness = completeness(u);
  u.updatedAt = clock.iso();
  put('useCases', u, u.ontologyId);
  if (u.visibility === 'private') void mirrorToPod(u);
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
  return saveUseCase({
    id: newId('uc'),
    number: nextNumber(project.id),
    ontologyId: project.id,
    authorId: author.id,
    source,
    sourceRef: init.sourceRef,
    sourceLines: init.sourceLines,
    status: init.status ?? 'draft',
    visibility: init.visibility ?? defaultVisibility(source),
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

/** Who can see it. Only the author decides; anonymous versions are always public. */
export function setVisibility(u: UseCase, actor: User, visibility: UseCaseVisibility, save = true) {
  if (!isAuthor(u, actor)) throw new HttpError(403, 'Only the author can change who sees a use case');
  if (!['private', 'group', 'public'].includes(visibility)) throw new HttpError(400, 'visibility must be private, group or public');
  if (u.anonymous && visibility !== 'public') throw new HttpError(409, 'An anonymised use case is always public. Archive it to withdraw it.');
  const from = u.visibility;
  u.visibility = visibility;
  // Sharing a finished private draft submits it for triage.
  if (from === 'private' && visibility !== 'private' && u.status === 'draft' && interviewDone(u)) u.status = 'triage';
  if (save) saveUseCase(u);
  if (from === 'private' && visibility !== 'private') {
    logActivity({ ontologyId: u.ontologyId, actorId: actor.id, type: 'usecase.shared', message: `shared UC-${u.number} ${u.sections.name ?? ''} with ${visibility === 'public' ? 'everyone' : 'the working group'}`.trim(), link: `/o/${u.ontologyId}/use-cases/${u.id}` });
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
  logActivity({ ontologyId: u.ontologyId, actorId: actor.id, type: 'usecase.triaged', message: `marked UC-${u.number} ${u.sections.name ?? ''} as ${label}`.replace('  ', ' '), link: `/o/${u.ontologyId}/use-cases/${u.id}` });
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
      const target = get<{ ontologyId: string }>(link.type === 'meeting' ? 'meetings' : 'changeRequests', link.id);
      if (!target || target.ontologyId !== u.ontologyId) throw new HttpError(404, `No such ${link.type.replace('-', ' ')}`);
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
  if (ucs.some((u) => u.visibility === 'private')) throw new HttpError(409, 'A change request cannot cite a private use case. Publish an anonymised version and cite that.');
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

/* ------------------------------------------------------------------------ */
/* Anonymised synthetic versions of private use cases                       */
/* ------------------------------------------------------------------------ */

const FICTIONAL_PLACES = ['Anytown', 'Riverton', 'Hillford', 'Lakeside', 'Oakbridge', 'Westmere', 'Eastholm', 'Northcombe'];
const FICTIONAL_ORGS = ['Brightwater Trust', 'Hillcrest Community Group', 'Greenway Volunteer Centre', 'Meadowbank Foundation'];
const COMMON = new Set(
  'The This That They These Those There When Then What Which Where Who Whom How Why We Our Us And But Or So For With If Each Every Some Many Most It Its A An In On At To Of From By As Is Are Was Be Can Could Would Should Will Also Yes No Not Please Thanks Thank Hi Hello I Im My Me You Your Sometimes Usually Often Today Now Students Teachers Volunteers Charity Platform Paid Our Every Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September October November December UK DBS GDPR API CSV JSON RDF OWL SPARQL URL CRM Excel Email Call See Tell'.split(' '),
);
const escRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Offline anonymiser: swaps names of people, places and organisations for fictional
 * ones and removes contact details. Proper nouns are found where they are not
 * sentence-initial, then replaced everywhere (any case), including in term labels.
 */
export function heuristicAnonymise(u: Pick<UseCase, 'sections' | 'competencyQuestions' | 'terms'>, authorName?: string): AnonymisedDraft {
  const counts = { emails: 0, phones: 0, urls: 0 };
  const strings: string[] = [];
  const collect = (v: unknown) => {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === 'object') Object.values(v).forEach(collect);
  };
  collect([u.sections, u.competencyQuestions.map((q) => [q.question, q.exampleAnswer]), u.terms.map((t) => t.definition)]);
  const proper = new Set<string>();
  for (const text of strings)
    for (const m of text.matchAll(/(?<![.!?:]\s|^|\n)\b((?:St\.? )?[A-Z][a-z'’]+(?:\s+(?:of\s+)?[A-Z][a-z'’]+)*)\b/g)) {
      const words = m[1].split(/\s+/).filter((w) => w !== 'of');
      if (words.every((w) => COMMON.has(w.replace(/['’]s$/, '')))) continue;
      // Drop a leading common word ("Every Northvale" -> "Northvale").
      const trimmed = words[0] && COMMON.has(words[0]) ? m[1].split(/\s+/).slice(1).join(' ') : m[1];
      if (trimmed.length > 2) proper.add(trimmed);
    }
  const map = new Map<string, string>();
  let place = 0;
  let org = 0;
  // Longest first, so "Northvale Food Bank" wins over "Northvale".
  for (const name of [...proper].sort((a, b) => b.length - a.length)) {
    const looksLikeOrg = /(Trust|Council|Charity|Foundation|Fund|Hospice|Hospital|Centre|Center|Group|Ltd|Limited|Society|Network|Association|Church|School|College|University|Bank|Impact|Club)$/.test(name);
    map.set(name, looksLikeOrg ? FICTIONAL_ORGS[org++ % FICTIONAL_ORGS.length] : FICTIONAL_PLACES[place++ % FICTIONAL_PLACES.length]);
  }
  const author = (authorName ?? '').trim();
  const authorParts = author.split(/\s+/).filter((p) => p.length >= 2);
  const scrub = (text: string): string => {
    let t = text;
    t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, () => (counts.emails++, 'an email address'));
    t = t.replace(/https?:\/\/\S+/g, () => (counts.urls++, 'a website'));
    t = t.replace(/(?:\+44\s?|0)\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}/g, () => (counts.phones++, 'a phone number'));
    if (author) t = t.replace(new RegExp(`\\b${escRe(author)}\\b`, 'gi'), 'a coordinator');
    for (const part of authorParts) t = t.replace(new RegExp(`\\b${escRe(part)}\\b`, 'g'), 'a coordinator');
    for (const [name, fake] of map) t = t.replace(new RegExp(`\\b${escRe(name)}\\b`, 'gi'), fake);
    return t.replace(/\b(a|the) a coordinator\b/gi, 'a coordinator').replace(/\b(a coordinator)(\s+a coordinator)+/g, '$1').replace(/\bthe (a|an) /gi, 'the ');
  };
  const deep = <T>(v: T): T => {
    if (typeof v === 'string') return scrub(v) as T;
    if (Array.isArray(v)) return v.map(deep) as T;
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'step' ? x : deep(x)])) as T;
    return v;
  };
  const sections = deep({ ...u.sections });
  delete sections.notes;
  delete sections.references;
  if (sections.dataSources) sections.dataSources = sections.dataSources.map((d) => ({ name: d.type ?? d.name, type: d.type, description: d.description }));
  // Terms that are themselves names (e.g. "riverside youth trust") are dropped, not renamed.
  const isName = (label: string) => [...map.keys()].some((n) => n.toLowerCase() === label.toLowerCase()) || authorParts.some((p) => p.toLowerCase() === label.toLowerCase());
  const changes: string[] = [];
  if (map.size) changes.push(`Replaced ${map.size} name${map.size === 1 ? '' : 's'} of places or organisations with fictional ones (${[...map.values()].slice(0, 4).map((x) => `“${x}”`).join(', ')}${map.size > 4 ? ', …' : ''}).`);
  if (author) changes.push('Removed your name; the use case is published with no name attached.');
  if (counts.emails) changes.push(`Removed ${counts.emails} email address${counts.emails === 1 ? '' : 'es'}.`);
  if (counts.phones) changes.push(`Removed ${counts.phones} phone number${counts.phones === 1 ? '' : 's'}.`);
  if (counts.urls) changes.push(`Removed ${counts.urls} link${counts.urls === 1 ? '' : 's'}.`);
  changes.push('Dropped your private notes and references, and kept only the kind of each data source.');
  return {
    sections,
    competencyQuestions: u.competencyQuestions.map((q) => ({ question: scrub(q.question), exampleAnswer: q.exampleAnswer ? scrub(q.exampleAnswer) : undefined })),
    terms: u.terms.filter((t) => !isName(t.label)).map((t) => ({ label: scrub(t.label), kind: t.kind, definition: t.definition ? scrub(t.definition) : undefined })),
    changes,
  };
}

/** Ask the model (or the offline stand-in) for an anonymised synthetic version, and store it as a proposal for the author. */
export async function proposeAnonymised(u: UseCase, actor: User): Promise<UseCase> {
  if (!isAuthor(u, actor)) throw new HttpError(404, `useCase ${u.id} not found`);
  if (u.visibility !== 'private') throw new HttpError(409, 'Only private use cases get an anonymised version; this one is already shared.');
  const project = getProject(u.ontologyId);
  const { value } = await llm.json<AnonymisedDraft>({
    task: 'anonymise',
    system: ANONYMISER,
    schema: AnonymisedDraftSchema,
    effort: 'medium',
    maxTokens: 8000,
    messages: [
      {
        role: 'user',
        content: `Ontology: ${project.title}${project.domain ? ` (domain: ${project.domain})` : ''}.\nThe author's name (must not appear): ${actor.name}${actor.organisation ? `, of ${actor.organisation}` : ''}.\n\nPrivate use case (JSON):\n${JSON.stringify({ sections: u.sections, competencyQuestions: u.competencyQuestions.map(({ question, exampleAnswer }) => ({ question, exampleAnswer })), terms: u.terms.map(({ label, kind, definition }) => ({ label, kind, definition })) })}\n\nWrite the anonymised synthetic version.`,
      },
    ],
    fallback: () => heuristicAnonymise(u, actor.name),
  });
  u.anonymisation = { status: 'proposed', draft: value, proposedAt: clock.iso() };
  return saveUseCase(u);
}

/** The author consents: publish the (possibly edited) anonymised version as a new public use case with no name attached. */
export function publishAnonymised(u: UseCase, actor: User, edited?: Partial<AnonymisedDraft>): { original: UseCase; published: UseCase } {
  if (!isAuthor(u, actor)) throw new HttpError(404, `useCase ${u.id} not found`);
  if (u.visibility !== 'private') throw new HttpError(409, 'Only private use cases get an anonymised version');
  const draft = u.anonymisation?.draft;
  if (!draft) throw new HttpError(409, 'There is no anonymised version to publish yet');
  if (u.anonymisation?.status === 'published' && u.anonymisation.publishedId) throw new HttpError(409, 'An anonymised version is already published');
  const final: AnonymisedDraft = {
    sections: edited?.sections ?? draft.sections,
    competencyQuestions: edited?.competencyQuestions ?? draft.competencyQuestions,
    terms: edited?.terms ?? draft.terms,
    changes: draft.changes,
  };
  const project = getProject(u.ontologyId);
  const published = createUseCase(project, actor, {
    source: u.source,
    visibility: 'public',
    anonymous: true,
    status: 'triage',
    sections: { ...final.sections, notes: 'An anonymised, synthetic version of a use case a participant described privately. It keeps their requirements but not their details.' },
    competencyQuestions: final.competencyQuestions.filter((q) => q.question?.trim()).map((q) => ({ id: newId('cq'), question: q.question, exampleAnswer: q.exampleAnswer, status: 'untested' as const })),
    terms: final.terms,
  });
  u.anonymisation = { ...u.anonymisation!, status: 'published', draft: final, decidedAt: clock.iso(), publishedId: published.id };
  saveUseCase(u);
  // No actor on the activity item: naming the author would undo the anonymisation.
  logActivity({ ontologyId: u.ontologyId, type: 'usecase.anonymised', message: `An anonymised use case was published: UC-${published.number} ${published.sections.name ?? ''}`.trim(), link: `/o/${u.ontologyId}/use-cases/${published.id}` });
  return { original: u, published };
}

export function declineAnonymised(u: UseCase, actor: User) {
  if (!isAuthor(u, actor)) throw new HttpError(404, `useCase ${u.id} not found`);
  if (!u.anonymisation) throw new HttpError(409, 'There is no anonymised version to decline');
  if (u.anonymisation.status === 'published') throw new HttpError(409, 'The anonymised version is already published; archive it instead');
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
  if (u.authorId !== user.id) throw new HttpError(403, 'Only the author can continue this interview');
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
  if (session.userId !== user.id) throw new HttpError(403, 'This interview belongs to someone else');
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
  if (session.userId !== user.id) throw new HttpError(403, 'This interview belongs to someone else');
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
    logActivity({ ontologyId: u.ontologyId, actorId: user.id, type: 'usecase.ready', message: `described UC-${u.number}: ${u.sections.name ?? 'untitled'}`, link: `/o/${u.ontologyId}/use-cases/${u.id}` });
  }
}

/* ------------------------------------------------------------------------ */
/* Synthesis: use cases -> proposed change request                          */
/* ------------------------------------------------------------------------ */

export async function synthesise(project: OntologyProject, actor: User, useCaseIds?: string[]) {
  const picked = (useCaseIds?.length ? useCaseIds.map((id) => getUseCaseFor(id, actor)) : allUseCases(project.id).filter((u) => ['triage', 'accepted'].includes(u.status) && canSee(u, actor))).filter(
    (u) => u.ontologyId === project.id,
  );
  // Private use cases never feed a change request directly: their anonymised version does.
  if (useCaseIds?.length && picked.some((u) => u.visibility === 'private'))
    throw new HttpError(409, 'Private use cases are not used directly. Publish an anonymised version (or share the use case) and synthesise from that.');
  const ucs = picked.filter((u) => u.visibility !== 'private' && !['archived', 'out-of-scope'].includes(u.status));
  if (!ucs.length) throw new HttpError(409, 'No use cases are ready to synthesise. Finish an interview and share it, or accept a use case first.');
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
  const cr = await createChangeRequest(project, actor, {
    title: value.title,
    description: `${value.summary}\n\n**Rationale.** ${value.rationale}\n\nFrom use cases: ${ucs.map((u) => u.sections.name ?? u.id).join('; ')}${value.conflicts.length ? `\n\n**Terminology conflicts.**\n${value.conflicts.map((c) => `- ${c}`).join('\n')}` : ''}`,
    kind: 'feature',
    origin: { type: 'synthesis', useCaseIds: ucs.map((u) => u.id) },
    ops: proposalToOps(graph, value.terms, `use cases: ${ucs.map((u) => u.sections.name).join('; ')}`).ops,
    tests: value.competencyQuestionTests,
    analysis: { summary: value.summary, rationale: value.rationale, risks: value.risks, recommendation: 'change-ontology' },
  });
  // Carry the drafted SPARQL back onto the use cases so the tests keep running on every future change.
  for (const u of ucs) {
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
  cr.useCaseIds = ucs.map((u) => u.id);
  put('changeRequests', cr, cr.ontologyId);
  return cr;
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
        definition: t.definition ?? `A ${t.label.toLowerCase()}, as described in the use case “${u.sections.name ?? ''}”. (Definition to be refined by an editor.)`,
        range: kind === 'datatypeProperty' ? ['xsd:string'] : undefined,
        evidence: t.evidence,
        reason: `Needed by the use case “${u.sections.name ?? u.id}”`,
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

