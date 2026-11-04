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
  health?: { passed: boolean; errors: number; warnings: number; fairScore: number; consistent: boolean };
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

/**
 * Who can see a use case.
 * - private: only its author. The body is mirrored to the author's Solid pod. It never
 *   feeds public outputs directly; instead the author can approve an anonymised,
 *   synthetic version that is published with no name attached.
 * - group: members of the working group (anyone with a role other than contributor or agent).
 * - public: anyone, including the published spec's "Use cases and requirements" page.
 */
export type UseCaseVisibility = 'private' | 'group' | 'public';

export const VISIBILITY_INFO: Record<UseCaseVisibility, { label: string; description: string }> = {
  private: { label: 'Private', description: 'Only you can see it. You can publish an anonymised version with no name attached.' },
  group: { label: 'Working group', description: 'Members of the working group can see it. It is not published.' },
  public: { label: 'Public', description: 'Anyone can see it, and changes can be drafted from it. Once a release includes it, the copy in that release on GitHub can’t be recalled.' },
};

/**
 * Use case lifecycle. Moves forward automatically where it can:
 * draft -> triage (author submits) -> accepted / deferred / out-of-scope (triaged by an editor or steward)
 * -> in-progress (a change request was drafted from it) -> addressed (that change was merged into the working draft)
 * -> closed (a release containing the change was published; `resolution.version` says which).
 */
export type UseCaseStatus = 'draft' | 'triage' | 'accepted' | 'in-progress' | 'addressed' | 'closed' | 'deferred' | 'out-of-scope' | 'archived';

export const USE_CASE_STATUS_INFO: Record<UseCaseStatus, { label: string; description: string; open: boolean }> = {
  draft: { label: 'Draft', description: 'Still being written by its author.', open: true },
  triage: { label: 'Needs triage', description: 'Submitted. An editor or steward decides whether the ontology should support it.', open: true },
  accepted: { label: 'Accepted', description: 'In scope. Waiting for a change to the ontology.', open: true },
  'in-progress': { label: 'In progress', description: 'A change request proposes the terms it needs.', open: true },
  addressed: { label: 'Addressed', description: 'The change is merged into the working draft and waits for the next release.', open: true },
  closed: { label: 'Closed', description: 'Covered by a published version of the ontology.', open: false },
  deferred: { label: 'Deferred', description: 'In scope, but not for now.', open: false },
  'out-of-scope': { label: 'Out of scope', description: 'The ontology will not cover this.', open: false },
  archived: { label: 'Archived', description: 'Withdrawn or superseded.', open: false },
};

/** A manually added link from a use case to something related. */
export interface UseCaseLink {
  type: 'use-case' | 'meeting' | 'change-request' | 'url';
  /** Target id (for use-case, meeting and change-request links). */
  id?: string;
  url?: string;
  label?: string;
  relation: 'related' | 'duplicate-of' | 'depends-on' | 'refines';
  addedBy?: string;
  at: string;
}

/** An anonymised, synthetic rewrite of a private use case, proposed to its author for approval. */
export interface AnonymisedDraft {
  sections: UseCaseSections;
  competencyQuestions: { question: string; exampleAnswer?: string }[];
  terms: ElicitedTerm[];
  /** What was changed to anonymise it, in plain words (shown to the author). */
  changes: string[];
  /**
   * Things that may still identify someone (names, organisations, numbers, dates),
   * found by a check of every field. Shown to the author before they consent.
   */
  warnings?: string[];
}

