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
import { get, HttpError, list, mustGet, put, transaction } from '../db.js';
import { newId } from '../ids.js';
import { ontologyDigest, requestText } from '../llm/context.js';
import { CHANGE_DRAFTER, REVISER, TRIAGE, UNTRUSTED_TEXT } from '../llm/prompts.js';
import { llm } from '../llm/provider.js';
import { AnalysisSchema, ProposalSchema, type Proposal } from '../llm/schemas.js';
import { evaluate } from './governance.js';
import { competencyTests, getProject, members, requireRole, rolesFor, updateProject } from './ontologies.js';
import { OWN_TEST, SOURCE_GONE, sourcesPublic, withConsentLock } from './useCases.js';
import { ontologyStore } from './ontologyStore.js';
import { describeOp, proposalToOps, toLocalName } from './proposals.js';
import { getUser, logActivity, publicUser } from './users.js';
import { syncUseCasesForCR } from './traceability.js';
import { createHash } from 'node:crypto';
import { findSecrets, secretsOf } from './redact.js';

const OPEN: ChangeRequestStatus[] = ['triage', 'review', 'voting', 'approved', 'needs-work'];

const ev = (type: TimelineEvent['type'], message: string, actorId?: string): TimelineEvent => ({ at: clock.iso(), type, message, actorId });

export const getCR = async (id: string) => await mustGet<ChangeRequest>('changeRequests', id);
export const listCRs = async (ontologyId: string) => (await list<ChangeRequest>('changeRequests', ontologyId)).sort((a, b) => b.number - a.number);
const save = async (cr: ChangeRequest) => {
  cr.updatedAt = clock.iso();
  return await put('changeRequests', cr, cr.ontologyId);
};

async function setStatus(cr: ChangeRequest, status: ChangeRequestStatus, message: string, actorId?: string) { return transaction(async () => {
  if (cr.status === status) return;
  cr.status = status;
  cr.statusSince = clock.iso();
  if (status === 'review') cr.reviewStartedAt = cr.statusSince;
  cr.timeline.push(ev('status', message, actorId));
  await syncUseCasesForCR(cr);
}); }

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
  /**
   * Wraps the moment the request is first stored: it must call `store()`, and may check first
   * (and refuse by throwing, in which case nothing is ever stored) and add to it after.
   */
  commit?: (cr: ChangeRequest, store: () => Promise<void>) => Promise<void>;
  /**
   * Runs in the same transaction that saves the change request, just before
   * it: throwing saves nothing. For steps that must happen exactly once with
   * the save, such as taking a public report off the queue.
   */
  atSave?: () => Promise<void> | void;
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
  const cr: ChangeRequest = {
    id: newId('cr'),
    number: 0,
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
  // Numbering and saving in one transaction, so two requests opened at once can't both take the same number.
  const store = async () => {
    await transaction(async () => {
      cr.number = (await list<ChangeRequest>('changeRequests', project.id)).reduce((m, c) => Math.max(m, c.number), 0) + 1;
      await input.atSave?.();
      await save(cr);
      await logActivity({ ontologyId: project.id, actorId: author.id, type: 'cr.created', message: `opened #${cr.number} ${cr.title}`, link: `/o/${project.id}/changes/${cr.id}` });
    });
  };
  if (input.commit) await input.commit(cr, store);
  else await store();
  await triage(cr);
  if (input.submit) await submit(cr, author);
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
  // The request's own tests are marked as such, so readers can tell them from use cases' questions.
  const cqs = [...await competencyTests(project.id), ...(tests ?? []).map((t) => ({ ...t, source: OWN_TEST }))];
  const validation = await validate(after, { cqs, reasoner: 'owl', fair: await fairContext(after.ontologyIRI) });
  return { before, after, diff, classification, validation, warnings };
}

function validationPassed(v: ValidationReport | undefined) {
  return !!v && v.passed;
}

