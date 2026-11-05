/**
 * Platform domain types and the HTTP API contract shared by server and web.
 * Ontology-level types come from @concord/core.
 */
import type {
  ChangeClassification,
  ChangeLevel,
  ChangeOp,
  OntologyDiff,
  OntologyView,
  OutputFormat,
  TermView,
  ValidationReport,
} from '@concord/core/types';

export type {
  ChangeClassification,
  ChangeLevel,
  ChangeOp,
  OntologyDiff,
  OntologyView,
  OutputFormat,
  TermView,
  ValidationReport,
};

/* ------------------------------------------------------------------------ */
/* People, identity, roles                                                   */
/* ------------------------------------------------------------------------ */

export type AuthProvider = 'google' | 'github' | 'demo';

export interface User {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string;
  /** Auto-provisioned WebID; users never need to know about it. */
  webId: string;
  podUrl?: string;
  providers: { provider: AuthProvider; subject: string }[];
  /** Demo/simulated personas are flagged so they can be filtered out. */
  simulated?: boolean;
  /** Short persona blurb for simulated users. */
  persona?: string;
  organisation?: string;
  isPlatformAdmin?: boolean;
  createdAt: string;
}

/**
 * Roles within one ontology's lifecycle. A person can hold several.
 * - owner: accountable for the ontology; can transfer ownership.
 * - steward: runs the process day to day (chair); can triage, cut releases.
 * - editor: can author changes and merge approved ones.
 * - reviewer: technical/ontological review of change requests.
 * - member: voting member of the community/working group.
 * - contributor: anyone who can propose use cases and changes.
 * - agent: an AI/coding agent acting for someone, via MCP.
 * - odi: ODI oversight role (privilege configured by policy).
 */
export type Role =
  | 'owner'
  | 'steward'
  | 'editor'
  | 'reviewer'
  | 'member'
  | 'contributor'
  | 'agent'
  | 'odi';

export const ROLE_INFO: Record<Role, { label: string; description: string }> = {
  owner: { label: 'Owner', description: 'Accountable for the ontology. Can change governance and transfer ownership.' },
  steward: { label: 'Steward', description: 'Runs the process day to day: triages requests, chairs votes, cuts releases.' },
  editor: { label: 'Editor', description: 'Authors and merges changes into the working draft.' },
  reviewer: { label: 'Reviewer', description: 'Reviews proposed changes for modelling quality.' },
  member: { label: 'Voting member', description: 'Votes on changes and releases that the policy puts to a vote.' },
  contributor: { label: 'Contributor', description: 'Describes use cases, reports bugs and proposes changes.' },
  agent: { label: 'Agent', description: 'An AI or coding agent acting for someone through the MCP connector.' },
  odi: { label: 'ODI oversight', description: 'Open Data Institute oversight; powers depend on the governance policy.' },
};

export interface Membership {
  ontologyId: string;
  userId: string;
  roles: Role[];
  addedAt: string;
}

/* ------------------------------------------------------------------------ */
/* Governance                                                                */
/* ------------------------------------------------------------------------ */

export interface ApprovalRule {
  /** Roles whose approvals count towards minApprovals. */
  approverRoles: Role[];
  minApprovals: number;
  /** If set, a vote of voterRoles is required as well as approvals. */
  vote?: {
    voterRoles: Role[];
    /** fraction of eligible voters who must cast a vote (0..1) */
    quorum: number;
    /** fraction of cast (non-abstain) votes that must be in favour (0..1) */
    threshold: number;
    /** voting window in days */
    durationDays: number;
  };
  /** Minimum days a request stays open for comment before it can be approved. */
  reviewPeriodDays: number;
  /** Lazy consensus: approved automatically once the review period ends with no objections. */
  lazyConsensus: boolean;
  /** Roles whose single 'object' (or reject) blocks the change. */
  vetoRoles: Role[];
  /** Merge automatically when approved (otherwise an editor merges). */
  autoMerge: boolean;
}