export interface UseCase {
  id: string;
  /**
   * Per-ontology public sequence number, shown as UC-3. 0 until the use case is
   * made public, so gaps never reveal private or working-group-only submissions.
   */
  number: number;
  /** Working group sequence number, shown as WG-2, given when a use case is first shared with the group only. */
  groupNumber?: number;
  ontologyId: string;
  /** Hidden from everyone but the author when `anonymous` is true. */
  authorId: string;
  source: UseCaseSource;
  /** Meeting/session/agent report this came from. */
  sourceRef?: string;
  /** For meeting use cases: indexes of the transcript lines it came from. */
  sourceLines?: number[];
  status: UseCaseStatus;
  visibility: UseCaseVisibility;
  /** Published with no name attached (an anonymised synthetic version of a private use case). */
  anonymous?: boolean;
  /** Only on private use cases, only visible to the author: the anonymised version proposed or published. */
  anonymisation?: { status: 'proposed' | 'published' | 'declined' | 'withdrawn'; draft?: AnonymisedDraft; proposedAt: string; decidedAt?: string; publishedId?: string };
  /** Set when the author withdrew a shared or anonymised use case: only they can see it now. */
  withdrawnAt?: string;
  /** Every competency question this use case has had while public, so withdrawal can remove each from saved results and tests. Never shown to others. */
  publicQuestions?: string[];
  /**
   * Demo only: the content a simulated persona's use case was seeded with. Testers
   * can sign in as personas and edit their use cases, so public pages show this
   * instead, and a persona's use case without it is never published.
   */
  demoSeed?: { sections: UseCaseSections; competencyQuestions: CompetencyQuestion[] };
  sections: UseCaseSections;
  competencyQuestions: CompetencyQuestion[];
  terms: ElicitedTerm[];
  links?: UseCaseLink[];
  /** Change requests drafted to address this use case. */
  changeRequestIds?: string[];
  /** Triage decision or closure. */
  resolution?: { status: UseCaseStatus; note?: string; by?: string; at: string; releaseId?: string; version?: string };
  /** 0..1 completeness against the template, computed by the server. */
  completeness: number;
  /** Where the private interview transcript lives (Solid pod resource URL). */
  transcriptUrl?: string;
  /** For private use cases: where the author's copy lives in their Solid pod. */
  podUrl?: string;
  createdAt: string;
  updatedAt: string;
}

/** A short reference to a use case, used in links from other things. */
/** "UC-3", or "Private draft" before a use case is shared and numbered. */
export const useCaseLabel = (u: { number: number; groupNumber?: number }) => (u.number ? `UC-${u.number}` : u.groupNumber ? `WG-${u.groupNumber}` : 'Private draft');

export interface UseCaseRef {
  id: string;
  number: number;
  groupNumber?: number;
  title: string;
  status: UseCaseStatus;
  visibility: UseCaseVisibility;
  anonymous?: boolean;
}

/** Everything a use case is linked to, in both directions. Computed by the server. */
export interface UseCaseTrace {
  /** Where it came from. */
  source?: { kind: 'meeting' | 'interview' | 'agent-report' | 'form' | 'anonymised'; id?: string; title: string; date?: string; href?: string; lines?: TranscriptLine[] };
  /** Change requests addressing it. */
  changeRequests: { id: string; number: number; title: string; status: ChangeRequestStatus; releaseId?: string }[];
  /** Releases that shipped those changes. */
  releases: { id: string; version: string; status: Release['status'] }[];
  /** Use cases it links to, and use cases linking to it. */
  related: (UseCaseRef & { relation: UseCaseLink['relation']; direction: 'out' | 'in' })[];
  /** Other links (meetings, URLs) added by hand. */
  other: UseCaseLink[];
  /** Requirements documents that cite it. */
  documents: { version: string; releaseId?: string; status: RequirementsDocument['status'] }[];
}

export interface UseCaseDetail extends UseCase {
  trace: UseCaseTrace;
  /** What the viewer may do. */
  can: { edit: boolean; triage: boolean; changeVisibility: boolean; withdraw: boolean };
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
  /** Use cases that came from this call (computed by the server, filtered to what the viewer can see). */
  useCases?: (UseCaseRef & { sourceLines?: number[]; analysisTitle?: string })[];
}

