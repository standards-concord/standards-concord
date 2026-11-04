import * as z from 'zod';

/**
 * Schemas for structured LLM output. These are deliberately flatter than the
 * engine's ChangeOp union: the model proposes terms by label/CURIE and the
 * server resolves them to IRIs and compiles valid ChangeOps, so the model can
 * never emit malformed RDF.
 */

const str = z.string();
const opt = <T extends z.ZodType>(t: T) => t.optional();

export const SectionsSchema = z.object({
  name: opt(str),
  goal: opt(str),
  requirements: opt(str),
  scope: opt(str),
  priority: opt(str),
  stakeholders: opt(str),
  description: opt(str),
  actors: opt(str),
  preconditions: opt(str),
  postconditions: opt(str),
  triggers: opt(str),
  performance: opt(str),
  assumptions: opt(str),
  openIssues: opt(str),
  usageScenarios: opt(z.array(str)),
  basicFlow: opt(
    z.array(z.object({ step: z.number(), actorPerson: opt(str), actorSystem: opt(str), description: str })),
  ),
  alternateFlows: opt(
    z.array(
      z.object({
        title: str,
        steps: z.array(z.object({ step: z.number(), actorPerson: opt(str), actorSystem: opt(str), description: str })),
      }),
    ),
  ),
  dataSources: opt(z.array(z.object({ name: str, type: opt(str), description: opt(str), owner: opt(str), access: opt(str) }))),
  externalOntologies: opt(z.array(z.object({ name: str, language: opt(str), description: opt(str), source: opt(str) }))),
  references: opt(z.array(str)),
  notes: opt(str),
});

export const TermKind = z.enum(['class', 'objectProperty', 'datatypeProperty', 'individual']);

export const ElicitedTermSchema = z.object({
  label: str,
  kind: TermKind,
  definition: opt(str),
  evidence: opt(z.array(str)),
});

export const InterviewTurnSchema = z.object({
  reply: str.describe('Your next message to the participant (markdown allowed). One focused question.'),
  targets: z.array(str).describe('Template section keys this question targets, e.g. ["goal"] or ["competencyQuestions"].'),
  sectionUpdates: SectionsSchema.describe('Full new values for any sections you can now fill or improve. Omit unchanged sections.'),
  newCompetencyQuestions: z.array(z.object({ question: str, exampleAnswer: opt(str) })),
  newTerms: z.array(ElicitedTermSchema),
  done: z.boolean(),
});
export type InterviewTurn = z.infer<typeof InterviewTurnSchema>;

export const RestrictionSchema = z.object({
  property: str.describe('CURIE of an existing property, or localName of a property added in this proposal'),
  kind: z.enum(['some', 'only', 'min', 'max', 'exactly', 'value']),
  filler: opt(str).describe('CURIE/localName of a class, or an xsd datatype CURIE such as xsd:string'),
  cardinality: opt(z.number()),
});

export const ProposedTermSchema = z.object({
  action: z.enum(['add', 'update', 'deprecate']),
  kind: TermKind,
  /** For add: the new local name. For update/deprecate: CURIE of the existing term. */
  localName: opt(str),
  existing: opt(str).describe('CURIE of the existing term (update/deprecate only)'),
  label: opt(str),
  definition: opt(str),
  comment: opt(str),
  altLabels: opt(z.array(str)),
  superClasses: opt(z.array(str)),
  disjointWith: opt(z.array(str)),
  restrictions: opt(z.array(RestrictionSchema)),
  domain: opt(z.array(str)),
  range: opt(z.array(str)),
  characteristics: opt(z.array(z.enum(['functional', 'inverseFunctional', 'transitive', 'symmetric', 'asymmetric', 'reflexive', 'irreflexive']))),
  types: opt(z.array(str)).describe('For individuals: class CURIEs/localNames'),
  replacedBy: opt(str),
  reason: opt(str).describe('Why this change is needed; for deprecations, the reason recorded in the ontology'),
  evidence: opt(z.array(str)).describe('Use case names / quotes that motivate the change'),
});
export type ProposedTerm = z.infer<typeof ProposedTermSchema>;

export const CqTestSchema = z.object({
  question: str,
  sparql: str,
  exampleData: str.describe('Turtle example instance data used to test this question'),
});

export const ProposalSchema = z.object({
  title: str.describe('Short title for the change request, e.g. "Add shifts and skills needed for opportunities"'),
  summary: str,
  rationale: str,
  terms: z.array(ProposedTermSchema),
  competencyQuestionTests: z.array(CqTestSchema),
  conflicts: z.array(str).describe('Terminology conflicts between participants and how they were resolved'),
  risks: z.array(str),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export const AnalysisSchema = z.object({
  summary: str,
  recommendation: z.enum(['change-ontology', 'use-existing-terms', 'local-extension', 'needs-discussion']),
  existingTerms: z.array(str),
  rationale: str,
  risks: z.array(str),
  suggestedLevel: z.enum(['patch', 'minor', 'major']),
});

export const GapAnalysisSchema = AnalysisSchema.extend({
  terms: z.array(ProposedTermSchema).describe('Edits, only when recommendation is change-ontology'),
});

export const MeetingAnalysisSchema = z.object({
  summary: str,
  useCases: z.array(z.object({ title: str, speaker: opt(str), sections: SectionsSchema })),
  terms: z.array(ElicitedTermSchema),
  competencyQuestions: z.array(z.object({ question: str, askedBy: opt(str) })),
  disagreements: z.array(z.object({ topic: str, positions: z.array(z.object({ speaker: str, position: str })) })),
  openQuestions: z.array(str),
  decisions: z.array(str),
});

export const FacilitatorSchema = z.object({
  speak: z.boolean(),
  prompt: opt(str),
});

export const FeedbackTurnSchema = z.object({
  reply: str,
  answers: z
    .array(z.object({ questionId: str, value: str.describe('The answer; for multi-select, values separated by " | "') }))
    .describe('New or updated answers from the latest message'),
  nextQuestionId: opt(str),
  done: z.boolean(),
});

export const FeedbackSummarySchema = z.object({
  summary: str,
  themes: z.array(z.object({ theme: str, count: z.number() })),
});

export const PersonaActionSchema = z.object({
  decision: z.enum(['approve', 'request-changes', 'object', 'comment']),
  comment: str,
  vote: z.enum(['yes', 'no', 'abstain']),
});

export const QueryChatSchema = z.object({
  reply: str.describe('One to three plain sentences for a non-technical reader: what the query finds and any choice you made. No SPARQL here.'),
  query: str.describe('The complete SPARQL 1.1 query, with every PREFIX it uses declared at the top'),
  target: z.enum(['ontology', 'data']).describe('"data" when it asks about records (instances), "ontology" when it asks about the model itself'),
  columns: z.array(z.object({ variable: str.describe('A projected variable, without "?"'), label: str.describe('A short readable column heading') })),
});