export interface GovernancePolicy {
  templateId: GovernanceTemplateId | 'custom';
  name: string;
  description: string;
  changes: Record<ChangeLevel, ApprovalRule>;
  /** Releases: how a new version is approved, by release level. */
  releases: Record<ChangeLevel, ApprovalRule>;
  ownership: {
    model: 'single' | 'group';
    transfer: 'owner-decides' | 'member-vote' | 'odi-approval';
  };
  odiPrivilege: 'none' | 'veto' | 'final-say';
  automation: {
    /** AI triage classifies and validates every request on arrival. */
    autoTriage: boolean;
    /** Automatically draft a release when approved changes accumulate. */
    autoDraftRelease: boolean;
    /** Nudge reviewers/voters when actions are pending. */
    reminders: boolean;
  };
  /** Changes failing validation (inconsistent ontology, lint errors) can never be approved. */
  requireValidation: boolean;
}

export type GovernanceTemplateId =
  | 'steward-led'
  | 'lazy-consensus'
  | 'working-group'
  | 'membership-vote'
  | 'odi-stewarded';

/* ------------------------------------------------------------------------ */
/* Ontology projects                                                         */
/* ------------------------------------------------------------------------ */

export type LifecycleStage = 'discovery' | 'drafting' | 'review' | 'released' | 'maintenance' | 'retired';

export interface OntologyProject {
  id: string;
  slug: string;
  title: string;
  description: string;
  namespace: string;
  prefix: string;
  ontologyIRI: string;
  stage: LifecycleStage;
  currentVersion: string; // latest released version, '0.0.0' if never released
  ownerIds: string[];
  governance: GovernancePolicy;
  github?: { repo: string; branch: string; path: string };
  createdAt: string;
  updatedAt: string;
  /** Domain the ontology covers, used to steer the interviewer. */
  domain?: string;
  /** Example demo project for alpha testers. */
  demo?: boolean;
}

export interface OntologySummary extends OntologyProject {
  stats: {
    classes: number;
    properties: number;
    individuals: number;
    useCases: number;
    openChangeRequests: number;
    releases: number;
    members: number;
  };
  health?: {
    passed: boolean;
    errors: number;
    warnings: number;
    fairScore: number;
    consistent: boolean;
    /** Checks that could not run, e.g. the OWL reasoner when only structural checks ran. Absent on older summaries. */
    incomplete?: string[];
    /** Which reasoner produced `consistent`; 'structural' means the OWL DL reasoner did not run. */
    reasoner?: string;
  };
}

/* ------------------------------------------------------------------------ */
/* Requirements: use cases (Kendall/OMG template), competency questions      */
/* ------------------------------------------------------------------------ */

export type UseCaseSource = 'chat' | 'meeting' | 'agent' | 'form';

/** Field keys follow Elisa Kendall's OE use case template sections. */
export interface UseCaseSections {
  name?: string;
  goal?: string;
  requirements?: string;
  scope?: string;
  priority?: string;
  stakeholders?: string;
  description?: string;
  actors?: string;
  preconditions?: string;
  postconditions?: string;
  triggers?: string;
  performance?: string;
  assumptions?: string;
  openIssues?: string;
  usageScenarios?: string[];
  basicFlow?: { step: number; actorPerson?: string; actorSystem?: string; description: string }[];
  alternateFlows?: { title: string; steps: { step: number; actorPerson?: string; actorSystem?: string; description: string }[] }[];
  dataSources?: { name: string; type?: string; description?: string; owner?: string; access?: string }[];
  externalOntologies?: { name: string; language?: string; description?: string; source?: string }[];
  references?: string[];
  notes?: string;
}

