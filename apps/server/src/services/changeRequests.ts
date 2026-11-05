import {
  applyChangeOps,
  ChangeOpError,
  classifyChange,
  compactIRI,
  diffOntologies,
  toKGCL,
  validate,
  withDeclaredLevel,
  type OntologyGraph,
} from '@concord/core';
import type { ChangeOp, ValidationReport } from '@concord/core/types';
import { fairContext } from './fairResolution.js';
import type {
  AiAnalysis,
  ChangeRequest,
  ChangeRequestDetail,
  ChangeRequestKind,
  ChangeRequestOrigin,
  ChangeRequestStatus,
  OntologyProject,
  Publication,
  PublicationStatement,
  Review,
  TimelineEvent,
  UseCase,
  User,
  Vote,
} from '@concord/shared';
import { canCastVote } from '@concord/shared';
import { clock } from '../clock.js';
import { HttpError, list, mustGet, put, transaction } from '../db.js';
import { newId } from '../ids.js';
import { ontologyDigest, requestText } from '../llm/context.js';
import { CHANGE_DRAFTER, REVISER, TRIAGE, UNTRUSTED_TEXT } from '../llm/prompts.js';
import { llm } from '../llm/provider.js';
import { AnalysisSchema, ProposalSchema, type Proposal } from '../llm/schemas.js';
import { evaluate } from './governance.js';
import { triageBudgetAvailable, withTriageBudget } from './budget.js';
import { assertStillHeld, withWorkingDraftLock } from './repoLock.js';
import { competencyTests, getProject, members, requireRole, rolesFor, updateProject } from './ontologies.js';
import { ontologyStore } from './ontologyStore.js';
import { describeOp, proposalToOps, toLocalName } from './proposals.js';
import { getUser, logActivity, publicUser } from './users.js';
import { createHash } from 'node:crypto';
import { findSecrets, secretsOf } from './redact.js';

const OPEN: ChangeRequestStatus[] = ['triage', 'review', 'voting', 'approved', 'needs-work'];

const ev = (type: TimelineEvent['type'], message: string, actorId?: string): TimelineEvent => ({ at: clock.iso(), type, message, actorId });

export const getCR = async (id: string) => await mustGet<ChangeRequest>('changeRequests', id);
export const listCRs = async (ontologyId: string) => (await list<ChangeRequest>('changeRequests', ontologyId)).sort((a, b) => b.number - a.number);

/**
 * Saves a change request. Only allowed while holding its ontology's lock (see
 * `locked`): every change is made to the latest stored copy, one at a time,
 * across processes too, so none is ever saved from a stale copy.
 */
const save = async (cr: ChangeRequest) =>
  // The lease check and the write are one transaction, so the lease can't lapse between them.
  await transaction(async () => {
    await assertStillHeld({ id: cr.ontologyId });
    return await stamp(cr);
  });

/**
 * Writes a request if it is still at the revision it was read at, bumping the
 * revision: a compare-and-swap, so a copy read before someone else's write
 * (another process's, or a merge's) can never be written over it. Call inside
 * a transaction with any other rows that go with it (a review, a vote).
 */
async function stamp(cr: ChangeRequest) {
  return await transaction(async () => {
    const stored = await getCR(cr.id);
    if ((stored.rev ?? 0) !== (cr.rev ?? 0)) throw new HttpError(409, 'This request was changed by someone else meanwhile. Reload it and try again.');
    cr.rev = (stored.rev ?? 0) + 1;
    cr.updatedAt = clock.iso();
    return await put('changeRequests', cr, cr.ontologyId);
  });
}

/** Marks a merged request released, inside the release's own transaction (see releases.publishRelease). */
export async function markReleased(id: string, releaseId: string, version: string, at: string) {
  const cr = await getCR(id);
  if (cr.status !== 'merged') return;
  cr.status = 'released';
  cr.releaseId = releaseId;
  cr.statusSince = at;
  cr.timeline.push({ at, type: 'released', message: `released in ${version}` });
  await stamp(cr);
}

/** Replace `cr`'s contents with the stored copy, in place, so callers holding it see the latest. */
async function refresh(cr: ChangeRequest): Promise<ChangeRequest> {
  const latest = await getCR(cr.id);
  for (const k of Object.keys(cr)) if (!(k in latest)) delete (cr as unknown as Record<string, unknown>)[k];
  return Object.assign(cr, latest);
}

/** Run fn on the latest stored copy of the request, holding its ontology's lock. */
function locked<T>(cr: ChangeRequest, fn: (cr: ChangeRequest) => Promise<T> | T): Promise<T> {
  return withWorkingDraftLock({ id: cr.ontologyId }, async () => fn(await refresh(cr)));
}

/**
 * Change a stored request from elsewhere (e.g. meetings), the same safe way:
 * under the lock, on the latest copy, and only if it is still at
 * `expectedRev` (by default the revision of the copy passed in).
 */
export function updateCR(cr: ChangeRequest, fn: (cr: ChangeRequest) => unknown, expectedRev = cr.rev): Promise<ChangeRequest> {
  return locked(cr, async (c) => {
    if ((c.rev ?? 0) !== (expectedRev ?? 0)) throw new HttpError(409, 'This request was changed by someone else meanwhile. Reload it and try again.');
    // Awaited, so a change that is made asynchronously is made before the save, not after it.
    await fn(c);
    return await save(c);
  });
}

const RANK = { patch: 0, minor: 1, major: 2 } as const;
const needsConfirmation = (cr: ChangeRequest) => !!cr.classification?.reasons.some((r) => r.rule === 'definition-reworded');

function setStatus(cr: ChangeRequest, status: ChangeRequestStatus, message: string, actorId?: string) {
  if (cr.status === status) return;
  cr.status = status;
  cr.statusSince = clock.iso();
  if (status === 'review') cr.reviewStartedAt = cr.statusSince;
  cr.timeline.push(ev('status', message, actorId));
}