/* ------------------------------------------------------------------------ */
/* Change requests and lifecycle                                             */
/* ------------------------------------------------------------------------ */

export type ChangeRequestKind = 'feature' | 'bug' | 'gap' | 'editorial' | 'deprecation';

export type ChangeRequestOrigin =
  | { type: 'chat'; useCaseId?: string }
  | { type: 'meeting'; meetingId: string }
  | { type: 'agent'; agentName?: string; reportId?: string }
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
  /** Use cases this change addresses (traceability). */
  useCaseIds?: string[];
}

export interface ChangeRequestDetail extends ChangeRequest {
  /** The use cases it addresses that the viewer can see. */
  useCases?: UseCaseRef[];
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
}

export interface ReleaseDetail extends Release {
  /** Use cases this release closes (visible to the viewer). */
  useCases?: UseCaseRef[];
  /** The release's use cases and requirements document, if one was generated. */
  requirements?: Pick<RequirementsDocument, 'id' | 'version' | 'status' | 'generatedAt' | 'title'>;
  votes: Vote[];
  governance: GovernanceEvaluation;
  changeRequests: Pick<ChangeRequest, 'id' | 'number' | 'title' | 'classification'>[];
}

/* ------------------------------------------------------------------------ */
/* Use cases and requirements documents (published with each release)       */
/* ------------------------------------------------------------------------ */

/**
 * The public face of a use case. Only public use cases, and the anonymised
 * synthetic versions of private ones, ever become a PublicUseCase.
 */
/**
 * A use case as anyone on the internet may see it. Built only by the guarded
 * projection in the server (services/requirements.ts toPublic), which checks
 * visibility and copies an allowlist of fields. An anonymised one never carries
 * attribution or an identifying origin.
 */
export type PublicUseCase = PublicUseCaseBase &
  (
    | { anonymised: true; attribution?: never; origin?: { kind: 'synthetic'; label: string; date?: never; href?: never } }
    | { anonymised: false; attribution?: string; origin?: { kind: 'meeting' | 'interview' | 'agent' | 'form'; label: string; date?: string; href?: string } }
  );

export interface PublicUseCaseBase {
  id: string;
  /** e.g. "UC-3" */
  ref: string;
  title: string;
  goal?: string;
  description?: string;
  actors?: string;
  scenarios: string[];
  competencyQuestions: { question: string; exampleAnswer?: string }[];
  status: Exclude<UseCaseStatus, 'draft' | 'archived'>;
  /** The version that covers it, once closed. */
  coveredIn?: string;
  sourceKind: UseCaseSource | 'synthetic';
}

export interface RequirementItem {
  /** Stable id within the document, e.g. "R1". Anchor: #req-R1 */
  id: string;
  text: string;
  useCaseIds: string[];
  /** Ontology terms that meet it. */
  termIris: string[];
  /** Terms it needs that the ontology doesn't have (yet): it can't be met while any are missing. */
  missingTerms?: string[];
  status: 'met' | 'partial' | 'open';
}

/**
 * A release's "Use cases and requirements" document: the use cases told as one running
 * story (in the style of the W3C Verifiable Credentials use cases), with every point
 * linked to the use cases behind it, then the requirements and how far this version meets them.
 *
 * Citation links inside markdown: [UC-3](#uc-<useCaseId>) and [R1](#req-R1).
 */
export interface RequirementsDocument {
  id: string;
  ontologyId: string;
  releaseId?: string;
  version: string;
  title: string;
  status: 'draft' | 'published';
  generatedAt: string;
  /** True when written by the offline stand-in rather than the model. */
  simulated?: boolean;
  intro: string;
  sections: { id: string; heading: string; markdown: string; useCaseIds: string[] }[];
  requirements: RequirementItem[];
  useCases: PublicUseCase[];
  /**
   * Working group use cases that informed the work but are not public (a count).
   * Only working group members see it; private use cases are never counted.
   */
  unpublished?: { group: number };
  /** Coverage of the public use cases at this version. */
  coverage: { total: number; closed: number; addressed: number; open: number };
  /** Set when serving a published document from which withdrawn use cases were removed. */
  withdrawnNote?: string;
  /**
   * Every use case the document was written from. Kept even when one drops out
   * of `useCases`, so a document is known to depend on it and is written again
   * (never patched) if it stops being public. Not served.
   */
  sourceIds?: string[];
  /** A draft whose content was dropped because a use case it drew on stopped being public: written again on the next read. Not served. */
  invalidated?: boolean;
}