export const USE_CASE_SECTION_LABELS: Record<keyof UseCaseSections, string> = {
  name: 'Use case name',
  goal: 'Goal',
  requirements: 'Requirements',
  scope: 'Scope',
  priority: 'Priority',
  stakeholders: 'Stakeholders',
  description: 'Description',
  actors: 'Actors / interfaces',
  preconditions: 'Pre-conditions',
  postconditions: 'Post-conditions',
  triggers: 'Triggers',
  performance: 'Performance requirements',
  assumptions: 'Assumptions',
  openIssues: 'Open issues',
  usageScenarios: 'Usage scenarios',
  basicFlow: 'Basic flow of events',
  alternateFlows: 'Alternate flows',
  dataSources: 'Data sources',
  externalOntologies: 'External ontologies / vocabularies',
  references: 'References',
  notes: 'Notes',
};

export interface CompetencyQuestion {
  id: string;
  question: string;
  exampleAnswer?: string;
  /** SPARQL drafted by the platform to test the ontology answers it. */
  sparql?: string;
  /** Example instance data (Turtle) used to test the CQ. */
  exampleData?: string;
  status: 'draft' | 'answerable' | 'unanswerable' | 'untested';
  /** Terms the question needs. */
  terms?: string[];
}

export interface ElicitedTerm {
  label: string;
  kind: 'class' | 'objectProperty' | 'datatypeProperty' | 'individual';
  definition?: string;
  /** Exact quote(s) from the participant that introduced the term. */
  evidence?: string[];
  /** If the term maps to an existing ontology term. */
  existingIri?: string;
}

export interface UseCase {
  id: string;
  ontologyId: string;
  authorId: string;
  source: UseCaseSource;
  /** Meeting/session/agent report this came from. */
  sourceRef?: string;
  status: 'eliciting' | 'ready' | 'synthesised' | 'archived';
  sections: UseCaseSections;
  competencyQuestions: CompetencyQuestion[];
  terms: ElicitedTerm[];
  /** 0..1 completeness against the template, computed by the server. */
  completeness: number;
  /** Where the private interview transcript lives (Solid pod resource URL). */
  transcriptUrl?: string;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------------ */
/* Interview chat                                                            */
/* ------------------------------------------------------------------------ */

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  at: string;
  /** For assistant turns: which template section the question targets. */
  targets?: (keyof UseCaseSections | 'competencyQuestions' | 'terms')[];
}

