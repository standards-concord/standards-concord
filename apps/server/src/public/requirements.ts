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
  sections?: { id: string; heading: string; markdown: string }[];
  requirements?: RequirementView[];
}

export interface PublishedRequirements {
  document?: RequirementsDocumentView;
  useCases: PublicUseCaseView[];
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
  sections?: { id: string; heading: string; markdown: string }[];
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
      sections: doc.sections?.map((s) => ({ id: s.id, heading: s.heading, markdown: s.markdown })),
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
export function publishedRequirements(project: OntologyProject, version?: string, opts: { releasing?: boolean } = {}): PublishedRequirements {
  const doc = version ? (opts.releasing ? releasingDocument(project.id, version) : requirementsDocument(project.id, version)) : undefined;
  return toPublishedRequirements(doc, doc?.useCases ?? publicUseCases(project.id));
}

/**
 * What a release's page shows. Each release stores a snapshot of its public
 * use cases and requirements (requirements.json, written at publish time), so
 * later edits never rewrite a published version. Releases from before
 * snapshots existed, and the working draft, use the current data.
 */
export function requirementsFor(project: OntologyProject, version: string | undefined, snapshot: PublishedRequirements | undefined): PublishedRequirements {
  if (!snapshot) return publishedRequirements(project, version);
  // A use case withdrawn after the release is no longer shown, and neither is anything written from it:
  // the requirements that came only from it, the sections citing it, and the introduction (the
  // copy on GitHub can't be recalled). Same rule as served() in services/requirements.ts.
  const cited = [...snapshot.useCases.map((u) => u.id), ...(snapshot.document?.requirements ?? []).flatMap((r) => r.useCaseIds)];
  const gone = withdrawnSince(project.id, [...new Set(cited)]);
  if (!snapshot.document) return { document: publishedRequirements(project, version).document, useCases: snapshot.useCases.filter((u) => !gone.has(u.id)) };
  const d = snapshot.document;
  const citesGone = (md: string) => [...gone].some((id) => md.includes(`#uc-${id}`));
  return {
    document: !gone.size
      ? d
      : {
          ...d,
          intro: undefined,
          markdown: d.markdown && !citesGone(d.markdown) ? d.markdown : undefined,
          sections: d.sections?.filter((x) => !citesGone(x.markdown)),
          requirements: d.requirements
            ?.map((r) => ({ ...r, useCaseIds: r.useCaseIds.filter((id) => !gone.has(id)), original: r.useCaseIds.length }))
            .filter((r) => r.useCaseIds.length > 0 || r.original === 0)
            .map(({ original: _, ...r }) => r),
        },
    useCases: snapshot.useCases.filter((u) => !gone.has(u.id)),
  };
}