export async function triage(cr: ChangeRequest): Promise<ChangeRequest> {
  const project = await getProject(cr.ontologyId);
  const author = await getUser(cr.authorId);
  // Works from the stored record and writes back only the fields triage owns, onto the record as it
  // is when the checks finish. Competency question results carry the use case each came from, and
  // readers see only those they may (visibleCQResults), so a withdrawal while this runs needs no redo.
  const fresh = async () => await get<ChangeRequest>('changeRequests', cr.id);
  /** Make `cr` exactly the stored record: fields it lacks are dropped too. */
  const become = (stored: ChangeRequest) => {
    for (const k of Object.keys(cr) as (keyof ChangeRequest)[]) delete cr[k];
    Object.assign(cr, structuredClone(stored));
  };
  // Triage works on stored requests only. One that has been discarded is never written back.
  const base = await fresh();
  if (!base) return cr;
  become(base);
  let event: ReturnType<typeof ev>;
  try {
    const p = await preview(project, cr.ops, cr.tests, author);
    cr.diff = trimDiff(p.diff);
    cr.classification = p.classification;
    cr.validation = p.validation;
    cr.warnings = [...new Set([...(cr.warnings ?? []), ...p.warnings])];
    cr.kgcl = toKGCL(cr.ops, p.after.prefixes);
    event = ev(
      'triaged',
      `Classified as ${p.classification.level.toUpperCase()} (${p.classification.reasons
        .filter((r) => r.level === p.classification.level)
        .map((r) => r.rule)
        .slice(0, 3)
        .join(', ')}). Validation ${p.validation.passed ? 'passed' : 'failed'}.`,
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
    event = ev('validated', message);
  }
  const owned = { diff: cr.diff, classification: cr.classification, validation: cr.validation, kgcl: cr.kgcl, warnings: cr.warnings, analysis: cr.analysis };
  const latest = await fresh();
  if (!latest) return cr;
  become(latest);
  Object.assign(cr, owned, { timeline: [...latest.timeline, event] });
  return await save(cr);
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
  });
}

export async function detail(cr: ChangeRequest): Promise<ChangeRequestDetail> {
  return { ...cr, reviews: await reviewsFor(cr.id), votes: await votesFor(cr.id), governance: await governanceFor(cr), author: publicUser(await getUser(cr.authorId)) };
}

export async function submit(cr: ChangeRequest, actor: User) {
  if (cr.authorId !== actor.id && !(await rolesFor(cr.ontologyId, actor.id)).some((r) => ['steward', 'editor', 'owner'].includes(r)))
    throw new HttpError(403, 'Only the author or an editor can submit this');
  if (!['draft', 'needs-work'].includes(cr.status)) throw new HttpError(409, `Cannot submit a request that is ${cr.status}`);
  if (!await sourcesPublic(cr)) throw new HttpError(409, SOURCE_GONE);
  await setStatus(cr, 'review', 'submitted for review', actor.id);
  await save(cr);
  return advance(cr);
}

export async function updateOps(cr: ChangeRequest, actor: User, patch: { title?: string; description?: string; ops?: ChangeOp[] }) {
  if (cr.authorId !== actor.id) await requireRole(cr.ontologyId, actor, ['editor', 'steward', 'owner'], 'edit this change request');
  if (['merged', 'released', 'rejected', 'withdrawn'].includes(cr.status)) throw new HttpError(409, `Cannot edit a ${cr.status} request`);
  // Checked as the edit is stored (no await before the save), so a withdrawal during an AI revision counts.
  if (!await sourcesPublic(cr)) throw new HttpError(409, SOURCE_GONE);
  // An approval of what it publishes covers exactly what was approved: a new title or new edits need a new one.
  if ((patch.title && patch.title !== cr.title) || patch.ops) cr.privacyCleared = undefined;
  if (patch.title) cr.title = patch.title;
  if (patch.description !== undefined) cr.description = patch.description;
  if (patch.ops) {
    cr.ops = patch.ops;
    cr.opsUpdatedAt = clock.iso();
    cr.timeline.push(ev('ops-updated', 'updated the proposed edits (earlier approvals no longer count)', actor.id));
    if (cr.status === 'voting' || cr.status === 'approved') await setStatus(cr, 'review', 'returned to review after the edits changed', actor.id);
  }
  await save(cr);
  await triage(cr);
  return advance(cr);
}

