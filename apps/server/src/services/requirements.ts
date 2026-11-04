import { compactIRI, expandIRI, type OntologyGraph } from '@concord/core';
import type { TermView } from '@concord/core/types';
import type { OntologyProject, PublicUseCase, Release, RequirementItem, RequirementsDocument, UseCase, User } from '@concord/shared';
import { useCaseLabel } from '@concord/shared';
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
import { allUseCases, canTriage, isGroupMember, onNoLongerPublic } from './useCases.js';
import { getUser, logActivity } from './users.js';

/**
 * Each release gets a "Use cases and requirements" document: the public use cases
 * told as one running story (the W3C Verifiable Credentials use cases note is the
 * model), every point linked back to its use cases, then the requirements and how
 * far that version meets them. Drafted when a release is drafted, frozen and
 * committed to git (USE_CASES.md) when it is published.
 *
 * Only public use cases, and anonymised synthetic versions of private ones, are
 * ever included. Working group members also see how many group-only use cases
 * informed it; private use cases are never counted. If a cited use case stops
 * being public (made private, withdrawn or archived), draft documents are
 * written again from scratch, and published ones stop showing it.
 */

/* ------------------------------------------------------------------------ */
/* Public view of use cases                                                  */
/* ------------------------------------------------------------------------ */

export const isPublishable = (u: UseCase) =>
  u.visibility === 'public' && !u.withdrawnAt && !['draft', 'archived'].includes(u.status) && (!!u.demoSeed || !getUser(u.authorId)?.simulated);

/** What a use case's status will be once a given set of change requests is released. */
function projectedStatus(u: UseCase, release?: { version: string; changeRequestIds: string[] }): { status: PublicUseCase['status']; coveredIn?: string } {
  const status = u.status as PublicUseCase['status'];
  if (u.status === 'closed') return { status, coveredIn: u.resolution?.version };
  if (release && ['accepted', 'in-progress', 'addressed'].includes(u.status)) {
    const all = changeRequestsFor(u);
    const live = all.filter((c) => c.status !== 'rejected' && c.status !== 'withdrawn');
    // As in traceability.ts: with a change dropped along the way, an editor decides whether it is covered.
    if (live.length && live.length === all.length && live.every((c) => c.status === 'released' || release.changeRequestIds.includes(c.id))) return { status: 'closed', coveredIn: release.version };
  }
  return { status };
}

/**
 * The only way to build a PublicUseCase. It refuses anything that is not public,
 * and copies an allowlist of fields. Anonymised versions carry no attribution
 * and no identifying origin. Meetings are working group business, so a meeting
 * is described without its title or a link.
 */
