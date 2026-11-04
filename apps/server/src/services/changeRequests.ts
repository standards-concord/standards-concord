import {
  applyChangeOps,
  ChangeOpError,
  classifyChange,
  compactIRI,
  diffOntologies,
  toKGCL,
  validate,
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
  Review,
  TimelineEvent,
  User,
  Vote,
} from '@concord/shared';
import { clock } from '../clock.js';
import { get, HttpError, list, mustGet, put, putFenced, putIfFenced } from '../db.js';
import { newId } from '../ids.js';
import { ontologyDigest } from '../llm/context.js';
import { CHANGE_DRAFTER, REVISER, TRIAGE } from '../llm/prompts.js';
import { llm } from '../llm/provider.js';
import { AnalysisSchema, ProposalSchema, type Proposal } from '../llm/schemas.js';
import { evaluate } from './governance.js';
import { competencyTests, getProject, members, requireRole, rolesFor, updateProject } from './ontologies.js';
import { ontologyStore } from './ontologyStore.js';
import { describeOp, proposalToOps, toLocalName } from './proposals.js';
import { getUser, logActivity, publicUser } from './users.js';

const OPEN: ChangeRequestStatus[] = ['triage', 'review', 'voting', 'approved', 'needs-work'];

const ev = (type: TimelineEvent['type'], message: string, actorId?: string): TimelineEvent => ({ at: clock.iso(), type, message, actorId });

export const getCR = (id: string) => mustGet<ChangeRequest>('changeRequests', id);
export const listCRs = (ontologyId: string) => list<ChangeRequest>('changeRequests', ontologyId).sort((a, b) => b.number - a.number);
/**
 * Store a change request, only if nobody else has saved it since this copy
 * was read (a conditional write on `rev`, atomic across server processes), so
 * a slow writer (a long triage, a stalled proposal) can't put back an older
 * version over an edit someone else made. Also fenced: a fork proposal that
 * has lost its hold on the fork writes nothing. Every writer goes through here.
 *
 * A merge holds the request from its claim to its final save, and only the
 * merger (claimMerge) can save it meanwhile. Once the merge has recorded the
 * commit it is making, nobody can change the request until that merge is
 * finished, so a save that finds one finishes it first and then refuses this
 * (now out-of-date) copy.
 */
export function saveChangeRequest(cr: ChangeRequest, opts: { claimMerge?: boolean } = {}): ChangeRequest {
  if (!opts.claimMerge) {
    const stored = get<ChangeRequest>('changeRequests', cr.id);
    if (stored?.merging?.commit) {
      const outcome = settleMerge(stored);
      throw new HttpError(
        409,
        outcome === 'merged'
          ? `Change request #${cr.number} has just been merged, so it can't be changed any more.`
          : `Change request #${cr.number} was changed by someone else at the same time. Reload it and try again.`,
      );
    }
    if (stored?.merging && stored.merging.until > Date.now()) throw new HttpError(409, `Change request #${cr.number} is being merged right now. Try again in a moment.`);
    // A hold that ran out before its merge decided anything is void: don't carry it forward.
    if (cr.merging && !cr.merging.commit && cr.merging.until <= Date.now()) delete cr.merging;
  }
  const expected = cr.rev;
  const updatedAt = cr.updatedAt;
  cr.rev = (expected ?? 0) + 1;
  cr.updatedAt = clock.iso();
  const isNew = expected === undefined && !get<ChangeRequest>('changeRequests', cr.id);
  if (isNew) return putFenced('changeRequests', cr, cr.ontologyId);
  if (!putIfFenced('changeRequests', cr, 'rev', expected)) {
    cr.rev = expected;
    cr.updatedAt = updatedAt;
    throw new HttpError(409, `Change request #${cr.number} was changed by someone else at the same time. Reload it and try again.`);
  }
  return cr;
}
const save = saveChangeRequest;

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
}

