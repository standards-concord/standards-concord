import type {
  ChatMessage,

  ElicitedTerm,
  InterviewSession,
  OntologyProject,
  UseCase,
  UseCaseSections,
  User,
} from '@concord/shared';
import { clock } from '../clock.js';
import { config } from '../config.js';
import { HttpError, list, mustGet, put } from '../db.js';
import { newId } from '../ids.js';
import { ontologyDigest, useCaseDigest } from '../llm/context.js';
import { INTERVIEWER, SYNTHESISER } from '../llm/prompts.js';
import { llm } from '../llm/provider.js';
import { InterviewTurnSchema, ProposalSchema, type InterviewTurn, type Proposal } from '../llm/schemas.js';
import { createChangeRequest } from './changeRequests.js';
import { getProject, rolesFor, setRoles } from './ontologies.js';
import { ontologyStore } from './ontologyStore.js';
import { proposalToOps, toLocalName } from './proposals.js';
import { solid, transcriptToTurtle } from './solid.js';
import { logActivity } from './users.js';
import { redactOps, redactText, secretsFor } from './redact.js';

/* ------------------------------------------------------------------------ */
/* Use cases                                                                 */
/* ------------------------------------------------------------------------ */

export const getUseCase = (id: string) => mustGet<UseCase>('useCases', id);
export const listUseCases = (ontologyId: string) =>
  list<UseCase>('useCases', ontologyId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

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
  return put('useCases', u, u.ontologyId);
}

export function createUseCase(
  project: OntologyProject,
  author: User,
  init: Partial<Pick<UseCase, 'sections' | 'competencyQuestions' | 'terms' | 'source' | 'sourceRef' | 'status'>>,
): UseCase {
  const now = clock.iso();
  // Anyone describing a use case becomes a contributor.
  if (!rolesFor(project.id, author.id).length) setRoles(project.id, author.id, ['contributor']);
  return saveUseCase({
    id: newId('uc'),
    ontologyId: project.id,
    authorId: author.id,
    source: init.source ?? 'chat',
    sourceRef: init.sourceRef,
    status: init.status ?? 'eliciting',
    sections: init.sections ?? {},
    competencyQuestions: init.competencyQuestions ?? [],
    terms: init.terms ?? [],
    completeness: 0,
    createdAt: now,
    updatedAt: now,
  });
}

export function updateUseCase(u: UseCase, actor: User, patch: Partial<Pick<UseCase, 'sections' | 'competencyQuestions' | 'status' | 'terms'>>) {
  if (u.authorId !== actor.id && !rolesFor(u.ontologyId, actor.id).some((r) => ['editor', 'steward', 'owner'].includes(r)))
    throw new HttpError(403, 'Only the author or an editor can change this use case');
  if (patch.sections) u.sections = { ...u.sections, ...patch.sections };
  if (patch.competencyQuestions) u.competencyQuestions = patch.competencyQuestions.map((q) => ({ ...q, id: q.id || newId('cq'), status: q.status ?? 'draft' }));
  if (patch.terms) u.terms = patch.terms;
  if (patch.status) u.status = patch.status;
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
      reply: `Thank you, that's really useful. Here's what I captured:\n\n- **Goal:** ${updates.goal ?? s.goal ?? '—'}\n- **Actors:** ${s.actors ?? '—'}\n- **Scenarios:** ${(s.usageScenarios ?? []).length}\n- **Competency questions:** ${q.map((x) => x.question).join(' / ') || '—'}\n\nYou can edit any of this in the use case panel. I'll pass it to the editors, who will use it to propose changes to the ontology.`,
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
  if (turn.done) {
    session.done = true;
    if (u.status === 'eliciting') u.status = 'ready';
  }
  saveUseCase(u);
  saveInterview(session);
  await persistTranscript(session, u);
  if (turn.done) logActivity({ ontologyId: project.id, actorId: user.id, type: 'usecase.ready', message: `described a use case: ${u.sections.name ?? 'untitled'}`, link: `/o/${project.id}/use-cases/${u.id}` });
  return { session, useCase: u };
}

export async function finishInterview(session: InterviewSession, user: User) {
  if (session.userId !== user.id) throw new HttpError(403, 'This interview belongs to someone else');
  const u = getUseCase(session.useCaseId);
  session.done = true;
  if (u.status === 'eliciting') u.status = 'ready';
  saveInterview(session);
  saveUseCase(u);
  logActivity({ ontologyId: session.ontologyId, actorId: user.id, type: 'usecase.ready', message: `described a use case: ${u.sections.name ?? 'untitled'}`, link: `/o/${session.ontologyId}/use-cases/${u.id}` });
  return { useCase: u };
}

/* ------------------------------------------------------------------------ */
/* Synthesis: use cases -> proposed change request                          */
/* ------------------------------------------------------------------------ */

export async function synthesise(project: OntologyProject, actor: User, useCaseIds?: string[]) {
  const ucs = (useCaseIds?.length ? useCaseIds.map(getUseCase) : listUseCases(project.id).filter((u) => u.status === 'ready')).filter(
    (u) => u.ontologyId === project.id,
  );
  if (!ucs.length) throw new HttpError(409, 'No use cases are ready to synthesise. Finish an interview or mark a use case as ready first.');
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
  // The ontology is published, but use cases may be private: its annotations
  // cite use cases only by their (sign-in only) link, never their title or
  // author, and the title (which reaches release notes) is redacted too.
  const secrets = secretsFor(ucs);
  const sources = ucs.map((u) => `${config.publicUrl}/o/${encodeURIComponent(project.slug)}/use-cases/${encodeURIComponent(u.id)}`);
  const redacted = redactOps(proposalToOps(graph, value.terms, sources).ops, secrets);
  const cr = await createChangeRequest(project, actor, {
    title: redactText(value.title, secrets),
    description: `${value.summary}\n\n**Rationale.** ${value.rationale}\n\nFrom use cases: ${ucs.map((u) => u.sections.name ?? u.id).join('; ')}${redacted.dropped.length ? `\n\n**Left out.** ${redacted.dropped.join(', ')}: the name would publish a use case title or a person's name, so add it by hand with a neutral name.` : ''}${value.conflicts.length ? `\n\n**Terminology conflicts.**\n${value.conflicts.map((c) => `- ${c}`).join('\n')}` : ''}`,
    kind: 'feature',
    origin: { type: 'synthesis', useCaseIds: ucs.map((u) => u.id) },
    ops: redacted.ops,
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
    u.status = 'synthesised';
    saveUseCase(u);
  }
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