/* ------------------------------------------------------------------------ */
/* Creation                                                                  */
/* ------------------------------------------------------------------------ */

export interface CreateInput {
  title: string;
  description: string;
  kind: ChangeRequestKind;
  origin: ChangeRequestOrigin;
  ops?: ChangeOp[];
  naturalLanguage?: string;
  tests?: ChangeRequest['tests'];
  analysis?: AiAnalysis;
  warnings?: string[];
  /** Submit straight into review (agents, synthesis) rather than leaving as a draft. */
  submit?: boolean;
  /** A minimum level someone declared, e.g. a definition edit its author says changes the meaning. */
  declaredLevel?: ChangeRequest['declaredLevel'];
  /**
   * Runs in the same transaction that saves the change request, just before
   * it: throwing saves nothing. For steps that must happen exactly once with
   * the save, such as taking a public report off the queue.
   */
  atSave?: () => Promise<void> | void;
}

export function createChangeRequest(project: OntologyProject, author: User, input: CreateInput): Promise<ChangeRequest> {
  return withTriageBudget(author, () => createNow(project, author, input));
}

async function createNow(project: OntologyProject, author: User, input: CreateInput): Promise<ChangeRequest> {
  let ops = input.ops ?? [];
  let tests = input.tests;
  let warnings = input.warnings ?? [];
  let analysis = input.analysis;
  let title = input.title;
  const working = await ontologyStore.working(project);

  if (!input.ops && input.naturalLanguage) {
    const drafted = await draftFromNaturalLanguage(project, working, input.naturalLanguage, input.kind);
    ops = drafted.ops;
    warnings = [...warnings, ...drafted.warnings];
    tests = drafted.tests;
    title ||= drafted.title;
    analysis ??= drafted.analysis;
  }

  // Numbering and saving in one transaction, so two requests opened at once can't both take the same number.
  const cr = await transaction(async () => {
    const now = clock.iso();
    const number = (await list<ChangeRequest>('changeRequests', project.id)).reduce((m, c) => Math.max(m, c.number), 0) + 1;
    const cr: ChangeRequest = {
      id: newId('cr'),
      number,
      ontologyId: project.id,
      title: title || 'Untitled change',
      description: input.description,
      kind: input.kind,
      origin: input.origin,
      declaredLevel: input.declaredLevel,
      authorId: author.id,
      ops,
      status: 'draft',
      analysis,
      timeline: [ev('created', `opened this ${input.kind === 'bug' ? 'bug report' : 'change request'}`, author.id)],
      createdAt: now,
      updatedAt: now,
      statusSince: now,
      opsUpdatedAt: now,
      tests,
      warnings,
      baseCommit: await ontologyStore.head(project),
      rev: 0,
    };
    await input.atSave?.();
    await put('changeRequests', cr, cr.ontologyId); // new, so nobody else can be changing it yet
    await logActivity({ ontologyId: project.id, actorId: author.id, type: 'cr.created', message: `opened #${cr.number} ${cr.title}`, link: `/o/${project.id}/changes/${cr.id}` });
    return cr;
  });
  await triage(cr);
  // Just triaged against the current draft, so no need to do it again.
  if (input.submit) {
    await locked(cr, async (c) => {
      if (c.status !== 'draft') return c; // withdrawn meanwhile
      setStatus(c, 'review', 'submitted for review', author.id);
      await save(c);
      return advanceNow(c, author);
    });
  }
  return cr;
}

/** LLM drafts edits from a plain-language request; falls back to a simple parser. */
async function draftFromNaturalLanguage(project: OntologyProject, working: OntologyGraph, text: string, kind: ChangeRequestKind) {
  const { value } = await llm.json<Proposal>({
    task: 'draft-change',
    system: CHANGE_DRAFTER,
    schema: ProposalSchema,
    messages: [
      {
        role: 'user',
        content: `Current ontology:\n\n${ontologyDigest(working)}\n\nRequest type: ${kind}\nRequest:\n${text}\n\nPropose the edits. Include competency question tests only if the request implies questions the data must answer.`,
      },
    ],
    fallback: () => heuristicProposal(working, text),
  });
  const { ops, warnings } = proposalToOps(working, value.terms, `change request: ${value.title}`);
  return {
    ops,
    warnings,
    title: value.title,
    tests: value.competencyQuestionTests.length ? value.competencyQuestionTests : undefined,
    analysis: { summary: value.summary, rationale: value.rationale, risks: value.risks, recommendation: value.terms.length ? 'change-ontology' : 'use-existing-terms' } as AiAnalysis,
  };
}

/**
 * Offline fallback: understands simple requests like
 * "Add a class Shift as a subclass of Session" or "deprecate vol:Placement in favour of vol:Role".
 */
export function heuristicProposal(graph: OntologyGraph, text: string): Proposal {
  const terms: Proposal['terms'] = [];
  const t = text.trim();
  const dep = t.match(/deprecat\w*\s+(?:the\s+)?(?:term\s+|class\s+|property\s+)?["“]?([\w:-]+(?: [\w-]+)?)["”]?(?:.*?(?:in favou?r of|replaced by|use)\s+["“]?([\w:-]+)["”]?)?/i);
  if (dep) {
    terms.push({ action: 'deprecate', kind: 'class', existing: dep[1], replacedBy: dep[2], reason: t });
  } else {
    const re = /add(?:ing)?\s+(?:a\s+|an\s+)?(?:new\s+)?(class|concept|type|property|relationship|attribute|field)?\s*(?:called\s+|named\s+)?["“]?([A-Za-z][\w -]{1,40}?)["”]?(?:\s+(?:as\s+)?(?:a\s+)?(?:subclass|kind|type)\s+of\s+["“]?([\w: -]+?)["”]?)?(?=[,.;]|\s+(?:to|for|with|that|which)\b|$)/gi;
    for (const m of t.matchAll(re)) {
      const word = (m[1] ?? 'class').toLowerCase();
      const label = m[2].trim();
      const isProp = ['property', 'relationship', 'attribute', 'field'].includes(word);
      const kind = isProp ? (word === 'relationship' ? 'objectProperty' : 'datatypeProperty') : 'class';
      terms.push({
        action: 'add',
        kind,
        localName: toLocalName(label, kind),
        label: label.toLowerCase(),
        definition: isProp ? `The ${label.toLowerCase()} of something, as requested: ${t}` : `A ${m[3] ? m[3].toLowerCase() : 'thing'} that is a ${label.toLowerCase()}, as requested: ${t}`,
        superClasses: m[3] ? [m[3].trim()] : undefined,
        range: kind === 'datatypeProperty' ? ['xsd:string'] : undefined,
        reason: t,
      });
    }
  }
  return {
    title: t.length > 70 ? `${t.slice(0, 67)}…` : t,
    summary: terms.length ? `Proposes ${terms.length} edit(s) based on the request.` : 'No edits could be inferred automatically; an editor should draft them.',
    rationale: 'Drafted by the offline assistant from the wording of the request. An editor should check the definitions.',
    terms,
    competencyQuestionTests: [],
    conflicts: [],
    risks: [],
  };
}

