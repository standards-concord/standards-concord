import type { OntologyProject } from '@concord/shared';
import { publicUseCases, releasingDocument, requirementsDocument, withdrawnSince } from '../services/requirements.js';

/**
 * What the public ontology page shows on its "Use cases and requirements" tab.
 *
 * The data comes from services/requirements.ts (sharing modes, anonymised
 * synthetic versions, the story document and per-release status). This file is
 * the single seam between that data and the public page. Whatever it returns is shown
 * to anyone on the internet, so it must only ever contain public use cases or
 * anonymised synthetic versions of private ones, never private or
 * working-group-only material.
 */

export type PublicUseCaseStatus =
  | 'proposed'
  | 'accepted'
  | 'addressed'
  | 'closed'
  | 'deferred'
  | 'out-of-scope'
  // Spellings the use case data may also use.
  | 'triage'
  | 'in-progress'
  | 'covered'
  | 'rejected';

export interface PublicUseCaseView {
  id: string;
  /** Short reference shown in the story, e.g. "UC-3". */
  ref: string;
  title: string;
  summary?: string;
  goal?: string;
  description?: string;
  actors?: string;
  scenarios?: string[];
  competencyQuestions?: (string | { question: string; exampleAnswer?: string })[];
  status: PublicUseCaseStatus | string;
  /** The version that addressed (or closed) the use case. */
  addressedIn?: string;
  /** Display name of the contributor. Omitted when anonymous. */
  attribution?: string;
  /** True for an anonymised synthetic version of a private use case. */
  anonymised?: boolean;
  origin?: { kind: 'meeting' | 'interview' | 'chat' | 'agent' | 'form' | 'synthetic' | string; label?: string; date?: string; href?: string };
}

export interface RequirementView {
  id: string;
  text: string;
  useCaseIds: string[];
  status: 'met' | 'partial' | 'open' | string;
  /** Ontology terms that meet it. */
  termIris?: string[];
}

export interface RequirementsDocumentView {
  title: string;
  version: string;
  generatedAt?: string;
  /** Either one markdown body, or an intro plus sections, or both. */
  intro?: string;
  markdown?: string;
  /** useCaseIds: the use cases each section draws on, kept so a section can be dropped if one is withdrawn. */
  sections?: { id: string; heading: string; markdown: string; useCaseIds?: string[] }[];
  requirements?: RequirementView[];
}

export interface PublishedRequirements {
  document?: RequirementsDocumentView;
  useCases: PublicUseCaseView[];
  /** A release whose snapshot is missing or unreadable: shown as such, never filled with current data. */
  snapshotMissing?: boolean;
  /** How many use cases recorded with this release have since been withdrawn (and, with what was written from them, are not shown). */
  withdrawn?: number;
}

/**
 * Structural views of RequirementsDocument and PublicUseCase in @concord/shared.
 */
interface SourceUseCase {
  id: string;
  ref: string;
  title: string;
  goal?: string;
  description?: string;
  actors?: string;
  scenarios?: string[];
  competencyQuestions?: { question: string; exampleAnswer?: string }[];
  status: string;
  coveredIn?: string;
  anonymised?: boolean;
  attribution?: string;
  origin?: { kind: string; label?: string; date?: string; href?: string };
}
interface SourceDocument {
  version: string;
  title: string;
  generatedAt?: string;
  intro?: string;
  sections?: { id: string; heading: string; markdown: string; useCaseIds?: string[] }[];
  requirements?: { id: string; text: string; useCaseIds: string[]; termIris?: string[]; status: string }[];
  useCases?: SourceUseCase[];
}

/**
 * Maps a published document and public use cases onto the page. In-app links (origin.href like /o/...) point at working group pages, so only
 * absolute links are kept for the public page.
 */
export function toPublishedRequirements(doc: SourceDocument | undefined, useCases: SourceUseCase[]): PublishedRequirements {
  return {
    document: doc && {
      title: doc.title,
      version: doc.version,
      generatedAt: doc.generatedAt,
      intro: doc.intro,
      sections: doc.sections?.map((s) => ({ id: s.id, heading: s.heading, markdown: s.markdown, ...(s.useCaseIds ? { useCaseIds: s.useCaseIds } : {}) })),
      requirements: doc.requirements?.map((r) => ({ id: r.id, text: r.text, useCaseIds: r.useCaseIds, termIris: r.termIris, status: r.status })),
    },
    useCases: useCases.map((u) => ({
      id: u.id,
      ref: u.ref,
      title: u.title,
      goal: u.goal,
      description: u.description,
      actors: u.actors,
      scenarios: u.scenarios,
      competencyQuestions: u.competencyQuestions,
      status: u.status,
      addressedIn: u.coveredIn,
      anonymised: u.anonymised,
      attribution: u.anonymised ? undefined : u.attribution,
      origin: u.origin && { kind: u.origin.kind, label: u.origin.label, date: u.origin.date, href: u.origin.href && /^https?:/i.test(u.origin.href) ? u.origin.href : undefined },
    })),
  };
}