export async function addReview(cr: ChangeRequest, actor: User, decision: Review['decision'], comment?: string) {
  if (!OPEN.includes(cr.status) && decision !== 'comment') throw new HttpError(409, `This request is ${cr.status}`);
  const roles = await rolesFor(cr.ontologyId, actor.id);
  if (decision !== 'comment' && !roles.length) throw new HttpError(403, 'Only members of this ontology can review it');
  const review: Review = { id: newId('rev'), changeRequestId: cr.id, userId: actor.id, roles, decision, comment, at: clock.iso() };
  await put('reviews', review, cr.id);
  const verb = { approve: 'approved', 'request-changes': 'requested changes', object: 'objected', comment: 'commented' }[decision];
  cr.timeline.push(ev(decision === 'comment' ? 'comment' : 'review', `${verb}${comment ? `: “${comment}”` : ''}`, actor.id));
  await save(cr);
  await logActivity({ ontologyId: cr.ontologyId, actorId: actor.id, type: `cr.${decision}`, message: `${verb} on #${cr.number} ${cr.title}`, link: `/o/${cr.ontologyId}/changes/${cr.id}` });
  return advance(cr);
}

export async function addVote(cr: ChangeRequest, actor: User, choice: Vote['choice'], comment?: string) {
  if (cr.status !== 'voting') throw new HttpError(409, 'There is no open vote on this request');
  const g = await governanceFor(cr);
  const roles = await rolesFor(cr.ontologyId, actor.id);
  if (!g.rule.vote || !canCastVote(roles, g.rule.vote.voterRoles))
    throw new HttpError(403, `Only ${g.rule.vote?.voterRoles.join(' / ') ?? 'voters'} can vote on this`);
  const vote: Vote = { id: newId('vote'), subjectType: 'change-request', subjectId: cr.id, userId: actor.id, roles, choice, comment, at: clock.iso() };
  await put('votes', vote, cr.id);
  cr.timeline.push(ev('vote', `voted ${choice}${comment ? `: “${comment}”` : ''}`, actor.id));
  await save(cr);
  await logActivity({ ontologyId: cr.ontologyId, actorId: actor.id, type: 'cr.vote', message: `voted ${choice} on #${cr.number} ${cr.title}`, link: `/o/${cr.ontologyId}/changes/${cr.id}` });
  return advance(cr);
}