/* ------------------------------------------------------------------------ */
/* Triage: apply, diff, classify, validate, analyse                         */
/* ------------------------------------------------------------------------ */

export async function preview(project: OntologyProject, ops: ChangeOp[], tests: ChangeRequest['tests'], author?: User) {
  const before = await ontologyStore.working(project);
  const { graph: after, warnings } = applyChangeOps(before, ops, { author: author?.name, date: clock.iso().slice(0, 10) });
  const diff = diffOntologies(before, after);
  const classification = classifyChange(diff, before, after);
  const cqs = [...await competencyTests(project.id), ...(tests ?? [])];
  const validation = await validate(after, { cqs, reasoner: 'owl', fair: await fairContext(after.ontologyIRI) });
  return { before, after, diff, classification, validation, warnings };
}

function validationPassed(v: ValidationReport | undefined) {
  return !!v && v.passed;
}

/**
 * Classifies and validates a request against the current working draft. It
 * computes on a snapshot and then, holding the lock, writes only its own
 * results onto the latest stored request, so a status change made meanwhile (a withdrawal, a merge) is kept;
 * if the edits themselves changed meanwhile, its now-stale results are dropped.
 */
export async function triage(cr: ChangeRequest, opts: { analyse?: boolean } = {}): Promise<ChangeRequest> {
  const project = await getProject(cr.ontologyId);
  const author = await getUser(cr.authorId);
  const opsKey = JSON.stringify(cr.ops);
  const result: Pick<ChangeRequest, 'diff' | 'classification' | 'validation' | 'warnings' | 'kgcl' | 'analysis'> = {};
  let event: TimelineEvent;
  try {
    const p = await preview(project, cr.ops, cr.tests, author);
    result.diff = trimDiff(p.diff);
    result.classification = withDeclaredLevel(p.classification, cr.declaredLevel);
    result.validation = p.validation;
    result.warnings = [...new Set([...(cr.warnings ?? []), ...p.warnings])];
    result.kgcl = toKGCL(cr.ops, p.after.prefixes);
    event = ev(
      'triaged',
      `Classified as ${result.classification.level.toUpperCase()} (${result.classification.reasons
        .filter((r) => r.level === result.classification!.level)
        .map((r) => r.rule)
        .slice(0, 3)
        .join(', ')}). Validation ${p.validation.passed ? 'passed' : 'failed'}.`,
    );
    if (opts.analyse !== false && project.governance.automation.autoTriage) result.analysis = await analyse(project, { ...cr, ...result }, p.after);
  } catch (err) {
    const message = err instanceof ChangeOpError ? `Edit ${err.opIndex + 1} cannot be applied: ${err.message}` : (err as Error).message;
    result.validation = {
      // An edit that no longer applies, or (anything else) a check that couldn't run: either way, not validated.
      lint: [{ severity: 'error', code: err instanceof ChangeOpError ? 'change-not-applicable' : 'triage-failed', message }],
      fair: { score: 0, checks: [], byPrinciple: { F: { passed: 0, total: 0, score: 0 }, A: { passed: 0, total: 0, score: 0 }, I: { passed: 0, total: 0, score: 0 }, R: { passed: 0, total: 0, score: 0 } } },
      reasoner: { engine: 'structural', available: false, consistent: true, unsatisfiable: [], inferredSubClassOf: [], durationMs: 0 },
      competencyQuestions: [],
      passed: false,
    };
    event = ev('validated', message);
  }
  return locked(cr, async (latest) => {
    if (JSON.stringify(latest.ops) !== opsKey) return latest;
    for (const [k, v] of Object.entries(result)) if (v !== undefined) (latest as unknown as Record<string, unknown>)[k] = v;
    latest.timeline.push(event);
    return await save(latest);
  });
}

function trimDiff(d: ChangeRequest['diff']) {
  if (!d) return d;
  return { ...d, addedNTriples: d.addedNTriples.slice(0, 400), removedNTriples: d.removedNTriples.slice(0, 400) };
}

async function analyse(project: OntologyProject, cr: ChangeRequest, after: OntologyGraph): Promise<AiAnalysis> {
  const c = (iri: string) => compactIRI(iri, after.prefixes);
  const v = cr.validation!;
  const lintErrors = v.lint.filter((i) => i.severity === 'error');
  const { value } = await llm.json({
    task: 'triage',
    system: `${TRIAGE}\n\n${UNTRUSTED_TEXT}`,
    schema: AnalysisSchema,
    effort: 'medium',
    messages: [
      {
        role: 'user',
        content: `${requestText(cr)}\n\nEdits:\n${cr.ops.map((o) => `- ${describeOp(o, c)}`).join('\n')}\n\nRule-based classification: ${cr.classification?.level}\n${cr.classification?.reasons.map((r) => `- [${r.level}] ${r.rule}: ${r.message}`).join('\n')}\n\nValidation: ${v.passed ? 'passed' : 'FAILED'}; reasoner consistent=${v.reasoner.consistent}, unsatisfiable=${v.reasoner.unsatisfiable.map(c).join(', ') || 'none'}; lint errors: ${lintErrors.map((i) => i.message).join('; ') || 'none'}; FAIR ${Math.round(v.fair.score * 100)}%.\n\nOntology after the change:\n${ontologyDigest(after, 250)}`,
      },
    ],
    fallback: () => fallbackAnalysis(cr, c),
  });
  return { ...cr.analysis, ...value, summary: value.summary || cr.analysis?.summary || '' };
}

