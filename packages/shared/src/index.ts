/**
 * Platform domain types and the HTTP API contract shared by server and web.
 * Ontology-level types come from @concord/core.
 */
import type {
  ChangeClassification,
  ChangeLevel,
  ChangeOp,
  FederationCheck,
  FederationImpact,
  FederationPin,
  OntologyDiff,
  OntologyView,
  OutputFormat,
  TermView,
  ValidationReport,
} from '@concord/core/types';

export * from './appReleases.js';

export type {
  ChangeClassification,
  ChangeLevel,
  ChangeOp,
  FederationCheck,
  FederationImpact,
  FederationPin,
  OntologyDiff,
  OntologyView,
  OutputFormat,
  TermView,
  ValidationReport,
};

/* ------------------------------------------------------------------------ */
/* People, identity, roles                                                   */
/* ------------------------------------------------------------------------ */

export type AuthProvider = 'google' | 'github' | 'solid' | 'demo';

export interface User {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string;
  /**
   * Auto-provisioned WebID (users never need to know about it), or, for someone who
   * signed in with Solid, their own WebID.
   */
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

/**
 * Whether someone with these roles can cast a vote that counts under a rule's voter roles. Members
 * who only act as AI agents never vote. The server's acceptance check, its tally and the app's
 * "Vote on" ask all use this, so a vote is only asked for and accepted where it will be counted.
 */
export function canCastVote(roles: readonly Role[], voterRoles: readonly Role[]): boolean {
  return roles.some((r) => voterRoles.includes(r)) && !roles.every((r) => r === 'agent');
}

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
    /**
     * Let members put their say on autopilot: when their application's checks pass
     * against a proposed change, Concord approves or votes yes for them. Missing means on.
     */
    appAutopilot?: boolean;
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
  /** Everything this ontology publishes was approved as it was merged (older ones are checked once: see PublicHold). */
  publishedWithApproval?: boolean;
  /**
   * Federations (ids) this ontology commits to stay usable with: a change that breaks one of them fails
   * validation. Results for any other federation it belongs to are advisory. Set by its owners and stewards.
   */
  committedFederations?: string[];
}

/** One ontology in a federation: at a release, following its working draft ('draft'), or one of its development forks ('fork:<slug>'). */
export interface FederationMember {
  ontologyId: string;
  version: string;
}

/**
 * A set of ontologies, each at a chosen version, meant to be used together (an Advanced feature).
 * Anyone signed in can start one; its owners change it.
 */
export interface Federation {
  id: string;
  slug: string;
  title: string;
  description: string;
  ownerIds: string[];
  members: FederationMember[];
  /**
   * The federation this one extends (a sub-federation): typically it adds ontologies of its own and
   * refines some of the parent's terms. Compare shows up to which terms the two agree.
   */
  parentId?: string;
  /**
   * The federation this one was forked from. A development fork is meant to come back (its owners
   * propose its ontology choices back); a divergent fork goes its own way.
   */
  forkOf?: { federationId: string; kind: 'development' | 'divergent' };
  /** Development forks proposing their ontology choices back to this federation. */
  proposals?: FederationProposal[];
  /** Terms this federation handed upstream to an ontology of the federation it extends. */
  upstream?: UpstreamProposal[];
  createdAt: string;
  updatedAt: string;
}

export interface FederationProposal {
  id: string;
  fromFederationId: string;
  members: FederationMember[];
  note: string;
  by: string;
  at: string;
  status: 'open' | 'accepted' | 'declined';
  decidedBy?: string;
  decidedAt?: string;
}

export interface UpstreamProposal {
  /** The change request opened on the target ontology. */
  changeRequestId: string;
  ontologyId: string;
  /** Original term IRI → the IRI it gets upstream. */
  mapping: Record<string, string>;
  by: string;
  at: string;
}

/**
 * A federation release: every member and everything it imports pinned to a release and its RDFC-1.0
 * content hash, with the hash of the SHACL shapes derived from the members' OWL. Never changes once published.
 */
export interface FederationRelease {
  id: string;
  federationId: string;
  version: string;
  notes: string;
  pins: FederationPin[];
  shapesHash: string;
  /** The frozen closure's RDFC-1.0 hash: every pinned graph merged, exactly as checked. */
  closureHash?: string;
  /** The manifest's own RDFC-1.0 hash. */
  hash: string;
  previousVersion?: string;
  publishedAt: string;
  publishedBy: string;
  /** The manifest, derived shapes and frozen closure (Turtle), exactly as published. */
  manifest: string;
  shapes: string;
  closure?: string;
}

/** Whether a federation can be released now, what is in the way, and the version it should take. */
export interface FederationReleasePlan {
  ready: boolean;
  blockers: string[];
  suggested: { version: string; level: 'major' | 'minor' | 'patch'; reasons: string[] };
  pins: FederationPin[];
}

/** A federation with what a page needs to show its members. */
/** Two federations compared term by term (B is the federation asked about, A the one it is compared with). */
export interface FederationComparison {
  a: { id: string; slug: string; title: string };
  b: { id: string; slug: string; title: string };
  terms: { iri: string; kind: string; label?: string; relation: 'same' | 'equivalent' | 'tightened' | 'loosened' | 'conflict' | 'only-a' | 'only-b'; onlyInA: string[]; onlyInB: string[] }[];
  counts: Record<'same' | 'equivalent' | 'tightened' | 'loosened' | 'conflict' | 'only-a' | 'only-b', number>;
  shared: number;
  agreeing: number;
  /** The reasoner couldn't run on one side, so entailed superclasses are missing (not cached; try again). */
  unfinished?: boolean;
}