export interface InterviewSession {
  id: string;
  ontologyId: string;
  useCaseId: string;
  userId: string;
  messages: ChatMessage[];
  /** Private storage location (Solid pod) for the transcript. */
  storage: { kind: 'solid' | 'local'; url: string };
  done: boolean;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------------ */
/* Meetings                                                                  */
/* ------------------------------------------------------------------------ */

export interface TranscriptLine {
  speaker: string;
  text: string;
  /** seconds from start */
  t?: number;
}

export interface MeetingAnalysis {
  summary: string;
  useCases: { title: string; speaker?: string; sections: UseCaseSections }[];
  terms: ElicitedTerm[];
  competencyQuestions: { question: string; askedBy?: string }[];
  disagreements: { topic: string; positions: { speaker: string; position: string }[] }[];
  openQuestions: string[];
  decisions: string[];
}

export interface Meeting {
  id: string;
  ontologyId: string;
  title: string;
  source: 'upload' | 'google-meet-bot' | 'simulation' | 'google-drive';
  /** Google Meet URL when a bot was invited. */
  meetingUrl?: string;
  bot?: { provider: 'recall' | 'simulated'; botId?: string; status: 'scheduled' | 'joining' | 'in-call' | 'done' | 'error'; error?: string };
  transcript: TranscriptLine[];
  /** Suggestions the co-lead bot made during the call (gaps, follow-up questions). */
  facilitatorPrompts: { at: string; t?: number; text: string; posted: boolean }[];
  analysis?: MeetingAnalysis;
  status: 'live' | 'processing' | 'analysed' | 'error';
  createdAt: string;
  createdBy: string;
}

/* ------------------------------------------------------------------------ */
/* Change requests and lifecycle                                             */
/* ------------------------------------------------------------------------ */

export type ChangeRequestKind = 'feature' | 'bug' | 'gap' | 'editorial' | 'deprecation';

/** Annotation fields that can be edited inline on a term's page. */
export const TERM_EDIT_FIELDS = ['label', 'definition', 'comment', 'altLabels', 'examples', 'editorialNote'] as const;
export type TermEditField = (typeof TERM_EDIT_FIELDS)[number];
export type TermEditValues = Partial<{ label: string; definition: string; comment: string; altLabels: string[]; examples: string[]; editorialNote: string }>;

/**
 * POST /api/ontologies/:id/term-edits. Opens an editorial change request with
 * the changed fields; nothing is written to the working draft until it is
 * approved and merged under the ontology's governance policy.
 */
export type TermEditInput = {
  termIri: string;
  /** New values for the fields being edited. An empty string or list removes the field. */
  set: TermEditValues;
  /** The values the editor started from, so a concurrent change is refused (409) rather than overwritten. */
  previous?: TermEditValues;
  /** Why the change is needed, for reviewers. */
  reason?: string;
  /**
   * Required when an existing definition is reworded: 'same-meaning' records the
   * author's confirmation that it still picks out the same things (patch);
   * 'new-meaning' declares a change of meaning, which is reviewed as major.
   */
  definitionIntent?: 'same-meaning' | 'new-meaning';
  /** Submit for review straight away; otherwise the request stays a draft for its author. */
  submit?: boolean;
};

export type ChangeRequestOrigin =
  | { type: 'chat'; useCaseId?: string }
  | { type: 'meeting'; meetingId: string }
  | { type: 'agent'; agentName?: string; reportId?: string }
  | { type: 'term-edit'; termIri: string }
  | { type: 'bug-report' }
  | { type: 'direct' }
  | { type: 'synthesis'; useCaseIds: string[] };

export type ChangeRequestStatus =
  | 'draft' // being drafted by its author
  | 'triage' // automated classification + validation running/needs triage
  | 'review' // open for review/comment
  | 'voting' // a vote is open
  | 'approved' // approved, waiting to be merged
  | 'merged' // in the working draft, waiting for release
  | 'released'
  | 'rejected'
  | 'withdrawn'
  | 'needs-work'; // validation failed or reviewers asked for changes

export interface Review {
  id: string;
  changeRequestId: string;
  userId: string;
  /** roles the reviewer held when they reviewed */
  roles: Role[];
  decision: 'approve' | 'request-changes' | 'object' | 'comment';
  comment?: string;
  at: string;
  /** For change requests: the review round it was given in, and its place in the request's order of decisions. */
  round?: number;
  seq?: number;
  /** In change request details: true when it no longer counts because a later round has started. */
  stale?: boolean;
}

export interface Vote {
  id: string;
  subjectType: 'change-request' | 'release' | 'ownership-transfer';
  subjectId: string;
  userId: string;
  roles: Role[];
  choice: 'yes' | 'no' | 'abstain';
  comment?: string;
  at: string;
  /** For change requests: the round and edits version it was cast on, and its place in the request's order of decisions. */
  round?: number;
  editsVersion?: number;
  seq?: number;
  /** In change request details: true when it no longer counts because the edits changed since. */
  stale?: boolean;
}

export interface TimelineEvent {
  at: string;
  actorId?: string;
  type:
    | 'created'
    | 'triaged'
    | 'validated'
    | 'status'
    | 'review'
    | 'vote'
    | 'comment'
    | 'merged'
    | 'released'
    | 'ai-analysis'
    | 'ops-updated'
    | 'reminder';
  message: string;
}

export interface GovernanceEvaluation {
  rule: ApprovalRule;
  level: ChangeLevel;
  approvals: number;
  requiredApprovals: number;
  reviewPeriodEndsAt: string;
  reviewPeriodOver: boolean;
  vote?: {
    open: boolean;
    opensAt?: string;
    closesAt?: string;
    eligible: number;
    cast: number;
    yes: number;
    no: number;
    abstain: number;
    quorumMet: boolean;
    thresholdMet: boolean;
  };
  vetoedBy: string[];
  validationOk: boolean;
  /** What would be the next status if evaluated now. */
  outcome: ChangeRequestStatus;
  /** Human-readable remaining conditions. */
  unmet: string[];
  /** Human-readable next step. */
  next: string;
}

export interface AiAnalysis {
  summary: string;
  /** Does the ontology need changing, or is it a usage problem? (agent gap reports) */
  recommendation?: 'change-ontology' | 'use-existing-terms' | 'local-extension' | 'needs-discussion';
  /** Existing terms that already cover the need. */
  existingTerms?: string[];
  rationale: string;
  risks?: string[];
  /** Suggested level, can differ from the rule-based one (rules win). */
  suggestedLevel?: ChangeLevel;
}

export interface ChangeRequest {
  id: string;
  number: number; // per-ontology sequence, shown as #12
  ontologyId: string;
  title: string;
  description: string;
  kind: ChangeRequestKind;
  origin: ChangeRequestOrigin;
  /**
   * A level a person declared for this change, which classification can raise
   * to but never lower (e.g. an author saying a new definition changes what a
   * term means). Re-applied every time the request is triaged.
   */
  declaredLevel?: { level: ChangeLevel; rule: string; message: string; iri?: string };
  /** People other than the author who rewrote the edits; like the author, they can't give the independent approval. */
  revisedBy?: string[];
  /**
   * What the request was approved as. If, re-checked against the draft at merge
   * time, it is a bigger change than this (or now rewords a definition), it goes
   * back to review instead of merging.
   */
  approvedAs?: { level: ChangeLevel; confirmation: boolean; voted?: boolean };
  /** Whose action approved it for an automatic merge that is waiting for their triage budget; the merge is charged to them. */
  autoMergeBy?: string;
  /** Bumped on every write; a merge only lands if the revision it checked is still current. */
  rev?: number;
  /**
   * Review round, from 1. It moves on when the author resubmits or the edits change, and reviews only
   * count in the round they were given in (like GitHub dismissing stale reviews). Objections are the
   * exception: they stand until the objector changes their review. Decisions name the round they were
   * made on, and one made on an older round is refused.
   */
  round?: number;
  /** Version of the edits, from 1; moves on only when the edits really change. Votes count for the version they were cast on. */
  editsVersion?: number;
  /** Last sequence number given to a review or vote of this request; they are ordered by it, not by the clock. */
  decisionSeq?: number;
  authorId: string;
  ops: ChangeOp[];
  status: ChangeRequestStatus;
  classification?: ChangeClassification;
  diff?: OntologyDiff;
  validation?: ValidationReport;
  analysis?: AiAnalysis;
  /** The working draft version this was based on (git commit). */
  baseCommit?: string;
  mergedCommit?: string;
  releaseId?: string;
  timeline: TimelineEvent[];
  createdAt: string;
  updatedAt: string;
  /** Status entered at — used for review period / vote windows */
  statusSince: string;
  /** When the request entered review (review period is measured from here). */
  reviewStartedAt?: string;
  /** When the proposed edits last changed; reviews before this no longer count. */
  opsUpdatedAt?: string;
  /** Competency-question tests that came with the proposal. */
  tests?: { question: string; sparql: string; exampleData?: string }[];
  /** Notes from compiling the proposal (e.g. unresolved term references). */
  warnings?: string[];
  /** KGCL-style change lines, for people used to ontology change languages. */
  kgcl?: string[];
}

export interface ChangeRequestDetail extends ChangeRequest {
  reviews: Review[];
  votes: Vote[];
  governance: GovernanceEvaluation;
  author?: Pick<User, 'id' | 'name' | 'avatarUrl' | 'simulated'>;
}

export interface Release {
  id: string;
  ontologyId: string;
  version: string;
  level: ChangeLevel;
  status: 'draft' | 'voting' | 'published' | 'rejected';
  changeRequestIds: string[];
  notes: string;
  versionIRI: string;
  commit?: string;
  githubUrl?: string;
  createdBy: string;
  createdAt: string;
  publishedAt?: string;
  statusSince: string;
  /** Bumped on every write; a write from a copy at an older revision is refused. */
  rev?: number;
}

export interface ReleaseDetail extends Release {
  votes: Vote[];
  governance: GovernanceEvaluation;
  changeRequests: Pick<ChangeRequest, 'id' | 'number' | 'title' | 'classification'>[];
}

/* ------------------------------------------------------------------------ */
/* Agents (MCP) and agent reports                                            */
/* ------------------------------------------------------------------------ */

/** What the consent page shows when an MCP client asks to connect (GET /api/oauth/requests/:id). */
export interface OAuthRequestInfo {
  id: string;
  clientName: string;
  /** Name, website and logo come from the app itself and are not checked. */
  clientUri?: string;
  logoUri?: string;
  /** For apps identified by a metadata document URL: the host that published it, which Concord did check. */
  publisher?: string;
  /** Where the person is sent back to, e.g. localhost:33418 for Claude Code; for a native app, its link scheme (com.example.app:). */
  redirectHost: string;
  /** web: an https site. local: an app on this computer listening on localhost. native: an installed app's link scheme. */
  redirectKind: 'web' | 'local' | 'native';
  localRedirect: boolean;
  resource?: string;
}

/** An app the person has connected with OAuth (Settings → Connected agents). */
export interface OAuthConnection {
  id: string;
  clientName: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface AgentToken {
  id: string;
  userId: string;
  name: string;
  /** Only returned once, on creation. */
  token?: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface AgentReport {
  id: string;
  ontologyId: string;
  userId: string;
  agentName: string;
  kind: 'missing-concept' | 'does-not-fit' | 'bug' | 'question';
  summary: string;
  details: string;
  /** What the agent was trying to do; sample data, code context. */
  context?: string;
  suggestedOps?: ChangeOp[];
  analysis?: AiAnalysis;
  changeRequestId?: string;
  status: 'open' | 'answered' | 'converted' | 'closed';
  createdAt: string;
}

/* ------------------------------------------------------------------------ */
/* Feedback (alpha testing)                                                  */
/* ------------------------------------------------------------------------ */

export interface FeedbackQuestion {
  id: string;
  section: string;
  text: string;
  type: 'scale' | 'choice' | 'multi' | 'text';
  options?: string[];
  /** scale bounds */
  min?: number;
  max?: number;
  minLabel?: string;
  maxLabel?: string;
  optional?: boolean;
}

export interface FeedbackSubmission {
  id: string;
  userId?: string;
  name?: string;
  email?: string;
  role?: Role | string;
  pathway: 'structured' | 'general';
  answers: Record<string, string | number | string[]>;
  /** Chat transcript of the feedback conversation. */
  transcript: ChatMessage[];
  /** true if any answer came from voice input */
  usedVoice: boolean;
  /** AI-extracted themes for the general pathway */
  themes?: string[];
  createdAt: string;
}

/* ------------------------------------------------------------------------ */
/* Activity                                                                  */
/* ------------------------------------------------------------------------ */

export interface ActivityItem {
  id: string;
  ontologyId?: string;
  actorId?: string;
  actorName?: string;
  simulated?: boolean;
  type: string;
  message: string;
  link?: string;
  at: string;
}

/* ------------------------------------------------------------------------ */
/* API contract (all JSON, prefix /api)                                     */
/* ------------------------------------------------------------------------ */

export interface SessionInfo {
  user?: User;
  providers: { google: boolean; github: boolean; demo: boolean };
  llm: { provider: 'anthropic' | 'simulated'; model: string };
  solid: { enabled: boolean; serverUrl?: string };
  meetBot: { provider: 'recall' | 'simulated' };
  /** Simulated clock offset in ms (demo mode lets testers fast-forward time). */
  clockOffsetMs: number;
  now: string;
}

/**
 * Routes. The web client in apps/web/src/api.ts mirrors these.
 *
 * Auth
 *  GET  /api/session                              -> SessionInfo
 *  GET  /auth/google, /auth/github                -> OAuth redirect
 *  POST /api/auth/demo {userId? , name?, role?}   -> SessionInfo   (log in as a persona or create a demo user)
 *  POST /api/auth/logout                           -> {}
 *  GET  /api/personas                              -> User[] (simulated personas available for demo login)
 *
 * Ontologies
 *  GET  /api/ontologies                            -> OntologySummary[]
 *  POST /api/ontologies {title, description, prefix, namespace?, domain?, governanceTemplate?} -> OntologySummary
 *  GET  /api/ontologies/:id                        -> OntologySummary & { members: (Membership & {user: User})[] }
 *  GET  /api/ontologies/:id/view?ref=working|<version> -> OntologyView
 *  GET  /api/ontologies/:id/terms/:iri(encoded)    -> TermView & { usedBy: {iri:string; label?:string; via:string}[] }
 *  GET  /api/ontologies/:id/search?q=              -> TermView[]
 *  GET  /api/ontologies/:id/source?format=turtle|...&ref=working|<version>  -> text (Content-Type by format); ?download=1 sets attachment
 *  GET  /api/ontologies/:id/validation?ref=working -> ValidationReport
 *  POST /api/ontologies/:id/sparql {query}         -> {head:{vars:string[]}, rows: Record<string,string>[]}
 *
 * Members & governance
 *  PUT  /api/ontologies/:id/members/:userId {roles}  -> Membership
 *  DELETE /api/ontologies/:id/members/:userId
 *  GET  /api/governance/templates                    -> GovernancePolicy[]
 *  PUT  /api/ontologies/:id/governance {policy}      -> OntologySummary
 *  POST /api/ontologies/:id/ownership-transfer {toUserId} -> {status, voteId?}
 *
 * Use cases & interviews
 *  GET  /api/ontologies/:id/use-cases                -> UseCase[]
 *  GET  /api/use-cases/:id                           -> UseCase
 *  PATCH /api/use-cases/:id {sections?, competencyQuestions?, status?} -> UseCase
 *  POST /api/ontologies/:id/interviews {useCaseId?}  -> InterviewSession  (starts with the assistant's first question)
 *  GET  /api/interviews/:id                          -> InterviewSession & { useCase: UseCase }
 *  POST /api/interviews/:id/messages {content}       -> { session: InterviewSession; useCase: UseCase }
 *  POST /api/interviews/:id/finish                   -> { useCase: UseCase }
 *  POST /api/ontologies/:id/synthesise {useCaseIds?} -> ChangeRequest  (draft CR proposing ontology changes from use cases)
 *
 * Meetings
 *  GET  /api/ontologies/:id/meetings                 -> Meeting[]
 *  POST /api/ontologies/:id/meetings/upload {title, transcript (raw text: Google Meet/Gemini doc text, .vtt, .srt, or "Speaker: text" lines)} -> Meeting
 *  POST /api/ontologies/:id/meetings/bot {title, meetingUrl} -> Meeting   (invites the co-lead bot)
 *  POST /api/ontologies/:id/meetings/simulate {title} -> Meeting           (replays a scripted call live)
 *  GET  /api/meetings/:id                            -> Meeting
 *  POST /api/meetings/:id/analyse                    -> Meeting
 *  POST /api/meetings/:id/propose                    -> { useCases: UseCase[]; changeRequest?: ChangeRequest }
 *  GET  /api/meetings/:id/stream                     -> text/event-stream of {type:'line'|'prompt'|'status', ...}
 *
 * Change requests
 *  GET  /api/ontologies/:id/change-requests?status=  -> ChangeRequest[]
 *  POST /api/ontologies/:id/change-requests {title, description, kind, ops?, naturalLanguage?} -> ChangeRequestDetail
 *        (if ops omitted and naturalLanguage given, the LLM drafts ops)
 *  POST /api/ontologies/:id/bug-reports {title, description, termIri?} -> ChangeRequestDetail
 *  GET  /api/change-requests/:id                     -> ChangeRequestDetail
 *  PATCH /api/change-requests/:id {title?, description?, ops?} -> ChangeRequestDetail (re-triages)
 *  POST /api/change-requests/:id/submit              -> ChangeRequestDetail (draft -> triage -> review)
 *  POST /api/change-requests/:id/reviews {decision, comment?} -> ChangeRequestDetail
 *  POST /api/change-requests/:id/votes {choice, comment?}     -> ChangeRequestDetail
 *  POST /api/change-requests/:id/merge               -> ChangeRequestDetail
 *  POST /api/change-requests/:id/withdraw            -> ChangeRequestDetail
 *  POST /api/change-requests/:id/revise {instruction} -> ChangeRequestDetail (LLM revises ops per reviewer feedback)
 *
 * Releases
 *  GET  /api/ontologies/:id/releases                 -> Release[]
 *  POST /api/ontologies/:id/releases {notes?}        -> ReleaseDetail (draft from merged CRs; level = max of CRs)
 *  GET  /api/releases/:id                            -> ReleaseDetail
 *  POST /api/releases/:id/votes {choice, comment?}   -> ReleaseDetail
 *  POST /api/releases/:id/publish                    -> ReleaseDetail (commits, tags, pushes to GitHub if configured)
 *
 * Agents
 *  GET  /api/agent-tokens                            -> AgentToken[]
 *  POST /api/agent-tokens {name}                     -> AgentToken (with token)
 *  DELETE /api/agent-tokens/:id
 *  GET  /api/ontologies/:id/agent-reports            -> AgentReport[]
 *  POST /api/ontologies/:id/agent-reports {...}      -> AgentReport
 *  GET  /api/oauth/requests/:id                     -> OAuthRequestInfo  (consent page for an MCP client)
 *  POST /api/oauth/requests/:id/approve|deny        -> { redirect }
 *  GET  /api/oauth/connections                       -> OAuthConnection[]
 *  DELETE /api/oauth/connections/:id
 *  POST /mcp  (Streamable HTTP MCP endpoint; OAuth 2.1 per the MCP authorization spec, or a personal token)
 *
 * Simulation (alpha walkthrough)
 *  POST /api/simulation/step {ontologyId}            -> { events: ActivityItem[] }  (simulated people act: comment, vote, add use case)
 *  POST /api/simulation/clock {advanceDays}          -> SessionInfo   (fast-forward the governance clock)
 *  POST /api/simulation/reset                        -> {}
 *
 * Activity
 *  GET  /api/activity?ontologyId=                    -> ActivityItem[]
 *
 * Feedback
 *  GET  /api/feedback/questions                      -> FeedbackQuestion[]
 *  POST /api/feedback/chat {pathway, messages: ChatMessage[], answers} -> { reply: string; answers: Record<string, ...>; done: boolean; nextQuestionId?: string }
 *  POST /api/feedback {FeedbackSubmission minus id/createdAt} -> FeedbackSubmission
 *  GET  /api/feedback                                -> FeedbackSubmission[] (admin)
 *  GET  /api/feedback/summary                        -> { summary: string; themes: {theme:string; count:number}[] } (admin)
 *  POST /api/transcribe (audio/webm body)            -> { text: string } (server-side STT fallback; 501 if not configured)
 */
export const API_PREFIX = '/api';