function fallbackAnalysis(cr: ChangeRequest, c: (iri: string) => string) {
  const level = cr.classification?.level ?? 'minor';
  const v = cr.validation;
  const risks: string[] = [];
  if (level === 'major') risks.push('This is a breaking change: existing data or queries may stop working or give different answers. Consider deprecating instead, and ship migration notes.');
  if (v && !v.reasoner.consistent) risks.push('The ontology would become logically inconsistent.');
  if (v?.reasoner.unsatisfiable.length) risks.push(`Unsatisfiable classes: ${v.reasoner.unsatisfiable.map(c).join(', ')}.`);
  for (const i of v?.lint.filter((x) => x.severity === 'error').slice(0, 3) ?? []) risks.push(i.message);
  return {
    summary: cr.ops.map((o) => describeOp(o, c)).join(' ') || 'No edits yet.',
    recommendation: (v?.passed ? 'change-ontology' : 'needs-discussion') as AiAnalysis['recommendation'] & string,
    existingTerms: [] as string[],
    rationale: v?.passed
      ? `The edits apply cleanly, keep the ontology consistent and pass the strict modelling checks. The rule-based classification is ${level}.`
      : 'The edits do not yet pass validation; see the validation panel for what to fix.',
    risks,
    suggestedLevel: level,
  };
}

/* ------------------------------------------------------------------------ */
/* Lifecycle                                                                 */
/* ------------------------------------------------------------------------ */

export const reviewsFor = async (crId: string) => await list<Review>('reviews', crId);
export const votesFor = async (subjectId: string) => await list<Vote>('votes', subjectId);

export async function governanceFor(cr: ChangeRequest) {
  const project = await getProject(cr.ontologyId);
  const since = cr.opsUpdatedAt ?? cr.createdAt;
  return evaluate({
    policy: project.governance,
    level: cr.classification?.level ?? 'minor',
    kind: 'change',
    status: cr.status,
    statusSince: cr.statusSince,
    reviewStartedAt: cr.reviewStartedAt ?? cr.statusSince,
    authorId: cr.authorId,
    reviews: (await reviewsFor(cr.id)).filter((r) => r.at >= since),
    votes: (await votesFor(cr.id)).filter((v) => v.at >= since),
    members: await members(cr.ontologyId),
    validationOk: validationPassed(cr.validation),
    now: clock.now(),
    coAuthorIds: cr.revisedBy,
    independentConfirmation: needsConfirmation(cr)
      ? 'A definition was reworded, so someone other than the author must confirm it still means the same thing.'
      : undefined,
  });
}

export async function detail(cr: ChangeRequest): Promise<ChangeRequestDetail> {
  return { ...cr, reviews: await reviewsFor(cr.id), votes: await votesFor(cr.id), governance: await governanceFor(cr), author: publicUser(await getUser(cr.authorId)) };
}

export async function submit(cr: ChangeRequest, actor: User) {
  const check = async (c: ChangeRequest) => {
    if (c.authorId !== actor.id && !(await rolesFor(c.ontologyId, actor.id)).some((r) => ['steward', 'editor', 'owner'].includes(r)))
      throw new HttpError(403, 'Only the author or an editor can submit this');
    if (!['draft', 'needs-work'].includes(c.status)) throw new HttpError(409, `Cannot submit a request that is ${c.status}`);
  };
  await check(cr);
  return withTriageBudget(actor, async () => {
    // Classify against the draft as it is now, not as it was when the request was written.
    await triage(cr);
    return locked(cr, async (c) => {
      await check(c);
      setStatus(c, 'review', 'submitted for review', actor.id);
      await save(c);
      return advanceNow(c, actor);
    });
  });
}

interface EditsPatch {
  title?: string;
  description?: string;
  ops?: ChangeOp[];
}

/** Identifies the edits a revision started from, to tell whether someone changed them meanwhile. */
const editsBasis = (cr: ChangeRequest) => `${cr.opsUpdatedAt ?? cr.createdAt} ${JSON.stringify(cr.ops)}`;

export async function updateOps(cr: ChangeRequest, actor: User, patch: EditsPatch) {
  const { title, description, ops } = patch;
  await canEdit(cr, actor);
  return withTriageBudget(actor, () => updateOpsNow(cr, actor, { title, description, ops }));
}

async function canEdit(cr: ChangeRequest, actor: User) {
  if (cr.authorId !== actor.id) await requireRole(cr.ontologyId, actor, ['editor', 'steward', 'owner'], 'edit this change request');
  if (['merged', 'released', 'rejected', 'withdrawn'].includes(cr.status)) throw new HttpError(409, `Cannot edit a ${cr.status} request`);
}