export async function createChangeRequest(project: OntologyProject, author: User, input: CreateInput): Promise<ChangeRequest> {
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

  const now = clock.iso();
  const number = list<ChangeRequest>('changeRequests', project.id).reduce((m, c) => Math.max(m, c.number), 0) + 1;
  const cr: ChangeRequest = {
    id: newId('cr'),
    number,
    ontologyId: project.id,
    title: title || 'Untitled change',
    description: input.description,
    kind: input.kind,
    origin: input.origin,
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
    baseCommit: ontologyStore.head(project),
  };
  save(cr);
  logActivity({ ontologyId: project.id, actorId: author.id, type: 'cr.created', message: `opened #${cr.number} ${cr.title}`, link: `/o/${project.id}/changes/${cr.id}` });
  await triage(cr);
  if (input.submit) await submit(cr, author);
  return cr;
}

/** LLM drafts edits from a plain-language request; falls back to a simple parser. */
export async function draftFromNaturalLanguage(project: OntologyProject, working: OntologyGraph, text: string, kind: ChangeRequestKind) {
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
  const cqs = [...competencyTests(project.id), ...(tests ?? [])];
  const validation = await validate(after, { cqs, reasoner: 'owl', fair: await fairContext(after.ontologyIRI) });
  return { before, after, diff, classification, validation, warnings };
}

function validationPassed(v: ValidationReport | undefined) {
  return !!v && v.passed;
}

