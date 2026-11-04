import { compactIRI, expandIRI, type OntologyGraph } from '@concord/core';
import type { TermView } from '@concord/core/types';
import type { Meeting, OntologyProject, PublicUseCase, Release, RequirementItem, RequirementsDocument, UseCase, User } from '@concord/shared';
import { clock } from '../clock.js';
import { get, HttpError, list, put } from '../db.js';
import { newId } from '../ids.js';
import { ontologyDigest } from '../llm/context.js';
import { REQUIREMENTS_WRITER } from '../llm/prompts.js';
import { llm } from '../llm/provider.js';
import { RequirementsDraftSchema, type RequirementsDraft } from '../llm/schemas.js';
import { getProject, mustFindProject } from './ontologies.js';
import { ontologyStore } from './ontologyStore.js';
import { changeRequestsFor } from './traceability.js';
import { allUseCases, canTriage, isGroupMember } from './useCases.js';
import { getUser, logActivity } from './users.js';

/**
 * Each release gets a "Use cases and requirements" document: the public use cases
 * told as one running story (the W3C Verifiable Credentials use cases note is the
 * model), every point linked back to its use cases, then the requirements and how
 * far that version meets them. Drafted when a release is drafted, frozen and
 * committed to git (USE_CASES.md) when it is published.
 *
 * Only public use cases, and anonymised synthetic versions of private ones, are
 * ever included. Working group and private use cases appear as counts only.
 */

/* ------------------------------------------------------------------------ */
/* Public view of use cases                                                  */
/* ------------------------------------------------------------------------ */

const isPublishable = (u: UseCase) => u.visibility === 'public' && !['draft', 'archived'].includes(u.status);

/** What a use case's status will be once a given set of change requests is released. */
function projectedStatus(u: UseCase, release?: { version: string; changeRequestIds: string[] }): { status: PublicUseCase['status']; coveredIn?: string } {
  const status = u.status as PublicUseCase['status'];
  if (u.status === 'closed') return { status, coveredIn: u.resolution?.version };
  if (release && ['accepted', 'in-progress', 'addressed'].includes(u.status)) {
    const live = changeRequestsFor(u).filter((c) => c.status !== 'rejected' && c.status !== 'withdrawn');
    if (live.length && live.every((c) => c.status === 'released' || release.changeRequestIds.includes(c.id))) return { status: 'closed', coveredIn: release.version };
  }
  return { status };
}

export function toPublic(u: UseCase, release?: { version: string; changeRequestIds: string[] }): PublicUseCase {
  const s = u.sections;
  const { status, coveredIn } = projectedStatus(u, release);
  const meeting = u.source === 'meeting' && u.sourceRef ? get<Meeting>('meetings', u.sourceRef) : undefined;
  const origin: PublicUseCase['origin'] = u.anonymous
    ? { kind: 'synthetic', label: 'Anonymised from a privately described use case' }
    : meeting
      ? { kind: 'meeting', label: `Raised in the working group call “${meeting.title}”`, date: meeting.createdAt.slice(0, 10), href: `/o/${u.ontologyId}/meetings/${meeting.id}` }
      : u.source === 'agent'
        ? { kind: 'agent', label: 'Reported by a coding agent' }
        : u.source === 'chat'
          ? { kind: 'interview', label: 'From a requirements interview', date: u.createdAt.slice(0, 10) }
          : { kind: 'form', label: 'Submitted by a participant', date: u.createdAt.slice(0, 10) };
  return {
    id: u.id,
    ref: `UC-${u.number}`,
    title: s.name || 'Untitled use case',
    goal: s.goal,
    description: s.description,
    actors: s.actors,
    scenarios: s.usageScenarios ?? [],
    competencyQuestions: u.competencyQuestions.map((q) => ({ question: q.question, ...(q.exampleAnswer ? { exampleAnswer: q.exampleAnswer } : {}) })),
    status,
    ...(coveredIn ? { coveredIn } : {}),
    sourceKind: u.anonymous ? 'synthetic' : u.source,
    anonymised: !!u.anonymous,
    ...(u.anonymous ? {} : { attribution: getUser(u.authorId)?.name }),
    origin,
  };
}

/** Public use cases of an ontology (public ones and anonymised versions only), oldest first. */
export function publicUseCases(ontologyId: string): PublicUseCase[] {
  const id = mustFindProject(ontologyId).id;
  return allUseCases(id)
    .filter(isPublishable)
    .sort((a, b) => a.number - b.number)
    .map((u) => toPublic(u));
}