async function updateOpsNow(
  cr: ChangeRequest,
  actor: User,
  patch: EditsPatch & { basis?: string; tests?: ChangeRequest['tests']; warnings?: string[]; note?: string },
) {
  await locked(cr, async (c) => {
    await canEdit(c, actor);
    // A revision computed from edits someone has since replaced would silently undo their work.
    if (patch.basis !== undefined && editsBasis(c) !== patch.basis)
      throw new HttpError(409, 'Someone changed the edits while they were being revised. Look at the latest edits and try again.');
    if (patch.note) c.timeline.push(ev('ai-analysis', patch.note, actor.id));
    if (patch.tests) c.tests = patch.tests;
    if (patch.warnings) c.warnings = patch.warnings;
    // An approval of what it publishes covers exactly what was approved: a new title or new edits need a new one.
    if ((patch.title && patch.title !== c.title) || patch.ops) c.privacyCleared = undefined;
    if (patch.title) c.title = patch.title;
    if (patch.description !== undefined) c.description = patch.description;
    if (patch.ops) {
      c.ops = patch.ops;
      c.opsUpdatedAt = clock.iso();
      // Whoever writes the edits can't also be the independent reviewer of them.
      if (actor.id !== c.authorId && !(c.revisedBy ?? []).includes(actor.id)) c.revisedBy = [...(c.revisedBy ?? []), actor.id];
      c.timeline.push(ev('ops-updated', 'updated the proposed edits (earlier approvals no longer count)', actor.id));
      if (c.status === 'voting' || c.status === 'approved') setStatus(c, 'review', 'returned to review after the edits changed', actor.id);
      c.approvedAs = undefined;
    }
    await save(c);
  });
  await triage(cr);
  return advance(cr, actor);
}

export function addReview(cr: ChangeRequest, actor: User, decision: Review['decision'], comment?: string) {
  return locked(cr, async (c) => {
    if (!OPEN.includes(c.status) && decision !== 'comment') throw new HttpError(409, `This request is ${c.status}`);
    const roles = await rolesFor(c.ontologyId, actor.id);
    if (decision !== 'comment' && !roles.length) throw new HttpError(403, 'Only members of this ontology can review it');
    const review: Review = { id: newId('rev'), changeRequestId: c.id, userId: actor.id, roles, decision, comment, at: clock.iso() };
    const verb = { approve: 'approved', 'request-changes': 'requested changes', object: 'objected', comment: 'commented' }[decision];
    c.timeline.push(ev(decision === 'comment' ? 'comment' : 'review', `${verb}${comment ? `: “${comment}”` : ''}`, actor.id));
    // The review only counts if the request it was given on is still the stored one.
    await transaction(async () => {
      await put('reviews', review, c.id);
      await save(c);
    });
    await logActivity({ ontologyId: c.ontologyId, actorId: actor.id, type: `cr.${decision}`, message: `${verb} on #${c.number} ${c.title}`, link: `/o/${c.ontologyId}/changes/${c.id}` });
    return advanceNow(c, actor);
  });
}

export function addVote(cr: ChangeRequest, actor: User, choice: Vote['choice'], comment?: string) {
  return locked(cr, async (c) => {
    if (c.status !== 'voting') throw new HttpError(409, 'There is no open vote on this request');
    const g = await governanceFor(c);
    const roles = await rolesFor(c.ontologyId, actor.id);
    if (!g.rule.vote || !canCastVote(roles, g.rule.vote.voterRoles))
      throw new HttpError(403, `Only ${g.rule.vote?.voterRoles.join(' / ') ?? 'voters'} can vote on this`);
    const vote: Vote = { id: newId('vote'), subjectType: 'change-request', subjectId: c.id, userId: actor.id, roles, choice, comment, at: clock.iso() };
    c.timeline.push(ev('vote', `voted ${choice}${comment ? `: “${comment}”` : ''}`, actor.id));
    await transaction(async () => {
      await put('votes', vote, c.id);
      await save(c);
    });
    await logActivity({ ontologyId: c.ontologyId, actorId: actor.id, type: 'cr.vote', message: `voted ${choice} on #${c.number} ${c.title}`, link: `/o/${c.ontologyId}/changes/${c.id}` });
    return advanceNow(c, actor);
  });
}

/**
 * Re-evaluate governance and apply any transition it allows. Safe to call any
 * time. `by` is whoever's action prompted it, whose budget an automatic merge
 * comes out of.
 */
export function advance(cr: ChangeRequest, by?: User): Promise<ChangeRequest> {
  return locked(cr, (c) => advanceNow(c, by));
}

async function advanceNow(cr: ChangeRequest, by?: User): Promise<ChangeRequest> {
  for (let i = 0; i < 4; i++) {
    if (!OPEN.includes(cr.status)) break;
    if (cr.status === 'triage') {
      setStatus(cr, 'review', 'entered review');
      continue;
    }
    const g = await governanceFor(cr);
    if (g.outcome === cr.status) break;
    // Approved stays approved (a passed vote isn't reopened) unless something
    // now blocks it: a request for changes, a veto, failed validation, or an
    // objection that sends it to a vote it hasn't had.
    if (cr.status === 'approved' && !await approvalLost(cr, g.outcome)) break;
    if (cr.status === 'needs-work' && g.outcome !== 'rejected') {
      // needs-work only leaves via an explicit resubmit/revision, or once the blockers clear
      if (g.outcome === 'needs-work') break;
      setStatus(cr, 'review', 'blocking issues resolved; back in review');
      continue;
    }
    const messages: Partial<Record<ChangeRequestStatus, string>> = {
      voting: `vote opened (${g.next})`,
      approved: `approved — ${g.next}`,
      rejected: g.vetoedBy.length ? 'rejected (vetoed)' : 'rejected — the vote did not pass',
      'needs-work': `needs work — ${g.unmet[0] ?? ''}`,
      review: 'returned to review',
    };
    const voted = cr.status === 'voting';
    setStatus(cr, g.outcome, messages[g.outcome] ?? g.outcome);
    cr.approvedAs = g.outcome === 'approved' ? { level: cr.classification?.level ?? 'minor', confirmation: needsConfirmation(cr), voted } : undefined;
    await logActivity({ ontologyId: cr.ontologyId, type: `cr.${g.outcome}`, message: `#${cr.number} ${cr.title} → ${g.outcome}`, link: `/o/${cr.ontologyId}/changes/${cr.id}` });
  }
  await save(cr);
  if (cr.status === 'approved' && (await governanceFor(cr)).rule.autoMerge) {
    // Merging re-validates the change, so it comes out of the budget of whoever
    // prompted it. If they have none left, it waits until they do, and the
    // governance clock merges it then, still on their budget.
    const payer = by ?? (cr.autoMergeBy ? await getUser(cr.autoMergeBy) : undefined);
    if (payer && !triageBudgetAvailable(payer)) {
      if (cr.autoMergeBy !== payer.id) {
        cr.autoMergeBy = payer.id;
        await save(cr);
      }
      return cr;
    }
    return merge(cr, undefined, payer);
  }
  return cr;
}