export async function triage(cr: ChangeRequest): Promise<ChangeRequest> {
  const project = getProject(cr.ontologyId);
  const author = getUser(cr.authorId);
  try {
    const p = await preview(project, cr.ops, cr.tests, author);
    cr.diff = trimDiff(p.diff);
    cr.classification = p.classification;
    cr.validation = p.validation;
    cr.warnings = [...new Set([...(cr.warnings ?? []), ...p.warnings])];
    cr.kgcl = toKGCL(cr.ops, p.after.prefixes);
    cr.timeline.push(
      ev(
        'triaged',
        `Classified as ${p.classification.level.toUpperCase()} (${p.classification.reasons
          .filter((r) => r.level === p.classification.level)
          .map((r) => r.rule)
          .slice(0, 3)
          .join(', ')}). Validation ${p.validation.passed ? 'passed' : 'failed'}.`,
      ),
    );
    if (project.governance.automation.autoTriage) cr.analysis = await analyse(project, cr, p.after);
  } catch (err) {
    const message = err instanceof ChangeOpError ? `Edit ${err.opIndex + 1} cannot be applied: ${err.message}` : (err as Error).message;
    cr.validation = {
      lint: [{ severity: 'error', code: 'change-not-applicable', message }],
      fair: { score: 0, checks: [], byPrinciple: { F: { passed: 0, total: 0, score: 0 }, A: { passed: 0, total: 0, score: 0 }, I: { passed: 0, total: 0, score: 0 }, R: { passed: 0, total: 0, score: 0 } } },
      reasoner: { engine: 'structural', available: false, consistent: true, unsatisfiable: [], inferredSubClassOf: [], durationMs: 0 },
      competencyQuestions: [],
      passed: false,
    };
    cr.timeline.push(ev('validated', message));
  }
  return save(cr);
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
    system: TRIAGE,
    schema: AnalysisSchema,
    effort: 'medium',
    messages: [
      {
        role: 'user',
        content: `Change request #${cr.number}: ${cr.title}\n${cr.description}\n\nEdits:\n${cr.ops.map((o) => `- ${describeOp(o, c)}`).join('\n')}\n\nRule-based classification: ${cr.classification?.level}\n${cr.classification?.reasons.map((r) => `- [${r.level}] ${r.rule}: ${r.message}`).join('\n')}\n\nValidation: ${v.passed ? 'passed' : 'FAILED'}; reasoner consistent=${v.reasoner.consistent}, unsatisfiable=${v.reasoner.unsatisfiable.map(c).join(', ') || 'none'}; lint errors: ${lintErrors.map((i) => i.message).join('; ') || 'none'}; FAIR ${Math.round(v.fair.score * 100)}%.\n\nOntology after the change:\n${ontologyDigest(after, 250)}`,
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

export const reviewsFor = (crId: string) => list<Review>('reviews', crId);
export const votesFor = (subjectId: string) => list<Vote>('votes', subjectId);

export function governanceFor(cr: ChangeRequest) {
  const project = getProject(cr.ontologyId);
  const since = cr.opsUpdatedAt ?? cr.createdAt;
  return evaluate({
    policy: project.governance,
    level: cr.classification?.level ?? 'minor',
    kind: 'change',
    status: cr.status,
    statusSince: cr.statusSince,
    reviewStartedAt: cr.reviewStartedAt ?? cr.statusSince,
    authorId: cr.authorId,
    reviews: reviewsFor(cr.id).filter((r) => r.at >= since),
    votes: votesFor(cr.id).filter((v) => v.at >= since),
    members: members(cr.ontologyId),
    validationOk: validationPassed(cr.validation),
    now: clock.now(),
  });
}

export function detail(cr: ChangeRequest): ChangeRequestDetail {
  return { ...cr, reviews: reviewsFor(cr.id), votes: votesFor(cr.id), governance: governanceFor(cr), author: publicUser(getUser(cr.authorId)) };
}

export async function submit(cr: ChangeRequest, actor: User) {
  if (cr.authorId !== actor.id && !rolesFor(cr.ontologyId, actor.id).some((r) => ['steward', 'editor', 'owner'].includes(r)))
    throw new HttpError(403, 'Only the author or an editor can submit this');
  if (!['draft', 'needs-work'].includes(cr.status)) throw new HttpError(409, `Cannot submit a request that is ${cr.status}`);
  setStatus(cr, 'review', 'submitted for review', actor.id);
  save(cr);
  return advance(cr);
}

export async function updateOps(cr: ChangeRequest, actor: User, patch: { title?: string; description?: string; ops?: ChangeOp[] }) {
  if (cr.authorId !== actor.id) requireRole(cr.ontologyId, actor, ['editor', 'steward', 'owner'], 'edit this change request');
  if (['merged', 'released', 'rejected', 'withdrawn'].includes(cr.status)) throw new HttpError(409, `Cannot edit a ${cr.status} request`);
  if (patch.title) cr.title = patch.title;
  if (patch.description !== undefined) cr.description = patch.description;
  if (patch.ops) {
    cr.ops = patch.ops;
    cr.opsUpdatedAt = clock.iso();
    cr.timeline.push(ev('ops-updated', 'updated the proposed edits (earlier approvals no longer count)', actor.id));
    if (cr.status === 'voting' || cr.status === 'approved') setStatus(cr, 'review', 'returned to review after the edits changed', actor.id);
  }
  save(cr);
  await triage(cr);
  return advance(cr);
}

export async function addReview(cr: ChangeRequest, actor: User, decision: Review['decision'], comment?: string) {
  if (!OPEN.includes(cr.status) && decision !== 'comment') throw new HttpError(409, `This request is ${cr.status}`);
  const roles = rolesFor(cr.ontologyId, actor.id);
  if (decision !== 'comment' && !roles.length) throw new HttpError(403, 'Only members of this ontology can review it');
  const review: Review = { id: newId('rev'), changeRequestId: cr.id, userId: actor.id, roles, decision, comment, at: clock.iso() };
  put('reviews', review, cr.id);
  const verb = { approve: 'approved', 'request-changes': 'requested changes', object: 'objected', comment: 'commented' }[decision];
  cr.timeline.push(ev(decision === 'comment' ? 'comment' : 'review', `${verb}${comment ? `: “${comment}”` : ''}`, actor.id));
  save(cr);
  logActivity({ ontologyId: cr.ontologyId, actorId: actor.id, type: `cr.${decision}`, message: `${verb} on #${cr.number} ${cr.title}`, link: `/o/${cr.ontologyId}/changes/${cr.id}` });
  return advance(cr);
}

export async function addVote(cr: ChangeRequest, actor: User, choice: Vote['choice'], comment?: string) {
  if (cr.status !== 'voting') throw new HttpError(409, 'There is no open vote on this request');
  const g = governanceFor(cr);
  const roles = rolesFor(cr.ontologyId, actor.id);
  if (!g.rule.vote || !roles.some((r) => g.rule.vote!.voterRoles.includes(r)))
    throw new HttpError(403, `Only ${g.rule.vote?.voterRoles.join(' / ') ?? 'voters'} can vote on this`);
  const vote: Vote = { id: newId('vote'), subjectType: 'change-request', subjectId: cr.id, userId: actor.id, roles, choice, comment, at: clock.iso() };
  put('votes', vote, cr.id);
  cr.timeline.push(ev('vote', `voted ${choice}${comment ? `: “${comment}”` : ''}`, actor.id));
  save(cr);
  logActivity({ ontologyId: cr.ontologyId, actorId: actor.id, type: 'cr.vote', message: `voted ${choice} on #${cr.number} ${cr.title}`, link: `/o/${cr.ontologyId}/changes/${cr.id}` });
  return advance(cr);
}

/** Re-evaluate governance and apply any transition it allows. Safe to call any time. */
export async function advance(cr: ChangeRequest): Promise<ChangeRequest> {
  for (let i = 0; i < 4; i++) {
    if (!OPEN.includes(cr.status)) break;
    if (cr.status === 'triage') {
      setStatus(cr, 'review', 'entered review');
      continue;
    }
    const g = governanceFor(cr);
    if (g.outcome === cr.status) break;
    if (cr.status === 'approved') break;
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
    setStatus(cr, g.outcome, messages[g.outcome] ?? g.outcome);
    logActivity({ ontologyId: cr.ontologyId, type: `cr.${g.outcome}`, message: `#${cr.number} ${cr.title} → ${g.outcome}`, link: `/o/${cr.ontologyId}/changes/${cr.id}` });
  }
  save(cr);
  if (cr.status === 'approved') {
    const g = governanceFor(cr);
    if (g.rule.autoMerge) return merge(cr, undefined);
  }
  return cr;
}

/** How long a merge may hold a request before deciding its commit; a merge whose process stopped stops blocking it after this. */
const MERGE_LEASE_MS = 2 * 60_000;

/**
 * Merge an approved request into the working draft. It's done so that a merge
 * either happens exactly once with the edits that were approved, or not at
 * all, even with several server processes and crashes in between:
 *
 * 1. Claim the request (a conditional save on its version: a stale copy is
 *    refused, and every other save is held off while the claim lasts).
 * 2. Apply the edits to the draft as it is at one exact commit, and write the
 *    resulting commit without moving the draft.
 * 3. Record that commit on the request, again conditionally: if anyone saved
 *    the request since the claim (say, after the claim ran out), this fails
 *    and the draft is never touched.
 * 4. Move the draft to the commit if it is still where the merge read it
 *    (settleMerge). From step 3 on anyone can do this, so a merge whose
 *    process stopped is finished by the next one to touch the request.
 */
export async function merge(cr: ChangeRequest, actor: User | undefined): Promise<ChangeRequest> {
  if (actor) requireRole(cr.ontologyId, actor, ['editor', 'steward', 'owner'], 'merge changes');
  const current = get<ChangeRequest>('changeRequests', cr.id);
  if (current?.merging?.commit) {
    // An earlier merge decided its commit and stopped: finish it rather than apply the edits twice.
    const outcome = settleMerge(current);
    adopt(cr, current);
    if (outcome === 'merged') {
      await retriageOthers(cr);
      return cr;
    }
  }
  if (cr.status !== 'approved') throw new HttpError(409, `Only approved requests can be merged (this one is ${cr.status})`);
  if (cr.merging && cr.merging.until > Date.now()) throw new HttpError(409, `Change request #${cr.number} is already being merged.`);
  cr.merging = { until: Date.now() + MERGE_LEASE_MS, by: actor?.id };
  save(cr, { claimMerge: true });
  const giveBack = () => {
    delete cr.merging;
    try {
      save(cr, { claimMerge: true });
    } catch {
      // Changed after the claim ran out: it's no longer this merge's to give back.
    }
  };
  const project = getProject(cr.ontologyId);
  const author = getUser(cr.authorId);
  try {
    const base = ontologyStore.head(project);
    const working = await ontologyStore.graphAt(project, base);
    let after: OntologyGraph;
    try {
      after = applyChangeOps(working, cr.ops, { author: author?.name, date: clock.iso().slice(0, 10), provenance: `${project.slug}#${cr.number}` }).graph;
    } catch (err) {
      delete cr.merging;
      setStatus(cr, 'needs-work', `could not be merged on the latest draft: ${(err as Error).message}`);
      return save(cr, { claimMerge: true });
    }
    const commit = await ontologyStore.prepareWorkingCommit(project, after, `#${cr.number} ${cr.title}\n\n${cr.kgcl?.join('\n') ?? ''}`, { name: author?.name ?? 'Concord' }, base);
    cr.merging = { ...cr.merging, commit, base };
    save(cr, { claimMerge: true });
  } catch (err) {
    if (!cr.merging?.commit || !get<ChangeRequest>('changeRequests', cr.id)?.merging?.commit) giveBack();
    throw err;
  }
  if (settleMerge(cr) !== 'merged') throw new HttpError(409, 'The working draft changed while this was being merged. Nothing was merged; try again.');
  await retriageOthers(cr);
  return cr;
}

/**
 * Finish a merge that has recorded its commit (any process can, any number of
 * times): if the commit is already in the draft, or the draft is still where
 * the merge read it and can be moved to it, record the merge; otherwise the
 * draft moved first, so give the claim back (the request stays approved).
 * Updates `cr` in place to what was stored.
 */
function settleMerge(cr: ChangeRequest): 'merged' | 'released' {
  const m = cr.merging;
  if (!m?.commit || !m.base) return cr.status === 'merged' ? 'merged' : 'released';
  const project = getProject(cr.ontologyId);
  if (!ontologyStore.inWorking(project, m.commit) && ontologyStore.head(project) === m.base) ontologyStore.advanceWorking(project, m.commit, m.base);
  const merged = ontologyStore.inWorking(project, m.commit);
  // A merge that stopped right after moving the branch never caught the checkout up.
  if (merged) ontologyStore.syncCheckout(project);
  const actorId = m.by;
  delete cr.merging;
  if (merged) {
    cr.mergedCommit = m.commit;
    setStatus(cr, 'merged', `merged into the working draft${actorId ? '' : ' automatically'}`, actorId);
  }
  try {
    save(cr, { claimMerge: true });
  } catch (err) {
    // Someone else settled it first: take what they stored.
    const stored = get<ChangeRequest>('changeRequests', cr.id);
    if (!stored || stored.merging?.commit) throw err;
    adopt(cr, stored);
    return stored.status === 'merged' ? 'merged' : 'released';
  }
  if (merged) {
    if (project.stage === 'discovery') {
      project.stage = 'drafting';
      updateProject(project);
    }
    logActivity({ ontologyId: cr.ontologyId, actorId, type: 'cr.merged', message: `merged #${cr.number} ${cr.title} into the working draft`, link: `/o/${cr.ontologyId}/changes/${cr.id}` });
  }
  return merged ? 'merged' : 'released';
}

/** Make `cr` exactly what was stored (dropping fields the stored copy no longer has, such as a finished merge's hold). */
function adopt(cr: ChangeRequest, stored: ChangeRequest) {
  for (const k of Object.keys(cr)) if (!(k in stored)) delete (cr as unknown as Record<string, unknown>)[k];
  Object.assign(cr, stored);
}

/** Re-triage other open requests against the new head so their diffs stay accurate. */
async function retriageOthers(cr: ChangeRequest) {
  for (const other of listCRs(cr.ontologyId).filter((o) => o.id !== cr.id && ['review', 'voting', 'needs-work'].includes(o.status))) {
    try {
      await triage(other);
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 409)) throw err;
    }
  }
}

export async function withdraw(cr: ChangeRequest, actor: User) {
  if (cr.authorId !== actor.id) requireRole(cr.ontologyId, actor, ['steward', 'owner'], 'withdraw someone else’s request');
  if (['merged', 'released'].includes(cr.status)) throw new HttpError(409, 'Already merged');
  setStatus(cr, 'withdrawn', 'withdrew this request', actor.id);
  return save(cr);
}

export async function revise(cr: ChangeRequest, actor: User, instruction: string) {
  const project = getProject(cr.ontologyId);
  const working = await ontologyStore.working(project);
  const c = (iri: string) => compactIRI(iri, working.prefixes);
  const feedback = reviewsFor(cr.id)
    .filter((r) => r.comment)
    .map((r) => `- ${getUser(r.userId)?.name ?? 'Reviewer'} (${r.decision}): ${r.comment}`)
    .join('\n');
  const issues = cr.validation?.lint.filter((i) => i.severity !== 'info').map((i) => `- ${i.severity}: ${i.message}`).join('\n');
  const { value } = await llm.json<Proposal>({
    task: 'revise',
    system: REVISER,
    schema: ProposalSchema,
    messages: [
      {
        role: 'user',
        content: `Ontology:\n${ontologyDigest(working)}\n\nChange request #${cr.number}: ${cr.title}\n${cr.description}\n\nCurrent edits:\n${cr.ops.map((o) => `- ${describeOp(o, c)}`).join('\n')}\n\nReviewer feedback:\n${feedback || '(none)'}\n\nValidation issues:\n${issues || '(none)'}\n\nInstruction from ${actor.name}: ${instruction}\n\nReturn the complete revised set of edits (not just the differences).`,
      },
    ],
    fallback: () => {
      const h = heuristicProposal(working, instruction);
      return h.terms.length ? h : { ...h, terms: [] };
    },
  });
  const compiled = value.terms.length ? proposalToOps(working, value.terms, `change request #${cr.number}`) : { ops: cr.ops, warnings: ['The offline assistant could not revise these edits; please edit them directly.'] };
  cr.timeline.push(ev('ai-analysis', `AI revision requested by ${actor.name}: “${instruction}”. ${value.rationale}`, actor.id));
  if (value.competencyQuestionTests.length) cr.tests = value.competencyQuestionTests;
  cr.warnings = compiled.warnings;
  return updateOps(cr, actor, { ops: compiled.ops });
}

/** Periodic sweep: time-based transitions (review periods ending, votes closing). */
export async function tick(): Promise<number> {
  let changed = 0;
  // Finish merges whose process stopped after deciding their commit.
  for (const cr of list<ChangeRequest>('changeRequests').filter((c) => c.merging?.commit)) {
    if (settleMerge(cr) === 'merged') {
      changed++;
      await retriageOthers(cr);
    }
  }
  for (const cr of list<ChangeRequest>('changeRequests').filter((c) => ['review', 'voting', 'approved'].includes(c.status))) {
    const before = cr.status;
    try {
      const after = await advance(cr);
      if (after.status !== before) changed++;
    } catch (err) {
      // Being merged or changed by someone else right now: the next sweep picks it up.
      if (!(err instanceof HttpError && err.status === 409)) throw err;
    }
  }
  return changed;
}