export function toPublic(u: UseCase, release?: { version: string; changeRequestIds: string[] }): PublicUseCase {
  if (!isPublishable(u)) throw new Error(`Use case ${u.id} is not public`);
  // A demo persona's use case is published as seeded, whatever testers have since typed into it.
  const s = u.demoSeed?.sections ?? u.sections;
  const questions = u.demoSeed?.competencyQuestions ?? u.competencyQuestions;
  const { status, coveredIn } = projectedStatus(u, release);
  const str = (x: unknown) => (typeof x === 'string' && x.trim() ? x : undefined);
  const base = {
    id: u.id,
    ref: useCaseLabel(u),
    title: str(s.name) ?? 'Untitled use case',
    goal: str(s.goal),
    description: str(s.description),
    actors: str(s.actors),
    scenarios: (s.usageScenarios ?? []).filter((x): x is string => typeof x === 'string'),
    competencyQuestions: questions.map((q) => ({ question: String(q.question), ...(str(q.exampleAnswer) ? { exampleAnswer: q.exampleAnswer } : {}) })),
    status,
    ...(coveredIn ? { coveredIn } : {}),
  };
  if (u.anonymous) return { ...base, sourceKind: 'synthetic', anonymised: true, origin: { kind: 'synthetic', label: 'Anonymised from a privately described use case' } };
  const day = u.createdAt.slice(0, 10);
  const origin =
    u.source === 'meeting'
      ? ({ kind: 'meeting', label: 'Raised in a working group call', date: day } as const)
      : u.source === 'agent'
        ? ({ kind: 'agent', label: 'Reported by a coding agent' } as const)
        : u.source === 'chat'
          ? ({ kind: 'interview', label: 'From a requirements interview', date: day } as const)
          : ({ kind: 'form', label: 'Submitted by a participant', date: day } as const);
  return { ...base, sourceKind: u.source, anonymised: false, attribution: getUser(u.authorId)?.name, origin };
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

/**
 * The only way a document leaves the server: built field by field. Published
 * documents are frozen, but if a use case they drew on was withdrawn (or is no
 * longer public) afterwards, nothing written from it is served: its snapshot,
 * the requirements that came only from it, every section that cites it, and the
 * introduction, which may summarise it. The note says so, and that the copy in
 * the released files on GitHub can't be recalled. The group-only count is for the group.
 */
function served(d: RequirementsDocument, viewer?: User): RequirementsDocument {
  const gone = withdrawnSince(d.ontologyId, [...new Set([...(d.sourceIds ?? []), ...d.useCases.map((u) => u.id)])]);
  const cites = (ids: string[], md = '') => ids.some((id) => gone.has(id)) || [...gone].some((id) => md.includes(`#uc-${id}`));
  const requirements = d.requirements
    .map((r) => ({ id: r.id, text: r.text, useCaseIds: r.useCaseIds.filter((id) => !gone.has(id)), termIris: r.termIris, ...(r.missingTerms?.length ? { missingTerms: r.missingTerms } : {}), status: r.status }))
    .filter((r, i) => r.useCaseIds.length > 0 || d.requirements[i].useCaseIds.length === 0);
  const useCases = d.useCases.filter((u) => !gone.has(u.id));
  const out: RequirementsDocument = {
    id: d.id,
    ontologyId: d.ontologyId,
    ...(d.releaseId ? { releaseId: d.releaseId } : {}),
    version: d.version,
    title: d.title,
    status: d.status,
    generatedAt: d.generatedAt,
    ...(d.simulated ? { simulated: true } : {}),
    intro: gone.size ? '' : d.intro,
    sections: d.sections.filter((x) => !cites(x.useCaseIds, x.markdown)).map((x) => ({ id: x.id, heading: x.heading, markdown: x.markdown, useCaseIds: x.useCaseIds })),
    requirements,
    useCases,
    ...(d.unpublished && isGroupMember(d.ontologyId, viewer) ? { unpublished: { group: d.unpublished.group } } : {}),
    coverage: gone.size ? coverageOf(useCases) : d.coverage,
  };
  if (gone.size)
    out.withdrawnNote = `${gone.size} use case${gone.size === 1 ? ' this document drew on was' : 's this document drew on were'} withdrawn by ${gone.size === 1 ? 'its author' : 'their authors'} after it was written, so the introduction and every part of the story citing ${gone.size === 1 ? 'it' : 'them'} are no longer shown. The copy in the released files on GitHub cannot be recalled.`;
  return out;
}

const coverageOf = (useCases: PublicUseCase[]) => ({
  total: useCases.length,
  closed: useCases.filter((u) => u.status === 'closed').length,
  addressed: useCases.filter((u) => u.status === 'addressed').length,
  open: useCases.filter((u) => !['closed', 'addressed', 'deferred', 'out-of-scope'].includes(u.status)).length,
});

/** Of these use case ids, the ones that are gone or no longer public (withdrawn, made private or group-only). */
export function withdrawnSince(ontologyId: string, ids: string[]): Set<string> {
  return new Set(
    ids.filter((id) => {
      const u = get<UseCase>('useCases', id);
      return !u || u.ontologyId !== ontologyId || !!u.withdrawnAt || u.visibility !== 'public';
    }),
  );
}

/**
 * True when a draft was invalidated, or any use case it was written from is no
 * longer public: it must be written again, not patched. Checked against every
 * source, not just the snapshots still in it.
 */
const isStale = (d: RequirementsDocument) => {
  if (d.invalidated) return true;
  const byId = new Map(allUseCases(d.ontologyId).map((u) => [u.id, u]));
  return [...new Set([...(d.sourceIds ?? []), ...d.useCases.map((u) => u.id)])].some((id) => { const u = byId.get(id); return !u || !isPublishable(u); });
};
const dependsOn = (d: RequirementsDocument, id: string) => (d.sourceIds ?? []).includes(id) || d.useCases.some((x) => x.id === id);

/** For the public spec pages: the published document for a version, if there is one. */
export function requirementsDocument(ontologyId: string, version: string): RequirementsDocument | undefined {
  const p = mustFindProject(ontologyId);
  const d = findDocument(p.id, version);
  return d?.status === 'published' ? served(d) : undefined;
}


/** While a release is being published: its prepared (not yet frozen) document, as the public will see it. */
export function releasingDocument(ontologyId: string, version: string): RequirementsDocument | undefined {
  const d = findDocument(ontologyId, version);
  return d && (d.status === 'published' || !isStale(d)) ? served(d) : undefined;
}

/** Documents a viewer may read: published ones for anyone, drafts for the working group. */
export function listDocuments(ontologyId: string, viewer?: User) {
  const group = isGroupMember(ontologyId, viewer);
  return docs(ontologyId)
    .filter((d) => d.status === 'published' || group)
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
    .map(({ id, version, status, generatedAt, title, releaseId, coverage }) => ({ id, version, status, generatedAt, title, releaseId, coverage }));
}

export async function documentFor(ontologyId: string, version: string, viewer?: User): Promise<RequirementsDocument> {
  let d = findDocument(ontologyId, version);
  if (!d || (d.status !== 'published' && !isGroupMember(ontologyId, viewer))) throw new HttpError(404, `No use cases and requirements document for ${version}`);
  // A draft that was invalidated, or depends on a use case which is no longer public, is written again before anyone reads it.
  if (d.status === 'draft' && isStale(d)) {
    const release = d.releaseId ? get<Release>('releases', d.releaseId) : undefined;
    d = await generateRequirements(getProject(ontologyId), { version: d.version, release });
  }
  return served(d, viewer);
}

/**
 * When a use case stops being public: empty every draft document written from
 * it, keeping only what is needed to write it again (on the next read, release
 * draft or publish). Its questions also leave saved validation results; see onNoLongerPublic.
 */
onNoLongerPublic((u) => {
  for (const d of docs(u.ontologyId))
    if (d.status === 'draft' && dependsOn(d, u.id))
      put('requirementsDocs', { ...d, invalidated: true, intro: '', sections: [], requirements: [], useCases: [], sourceIds: [], coverage: coverageOf([]) } satisfies RequirementsDocument, d.ontologyId);
});

const CAST = ['Sam', 'Priti', 'Jordan', 'Ada', 'Kofi', 'Morgan', 'Lena', 'Ravi'];
const LOWERABLE = /^(A|An|The|This|That|These|Every|Each|Some|Many|Most|Our|We|They|People|Volunteers|Organisations|Let|Help|Make|Find|Publish|Record|Report|Show|Tell)\b/;
/** Lower-case a leading common word so a sentence can continue it (proper nouns are left alone). */
const lowerFirst = (s: string) => (LOWERABLE.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const stripDot = (s: string) => s.trim().replace(/[.!]+$/, '');

/** Offline stand-in: a simple running story with one fictional character per use case. */
export function heuristicDraft(project: OntologyProject, ucs: UseCase[], version: string, termLabels: Set<string>): RequirementsDraft {
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
    const ref = useCaseLabel(u);
    const who = cast[i];
    const s = u.sections;
    const terms = u.terms.map((t) => t.label).filter((l) => termLabels.has(l.toLowerCase()));
    // Terms a question mentions by name ("organisations" -> organisation), so a requirement can be checked against the graph.
    const mentioned = (q: string) => {
      const text = q.toLowerCase();
      return [...termLabels].filter((l) => l.length >= 4 && /^[a-z][a-z ]+$/.test(l) && new RegExp(`\\b${l.replace(/y$/, '(y|ie)')}s?\\b`).test(text));
    };
    const reqIds = [
      ...u.competencyQuestions.map((q) => reqFor(`It must be possible to answer: “${stripDot(q.question)}${q.question.trim().endsWith('?') ? '' : '?'}”`, ref, [...new Set([...terms, ...mentioned(q.question)])])),
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
      `This note explains what **${project.title}** is for. It is drawn from the ${ucs.length} public use case${ucs.length === 1 ? '' : 's'} the working group has gathered.`,
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

/** The IRIs of every term in a graph. */
const termIris = (graph: OntologyGraph) => {
  const v = graph.view();
  return new Set([...v.classes, ...v.objectProperties, ...v.datatypeProperties, ...v.individuals].map((t) => t.iri));
};

/**
 * Recompute statuses (use cases, requirements, coverage) without rewriting the
 * story. A requirement is met at a version only when its use cases are covered
 * and every term that meets it is in that version's graph: a closed use case is
 * history, not proof that a later version still supports it.
 * Callers check isStale first: a use case that is no longer public is never kept.
 */
function refreshStatuses(doc: RequirementsDocument, inGraph: Set<string>, release?: { version: string; changeRequestIds: string[] }) {
  const byId = new Map(allUseCases(doc.ontologyId).map((u) => [u.id, u]));
  doc.useCases = doc.useCases.flatMap((pu) => {
    const u = byId.get(pu.id);
    return u && isPublishable(u) ? [toPublic(u, release)] : [];
  });
  const status = new Map(doc.useCases.map((u) => [u.id, u.status]));
  doc.requirements = doc.requirements.map((r) => {
    const st = r.useCaseIds.map((id) => status.get(id));
    const termsThere = r.termIris.filter((iri) => inGraph.has(iri));
    const covered = st.length > 0 && st.every((s) => s === 'closed');
    const met = covered && r.termIris.length > 0 && termsThere.length === r.termIris.length && !r.missingTerms?.length;
    const partial = st.some((s) => s === 'closed' || s === 'addressed') || termsThere.length > 0;
    return { ...r, status: met ? 'met' : partial ? 'partial' : 'open' };
  });
  doc.coverage = coverageOf(doc.useCases);
  return doc;
}

/**
 * Write (or rewrite) the document for a version. Editors, stewards and owners
 * only, unless called by the platform. Writing takes a while: if a use case it
 * draws on stops being public meanwhile, the result is thrown away and written
 * again from what is public now.
 */
export async function generateRequirements(project: OntologyProject, opts: { version: string; release?: Release; actor?: User }): Promise<RequirementsDocument> {
  if (opts.actor && !canTriage(project.id, opts.actor)) throw new HttpError(403, 'Only editors, stewards and owners can write the use cases and requirements document');
  for (let attempt = 0; attempt < 3; attempt++) {
    const doc = await writeRequirements(project, opts);
    if (doc) return doc;
  }
  throw new HttpError(409, 'Use cases kept changing while the document was being written. Try again.');
}

async function writeRequirements(project: OntologyProject, opts: { version: string; release?: Release; actor?: User }): Promise<RequirementsDocument | undefined> {
  const existing = findDocument(project.id, opts.version);
  if (existing?.status === 'published') throw new HttpError(409, `The document for ${opts.version} is published and can no longer change`);
  const all = allUseCases(project.id);
  const ucs = all.filter((u) => isPublishable(u) && u.status !== 'out-of-scope').sort((a, b) => a.number - b.number);
  // Group members see how many group-only use cases informed it. Private ones are never counted.
  const unpublished = { group: all.filter((u) => u.visibility === 'group' && !u.withdrawnAt && u.status !== 'archived').length };
  const graph = await ontologyStore.working(project);
  const terms = termIndex(graph);
  const releaseLike = opts.release ? { version: opts.version, changeRequestIds: opts.release.changeRequestIds } : undefined;
  const pub = ucs.map((u) => toPublic(u, releaseLike));
  const refToId = new Map(ucs.map((u) => [useCaseLabel(u), u.id]));

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
              .join('\n\n')}\n\nUse only these use cases.`,
          },
        ],
        fallback: () => heuristicDraft(project, ucs, opts.version, terms.labels),
      })
    : { value: heuristicDraft(project, [], opts.version, terms.labels), simulated: true };

  const requirements: RequirementItem[] = value.requirements.map((r, i) => ({
    id: `R${i + 1}`,
    text: r.text,
    useCaseIds: r.useCaseRefs.map((ref) => refToId.get(ref.trim())).filter((x): x is string => !!x),
    termIris: [...new Set(r.terms.map(terms.resolve).filter((x): x is string => !!x))],
    // Terms that don't resolve are kept as missing, so the requirement can't count as met without them.
    missingTerms: [...new Set(r.terms.filter((t) => !terms.resolve(t)).map((t) => t.trim()).filter(Boolean))],
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
    sourceIds: ucs.map((u) => u.id),
    unpublished,
    coverage: coverageOf([]),
  };
  // Consent is checked again now the writing is done, and nothing below waits, so nothing can change before it is stored.
  if (isStale(doc)) return undefined;
  const latest = findDocument(project.id, opts.version);
  if (latest?.status === 'published') throw new HttpError(409, `The document for ${opts.version} is published and can no longer change`);
  refreshStatuses(doc, termIris(graph), releaseLike);
  put('requirementsDocs', doc, project.id);
  if (opts.actor)
    logActivity({ ontologyId: project.id, actorId: opts.actor.id, type: 'requirements.drafted', message: `drafted the use cases and requirements for ${opts.version}`, link: `/o/${project.id}/requirements/${opts.version}` });
  return doc;
}

/** Before a release is committed: make sure its document exists, is current, and reflects what the release closes. */
export async function prepareForRelease(project: OntologyProject, r: Release): Promise<RequirementsDocument | undefined> {
  try {
    const inGraph = termIris(await ontologyStore.working(project));
    // Read after the wait, and checked and stored with nothing in between.
    const existing = findDocument(project.id, r.version);
    if (existing?.status === 'published') return existing;
    // Consent is checked again here: a draft depending on anything no longer public is written again from scratch.
    if (!existing || isStale(existing)) return await generateRequirements(project, { version: r.version, release: r });
    existing.releaseId = r.id;
    refreshStatuses(existing, inGraph, { version: r.version, changeRequestIds: r.changeRequestIds });
    put('requirementsDocs', existing, project.id);
    return existing;
  } catch (err) {
    console.warn(`[requirements] could not prepare the document for ${r.version}: ${(err as Error).message}`);
    return undefined;
  }
}

/** After publishing: freeze the document. */
export async function markPublished(doc: RequirementsDocument, r: Release) {
  const project = getProject(doc.ontologyId);
  const inGraph = termIris(await ontologyStore.working(project));
  // Read again after the wait: a withdrawal meanwhile invalidates the stored draft.
  let current = findDocument(project.id, r.version) ?? doc;
  if (current.status === 'published') return current;
  if (isStale(current)) current = await generateRequirements(project, { version: r.version, release: r });
  current.status = 'published';
  current.releaseId = r.id;
  refreshStatuses(current, inGraph, { version: r.version, changeRequestIds: r.changeRequestIds });
  put('requirementsDocs', current, current.ontologyId);
  return current;
}

/** Draft releases keep a draft document in step. Runs in the background; failures are logged. */
export function draftForRelease(r: Release) {
  void (async () => {
    try {
      const project = getProject(r.ontologyId);
      const inGraph = termIris(await ontologyStore.working(project));
      const d = findDocument(project.id, r.version);
      if (d?.status === 'published') return;
      if (d && !isStale(d)) {
        d.releaseId = r.id;
        refreshStatuses(d, inGraph, { version: r.version, changeRequestIds: r.changeRequestIds });
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
    ...(doc.withdrawnNote ? [`> ${doc.withdrawnNote}`, ''] : []),
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
  ].join('\n');
}