/* ------------------------------------------------------------------------ */
/* Publication approval                                                     */
/* ------------------------------------------------------------------------ */

/**
 * The ontology is published, but use cases may be private, and nothing can
 * reliably spot every name or title in text. So a request drafted from use
 * cases publishes only what a person approved: an editor is shown exactly
 * what merging it would publish (its title and edit list, which also go into
 * the commit and the release notes, and every statement it adds) and approves
 * those exact bytes. Any change afterwards needs a new approval. Name
 * matching only highlights what looks private; it never decides.
 */
export const needsPublicationApproval = (cr: Pick<ChangeRequest, 'origin'>) => cr.origin.type === 'synthesis';

const NT = /^(<[^>]*>|_:\S+) <([^>]*)> (.*) \.$/;
/** A literal's text, for reading; IRIs and blank nodes stay exactly as they are. */
function literalText(object: string): string | undefined {
  const lit = /^"((?:[^"\\]|\\.)*)"/.exec(object);
  return lit ? (JSON.parse(`"${lit[1]}"`) as string) : undefined;
}
/** Stands in for today's date when fingerprinting, so only the dates merging generates (dcterms:created and the like) are left out. */
const DATE_STAND_IN = '0001-01-01';

/** What merging this request now would publish, worked out exactly as merge() does it. */
async function publicationOf(cr: ChangeRequest, given?: OntologyProject) {
  const project = given ?? (await getProject(cr.ontologyId));
  const { graph: working, head: base } = await ontologyStore.workingAt(project);
  // No author: dcterms:contributor would publish the requester's name on every new term.
  const ctx = (date: string) => ({ date, source: `${project.slug}#${cr.number}` });
  const after = applyChangeOps(working, cr.ops, ctx(clock.iso().slice(0, 10))).graph;
  const added = diffOntologies(working, after).addedNTriples;
  const kgcl = toKGCL(cr.ops, after.prefixes);
  // The same edits applied with a stand-in date: what's approved doesn't change from one day to the next, but
  // any date someone wrote is part of it. The edits themselves and the draft they apply to are too.
  const dated = diffOntologies(working, applyChangeOps(working, cr.ops, ctx(DATE_STAND_IN)).graph).addedNTriples.sort();
  const fingerprint = createHash('sha256').update(JSON.stringify([cr.title, kgcl, dated, cr.ops, base])).digest('base64url');
  return { fingerprint, title: cr.title, kgcl, added, after, base };
}

/** For the editor approving it: what would be published, every statement in full, with what looks private highlighted. */
export async function publicationPreview(cr: ChangeRequest): Promise<Publication> {
  const p = await publicationOf(cr);
  const secrets = await secretsOf(cr);
  const hint = (text: string) => (secrets ? findSecrets(text, secrets)[0] : undefined);
  const statements = p.added.map((t) => {
    const m = NT.exec(t);
    const st: PublicationStatement = m ? { subject: m[1].replace(/^<|>$/g, ''), predicate: m[2], object: literalText(m[3]) ?? m[3].replace(/^<|>$/g, ''), nt: t } : { subject: '', predicate: '', object: t, nt: t };
    const h = hint(st.object) ?? hint(st.subject) ?? hint(t);
    return h ? { ...st, hint: h } : st;
  });
  const hints: Publication['hints'] = [];
  const t = hint(p.title);
  if (t) hints.push({ where: 'the title', kind: t });
  for (const line of p.kgcl) {
    const k = hint(line);
    if (k) hints.push({ where: `the edit list (${line.slice(0, 60)})`, kind: k });
  }
  return { fingerprint: p.fingerprint, title: p.title, kgcl: p.kgcl, statements, hints };
}

/**
 * An editor approves exactly what they were shown. If the request changed
 * since (its edits, its title, or the draft it merges into), the fingerprint
 * they send no longer matches and nothing is approved.
 */
export async function approvePublication(cr: ChangeRequest, actor: User, fingerprint: unknown): Promise<ChangeRequest> {
  await requireRole(cr.ontologyId, actor, ['editor', 'steward', 'owner'], 'approve what a change request publishes');
  if (!needsPublicationApproval(cr)) throw new HttpError(409, 'This request doesn’t need its publication approved');
  if (typeof fingerprint !== 'string' || !fingerprint) throw new HttpError(400, 'Say which version you reviewed (its fingerprint)');
  // On the latest stored request, holding its ontology's lock like every other change to it.
  const mergeNext = await locked(cr, async (c) => {
    if (c.status !== 'draft' && !OPEN.includes(c.status)) throw new HttpError(409, `This request is ${c.status}`);
    const p = await publicationOf(c);
    if (p.fingerprint !== fingerprint) throw new HttpError(409, 'This request changed after you reviewed it. Review what it publishes again.');
    c.privacyCleared = { by: actor.id, at: clock.iso(), fingerprint, title: p.title, kgcl: p.kgcl };
    c.timeline.push(ev('comment', 'approved exactly what this request publishes', actor.id));
    const held = c.heldForPublication;
    c.heldForPublication = undefined;
    c.privacyFindings = undefined;
    if (held && c.status === 'needs-work') setStatus(c, 'approved', 'approved again once its publication was approved', actor.id);
    await save(c);
    return !!held && c.status === 'approved';
  });
  return mergeNext ? merge(cr, actor) : cr;
}

