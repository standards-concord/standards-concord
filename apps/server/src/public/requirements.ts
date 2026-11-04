import type { OntologyProject } from '@concord/shared';
import { aggregationCompetencyQuestions, AGGREGATION_USE_CASE, WEEKLY_SHIFTS_QUESTIONS, WEEKLY_SHIFTS_USE_CASE } from '../services/demoUseCases.js';
import { PERSONAS } from '../services/personas.js';

/**
 * What the public ontology page shows on its "Use cases and requirements" tab.
 *
 * The use case thread owns the real data (sharing modes, anonymised synthetic
 * versions, the synthesised story document and per-release status). This file
 * is the single seam between that data and the public page: replace the body
 * of `publishedRequirements` with the real source. Whatever it returns is shown
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
  /** Use cases that informed the version but aren't public (counts only). */
  unpublished?: { group: number; private: number };
}

export interface PublishedRequirements {
  document?: RequirementsDocumentView;
  useCases: PublicUseCaseView[];
  /** A release whose snapshot is missing or unreadable: shown as such, never filled with current data. */
  snapshotMissing?: boolean;
}

/**
 * Shapes of the use case thread's data (RequirementsDocument and PublicUseCase
 * in @concord/shared), kept structural so this file compiles before and after
 * that work merges.
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
  unpublished?: { group: number; private: number };
}

/**
 * Maps the use case thread's published document and public use cases onto the
 * page. Wire it up with:
 *   const doc = requirementsDocument(project.id, version);
 *   return toPublishedRequirements(doc, doc?.useCases ?? publicUseCases(project.id));
 * In-app links (origin.href like /o/...) point at working group pages, so only
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
      unpublished: doc.unpublished,
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

const personaName = (key: string) => PERSONAS.find((p) => p.key === key)?.name;

/**
 * Placeholder until use case sharing modes land: nothing for real ontologies
 * (no use case is marked public yet), and for the demo its fixed, fictional
 * seed content. It never reads use cases from the database, because testers
 * can sign in as a simulated persona and edit them.
 */
export function publishedRequirements(project: OntologyProject, _version?: string): PublishedRequirements {
  if (!project.demo) return { useCases: [] };
  const useCases: PublicUseCaseView[] = [];
  const cqs = aggregationCompetencyQuestions();
  if (cqs.length)
    useCases.push({
      id: 'demo-aggregation',
      ref: 'UC-1',
      title: AGGREGATION_USE_CASE.name!,
      goal: AGGREGATION_USE_CASE.goal,
      description: AGGREGATION_USE_CASE.description,
      actors: AGGREGATION_USE_CASE.actors,
      scenarios: AGGREGATION_USE_CASE.usageScenarios,
      competencyQuestions: cqs.map((q) => ({ question: q.question })),
      status: 'closed',
      addressedIn: '1.0.0',
      attribution: personaName('tom'),
      origin: { kind: 'form' },
    });
  useCases.push({
    id: 'demo-weekly-shifts',
    ref: `UC-${useCases.length + 1}`,
    title: WEEKLY_SHIFTS_USE_CASE.name!,
    goal: WEEKLY_SHIFTS_USE_CASE.goal,
    description: WEEKLY_SHIFTS_USE_CASE.description,
    actors: WEEKLY_SHIFTS_USE_CASE.actors,
    scenarios: WEEKLY_SHIFTS_USE_CASE.usageScenarios,
    competencyQuestions: WEEKLY_SHIFTS_QUESTIONS,
    status: 'accepted',
    attribution: personaName('aisha'),
    origin: { kind: 'interview' },
  });
  return { useCases };
}

/**
 * What a release's page shows: the snapshot of its public use cases and
 * requirements (requirements.json) written when it was published, or
 * backfilled at startup for releases from before snapshots existed (see
 * refreshReleasePages). Later edits never rewrite a published version, and a
 * release without a readable snapshot says so instead of showing today's data
 * as its history.
 */
export function requirementsFor(snapshot: PublishedRequirements | undefined): PublishedRequirements {
  if (!snapshot || !Array.isArray(snapshot.useCases)) return { useCases: [], snapshotMissing: true };
  return { document: snapshot.document, useCases: snapshot.useCases };
}