/* ------------------------------------------------------------------------ */
/* Agents (MCP) and agent reports                                            */
/* ------------------------------------------------------------------------ */

/** What the consent page shows when an MCP client asks to connect (GET /api/oauth/requests/:id). */
export interface OAuthRequestInfo {
  id: string;
  clientName: string;
  clientUri?: string;
  logoUri?: string;
  /** Where the person is sent back to, e.g. localhost:33418 for Claude Code. */
  redirectHost: string;
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
 *  GET  /api/ontologies/:id/use-cases                -> UseCase[]  (only those the viewer may see; see UseCaseVisibility)
 *  GET  /api/ontologies/:id/public-use-cases         -> PublicUseCase[]  (no sign-in needed)
 *  GET  /api/use-cases/:id                           -> UseCaseDetail  (404 for private use cases of others)
 *  PATCH /api/use-cases/:id {sections?, competencyQuestions?, status?} -> UseCaseDetail
 *  POST /api/use-cases/:id/visibility {visibility}   -> UseCaseDetail  (author only)
 *  POST /api/use-cases/:id/withdraw                  -> UseCaseDetail  (author only; hides it from everyone else, including an anonymised version)
 *  POST /api/use-cases/:id/submit                    -> UseCaseDetail  (draft -> triage)
 *  POST /api/use-cases/:id/triage {status, note?}    -> UseCaseDetail  (editors: accepted | deferred | out-of-scope | closed | triage)
 *  POST /api/use-cases/:id/links {type, id?, url?, relation, label?} -> UseCaseDetail
 *  DELETE /api/use-cases/:id/links/:target           -> UseCaseDetail
 *  POST /api/use-cases/:id/anonymise                 -> UseCaseDetail  (author of a private use case: draft an anonymised version)
 *  POST /api/use-cases/:id/anonymise/publish {draft?} -> { original, published }  (author consents; published has no name)
 *  POST /api/use-cases/:id/anonymise/decline         -> UseCaseDetail
 *  GET  /api/ontologies/:id/requirements             -> RequirementsDocument summaries (drafts for the working group only)
 *  GET  /api/ontologies/:id/requirements/:version    -> RequirementsDocument
 *  GET  /api/ontologies/:id/requirements/:version/markdown -> text/markdown (also committed as USE_CASES.md on release)
 *  POST /api/releases/:id/requirements               -> RequirementsDocument  (editors: write or rewrite the draft)
 *  POST /api/ontologies/:id/interviews {useCaseId?}  -> InterviewSession  (starts with the assistant's first question)
 *  GET  /api/interviews/:id                          -> InterviewSession & { useCase: UseCase }
 *  POST /api/interviews/:id/messages {content}       -> { session: InterviewSession; useCase: UseCase }
 *  POST /api/interviews/:id/finish                   -> { useCase: UseCase }
 *  POST /api/ontologies/:id/synthesise {useCaseIds?} -> ChangeRequest  (draft CR proposing ontology changes; public use cases only, since CRs are public)
 *
 * Meetings
 *  GET  /api/ontologies/:id/meetings                 -> Meeting[]  (working group members and whoever recorded each; 404s for anyone else)
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
 *  POST /api/ontologies/:id/change-requests {title, description, kind, ops?, naturalLanguage?, useCaseIds?} -> ChangeRequestDetail
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