/**
 * Merge into the working draft. Re-applies the edits on the current head (a
 * rebase). Merges into one ontology run one at a time (across processes too),
 * so each is checked and applied against the draft the previous one committed,
 * and nothing else can change the request meanwhile. A manual merge comes out
 * of the merger's budget, an automatic one out of `chargeTo`'s.
 */
export async function merge(cr: ChangeRequest, actor: User | undefined, chargeTo: User | undefined = actor): Promise<ChangeRequest> {
  if (actor) await requireRole(cr.ontologyId, actor, ['editor', 'steward', 'owner'], 'merge changes');
  const run = async () => {
    await withWorkingDraftLock({ id: cr.ontologyId }, async () => mergeNow(await refresh(cr), actor));
    if (cr.status === 'merged') {
      // Re-check other open requests against the new head so their diffs stay accurate (no LLM: rule-based only).
      for (const other of (await listCRs(cr.ontologyId)).filter((o) => o.id !== cr.id && ['review', 'voting', 'needs-work'].includes(o.status))) {
        await triage(other, { analyse: false });
      }
    }
    return cr;
  };
  return chargeTo ? withTriageBudget(chargeTo, run) : run();
}

async function mergeNow(cr: ChangeRequest, actor: User | undefined): Promise<ChangeRequest> {
  if (cr.status !== 'approved') throw new HttpError(409, `Only approved requests can be merged (this one is ${cr.status})`);
  const project = await getProject(cr.ontologyId);
  const author = await getUser(cr.authorId);
  // Re-check against the draft as it is now, combined with everything merged
  // since this was approved: it must still apply, still pass validation, still
  // have no blocking reviews, and be no bigger a change than it was approved as.
  const opsKey = JSON.stringify(cr.ops);
  const base = await ontologyStore.head(project);
  await triage(cr, { analyse: false });
  if (cr.status !== 'approved' || JSON.stringify(cr.ops) !== opsKey) throw new HttpError(409, 'This request changed while it was being merged, so it was not merged.');
  const { graph: working, head } = await ontologyStore.workingAt(project);
  if (head !== base) throw new HttpError(409, 'The working draft changed while this was being merged, so it was not merged. Try again.');
  // The revision this merge checked: it only lands if nobody has changed the request since.
  const checkedRev = cr.rev;
  const notApplicable = cr.validation?.lint.find((i) => i.code === 'change-not-applicable');
  if (notApplicable) return await draftMovedOn(cr, notApplicable.message);
  const blocked = await mergeBlocker(cr);
  if (blocked) {
    cr.approvedAs = undefined;
    setStatus(cr, blocked.status, blocked.message);
    await save(cr);
    return blocked.status === 'review' ? advanceNow(cr) : cr;
  }
  let p: Awaited<ReturnType<typeof publicationOf>>;
  try {
    p = await publicationOf(cr, project);
  } catch (err) {
    return await draftMovedOn(cr, (err as Error).message);
  }
  if (p.base !== base) throw new HttpError(409, 'The working draft changed while this was being merged, so it was not merged. Try again.');
  // Drafted from use cases: published only as an editor approved it, byte for byte.
  if (needsPublicationApproval(cr) && cr.privacyCleared?.fingerprint !== p.fingerprint) {
    const pv = await publicationPreview(cr);
    cr.privacyFindings = [...pv.hints, ...pv.statements.filter((st) => st.hint).map((st) => ({ where: `${st.predicate} of ${st.subject}`, kind: st.hint! }))];
    cr.heldForPublication = true;
    cr.privacyCleared = undefined;
    setStatus(cr, 'needs-work', 'held back before merging: it was drafted from use cases, so an editor must approve exactly what it publishes first.');
    return await save(cr);
  }
  // The draft moves, and the request is marked merged, in one transaction, and
  // only if neither the draft nor the request has changed since they were checked.
  // Commits are published with the ontology, so they carry no names: the change request records who asked.
  await ontologyStore.commitWorking(project, p.after, `#${cr.number} ${p.title}\n\n${p.kgcl.join('\n')}`, { name: 'Concord' }, base, async (commit) => {
    const latest = await refresh(cr);
    if (latest.rev !== checkedRev || latest.status !== 'approved')
      throw new HttpError(409, 'This request changed while it was being merged (it was edited, reviewed or withdrawn), so it was not merged.');
    latest.kgcl = p.kgcl;
    latest.privacyFindings = undefined;
    latest.mergedCommit = commit;
    latest.autoMergeBy = undefined;
    setStatus(latest, 'merged', `merged into the working draft${actor ? '' : ' automatically'}`, actor?.id);
    await stamp(latest);
  });
  if (project.stage === 'discovery') {
    project.stage = 'drafting';
    await updateProject(project);
  }
  await logActivity({ ontologyId: cr.ontologyId, actorId: actor?.id, type: 'cr.merged', message: `merged #${cr.number} ${cr.title} into the working draft`, link: `/o/${cr.ontologyId}/changes/${cr.id}` });
  return cr;
}

/** The draft moved on underneath this request: approvals given for the old draft no longer count, and it needs revising before it can be approved again. */
async function draftMovedOn(cr: ChangeRequest, why: string) {
  cr.opsUpdatedAt = clock.iso();
  cr.approvedAs = undefined;
  setStatus(cr, 'needs-work', `could not be merged on the latest draft: ${why}. Earlier approvals no longer count`);
  return await save(cr);
}

/** Whether governance's current outcome for an approved request takes the approval away. */
async function approvalLost(cr: ChangeRequest, outcome: ChangeRequestStatus) {
  if (outcome === 'needs-work' || outcome === 'rejected') return true;
  // Governance can't see a vote that already closed, so "voting" only counts if it never had one (e.g. a late objection under lazy consensus).
  return outcome === 'voting' && !(cr.approvedAs?.voted ?? await passedVote(cr));
}

/**
 * For requests approved before Concord recorded whether a vote approved them:
 * whether the last vote opened on them (since the edits last changed) passed.
 */