/**
 * What a version's public page shows. A released version shows its frozen
 * document, and the use cases as they stood at that release. The draft page has
 * no document (drafts are for the working group) and shows the public use cases
 * as they stand now. While a release is being published its document is
 * prepared but not yet frozen, so `releasing` lets the page written into the
 * release include it.
 */
export async function publishedRequirements(project: OntologyProject, version?: string, opts: { releasing?: boolean } = {}): Promise<PublishedRequirements> {
  const doc = version ? (opts.releasing ? await releasingDocument(project.id, version) : await requirementsDocument(project.id, version)) : undefined;
  return toPublishedRequirements(doc, doc?.useCases ?? await publicUseCases(project.id));
}

/**
 * What a release's page shows: the snapshot of its public use cases and
 * requirements (requirements.json) written when it was published, or
 * backfilled at startup for releases from before snapshots existed (see
 * refreshReleasePages). Later edits never rewrite a published version, and a
 * release without a readable snapshot says so instead of showing today's data
 * as its history.
 */
export async function requirementsFor(project: OntologyProject, raw: PublishedRequirements | undefined): Promise<PublishedRequirements> {
  const snapshot = validSnapshot(raw);
  if (!snapshot || snapshot.snapshotMissing) return { useCases: [], snapshotMissing: true };
  // A use case that may no longer be published (withdrawn, archived, made private or group-only) is no
  // longer shown, and neither is anything written from it: every requirement citing it, every section
  // drawing on it (or, in a snapshot that didn't record what sections draw on, every section), the
  // introduction and the written title (the copy on GitHub can't be recalled). Same rule as served()
  // in services/requirements.ts.
  const d = snapshot.document;
  const cited = [...snapshot.useCases.map((u) => u.id), ...(d?.requirements ?? []).flatMap((r) => r.useCaseIds), ...(d?.sections ?? []).flatMap((x) => x.useCaseIds ?? [])];
  const gone = await withdrawnSince(project.id, [...new Set(cited)]);
  const useCases = snapshot.useCases.filter((u) => !gone.has(u.id));
  if (!d || !gone.size) return { document: d, useCases, ...(gone.size ? { withdrawn: gone.size } : {}) };
  const citesGone = (md = '') => [...gone].some((id) => md.includes(`#uc-${id}`));
  return {
    document: {
      title: `${project.title}: use cases and requirements for ${d.version}`,
      version: d.version,
      generatedAt: d.generatedAt,
      sections: d.sections?.filter((x) => x.useCaseIds && !x.useCaseIds.some((id) => gone.has(id)) && !citesGone(x.markdown)),
      requirements: d.requirements?.filter((r) => !r.useCaseIds.some((id) => gone.has(id))),
    },
    useCases,
    withdrawn: gone.size,
  };
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const optStr = (v: unknown) => v === undefined || isStr(v);
const strList = (v: unknown) => v === undefined || (Array.isArray(v) && v.every(isStr));
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The snapshot if every part of it has the shape the page renders, otherwise undefined (treated as unreadable). */
export function validSnapshot(x: unknown): PublishedRequirements | undefined {
  if (!isObj(x) || !Array.isArray(x.useCases)) return undefined;
  const useCaseOk = (u: unknown) =>
    isObj(u) &&
    isStr(u.id) &&
    isStr(u.ref) &&
    isStr(u.title) &&
    isStr(u.status) &&
    ['summary', 'goal', 'description', 'actors', 'addressedIn', 'attribution'].every((k) => optStr(u[k])) &&
    (u.anonymised === undefined || typeof u.anonymised === 'boolean') &&
    strList(u.scenarios) &&
    (u.competencyQuestions === undefined || (Array.isArray(u.competencyQuestions) && u.competencyQuestions.every((q) => isStr(q) || (isObj(q) && isStr(q.question) && optStr(q.exampleAnswer))))) &&
    (u.origin === undefined || (isObj(u.origin) && isStr(u.origin.kind) && ['label', 'date', 'href'].every((k) => optStr((u.origin as Record<string, unknown>)[k]))));
  if (!x.useCases.every(useCaseOk)) return undefined;
  const d = x.document;
  if (d !== undefined) {
    if (!isObj(d) || !isStr(d.title) || !isStr(d.version) || !['generatedAt', 'intro', 'markdown'].every((k) => optStr(d[k]))) return undefined;
    if (d.sections !== undefined && !(Array.isArray(d.sections) && d.sections.every((sec) => isObj(sec) && isStr(sec.id) && isStr(sec.heading) && isStr(sec.markdown) && strList(sec.useCaseIds)))) return undefined;
    if (d.requirements !== undefined && !(Array.isArray(d.requirements) && d.requirements.every((r) => isObj(r) && isStr(r.id) && isStr(r.text) && isStr(r.status) && Array.isArray(r.useCaseIds) && r.useCaseIds.every(isStr) && strList(r.termIris)))) return undefined;
    if (d.unpublished !== undefined && !(isObj(d.unpublished) && typeof d.unpublished.group === 'number' && typeof d.unpublished.private === 'number')) return undefined;
  }
  return x as unknown as PublishedRequirements;
}