/* ------------------------------------------------------------------------ */
/* Documents                                                                 */
/* ------------------------------------------------------------------------ */

const docs = (ontologyId: string) => list<RequirementsDocument>('requirementsDocs', ontologyId);
export const findDocument = (ontologyId: string, version: string) => docs(ontologyId).find((d) => d.version === version.replace(/^v/, ''));

/** For the public spec pages: the published document for a version, if there is one. */
export function requirementsDocument(ontologyId: string, version: string): RequirementsDocument | undefined {
  const p = mustFindProject(ontologyId);
  const d = findDocument(p.id, version);
  return d?.status === 'published' ? d : undefined;
}

/** Documents a viewer may read: published ones for anyone, drafts for the working group. */
export function listDocuments(ontologyId: string, viewer?: User) {
  const group = isGroupMember(ontologyId, viewer);
  return docs(ontologyId)
    .filter((d) => d.status === 'published' || group)
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
    .map(({ id, version, status, generatedAt, title, releaseId, coverage }) => ({ id, version, status, generatedAt, title, releaseId, coverage }));
}

export function documentFor(ontologyId: string, version: string, viewer?: User): RequirementsDocument {
  const d = findDocument(ontologyId, version);
  if (!d || (d.status !== 'published' && !isGroupMember(ontologyId, viewer))) throw new HttpError(404, `No use cases and requirements document for ${version}`);
  return d;
}