async function passedVote(cr: ChangeRequest): Promise<boolean> {
  const since = cr.opsUpdatedAt ?? cr.createdAt;
  const opened = [...cr.timeline].reverse().find((e) => e.type === 'status' && e.message.startsWith('vote opened') && e.at >= since);
  return !!opened && (await governanceFor({ ...cr, status: 'voting', statusSince: opened.at })).outcome === 'approved';
}

/** Why an approved request, just re-checked against the latest draft, can't be merged now (or undefined if it can). */
async function mergeBlocker(cr: ChangeRequest): Promise<{ status: ChangeRequestStatus; message: string } | undefined> {
  if (!validationPassed(cr.validation))
    return { status: 'needs-work', message: 'needs work: combined with the changes merged since it was approved, it fails validation (see the validation panel)' };
  const g = await governanceFor(cr);
  if (cr.approvedAs && await approvalLost(cr, g.outcome))
    return {
      status: g.outcome,
      message: g.outcome === 'rejected' ? 'rejected (vetoed)' : g.outcome === 'voting' ? `vote opened: ${g.next}` : `needs work — ${g.unmet[0] ?? ''}`,
    };
  const level = cr.classification?.level ?? 'minor';
  const was = cr.approvedAs;
  if (!was) {
    // Approved before Concord recorded what it was approved as: a vote that passed still stands; otherwise check it afresh, as if in review.
    if (await passedVote(cr)) return undefined;
    const fresh = await governanceFor({ ...cr, status: 'review' });
    return fresh.outcome === 'approved' ? undefined : { status: 'review', message: `back in review: on the latest draft it needs more than it was approved with (${fresh.unmet[0] ?? fresh.next})` };
  }
  const confirm = needsConfirmation(cr) && !was.confirmation;
  if (RANK[level] > RANK[was.level] || confirm)
    return {
      status: 'review',
      message: `back in review: on the latest draft this is a ${level} change${confirm ? ' that rewords a definition' : ''}, but it was approved as ${was.level}${was.confirmation ? '' : ' with no rewording'}`,
    };
  return undefined;
}

export function withdraw(cr: ChangeRequest, actor: User) {
  return locked(cr, async (c) => {
    if (c.authorId !== actor.id) await requireRole(c.ontologyId, actor, ['steward', 'owner'], 'withdraw someone else’s request');
    if (['merged', 'released'].includes(c.status)) throw new HttpError(409, 'Already merged');
    setStatus(c, 'withdrawn', 'withdrew this request', actor.id);
    return await save(c);
  });
}

export async function revise(cr: ChangeRequest, actor: User, instruction: string) {
  await canEdit(cr, actor);
  return withTriageBudget(actor, () => reviseNow(cr, actor, instruction));
}

async function reviseNow(cr: ChangeRequest, actor: User, instruction: string) {
  const basis = editsBasis(cr);
  const project = await getProject(cr.ontologyId);
  const working = await ontologyStore.working(project);
  const c = (iri: string) => compactIRI(iri, working.prefixes);
  const feedback = (await Promise.all((await reviewsFor(cr.id))
    .filter((r) => r.comment)
    .map(async (r) => `- ${(await getUser(r.userId))?.name ?? 'Reviewer'} (${r.decision}): ${r.comment}`)))
    .join('\n');
  const issues = cr.validation?.lint.filter((i) => i.severity !== 'info').map((i) => `- ${i.severity}: ${i.message}`).join('\n');
  const { value } = await llm.json<Proposal>({
    task: 'revise',
    system: `${REVISER}\n\n${UNTRUSTED_TEXT}`,
    schema: ProposalSchema,
    messages: [
      {
        role: 'user',
        content: `Ontology:\n${ontologyDigest(working)}\n\n${requestText(cr)}\n\nCurrent edits:\n${cr.ops.map((o) => `- ${describeOp(o, c)}`).join('\n')}\n\nReviewer feedback:\n${feedback || '(none)'}\n\nValidation issues:\n${issues || '(none)'}\n\nInstruction from ${actor.name}: ${instruction}\n\nReturn the complete revised set of edits (not just the differences).`,
      },
    ],
    fallback: () => {
      const h = heuristicProposal(working, instruction);
      return h.terms.length ? h : { ...h, terms: [] };
    },
  });
  const compiled = value.terms.length ? proposalToOps(working, value.terms, `change request #${cr.number}`) : { ops: cr.ops, warnings: ['The offline assistant could not revise these edits; please edit them directly.'] };
  // Written onto the latest stored request, and only if nobody changed the edits (or closed the request) meanwhile.
  return updateOpsNow(cr, actor, {
    ops: compiled.ops,
    basis,
    tests: value.competencyQuestionTests.length ? value.competencyQuestionTests : undefined,
    warnings: compiled.warnings,
    note: `AI revision requested by ${actor.name}: “${instruction}”. ${value.rationale}`,
  });
}

/** Periodic sweep: time-based transitions (review periods ending, votes closing). */
export async function tick(): Promise<number> {
  let changed = 0;
  for (const cr of (await list<ChangeRequest>('changeRequests')).filter((c) => ['review', 'voting', 'approved'].includes(c.status))) {
    const before = cr.status;
    const after = await advance(cr);
    if (after.status !== before) changed++;
  }
  return changed;
}

/**
 * Commits are authored by "Concord" (they're published), so for signed-in
 * users the history names whoever opened the change request each commit merged.
 */
export async function withRequesters<T extends { author: string; subject: string }>(ontologyId: string, log: T[]): Promise<T[]> {
  const crs = new Map((await list<ChangeRequest>('changeRequests', ontologyId)).map((c) => [c.number, c]));
  return (await Promise.all(log.map(async (e) => {
    const n = /^#(\d+)\b/.exec(e.subject)?.[1];
    const name = n ? (await getUser(crs.get(Number(n))?.authorId ?? ''))?.name : undefined;
    return name ? { ...e, author: name } : e;
  })));
}