/** Re-evaluate governance and apply any transition it allows. Safe to call any time. */
export async function advance(cr: ChangeRequest): Promise<ChangeRequest> {
  // A request whose use case is no longer public stops where it is: it can't be approved into the ontology.
  if (OPEN.includes(cr.status) && !await sourcesPublic(cr)) {
    if (cr.status !== 'needs-work') {
      await setStatus(cr, 'needs-work', SOURCE_GONE);
      await save(cr);
    }
    return cr;
  }
  for (let i = 0; i < 4; i++) {
    if (!OPEN.includes(cr.status)) break;
    if (cr.status === 'triage') {
      await setStatus(cr, 'review', 'entered review');
      continue;
    }
    const g = await governanceFor(cr);
    if (g.outcome === cr.status) break;
    if (cr.status === 'approved') break;
    if (cr.status === 'needs-work' && g.outcome !== 'rejected') {
      // needs-work only leaves via an explicit resubmit/revision, or once the blockers clear
      if (g.outcome === 'needs-work') break;
      await setStatus(cr, 'review', 'blocking issues resolved; back in review');
      continue;
    }
    const messages: Partial<Record<ChangeRequestStatus, string>> = {
      voting: `vote opened (${g.next})`,
      approved: `approved — ${g.next}`,
      rejected: g.vetoedBy.length ? 'rejected (vetoed)' : 'rejected — the vote did not pass',
      'needs-work': `needs work — ${g.unmet[0] ?? ''}`,
      review: 'returned to review',
    };
    await setStatus(cr, g.outcome, messages[g.outcome] ?? g.outcome);
    await logActivity({ ontologyId: cr.ontologyId, type: `cr.${g.outcome}`, message: `#${cr.number} ${cr.title} → ${g.outcome}`, link: `/o/${cr.ontologyId}/changes/${cr.id}` });
  }
  await save(cr);
  if (cr.status === 'approved') {
    const g = await governanceFor(cr);
    if (g.rule.autoMerge) return merge(cr, undefined);
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
  const working = await ontologyStore.working(project);
  const base = ontologyStore.head(project);
  // No author: dcterms:contributor would publish the requester's name on every new term.
  const ctx = (date: string) => ({ date, source: `${project.slug}#${cr.number}` });
  const after = applyChangeOps(working, cr.ops, ctx(clock.iso().slice(0, 10))).graph;
  const added = diffOntologies(working, after).addedNTriples;
  const kgcl = toKGCL(cr.ops, after.prefixes);
  // The same edits applied with a stand-in date: what's approved doesn't change from one day to the next, but
  // any date someone wrote is part of it. The edits themselves and the draft they apply to are too.
  const dated = diffOntologies(working, applyChangeOps(working, cr.ops, ctx(DATE_STAND_IN)).graph).addedNTriples.sort();
  const fingerprint = createHash('sha256').update(JSON.stringify([cr.title, kgcl, dated, cr.ops, base])).digest('base64url');
  return { fingerprint, title: cr.title, kgcl, added, after };
}

/** For the editor approving it: what would be published, every statement in full, with what looks private highlighted. */
export async function publicationPreview(cr: ChangeRequest): Promise<Publication> {
  // Drafted from a use case that is no longer shared: what it would publish is no longer anyone's to read.
  if (!await sourcesPublic(cr)) throw new HttpError(409, SOURCE_GONE);
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
  if (cr.status !== 'draft' && !OPEN.includes(cr.status)) throw new HttpError(409, `This request is ${cr.status}`);
  if (typeof fingerprint !== 'string' || !fingerprint) throw new HttpError(400, 'Say which version you reviewed (its fingerprint)');
  if (!await sourcesPublic(cr)) throw new HttpError(409, SOURCE_GONE);
  const p = await publicationOf(cr);
  if (p.fingerprint !== fingerprint) throw new HttpError(409, 'This request changed after you reviewed it. Review what it publishes again.');
  cr.privacyCleared = { by: actor.id, at: clock.iso(), fingerprint, title: p.title, kgcl: p.kgcl };
  cr.timeline.push(ev('comment', 'approved exactly what this request publishes', actor.id));
  const held = cr.heldForPublication;
  cr.heldForPublication = undefined;
  cr.privacyFindings = undefined;
  if (held && cr.status === 'needs-work') {
    await setStatus(cr, 'approved', 'approved again once its publication was approved', actor.id);
    await save(cr);
    return merge(cr, actor);
  }
  return await save(cr);
}

/** Merge into the working draft. Re-applies the edits on the current head (a rebase). */
export async function merge(cr: ChangeRequest, actor: User | undefined): Promise<ChangeRequest> {
  if (actor) await requireRole(cr.ontologyId, actor, ['editor', 'steward', 'owner'], 'merge changes');
  const project = await getProject(cr.ontologyId);
  // From the consent check to the commit, no use case can be withdrawn (withdrawals wait), and the
  // request is the stored one at that moment: what goes into the ontology is what was consented to.
  const merged = await withConsentLock(cr.ontologyId, async () => {
    const stored = await get<ChangeRequest>('changeRequests', cr.id);
    if (!stored) throw new HttpError(404, `change request ${cr.id} not found`);
    for (const k of Object.keys(cr) as (keyof ChangeRequest)[]) delete cr[k];
    Object.assign(cr, stored);
    if (cr.status !== 'approved') throw new HttpError(409, `Only approved requests can be merged (this one is ${cr.status})`);
    if (!await sourcesPublic(cr)) {
      await setStatus(cr, 'needs-work', SOURCE_GONE);
      await save(cr);
      return false;
    }
    let p: Awaited<ReturnType<typeof publicationOf>>;
    try {
      p = await publicationOf(cr, project);
    } catch (err) {
      await setStatus(cr, 'needs-work', `could not be merged on the latest draft: ${(err as Error).message}`);
      await save(cr);
      return false;
    }
    // Drafted from use cases: published only as an editor approved it, byte for byte.
    if (needsPublicationApproval(cr) && cr.privacyCleared?.fingerprint !== p.fingerprint) {
      const pv = await publicationPreview(cr);
      cr.privacyFindings = [...pv.hints, ...pv.statements.filter((st) => st.hint).map((st) => ({ where: `${st.predicate} of ${st.subject}`, kind: st.hint! }))];
      cr.heldForPublication = true;
      cr.privacyCleared = undefined;
      await setStatus(cr, 'needs-work', 'held back before merging: it was drafted from use cases, so an editor must approve exactly what it publishes first.');
      await save(cr);
      return false;
    }
    cr.privacyFindings = undefined;
    // Commits are published with the ontology, so they carry no names: the change request records who asked.
    cr.kgcl = p.kgcl;
    cr.mergedCommit = await ontologyStore.commitWorking(project, p.after, `#${cr.number} ${p.title}\n\n${p.kgcl.join('\n')}`, { name: 'Concord' });
    await setStatus(cr, 'merged', `merged into the working draft${actor ? '' : ' automatically'}`, actor?.id);
    if (project.stage === 'discovery') {
      project.stage = 'drafting';
      await updateProject(project);
    }
    await save(cr);
    return true;
  });
  if (!merged) return cr;
  await logActivity({ ontologyId: cr.ontologyId, actorId: actor?.id, type: 'cr.merged', message: `merged #${cr.number} ${cr.title} into the working draft`, link: `/o/${cr.ontologyId}/changes/${cr.id}` });
  // Re-triage other open requests against the new head so their diffs stay accurate.
  for (const other of (await listCRs(cr.ontologyId)).filter((o) => o.id !== cr.id && ['review', 'voting', 'needs-work'].includes(o.status))) {
    await triage(other);
  }
  return cr;
}

export async function withdraw(cr: ChangeRequest, actor: User) {
  if (cr.authorId !== actor.id) await requireRole(cr.ontologyId, actor, ['steward', 'owner'], 'withdraw someone else’s request');
  if (['merged', 'released'].includes(cr.status)) throw new HttpError(409, 'Already merged');
  await setStatus(cr, 'withdrawn', 'withdrew this request', actor.id);
  return await save(cr);
}

export async function revise(cr: ChangeRequest, actor: User, instruction: string) {
  if (!await sourcesPublic(cr)) throw new HttpError(409, SOURCE_GONE);
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
  // Nothing is rewritten: a request drafted from use cases is published only once an editor approves exactly what it publishes.
  cr.timeline.push(ev('ai-analysis', `AI revision requested by ${actor.name}: “${instruction}”. ${value.rationale}`, actor.id));
  if (value.competencyQuestionTests.length) cr.tests = value.competencyQuestionTests;
  cr.warnings = compiled.warnings;
  return updateOps(cr, actor, { ops: compiled.ops });
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