const CAST = ['Sam', 'Priti', 'Jordan', 'Ada', 'Kofi', 'Morgan', 'Lena', 'Ravi'];
const LOWERABLE = /^(A|An|The|This|That|These|Every|Each|Some|Many|Most|Our|We|They|People|Volunteers|Organisations|Let|Help|Make|Find|Publish|Record|Report|Show|Tell)\b/;
/** Lower-case a leading common word so a sentence can continue it (proper nouns are left alone). */
const lowerFirst = (s: string) => (LOWERABLE.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const stripDot = (s: string) => s.trim().replace(/[.!]+$/, '');

/** Offline stand-in: a simple running story with one fictional character per use case. */
export function heuristicDraft(project: OntologyProject, ucs: UseCase[], version: string, hidden: number, termLabels: Set<string>): RequirementsDraft {
  const requirements: RequirementsDraft['requirements'] = [];
  const seen = new Map<string, number>();
  const reqFor = (text: string, ref: string, terms: string[]) => {
    const key = text.toLowerCase().replace(/\W+/g, ' ').trim();
    let i = seen.get(key);
    if (i === undefined) {
      i = requirements.push({ text, useCaseRefs: [], terms: [] }) - 1;
      seen.set(key, i);
    }
    const r = requirements[i];
    if (!r.useCaseRefs.includes(ref)) r.useCaseRefs.push(ref);
    r.terms = [...new Set([...r.terms, ...terms])];
    return `R${i + 1}`;
  };
  const cast = ucs.map((_, i) => CAST[i % CAST.length]);
  const sections = ucs.map((u, i) => {
    const ref = `UC-${u.number}`;
    const who = cast[i];
    const s = u.sections;
    const terms = u.terms.map((t) => t.label).filter((l) => termLabels.has(l.toLowerCase()));
    const reqIds = [
      ...u.competencyQuestions.map((q) => reqFor(`It must be possible to answer: “${stripDot(q.question)}${q.question.trim().endsWith('?') ? '' : '?'}”`, ref, terms)),
      ...(s.requirements ? s.requirements.split(/\n+|;\s*/).filter((x) => x.trim().length > 8).map((x) => reqFor(stripDot(x.replace(/^[-*\d.)\s]+/, '')) + '.', ref, terms)) : []),
    ];
    const paras = [
      `${who}${s.actors ? ` works with ${lowerFirst(stripDot(s.actors.split(/[;(]/)[0]))} and` : ''} ${s.goal ? `wants to ${lowerFirst(stripDot(s.goal))}` : `needs to ${lowerFirst(stripDot(s.name ?? 'use this data'))}`} [${ref}].`,
      s.usageScenarios?.[0] && `Take a typical day: ${lowerFirst(stripDot(s.usageScenarios[0]))} [${ref}].${s.usageScenarios[1] ? ` Another time, ${lowerFirst(stripDot(s.usageScenarios[1]))}.` : ''}`,
      !s.usageScenarios?.length && s.description && `${stripDot(s.description)} [${ref}].`,
      u.competencyQuestions.length &&
        `To do that, ${who} needs the data to answer questions like ${u.competencyQuestions
          .slice(0, 3)
          .map((q) => `“${stripDot(q.question)}${q.question.trim().endsWith('?') ? '' : '?'}”`)
          .join(' and ')} ${reqIds
          .slice(0, 3)
          .map((r) => `[${r}]`)
          .join(', ')}.`,
    ].filter(Boolean);
    return { heading: s.name || ref, markdown: paras.join('\n\n'), useCaseRefs: [ref] };
  });
  const names = [...new Set(cast)];
  return {
    title: `${project.title}: use cases and requirements for ${version}`,
    intro: [
      `This note explains what **${project.title}** is for. It is drawn from the ${ucs.length} public use case${ucs.length === 1 ? '' : 's'} the working group has gathered${hidden ? `, and informed by ${hidden} more that are not published` : ''}.`,
      `Rather than list them one by one, it follows ${names.length === 1 ? 'one fictional person' : 'a few fictional people'}${names.length ? `, ${names.slice(0, -1).join(', ')}${names.length > 1 ? ' and ' : ''}${names.at(-1)},` : ''} through the situations the standard has to support. Each part of the story links to the use cases behind it, and the requirements at the end show how far version ${version} meets them.`,
    ].join(' '),
    sections,
    requirements,
  };
}

const refRe = /\[(UC-\d+)\](?!\()/g;
const reqRe = /\[(R\d+)\](?!\()/g;
function linkCitations(md: string, refToId: Map<string, string>, reqIds: Set<string>) {
  return md.replace(refRe, (m, ref) => (refToId.has(ref) ? `[${ref}](#uc-${refToId.get(ref)})` : ref)).replace(reqRe, (m, r) => (reqIds.has(r) ? `[${r}](#req-${r})` : r));
}

function termIndex(graph: OntologyGraph) {
  const v = graph.view();
  const all: TermView[] = [...v.classes, ...v.objectProperties, ...v.datatypeProperties, ...v.individuals];
  const byLabel = new Map<string, string>();
  for (const t of all) {
    if (t.label) byLabel.set(t.label.toLowerCase(), t.iri);
    byLabel.set(compactIRI(t.iri, v.prefixes).toLowerCase(), t.iri);
    byLabel.set((t.iri.split(/[#/]/).pop() ?? '').toLowerCase(), t.iri);
  }
  const resolve = (term: string) => {
    const k = term.trim().toLowerCase();
    if (byLabel.has(k)) return byLabel.get(k);
    try {
      const iri = expandIRI(term.trim(), v.prefixes);
      return all.some((t) => t.iri === iri) ? iri : undefined;
    } catch {
      return undefined;
    }
  };
  return { resolve, labels: new Set([...byLabel.keys()]) };
}

/** Recompute statuses (use cases, requirements, coverage) without rewriting the story. */
function refreshStatuses(doc: RequirementsDocument, release?: { version: string; changeRequestIds: string[] }) {
  const byId = new Map(allUseCases(doc.ontologyId).map((u) => [u.id, u]));
  doc.useCases = doc.useCases.map((pu) => {
    const u = byId.get(pu.id);
    return u && isPublishable(u) ? toPublic(u, release) : pu;
  });
  const status = new Map(doc.useCases.map((u) => [u.id, u.status]));
  doc.requirements = doc.requirements.map((r) => {
    const st = r.useCaseIds.map((id) => status.get(id));
    const met = st.length > 0 && st.every((s) => s === 'closed');
    const partial = st.some((s) => s === 'closed' || s === 'addressed');
    return { ...r, status: met ? 'met' : partial ? 'partial' : 'open' };
  });
  doc.coverage = {
    total: doc.useCases.length,
    closed: doc.useCases.filter((u) => u.status === 'closed').length,
    addressed: doc.useCases.filter((u) => u.status === 'addressed').length,
    open: doc.useCases.filter((u) => !['closed', 'addressed', 'deferred', 'out-of-scope'].includes(u.status)).length,
  };
  return doc;
}

/** Write (or rewrite) the document for a version. Editors, stewards and owners only, unless called by the platform. */
export async function generateRequirements(project: OntologyProject, opts: { version: string; release?: Release; actor?: User }): Promise<RequirementsDocument> {
  if (opts.actor && !canTriage(project.id, opts.actor)) throw new HttpError(403, 'Only editors, stewards and owners can write the use cases and requirements document');
  const existing = findDocument(project.id, opts.version);
  if (existing?.status === 'published') throw new HttpError(409, `The document for ${opts.version} is published and can no longer change`);
  const all = allUseCases(project.id);
  const ucs = all.filter((u) => isPublishable(u) && u.status !== 'out-of-scope').sort((a, b) => a.number - b.number);
  const unpublished = {
    group: all.filter((u) => u.visibility === 'group' && u.status !== 'archived').length,
    private: all.filter((u) => u.visibility === 'private' && u.status !== 'archived' && u.anonymisation?.status !== 'published').length,
  };
  const graph = await ontologyStore.working(project);
  const terms = termIndex(graph);
  const releaseLike = opts.release ? { version: opts.version, changeRequestIds: opts.release.changeRequestIds } : undefined;
  const pub = ucs.map((u) => toPublic(u, releaseLike));
  const refToId = new Map(ucs.map((u) => [`UC-${u.number}`, u.id]));

  const { value, simulated } = ucs.length
    ? await llm.json<RequirementsDraft>({
        task: 'requirements',
        system: REQUIREMENTS_WRITER,
        schema: RequirementsDraftSchema,
        effort: 'medium',
        maxTokens: 16000,
        messages: [
          {
            role: 'user',
            content: `Standard: ${project.title}${project.domain ? ` (domain: ${project.domain})` : ''}. ${project.description}\nVersion: ${opts.version}\n\nOntology terms:\n${ontologyDigest(graph, 200)}\n\nPublic use cases (cite as [UC-n]):\n\n${pub
              .map(
                (u) =>
                  `### ${u.ref}: ${u.title} (status at ${opts.version}: ${u.status})\nGoal: ${u.goal ?? '—'}\nActors: ${u.actors ?? '—'}\n${u.description ? `Description: ${u.description}\n` : ''}${u.scenarios.length ? `Scenarios:\n${u.scenarios.map((x) => `- ${x}`).join('\n')}\n` : ''}${u.competencyQuestions.length ? `Competency questions:\n${u.competencyQuestions.map((q) => `- ${q.question}${q.exampleAnswer ? ` (e.g. ${q.exampleAnswer})` : ''}`).join('\n')}` : ''}`,
              )
              .join('\n\n')}\n\n${unpublished.group + unpublished.private ? `${unpublished.group + unpublished.private} further use cases are not public; do not refer to their content.` : ''}`,
          },
        ],
        fallback: () => heuristicDraft(project, ucs, opts.version, unpublished.group + unpublished.private, terms.labels),
      })
    : { value: heuristicDraft(project, [], opts.version, unpublished.group + unpublished.private, terms.labels), simulated: true };

  const requirements: RequirementItem[] = value.requirements.map((r, i) => ({
    id: `R${i + 1}`,
    text: r.text,
    useCaseIds: r.useCaseRefs.map((ref) => refToId.get(ref.trim())).filter((x): x is string => !!x),
    termIris: [...new Set(r.terms.map(terms.resolve).filter((x): x is string => !!x))],
    status: 'open',
  }));
  const reqIds = new Set(requirements.map((r) => r.id));
  const doc: RequirementsDocument = {
    id: existing?.id ?? newId('reqdoc'),
    ontologyId: project.id,
    releaseId: opts.release?.id ?? existing?.releaseId,
    version: opts.version,
    title: value.title || `${project.title}: use cases and requirements`,
    status: 'draft',
    generatedAt: clock.iso(),
    simulated,
    intro: linkCitations(value.intro, refToId, reqIds),
    sections: value.sections.map((s, i) => ({
      id: `s${i + 1}`,
      heading: s.heading,
      markdown: linkCitations(s.markdown, refToId, reqIds),
      useCaseIds: [...new Set([...s.useCaseRefs.map((r) => refToId.get(r.trim())), ...[...s.markdown.matchAll(refRe)].map((m) => refToId.get(m[1]))].filter((x): x is string => !!x))],
    })),
    requirements,
    useCases: pub,
    unpublished,
    coverage: { total: 0, closed: 0, addressed: 0, open: 0 },
  };
  refreshStatuses(doc, releaseLike);
  put('requirementsDocs', doc, project.id);
  if (opts.actor)
    logActivity({ ontologyId: project.id, actorId: opts.actor.id, type: 'requirements.drafted', message: `drafted the use cases and requirements for ${opts.version}`, link: `/o/${project.id}/requirements/${opts.version}` });
  return doc;
}

/** Before a release is committed: make sure its document exists and reflects what the release closes. */
export async function prepareForRelease(project: OntologyProject, r: Release): Promise<RequirementsDocument | undefined> {
  try {
    const existing = findDocument(project.id, r.version);
    if (!existing || existing.status === 'published') return existing?.status === 'published' ? existing : await generateRequirements(project, { version: r.version, release: r });
    existing.releaseId = r.id;
    refreshStatuses(existing, { version: r.version, changeRequestIds: r.changeRequestIds });
    put('requirementsDocs', existing, project.id);
    return existing;
  } catch (err) {
    console.warn(`[requirements] could not prepare the document for ${r.version}: ${(err as Error).message}`);
    return undefined;
  }
}

/** After publishing: freeze the document. */
export function markPublished(doc: RequirementsDocument, r: Release) {
  doc.status = 'published';
  doc.releaseId = r.id;
  refreshStatuses(doc, { version: r.version, changeRequestIds: r.changeRequestIds });
  put('requirementsDocs', doc, doc.ontologyId);
  return doc;
}

/** Draft releases keep a draft document in step. Runs in the background; failures are logged. */
export function draftForRelease(r: Release) {
  void (async () => {
    try {
      const project = getProject(r.ontologyId);
      const d = findDocument(project.id, r.version);
      if (d?.status === 'published') return;
      if (d) {
        d.releaseId = r.id;
        refreshStatuses(d, { version: r.version, changeRequestIds: r.changeRequestIds });
        put('requirementsDocs', d, project.id);
      } else await generateRequirements(project, { version: r.version, release: r });
    } catch (err) {
      console.warn(`[requirements] background draft for ${r.version} failed: ${(err as Error).message}`);
    }
  })();
}

/** Markdown version, committed with each release as USE_CASES.md. */
export function renderMarkdown(doc: RequirementsDocument): string {
  const anchor = (u: PublicUseCase) => `<a id="uc-${u.id}"></a>`;
  const statusLine = (u: PublicUseCase) => (u.status === 'closed' ? `Covered${u.coveredIn ? ` in ${u.coveredIn}` : ''}` : u.status.replace('-', ' '));
  return [
    `# ${doc.title}`,
    '',
    doc.intro,
    '',
    ...doc.sections.flatMap((s) => [`## ${s.heading}`, '', s.markdown, '']),
    '## Requirements',
    '',
    '| | Requirement | Use cases | Status |',
    '|---|---|---|---|',
    ...doc.requirements.map(
      (r) =>
        `| <a id="req-${r.id}"></a>${r.id} | ${r.text.replace(/\|/g, '\\|')} | ${r.useCaseIds
          .map((id) => doc.useCases.find((u) => u.id === id))
          .filter(Boolean)
          .map((u) => `[${u!.ref}](#uc-${u!.id})`)
          .join(', ')} | ${r.status} |`,
    ),
    '',
    `## Use cases (${doc.coverage.closed} of ${doc.coverage.total} covered)`,
    '',
    ...doc.useCases.flatMap((u) => [
      `### ${anchor(u)}${u.ref}: ${u.title}`,
      '',
      `*${statusLine(u)}.* ${u.origin?.label ?? ''}${u.attribution ? `, described by ${u.attribution}` : ''}.`,
      '',
      u.goal ? `**Goal.** ${u.goal}\n` : '',
      u.actors ? `**Actors.** ${u.actors}\n` : '',
      ...(u.scenarios.length ? ['**Scenarios.**', '', ...u.scenarios.map((x) => `- ${x}`), ''] : []),
      ...(u.competencyQuestions.length ? ['**Competency questions.**', '', ...u.competencyQuestions.map((q) => `- ${q.question}${q.exampleAnswer ? ` (e.g. ${q.exampleAnswer})` : ''}`), ''] : []),
    ]),
    doc.unpublished.group + doc.unpublished.private ? `\n${doc.unpublished.group + doc.unpublished.private} further use cases informed this version but are not published.\n` : '',
  ].join('\n');
}