export interface FederationDetail extends Federation {
  memberInfo: { ontologyId: string; version: string; title: string; slug: string; ontologyIRI: string; versions: string[]; forks: { slug: string; title: string }[]; committed: boolean; canCommit: boolean }[];
  canEdit: boolean;
  parent?: { id: string; slug: string; title: string };
  children: { id: string; slug: string; title: string }[];
  forkedFrom?: { id: string; slug: string; title: string; kind: 'development' | 'divergent' };
  forks: { id: string; slug: string; title: string; kind: 'development' | 'divergent' }[];
  /** Each proposal with the proposing fork's name and how its ontology choices differ from this federation's. */
  proposalInfo: (FederationProposal & { from: { slug: string; title: string }; changes: string[] })[];
  /** Each upstream proposal with where its change request stands. */
  upstreamInfo: (UpstreamProposal & { ontologyTitle: string; number?: number; status?: string })[];
}


export interface OntologySummary extends OntologyProject {
  /** Counts a caller may not see are left out: activity for signed-out callers, and the graph's while its working draft waits for approval. */
  stats: {
    classes?: number;
    properties?: number;
    individuals?: number;
    useCases?: number;
    openChangeRequests?: number;
    releases: number;
    members?: number;
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
    /** How far the OWL reasoner got: everything, consistency only, or no verdict. Absent on older summaries. */
    reasonerChecked?: 'complete' | 'consistency' | 'none';
    /** The reasoner's own consistency verdict (`consistent` above also counts unsatisfiable classes). Absent on older summaries. */
    reasonerConsistent?: boolean;
    /** How many unsatisfiable classes the reasoner reported. Absent on older summaries. */
    unsatisfiable?: number;
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
  /** Every title it has had while public, so withdrawal can take each out of change requests, votes, releases and activity. Never shown to others. */
  publicTitles?: string[];
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
  /** Titles it had before, still kept out of anything published. */
  formerTitles?: string[];
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

export interface FacilitatorPrompt {
  at: string;
  /** seconds from the start of the call */
  t?: number;
  text: string;
  /** True once the prompt has been posted in the meeting's own chat. */
  posted: boolean;
  postedAt?: string;
  /** Why posting to the meeting chat failed, if it did. */
  postError?: string;
}

/** Where a calendar-invited call came from: the bot's calendar feed or an uploaded .ics invite. */
export interface MeetingCalendarInfo {
  /** Stable key of this occurrence (event UID plus its start), used to avoid joining twice. */
  key: string;
  /** The calendar event's UID (shared by every week of a series). */
  uid?: string;
  feed: 'calendar' | 'upload';
  start: string;
  end: string;
  organizer?: string;
  /** ORGANIZER;SENT-BY: someone who sent the invite on the organiser's behalf. */
  sentBy?: string;
  /** True for one occurrence of a recurring series. */
  recurring: boolean;
  /** Set when someone told the bot to stay out of this occurrence. */
  skip?: boolean;
  /**
   * No bot is booked until a facilitator of the ontology approves the call. Approval
   * covers a whole series, for as long as its organiser and Meet link stay the same;
   * if either changes, the call needs approving again.
   */
  approval?: 'approved' | 'pending';
  approvedBy?: string;
  /** Why the call needs approving again, when it was approved before. */
  approvalNote?: string;
  /** The call left the calendar but cancelling its booked bot failed; retried every minute. */
  cancelPending?: boolean;
}

export interface Meeting {
  id: string;
  ontologyId: string;
  title: string;
  source: 'upload' | 'google-meet-bot' | 'calendar-invite' | 'simulation' | 'google-drive';
  /** Google Meet URL when a bot was invited. */
  meetingUrl?: string;
  bot?: {
    provider: 'recall' | 'simulated';
    /**
     * A Recall.ai bot's state machine (one record per meeting): idle (nothing booked),
     * booking (a booking recorded and sent, not yet answered), booked (Recall.ai named
     * the bot), releasing (getting rid of it, until Recall.ai confirms) and done.
     */
    phase?: 'idle' | 'booking' | 'booked' | 'releasing' | 'done';
    /** Bumped by every change of the record: a change decided from an older copy is refused. */
    gen?: number;
    botId?: string;
    /** Shown instead of botId to people who can't see it: a bot is booked. */
    booked?: boolean;
    /** For the page; follows from the phase. */
    status: 'scheduled' | 'joining' | 'in-call' | 'done' | 'error';
    error?: string;
    /** The booking hasn't been answered: Recall.ai may or may not have made the bot. */
    uncertain?: boolean;
    /** The current booking's id: also its idempotency key, and the metadata a bot from it carries. */
    bookingId?: string;
    /** The Meet link the current booking was made for. */
    bookedUrl?: string;
    /** When the current booking was first sent (its idempotency key is only honoured for an hour). */
    bookedAt?: string;
    /** When the booking asks the bot to join, and whether its greeting says it will post in the chat: resent unchanged. */
    joinAt?: string;
    chat?: boolean;
    /** Releasing: take the bot out of the call (leave) or cancel its booking (cancel) first. */
    release?: 'cancel' | 'leave';
    /** Releasing: what follows once Recall.ai confirms. done for End call; idle when the call may book again. */
    after?: 'idle' | 'done';
    /** Failed tries of the current step, and when the next is due (ms, by the bot clock's time). */
    attempts?: number;
    nextAt?: number;
    /** The last failure of the current step (shown as error or cancelError). */
    fault?: string;
    /** Heard from the call. */
    inCall?: boolean;
    /** Other bots of this meeting's that turned up (they shouldn't exist): cancelled until confirmed. */
    strays?: string[];
    /** Bots Recall.ai confirmed gone: anything they still send is dropped. */
    released?: string[];
    /** Bookings a facilitator dismissed: still looked for (with the Meet link each was booked for, and when next, bot clock ms), and their bot cancelled if it turns up. */
    dismissed?: { bookingId: string; url: string; nextAt?: number }[];
    /** Failed attempts at removing strays, and when they're next tried (bot clock, ms): their own schedule, apart from the booking's. */
    strayAttempts?: number;
    strayNextAt?: number;
    /** A booking that can no longer be resent safely and hasn't turned up: a facilitator can dismiss it. */
    unconfirmed?: boolean;
    /** Cancelling an earlier bot for this call failed; Concord keeps retrying. */
    cancelError?: string;
    /** Someone ended the call but the bot hasn't been removed yet; Concord keeps trying. */
    leaving?: boolean;
  };
  /** Cancelled, or no longer on the calendar: kept (for facilitators only) until its bot is confirmed gone. */
  withdrawn?: boolean;
  /** Set for calls the bot was invited to through its calendar address. */
  calendar?: MeetingCalendarInfo;
  /** When true, the co-lead bot posts its prompts into the meeting's chat as well as showing them here. */
  postPromptsToChat?: boolean;
  /** What the bot last told the call about posting in its chat (its join message, or a later notice). */
  chatModeAnnounced?: boolean;
  /** The last notice about chat posting couldn't be sent; it is retried as the call goes on. */
  chatNoticeError?: string;
  /** When the last transcript line arrived (server time, ms): kept on the record so every server instance sees it. */
  lastLineAt?: number;
  transcript: TranscriptLine[];
  /** Suggestions the co-lead bot made during the call (gaps, follow-up questions). */
  facilitatorPrompts: FacilitatorPrompt[];
  analysis?: MeetingAnalysis;
  /** 'scheduled': a calendar invite the bot will join when the call starts. */
  status: 'scheduled' | 'live' | 'processing' | 'analysed' | 'error';
  createdAt: string;
  createdBy: string;
  /** Use cases that came from this call (computed by the server, filtered to what the viewer can see). */
  useCases?: (UseCaseRef & { sourceLines?: number[]; analysisTitle?: string })[];
}

/** What the co-lead bot can do on this server, for the Meetings page. */
export interface MeetBotInfo {
  provider: 'recall' | 'simulated';
  /** The address people add to a calendar invite to bring the bot into a call. */
  inviteEmail?: string;
  /** True when the server reads the bot's calendar, so invites to inviteEmail are picked up. */
  calendarConnected: boolean;
  /** Default for "post prompts into the Meet chat" on calls that arrive by invite. */
  postToChatDefault: boolean;
  /** The latest read of the bot's calendar. The error never contains the feed's secret address. */
  lastSync?: { at: string; ok: boolean; events: number; error?: string };
  /** Bots Concord is still trying to cancel (Recall.ai hasn't confirmed yet). */
  cancelling?: number;
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
  | { type: 'synthesis'; useCaseIds: string[] }
  | { type: 'fork'; forkId: string; forkSlug: string }
  /** Terms a sub-federation handed upstream to this ontology. */
  | { type: 'federation'; federationId: string; federationSlug: string; federationTitle: string }
  /** Reported anonymously from the public ontology page. */
  | { type: 'public-report'; termIri: string; version: string; /** The queued report it was opened from: approving twice finds this request. */ reportId?: string };

/**
 * A problem reported from the public ontology page by someone without an
 * account. Held for review: only editors, stewards and owners see it, and
 * nothing is done with it (no change request, activity or AI triage) until
 * one of them opens it as a bug report.
 */
export interface PublicReport {
  id: string;
  ontologyId: string;
  termIri: string;
  termName: string;
  /** The version of the page it was sent from ("draft" for the working draft). */
  version: string;
  title: string;
  description: string;
  createdAt: string;
  /** Set while a moderator is opening it as a change request (ms since the epoch). */
  claimedAt?: number;
  /** Server only: which request holds the claim. Never sent to the browser. */
  claimToken?: string;
}

/**
 * Versions of an ontology published before a person approved what goes
 * public, held (their pages and downloads say they're being reviewed) until
 * an owner or steward approves exactly what each publishes.
 */
export interface PublicHold {
  id: string;
  ontologyId: string;
  /** 'draft' or a released version. */
  versions: string[];
  since: string;
  approved?: { version: string; by: string; at: string; fingerprint: string }[];
}
/** What a steward reviews before approving a held version. */
export interface PublicHoldReview {
  version: string;
  /** Approving sends this back: it changes whenever what the version publishes does. */
  fingerprint: string;
  statements: number;
  /** Statements and lines that look like they name a use case or a person (hints, not verdicts). Full IRIs. */
  hints: { subject: string; predicate: string; object: string; kind: 'use case title' | 'name' }[];
  /** Everything the fingerprint covers, in full: what approving publishes. */
  turtle: string;
  notes: string;
  snapshot: string;
  /** Set when the version couldn't be read: nothing is highlighted, but it can still be read and approved. */
  error?: string;
}

export interface PublicationStatement {
  /** Full IRIs (or a blank node), never shortened: a private name can sit anywhere in one. */
  subject: string;
  predicate: string;
  /** A literal's text, or the full IRI. */
  object: string;
  /** The statement exactly as it is published (N-Triples), with any language or datatype. */
  nt: string;
  /** Looks like it names a private use case or a person (a hint, not a verdict). */
  hint?: 'use case title' | 'name';
}
/** Exactly what merging a request drafted from use cases would publish, for an editor to approve. */
export interface Publication {
  /** Approving sends this back: it changes whenever what would be published does. */
  fingerprint: string;
  title: string;
  kgcl: string[];
  statements: PublicationStatement[];
  /** The title or edit list looks like it names something private. */
  hints: { where: string; kind: 'use case title' | 'name' }[];
}

export interface PrivacyFinding {
  /** e.g. "definition of :PilotRecord", "title". */
  where: string;
  kind: 'use case title' | 'name';
}

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
  /** Set when autopilot made this review because the person's apps passed their checks. */
  autopilot?: AutopilotMark;
  /** When autopilot took this review back. A withdrawn review means the person has no say until they give one. */
  withdrawnAt?: string;
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
  /** Set when autopilot cast this vote because of the person's app checks. */
  autopilot?: AutopilotMark;
  /** When autopilot took this vote back. A withdrawn vote means the person has no vote until they cast one. */
  withdrawnAt?: string;
  /** For change requests: the round and edits version it was cast on, and its place in the request's order of decisions. */
  round?: number;
  editsVersion?: number;
  seq?: number;
  /** In change request details: true when it no longer counts because the edits changed since. */
  stale?: boolean;
}

/**
 * Which app checks an autopilot review or vote was based on. It counts only while it is
 * the person's latest say, isn't withdrawn, and `revision` is still the change's revision.
 */
export interface AutopilotMark {
  revision: string;
  apps: { id: string; name: string; runUrl?: string }[];
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
    | 'reminder'
    | 'app-check';
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
  /**
   * Where what a merge would publish looks like it names a private use case
   * or a person (where, and what kind: never the text itself). A hint for
   * the editor approving it, set when a merge is held back.
   */
  privacyFindings?: PrivacyFinding[];
  /** An editor approved exactly what merging this request publishes (see needsPublicationApproval). */
  privacyCleared?: { by: string; at: string; fingerprint: string; title: string; kgcl: string[] };
  /** Merging stopped until an editor approves what it publishes. */
  heldForPublication?: boolean;
  releaseId?: string;
  timeline: TimelineEvent[];
  createdAt: string;
  updatedAt: string;
  /** Status entered at — used for review period / vote windows */
  statusSince: string;
  /** Which stage approved it, so the approval can be re-checked before merging. */
  approvedFrom?: 'review' | 'voting';
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
  /** The working-draft commit the stored triage results were checked against. */
  triagedHead?: string;
  /** Counts triage results written, so a check can tell whether another wrote results while it ran. */
  triageSeq?: number;
  /** Use cases this change addresses (traceability). */
  useCaseIds?: string[];
  /**
   * Set on what a viewer receives (never stored) when the request was drafted from, or cites, a
   * use case that viewer may not see, such as one its author withdrew: only its number and state
   * are shown.
   */
  withheld?: boolean;
}

/* ------------------------------------------------------------------------ */
/* Development forks                                                         */
/* ------------------------------------------------------------------------ */

/**
 * A personal, pre-release copy of an ontology that a developer can import
 * straight away while a change goes through governance. Forks are git
 * branches (`forks/<slug>`) in the ontology's repository; new terms keep the
 * upstream namespace, so data written against the fork stays valid once the
 * change lands and only the import URL has to change.
 */
export type ForkStatus = 'active' | 'proposed' | 'merged' | 'released' | 'closed';

export interface OntologyFork {
  id: string;
  slug: string;
  ontologyId: string;
  ownerId: string;
  title: string;
  /** What the fork is for, e.g. "Volunteer hours in the Helping Hands app". */
  purpose?: string;
  /** Git branch in the ontology repository. */
  branch: string;
  /** Upstream commit and released version the fork was taken from (or last synced with). */
  baseCommit: string;
  baseVersion: string;
  /** The fork's outstanding edits since its base, in order: replayed on sync and proposed upstream as one change request. Edits that have landed upstream are dropped on sync. */
  ops: ChangeOp[];
  /** Terms (or import:/meta: keys) whose fork changes landed upstream and were dropped from `ops` on sync, so their status is still reported. */
  landed?: { key: string; change: 'added' | 'changed' | 'removed' }[];
  /** Increments on every edit or sync; part of the fork's version string. */
  revision: number;
  head: string;
  status: ForkStatus;
  changeRequestIds: string[];
  /** Record version: every change to the stored fork advances it, and a change is only saved if it hasn't moved since it was read. */
  seq?: number;
  /** The revision last proposed upstream; edits after it are not in the change request yet. */
  proposedRevision?: number;
  /** 2: generated provenance on the fork is recorded as dcterms:provenance. Forks without it (none were ever deployed) can't be changed. */
  provenanceFormat?: 2;
  /** Set while a proposal is being made (until: epoch ms), so no other change starts until it has finished or the lease has run out. */
  proposing?: { until: number };
  createdAt: string;
  updatedAt: string;
}

export interface ForkUrls {
  /** The fork's document IRI: dereference it for Turtle, JSON-LD and the other formats. */
  iri: string;
  /** One URL per format (by extension), for import statements. */
  formats: Record<string, string>;
  /** Where to see the fork in Concord. */
  app: string;
}

export interface ForkTerm {
  iri: string;
  curie: string;
  label?: string;
  kind: string;
  /** What the fork does to the term, compared with the upstream commit it is based on. */
  change: 'added' | 'changed' | 'removed';
  /**
   * Where the fork's version of the term stands upstream, by content (not just
   * by IRI): released or merged only when upstream says exactly what the fork
   * says; pending when the open change request would make it so; diverged when
   * upstream has a different version (changed in review, or by someone else).
   */
  upstream: 'not-proposed' | 'pending' | 'merged' | 'released' | 'rejected' | 'diverged';
  /** The released version that contains the fork's version of the term. */
  releasedIn?: string;
}

export interface ForkSummary extends OntologyFork {
  owner?: Pick<User, 'id' | 'name' | 'avatarUrl' | 'simulated'>;
  ontology: Pick<OntologyProject, 'id' | 'slug' | 'title' | 'prefix' | 'currentVersion'>;
  version: string;
  urls: ForkUrls;
  terms: ForkTerm[];
  changeRequest?: { id: string; number: number; title: string; status: ChangeRequestStatus; level?: ChangeLevel };
  /** Upstream commits since the fork's base (0 when up to date). */
  behindBy: number;
}

/** A fork edit that can't be carried onto the latest upstream draft as it is. */
export interface ForkConflict {
  /** The term (or `owl:imports <iri>`) both sides changed, when there is one. */
  iri?: string;
  curie?: string;
  message: string;
  /** What to pass to discard to resolve it: the terms of the fork's edits that cause it (may differ from `iri` when an edit reaches the term indirectly). */
  discard?: string[];
  /** Readable form of `discard`. */
  discardLabels?: string[];
}

/** What an agent should do about a fork at the start of a development session. */
export interface ForkCheck {
  fork: ForkSummary;
  outcome: 'keep-using-fork' | 'sync-fork' | 'resolve-conflicts' | 'switch-to-draft' | 'switch-to-release' | 'fork-closed' | 'recreate-fork';
  message: string;
  /** Import URLs to replace in the application (every one of them resolves). */
  replace: { from: string; to: string }[];
  /** Fork edits that conflict with upstream; discard them or edit the fork. */
  conflicts: ForkConflict[];
  steps: string[];
}

export interface ForkSyncResult {
  synced: boolean;
  fork: ForkSummary;
  conflicts: ForkConflict[];
  message: string;
}

export interface ChangeRequestDetail extends ChangeRequest {
  /** The use cases it addresses that the viewer can see. */
  useCases?: UseCaseRef[];
  reviews: Review[];
  votes: Vote[];
  governance: GovernanceEvaluation;
  author?: Pick<User, 'id' | 'name' | 'avatarUrl' | 'simulated'>;
  /** The latest result from each connected app that has tested this change. */
  appChecks?: AppCheckResult[];
  /** Fingerprint of the ontology this change would produce (working draft head plus the edits). */
  revision?: string;
}

export interface Release {
  id: string;
  ontologyId: string;
  version: string;
  level: ChangeLevel;
  status: 'draft' | 'voting' | 'published' | 'rejected';
  changeRequestIds: string[];
  notes: string;
  /** Who wrote the notes, when a steward did; drafted notes have none. */
  notesBy?: string;
  versionIRI: string;
  commit?: string;
  githubUrl?: string;
  createdBy: string;
  createdAt: string;
  publishedAt?: string;
  statusSince: string;
  /** Bumped on every write; a write from a copy at an older revision is refused. */
  rev?: number;
  /** The approval evaluation recorded when the release was published or rejected, so later policy or membership changes don't rewrite its history. */
  approval?: GovernanceEvaluation;
}

/**
 * Where a release's `governance` comes from:
 * - `live`: it's still open, evaluated against today's policy and members;
 * - `recorded`: the evaluation saved when it was published or rejected;
 * - `bootstrap`: the first release, published when the ontology was set up, before any approval rules applied;
 * - `current-policy`: decided before Concord kept a record, so it's re-evaluated against today's policy and members.
 */
export type ReleaseApprovalSource = 'live' | 'recorded' | 'bootstrap' | 'current-policy';

export interface ReleaseDetail extends Release {
  /** Use cases this release closes (visible to the viewer). */
  useCases?: UseCaseRef[];
  /** The release's use cases and requirements document, if one was generated. */
  requirements?: Pick<RequirementsDocument, 'id' | 'version' | 'status' | 'generatedAt' | 'title'>;
  votes: Vote[];
  governance: GovernanceEvaluation;
  approvalSource: ReleaseApprovalSource;
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

/** An app the person has connected with OAuth (Connect an agent → Connected agents). */
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
/* Connected apps: test applications against proposed changes, autopilot     */
/* ------------------------------------------------------------------------ */

export type AppCheckOutcome = 'passed' | 'failed' | 'error';

export interface AutopilotSettings {
  /** Approve or vote yes for the app's owner when all of their apps pass. */
  enabled: boolean;
  /** Change levels autopilot may say yes to. Defaults to patch and minor. */
  levels: ChangeLevel[];
  /** When an app fails: 'report' records it (and withdraws any autopilot yes); 'oppose' also votes no in a vote. */
  onFailure: 'report' | 'oppose';
}

/**
 * An application someone builds on the ontology, whose CI (the Concord GitHub Action)
 * tests it against every proposed change and reports back with the app's token.
 */
export interface ConnectedApp {
  id: string;
  ontologyId: string;
  ownerId: string;
  name: string;
  /** GitHub repository, as owner/name. */
  repo?: string;
  /** First characters of the token, to recognise it. */
  tokenPrefix: string;
  /** Only returned when the app is created or its token is replaced. */
  token?: string;
  autopilot: AutopilotSettings;
  /**
   * The app's result against the current working draft, before any proposed change. `verified`
   * when GitHub vouched that the run ran in the app's repository, or its owner reported it signed in.
   */
  baseline?: { revision: string; outcome: AppCheckOutcome; summary?: string; runUrl?: string; at: string; attempt?: number; commit?: string; current?: boolean; verified?: boolean };
  lastSeenAt?: string;
  createdAt: string;
  owner?: Pick<User, 'id' | 'name' | 'avatarUrl' | 'simulated'>;
  /** Set while the app is connected through the Concord GitHub App: no token, and Concord starts its runs. */
  github?: ConnectedAppGithub;
}

export interface ConnectedAppGithub {
  /** The repository the app was installed on, as owner/name (kept up to date if it is renamed). */
  repo: string;
  linkedAt: string;
  /** The installation was suspended on GitHub: Concord can't start runs until it is unsuspended. */
  suspended?: boolean;
  /** When Concord last started the app's workflow, and how that went. */
  lastDispatch?: { at: string; ok: boolean; message?: string };
  /** The pull request Concord opened to add the workflow file. */
  workflowPr?: { number: number; url: string };
}

/** Whether this Concord can connect apps through its GitHub App (GET /api/github-app). */
export interface GithubAppStatus {
  enabled: boolean;
  /** The app's page on GitHub, for people who want to see what it asks for. */
  url?: string;
}

export interface AppCheck {
  id: string;
  appId: string;
  ontologyId: string;
  changeRequestId: string;
  /** The change request revision that was tested (see ChangeRequestDetail.revision). */
  revision: string;
  outcome: AppCheckOutcome;
  summary?: string;
  runUrl?: string;
  /** The app commit that was tested. */
  commit?: string;
  /** The run that produced it, as issued by GET /api/app-checks/pending. Newer runs win. */
  attempt?: number;
  /** From a verified run (see ConnectedApp.baseline). Only verified results move autopilot. */
  verified?: boolean;
  at: string;
}

export interface AppCheckResult extends AppCheck {
  app: Pick<ConnectedApp, 'id' | 'name' | 'repo' | 'ownerId' | 'owner'> & { autopilot: boolean };
  /** False when the change or the working draft has moved on since this was tested. */
  current: boolean;
}

/** What GET /api/app-checks/pending returns to an app's CI. Paths are relative to the Concord URL. */
export interface PendingAppChecks {
  app: { id: string; name: string };
  /** Identifies this run. Send it back with every result; results from older runs are ignored. */
  attempt: number;
  ontology: { id: string; slug: string; title: string; ontologyIRI: string };
  formats: OutputFormat[];
  baseline: { revision: string; source: string; outcome?: AppCheckOutcome };
  targets: {
    changeRequestId: string;
    number: number;
    title: string;
    kind: ChangeRequestKind;
    level?: ChangeLevel;
    status: ChangeRequestStatus;
    revision: string;
    /** Path of the proposed ontology; add ?format=… for another serialisation. */
    source: string;
    /** Path of the change request page in the web app. */
    page: string;
    lastOutcome?: AppCheckOutcome;
    /** When this app last reported on the change; never-tested changes are listed first, then the longest ago. */
    lastTestedAt?: string;
  }[];
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
  /** structured: the full questionnaire; changes: questions about what changed since `sinceVersion`; general: free-form. */
  pathway: 'structured' | 'changes' | 'general';
  /** App version the tester was using (APP_VERSION of the web build). */
  appVersion?: string;
  /** Web build commit, when known. */
  appCommit?: string;
  /** The version the tester last tested before this one, if they said or we knew. */
  sinceVersion?: string;
  /** The tester's own account, when they were playing a persona at the time. */
  testerId?: string;
  answers: Record<string, string | number | string[]>;
  /** Chat transcript of the feedback conversation. */
  transcript: ChatMessage[];
  /** true if any answer came from voice input */
  usedVoice: boolean;
  /** AI-extracted themes for the general pathway */
  themes?: string[];
  /**
   * Opt-in public summary, filed as a GitHub issue. Sent by the tester on submit
   * (`summary`, already passed through publicSummary, so it is exactly what they saw);
   * returned by the server as `publication`.
   */
  publish?: { summary: string };
  publication?: FeedbackPublicationStatus;
  createdAt: string;
}

/* ------------------------------------------------------------------------ */
/* Public feedback summaries (GitHub issues)                                 */
/* ------------------------------------------------------------------------ */

/** Bumped whenever the wording testers agree to changes, and stored with each consent. */
export const PUBLIC_NOTICE_VERSION = 1;
export const PUBLIC_NOTICE =
  'Only the summary below is posted, exactly as shown, as a GitHub issue on the Concord repository, which may be public. Your answers, name, email, role and the conversation are not posted. Don’t include names, organisations or other details that identify anyone. Links and email addresses are removed.';
export const PUBLIC_SUMMARY_MAX = 500;

/**
 * queued → sending → filed; a send whose outcome is unknown → unknown (searched for, never re-posted
 * automatically) → filed or needs-admin. Withdrawal: → withdrawing (if it may be posted) → withdrawn,
 * which is terminal.
 */
export type FeedbackPublicationState = 'queued' | 'sending' | 'unknown' | 'filed' | 'needs-admin' | 'withdrawing' | 'withdrawn';

export interface FeedbackPublicationStatus {
  state: FeedbackPublicationState;
  issue?: { number: number; url: string };
  /** Only in the response to the submission: lets the tester withdraw the summary later. */
  withdrawToken?: string;
  /** A withdrawal that can't find its issue and needs an administrator to confirm. Administrators only. */
  adminNeeded?: boolean;
  /** Administrators only. */
  id?: string;
  summary?: string;
  lastError?: string;
  /** The hidden marker to look for on GitHub before posting again (needs-admin only). */
  marker?: string;
}

/**
 * The text of a public summary, as posted. The tester's preview and the server
 * both use this, so what they see is what is posted. It removes links (with or
 * without a scheme), email addresses and @handles, and normalises Unicode so
 * look-alike characters can't slip past. It can't recognise names: the tester
 * writes the summary and is asked not to include any.
 */
export function publicSummary(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, ' ')
    .replace(/[^\s@]+@[^\s@]+/g, '[email removed]')
    .replace(/\S+\s*[[(]\s*at\s*[\])]\s*\S+/gi, '[email removed]')
    .replace(/@[\p{L}\p{N}_-]+/gu, '[handle removed]')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, '[link removed]')
    .replace(/(^|[\s(\[<"'])\/\/\S+/g, '$1[link removed]')
    .replace(/\b(?:www\.|(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}\/)\S*/gu, '[link removed]')
    .replace(/(?:^|\s)\/(?:people|pods?|webid|u|profile)\/\S*/gi, ' [link removed]')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
    .slice(0, PUBLIC_SUMMARY_MAX)
    .trim();
}

/* ------------------------------------------------------------------------ */
/* Activity                                                                  */
/* ------------------------------------------------------------------------ */

export interface ActivityItem {
  id: string;
  ontologyId?: string;
  actorId?: string;
  actorName?: string;
  /** The actor's profile picture, filled in when the feed is read. */
  actorAvatarUrl?: string;
  simulated?: boolean;
  type: string;
  message: string;
  link?: string;
  at: string;
}

/* ------------------------------------------------------------------------ */
/* API contract (all JSON, prefix /api)                                     */
/* ------------------------------------------------------------------------ */

/** One tester's feedback folder in their pod, as an administrator's WebID can read it. */
export interface PodFeedbackFolder {
  testerId: string;
  testerName: string;
  url: string;
  /** forbidden: the pod refused the admin's WebID; missing: no feedback saved there; partial: some documents couldn't be read. */
  status: 'ok' | 'partial' | 'forbidden' | 'missing' | 'error';
  items: FeedbackSubmission[];
  /** Documents the folder lists that weren't read: they failed, or were beyond the first 100 (status partial). */
  unread?: number;
  /** Why Concord couldn't share this folder with the admins, the last time it tried. */
  sharingError?: string;
}

export interface PodFeedbackReport {
  /** The WebID the folders were read as (the admin's own, from their Solid sign-in). */
  readAs: string;
  /** WebIDs the folders are shared with (ADMIN_WEBIDS). */
  readers: string[];
  folders: PodFeedbackFolder[];
}

export interface SessionInfo {
  user?: User;
  /**
   * Names this browser session without revealing its token: a sign-out made with no connection
   * sends it later, so only that session ends (POST /api/auth/logout `{ session }`).
   */
  sessionId?: string;
  providers: { google: boolean; github: boolean; solid: boolean; demo: boolean };
  /**
   * WebIDs that can read testers' feedback: the deployment's administrators. Testers are
   * told this, and their pod's feedback folder is shared read-only with these WebIDs.
   */
  feedbackReaders: string[];
  /** Who turns recorded speech into text when the browser can't (the server-side fallback), if anyone. */
  serverTranscription: 'openai' | null;
  llm: { provider: 'anthropic' | 'simulated'; model: string };
  solid: { enabled: boolean; serverUrl?: string };
  meetBot: MeetBotInfo;
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
 *  GET  /auth/solid?webId=<WebID or provider URL>  -> Solid-OIDC redirect (DPoP); /auth/solid/client.jsonld is the Client ID Document
 *  POST /api/auth/demo {userId? , name?, role?}   -> SessionInfo   (log in as a persona or create a demo user)
 *  POST /api/auth/logout {session?} (JSON only)    -> {ended}   (with session: only if it is still that one)
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
 * Federations (Advanced features)
 *  GET  /api/federations                             -> Federation[]
 *  POST /api/federations {title, description?, members?, parentId?} -> FederationDetail
 *  GET  /api/federations/:fed                        -> FederationDetail
 *  PATCH /api/federations/:fed {title?, description?, members?} -> FederationDetail   (owners)
 *  GET  /api/federations/:fed/check                  -> FederationCheck
 *  GET  /api/federations/:fed/compare/:other         -> FederationComparison   (:fed compared with :other, term by term)
 *  GET  /api/federations/:fed/release-plan           -> FederationReleasePlan
 *  GET  /api/federations/:fed/releases               -> FederationRelease[] (without manifest, shapes and closure)
 *  POST /api/federations/:fed/releases {version?, notes?} -> FederationRelease   (owners)
 *  GET  /def/fed/:slug[/:version[/shapes]]           -> text/turtle: the release manifest, or its derived SHACL (public)
 *  GET  /api/ontologies/:id/federations              -> (Federation & {committed})[]
 *  POST /api/ontologies/:id/federations/:fed/commitment {committed} -> FederationDetail   (owners, stewards)
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
 *  POST /api/ontologies/:id/meetings/bot {title, meetingUrl, postPromptsToChat?} -> Meeting   (invites the co-lead bot)
 *  POST /api/ontologies/:id/meetings/calendar {ics, postPromptsToChat?} -> {meetings: Meeting[]; cancelled: number; cancelRetrying: number}   (imports a calendar invite or its cancellation)
 *  GET  /api/meet-bot                                -> MeetBotInfo
 *  POST /api/meet-bot/sync                           -> MeetBotInfo   (re-read the bot's calendar now)
 *  PATCH /api/meetings/:id {postPromptsToChat?, skip?, approve?} -> Meeting   (owners, stewards and editors)
 *  POST /api/meetings/:id/prompts/:index/post        -> Meeting   (post one prompt into the meeting chat)
 *  POST /api/ontologies/:id/meetings/simulate {title} -> Meeting           (replays a scripted call live)
 *  GET  /api/meetings/:id                            -> Meeting   (signed in; Meet link and organiser only for facilitators)
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
 * Connected apps (CI checks and autopilot)
 *  GET  /api/ontologies/:id/apps                     -> ConnectedApp[]
 *  POST /api/ontologies/:id/apps {name, repo?, autopilot?} -> ConnectedApp (with token)
 *  PATCH /api/apps/:id {name?, repo?, autopilot?}    -> ConnectedApp (owner only)
 *  POST /api/apps/:id/token                          -> ConnectedApp (with a new token; the old one stops working)
 *  DELETE /api/apps/:id
 *  GET  /api/change-requests/:id/proposed?format=    -> text: the ontology as it would be with this change merged
 *  GET  /api/app-checks/pending?all=1&commit=sha     -> PendingAppChecks   (Bearer app token)
 *  POST /api/app-checks {target: 'baseline'|changeRequestId, revision, attempt, outcome, summary?, runUrl?, commit?}
 *                                                    -> { check?, stale, autopilot? }   (Bearer app token)
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
 *  GET  /api/feedback/questions?pathway=&since=&role= -> FeedbackQuestion[] (pathway=changes asks about what changed since `since`)
 *  POST /api/feedback/chat {pathway, messages: ChatMessage[], answers, since?, role?} -> { reply: string; answers: Record<string, ...>; done: boolean; nextQuestionId?: string }
 *  POST /api/feedback {FeedbackSubmission minus id/createdAt} -> FeedbackSubmission
 *  GET  /api/feedback                                -> FeedbackSubmission[] (admin)
 *  GET  /api/feedback/summary                        -> { summary: string; themes: {theme:string; count:number}[] } (admin)
 *  GET  /api/feedback/pods                           -> PodFeedbackReport (admin: testers' feedback read from their pods as the admin's own WebID)
 *
 * Alpha testing (the tester's own account, even while playing a persona)
 *  GET  /api/alpha/me                                -> AlphaMe (versions tested, read from the tester's pod)
 *  POST /api/alpha/visit {version, commit?, role?}   -> AlphaMe (records a version in the tester's pod)
 *  POST /api/transcribe (audio/webm body)            -> { text: string } (server-side STT fallback; 501 if not configured)
 */
export const API_PREFIX = '/api';

/* ------------------------------------------------------------------------ */
/* Query assistant                                                           */
/* ------------------------------------------------------------------------ */

export type QueryTarget = 'ontology' | 'data';

export interface QueryChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface QueryChatRequest {
  /** The conversation so far, ending with the user's latest message. */
  messages: QueryChatTurn[];
  /** The query as it stands in the editor, including any edits made by hand. */
  query: string;
  target: QueryTarget;
  /** How many sample records of each class the user's (browser-only) data has. Counts only, never the data. */
  dataSummary?: { classIri: string; count: number }[];
  /** The offline helper's own record of its last query, as it returned it (checked against the ontology and the query before use). */
  offlineState?: unknown;
  /** The account this conversation belongs to: refused (409) if the request arrives signed in as anyone else. */
  account?: string;
}

export interface QueryChatResponse {
  reply: string;
  query: string;
  target: QueryTarget;
  /** Readable headings for result columns, by variable name (without '?'). */
  columns: { variable: string; label: string }[];
  /** True when the offline helper answered instead of Claude. */
  simulated: boolean;
  /** The assistant didn't change the query (it couldn't, or shouldn't): leave the editor as it is. */
  unchanged?: boolean;
  /** Why the offline helper answered: no API key, not a member of the ontology, or the assistant's usage limit. */
  offlineReason?: 'unavailable' | 'not-member' | 'limit';
  /** The offline helper's record of the query it wrote, to send back with the next message. */
  offlineState?: unknown;
}
export * from './workflowYaml.js';
