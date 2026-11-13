/**
 * Typed client for the Concord REST API. Mirrors the route list in
 * packages/shared/src/index.ts. Every call sends cookies and throws ApiError
 * (with the server's `{error}` message when there is one).
 */
import type {
  GithubAppStatus,
  Publication,
  ActivityItem,
  AlphaMe,
  FeedbackPublicationStatus,
  AgentReport,
  AgentToken,
  AutopilotSettings,
  ConnectedApp,
  OAuthConnection,
  OAuthRequestInfo,
  ChangeOp,
  CodeListEditInput,
  ChangeRequest,
  ChangeRequestDetail,
  ChangeRequestKind,
  ChangeRequestStatus,
  ChatMessage,
  CompetencyQuestion,
  FeedbackQuestion,
  ForkCheck,
  Federation,
  FederationCheck,
  FederationComparison,
  FederationDetail,
  FederationMember,
  FederationRelease,
  FederationReleasePlan,
  ForkSummary,
  ForkSyncResult,
  FeedbackSubmission,
  PodFeedbackReport,
  GovernancePolicy,
  GovernanceTemplateId,
  InterviewSession,
  MeetBotInfo,
  Meeting,
  Membership,
  OntologySummary,
  OntologyView,
  OutputFormat,
  PublicReport,
  PublicHoldReview,
  QueryChatRequest,
  QueryChatResponse,
  Release,
  ReleaseDetail,
  Role,
  SessionInfo,
  TermEditInput,
  TermView,
  TranscriptLine,
  AnonymisedDraft,
  PublicUseCase,
  RequirementsDocument,
  UseCase,
  UseCaseDetail,
  UseCaseLink,
  UseCaseSections,
  UseCaseStatus,
  UseCaseVisibility,
  User,
  ValidationReport,
} from '@concord/shared';
import { setOffline } from './lib/offline';

export class ApiError extends Error {
  status: number;
  body?: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
  /** True when the server could not be reached at all. */
  get offline() {
    return this.status === 0 || this.status === 502 || this.status === 503 || this.status === 504;
  }
}

const OFFLINE_MESSAGE =
  "Can't reach the Concord server. It may be starting up or offline — try again in a moment.";

type Json = Record<string, unknown> | unknown[] | undefined;

async function request<T>(method: string, path: string, body?: Json | BodyInit, opts: { raw?: boolean; headers?: Record<string, string>; onHeaders?: (h: Headers) => void } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: opts.raw ? '*/*' : 'application/json', ...opts.headers };
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof FormData || typeof body === 'string' || body instanceof ArrayBuffer) {
      payload = body as BodyInit;
    } else {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: 'include' });
  } catch {
    setOffline(true);
    throw new ApiError(0, OFFLINE_MESSAGE);
  }
  // The same outages ApiError.offline counts: no answer, or a gateway that couldn't reach the server.
  setOffline([502, 503, 504].includes(res.status));
  if (!res.ok) {
    let message = `${res.status} ${res.statusText || 'Request failed'}`;
    let parsed: unknown;
    const text = await res.text().catch(() => '');
    // The Vite dev proxy answers 500 with an empty body when the API is down.
    if ([500, 502, 503, 504].includes(res.status) && !text.trim()) {
      setOffline(true);
      throw new ApiError(503, OFFLINE_MESSAGE);
    }
    try {
      parsed = text ? JSON.parse(text) : undefined;
      if (parsed && typeof parsed === 'object' && 'error' in parsed) {
        const e = (parsed as { error: unknown }).error;
        message = typeof e === 'string' ? e : (e as { message?: string })?.message ?? message;
      }
    } catch {
      // Dev proxy returns plain text/HTML when the server is down.
      if ([500, 502, 503, 504].includes(res.status) && (!text || /ECONNREFUSED|proxy|<html/i.test(text))) {
        setOffline(true);
        throw new ApiError(503, OFFLINE_MESSAGE);
      }
      if (text && text.length < 300) message = text;
    }
    throw new ApiError(res.status, message, parsed);
  }
  opts.onHeaders?.(res.headers);
  if (opts.raw) return (await res.text()) as T;
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(res.status, 'The server sent an unexpected response.');
  }
}

const get = <T>(p: string) => request<T>('GET', p);
const post = <T>(p: string, b?: Json) => request<T>('POST', p, b ?? {});
const put = <T>(p: string, b?: Json) => request<T>('PUT', p, b ?? {});
const patch = <T>(p: string, b?: Json) => request<T>('PATCH', p, b ?? {});
const del = <T>(p: string) => request<T>('DELETE', p);
const e = encodeURIComponent;

function qs(params: Record<string, string | number | undefined | null>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
}

/* ---------------------------------------------------------------- types */

export type MemberWithUser = Membership & { user: User; lastActiveAt?: string };
export type OntologyDetail = OntologySummary & { members: MemberWithUser[] };
export type UsedBy = { iri: string; label?: string; via: string };
export type TermDetail = TermView & { usedBy: UsedBy[] };
export type InterviewDetail = InterviewSession & { useCase: UseCaseDetail };
export type RequirementsSummary = Pick<RequirementsDocument, 'id' | 'version' | 'status' | 'generatedAt' | 'title' | 'releaseId' | 'coverage'>;
export type NewUseCaseLink = Pick<UseCaseLink, 'type' | 'relation'> & { id?: string; url?: string; label?: string };
export type DataValidation = {
  ontology: string;
  version: string;
  shapes?: string;
  conforms: boolean;
  valid: boolean;
  triples: number;
  summary: { violations: number; warnings: number; infos: number; termErrors: number; termWarnings: number };
  results: { focusNode: string; path?: string; value?: string; severity: 'Violation' | 'Warning' | 'Info'; constraint: string; shape?: string; message?: string }[];
  terms: { severity: 'error' | 'warning'; message: string; term?: string }[];
  /** More results or term issues than the report lists (1,000 of each); the summary counts them all. */
  truncated?: true;
};
export type SparqlResult = { head: { vars: string[] }; rows: Record<string, string>[] };
export type FeedbackAnswers = Record<string, string | number | string[]>;
/** Which questionnaire: `pathway: 'changes'` asks about what changed since `since`, for a tester in `role`. */
export type FeedbackScope = { pathway?: FeedbackSubmission['pathway']; since?: string; role?: string; version?: string };
export type FeedbackChatResponse = { reply: string; answers: FeedbackAnswers; done: boolean; nextQuestionId?: string };
export type FeedbackSummary = { summary: string; themes: { theme: string; count: number }[] };
export type NewOntologyInput = {
  title: string;
  description: string;
  prefix: string;
  namespace?: string;
  domain?: string;
  governanceTemplate?: GovernanceTemplateId;
  /** List me as the ontology's creator (public). Off unless set. */
  creditCreator?: boolean;
};
export type NewChangeRequestInput = {
  submit?: boolean;
  title: string;
  description: string;
  kind: ChangeRequestKind;
  ops?: ChangeOp[];
  naturalLanguage?: string;
  /** Use cases this change addresses. */
  useCaseIds?: string[];
};
export type ForkDetail = ForkSummary & { history: { sha: string; author: string; date: string; subject: string }[] };
export type ForkEditResult = {
  fork: ForkSummary;
  ops: ChangeOp[];
  terms: ForkSummary['terms'];
  warnings: string[];
  validation: { passed: boolean; reasoner: 'owl' | 'structural'; consistent: boolean; errors: string[]; warnings: string[] };
};
export type { ForkSyncResult };
export type ReviewDecision = 'approve' | 'request-changes' | 'object' | 'comment';
export type VoteChoice = 'yes' | 'no' | 'abstain';

/* ---------------------------------------------------------------- routes */

/** A public feedback summary waiting for an administrator's decision. */
export interface PublicationNeedingAdmin {
  id: string;
  /** Why it's waiting: a post whose outcome is unknown, a withdrawal, a triage comment whose outcome is unknown, or a summary out of the triage queue. */
  kind: 'post-unknown' | 'withdrawal' | 'comment-unknown' | 'triage-parked';
  /** Sent back with a decision, so a decision about an older state is refused. */
  ref: string;
  state: 'needs-admin' | 'withdrawing' | 'filed';
  summary: string;
  repo: string;
  marker: string;
  issue?: { number: number; url: string };
  candidates: { number: number; url: string }[];
  reason?: string;
  feedbackDeleted: boolean;
  createdAt: string;
}

export interface MediaIndex {
  release: { tag: string; name?: string; publishedAt?: string; url: string } | null;
  files: { name: string; size: number; url: string }[];
  /** The server couldn't look the videos up and had none kept from before. */
  unavailable?: boolean;
}

/** The feature clips' playlist (concord-clips.json, written by walkthrough/record.ts). */
export interface ClipManifest {
  title?: string;
  clips: { id: string; file: string; title: string; summary?: string; duration?: number }[];
}

export const api = {
  // Auth
  session: () => get<SessionInfo>('/api/session'),
  demoLogin: (body: { userId?: string; name?: string; role?: Role } = {}) => post<SessionInfo>('/api/auth/demo', body),
  /** Ends this browser's session; with `session`, only if it is still that one (see SessionInfo.sessionId). */
  logout: (session?: string) => post<{ ended: boolean }>('/api/auth/logout', session ? { session } : {}),
  /** The walkthrough videos for the latest release (see /welcome). */
  mediaIndex: () => get<MediaIndex>('/api/media/index.json'),
  /** The feature clips' playlist, when the release has one. */
  mediaClips: () => get<ClipManifest>('/api/media/concord-clips.json'),
  personas: () => get<(User & { roles?: Role[] })[]>('/api/personas'),
  oauthUrl: (provider: 'google' | 'github', returnTo?: string) => `/auth/${provider}${qs({ returnTo })}`,
  /** Sign in with a WebID (or the address of a Solid provider). */
  solidLoginUrl: (webId: string, returnTo?: string) => `/auth/solid${qs({ webId, returnTo })}`,

  // Ontologies
  ontologies: () => get<OntologySummary[]>('/api/ontologies'),
  createOntology: (body: NewOntologyInput) => post<OntologySummary>('/api/ontologies', body),
  updateOntology: (id: string, body: { title?: string; description?: string; domain?: string }) => patch<OntologySummary>(`/api/ontologies/${e(id)}`, body),
  ontology: (id: string) => get<OntologyDetail>(`/api/ontologies/${e(id)}`),
  queryChat: (id: string, body: QueryChatRequest) => post<QueryChatResponse>(`/api/ontologies/${e(id)}/query-chat`, body as unknown as Json),
  view: (id: string, ref = 'working') => get<OntologyView>(`/api/ontologies/${e(id)}/view${qs({ ref })}`),
  examples: (id: string, version: string) => get<{ available: boolean }>(`/api/ontologies/${e(id)}/examples/${e(version)}`),
  term: (id: string, iri: string) => get<TermDetail>(`/api/ontologies/${e(id)}/terms/${e(iri)}`),
  search: (id: string, q: string) => get<TermView[]>(`/api/ontologies/${e(id)}/search${qs({ q })}`),
  sourceUrl: (id: string, format: OutputFormat, ref = 'working', download = false) =>
    `/api/ontologies/${e(id)}/source${qs({ format, ref, download: download ? 1 : undefined })}`,
  source: (id: string, format: OutputFormat, ref = 'working') =>
    request<string>('GET', `/api/ontologies/${e(id)}/source${qs({ format, ref })}`, undefined, { raw: true }),
  /** A version's source, with the working draft's revision when the server says it (signed in). */
  sourceWithRevision: async (id: string, format: OutputFormat, ref = 'working') => {
    let revision: string | undefined;
    const text = await request<string>('GET', `/api/ontologies/${e(id)}/source${qs({ format, ref })}`, undefined, {
      raw: true,
      onHeaders: (h) => (revision = h.get('X-Concord-Revision') ?? undefined),
    });
    return { text, revision };
  },
  /** The working draft as Turtle, with the revision it is (to compare with a validation report). */
  validation: (id: string, ref = 'working') => get<ValidationReport>(`/api/ontologies/${e(id)}/validation${qs({ ref })}`),
  sparql: (id: string, query: string) => post<SparqlResult>(`/api/ontologies/${e(id)}/sparql`, { query }),

  // Members & governance
  setMemberRoles: (id: string, userId: string, roles: Role[]) => put<Membership>(`/api/ontologies/${e(id)}/members/${e(userId)}`, { roles }),
  removeMember: (id: string, userId: string) => del<unknown>(`/api/ontologies/${e(id)}/members/${e(userId)}`),
  governanceTemplates: () => get<GovernancePolicy[]>('/api/governance/templates'),
  setGovernance: (id: string, policy: GovernancePolicy) => put<OntologySummary>(`/api/ontologies/${e(id)}/governance`, { policy }),
  transferOwnership: (id: string, toUserId: string) =>
    post<{ status: string; voteId?: string }>(`/api/ontologies/${e(id)}/ownership-transfer`, { toUserId }),

  // Use cases & interviews
  useCases: (id: string) => get<UseCase[]>(`/api/ontologies/${e(id)}/use-cases`),
  useCase: (id: string) => get<UseCaseDetail>(`/api/use-cases/${e(id)}`),
  updateUseCase: (id: string, body: { sections?: UseCaseSections; competencyQuestions?: CompetencyQuestion[]; status?: UseCaseStatus }) =>
    patch<UseCaseDetail>(`/api/use-cases/${e(id)}`, body),
  setUseCaseVisibility: (id: string, visibility: UseCaseVisibility) => post<UseCaseDetail>(`/api/use-cases/${e(id)}/visibility`, { visibility }),
  submitUseCase: (id: string) => post<UseCaseDetail>(`/api/use-cases/${e(id)}/submit`),
  withdrawUseCase: (id: string) => post<UseCaseDetail>(`/api/use-cases/${e(id)}/withdraw`),
  triageUseCase: (id: string, status: UseCaseStatus, note?: string) => post<UseCaseDetail>(`/api/use-cases/${e(id)}/triage`, { status, note }),
  addUseCaseLink: (id: string, link: NewUseCaseLink) => post<UseCaseDetail>(`/api/use-cases/${e(id)}/links`, link),
  removeUseCaseLink: (id: string, target: string) => del<UseCaseDetail>(`/api/use-cases/${e(id)}/links/${e(target)}`),
  proposeAnonymised: (id: string) => post<UseCaseDetail>(`/api/use-cases/${e(id)}/anonymise`),
  publishAnonymised: (id: string, draft?: Partial<AnonymisedDraft>) =>
    post<{ original: UseCaseDetail; published: UseCaseDetail }>(`/api/use-cases/${e(id)}/anonymise/publish`, { draft }),
  declineAnonymised: (id: string) => post<UseCaseDetail>(`/api/use-cases/${e(id)}/anonymise/decline`),
  publicUseCases: (id: string) => get<PublicUseCase[]>(`/api/ontologies/${e(id)}/public-use-cases`),
  requirementsDocs: (id: string) => get<RequirementsSummary[]>(`/api/ontologies/${e(id)}/requirements`),
  requirementsDoc: (id: string, version: string) => get<RequirementsDocument>(`/api/ontologies/${e(id)}/requirements/${e(version)}`),
  requirementsMarkdown: (id: string, version: string) => request<string>('GET', `/api/ontologies/${e(id)}/requirements/${e(version)}/markdown`, undefined, { raw: true }),
  generateRequirements: (releaseId: string) => post<RequirementsDocument>(`/api/releases/${e(releaseId)}/requirements`),
  startInterview: (id: string, useCaseId?: string) => post<InterviewSession>(`/api/ontologies/${e(id)}/interviews`, { useCaseId }),
  interview: (id: string) => get<InterviewDetail>(`/api/interviews/${e(id)}`),
  sendInterviewMessage: (id: string, content: string) =>
    post<{ session: InterviewSession; useCase: UseCaseDetail }>(`/api/interviews/${e(id)}/messages`, { content }),
  finishInterview: (id: string) => post<{ useCase: UseCaseDetail }>(`/api/interviews/${e(id)}/finish`),
  synthesise: (id: string, useCaseIds?: string[]) => post<ChangeRequest>(`/api/ontologies/${e(id)}/synthesise`, { useCaseIds }),

  // Meetings
  meetings: (id: string) => get<Meeting[]>(`/api/ontologies/${e(id)}/meetings`),
  uploadMeeting: (id: string, title: string, transcript: string) => post<Meeting>(`/api/ontologies/${e(id)}/meetings/upload`, { title, transcript }),
  inviteBot: (id: string, title: string, meetingUrl: string, postPromptsToChat = false) => post<Meeting>(`/api/ontologies/${e(id)}/meetings/bot`, { title, meetingUrl, postPromptsToChat }),
  scheduleFromInvite: (id: string, ics: string, postPromptsToChat = false) => post<{ meetings: Meeting[]; cancelled: number; cancelRetrying: number }>(`/api/ontologies/${e(id)}/meetings/calendar`, { ics, postPromptsToChat }),
  simulateMeeting: (id: string, title: string, postPromptsToChat = false) => post<Meeting>(`/api/ontologies/${e(id)}/meetings/simulate`, { title, postPromptsToChat }),
  meetBot: () => get<MeetBotInfo>('/api/meet-bot'),
  syncMeetBot: () => post<MeetBotInfo>('/api/meet-bot/sync'),
  meeting: (id: string) => get<Meeting>(`/api/meetings/${e(id)}`),
  /** A live call's news since the page's `from` transcript lines: the meeting without its transcript, and the lines from `from` on. */
  meetingUpdates: (id: string, from: number) => get<{ meeting: Meeting; from: number; lines: TranscriptLine[] }>(`/api/meetings/${e(id)}/updates?from=${from}`),
  updateMeeting: (id: string, changes: { postPromptsToChat?: boolean; skip?: boolean; approve?: boolean }) => patch<Meeting>(`/api/meetings/${e(id)}`, changes),
  postPrompt: (id: string, index: number) => post<Meeting>(`/api/meetings/${e(id)}/prompts/${index}/post`),
  endMeeting: (id: string) => post<Meeting>(`/api/meetings/${e(id)}/end`),
  dismissBooking: (id: string) => post<Meeting>(`/api/meetings/${e(id)}/bot/dismiss`),
  analyseMeeting: (id: string) => post<Meeting>(`/api/meetings/${e(id)}/analyse`),
  proposeFromMeeting: (id: string) => post<{ useCases: UseCase[] }>(`/api/meetings/${e(id)}/propose`),

  // Change requests
  changeRequests: (id: string, status?: ChangeRequestStatus) => get<ChangeRequest[]>(`/api/ontologies/${e(id)}/change-requests${qs({ status })}`),
  createChangeRequest: (id: string, body: NewChangeRequestInput) => post<ChangeRequestDetail>(`/api/ontologies/${e(id)}/change-requests`, body),
  reportBug: (id: string, body: { title: string; description: string; termIri?: string }) =>
    post<ChangeRequestDetail>(`/api/ontologies/${e(id)}/bug-reports`, body),
  proposeCodeListEdit: (id: string, body: CodeListEditInput) => post<ChangeRequestDetail>(`/api/ontologies/${e(id)}/code-list-edits`, { ...body }),
  proposeTermEdit: (id: string, body: TermEditInput) => post<ChangeRequestDetail>(`/api/ontologies/${e(id)}/term-edits`, body),
  changeRequest: (id: string) => get<ChangeRequestDetail>(`/api/change-requests/${e(id)}`),
  turtleDiff: (id: string) => get<{ before: string; after: string } | { error: string }>(`/api/change-requests/${e(id)}/turtle-diff`),
  publicReports: (id: string) => get<PublicReport[]>(`/api/ontologies/${e(id)}/public-reports`),
  acceptPublicReport: (id: string, reportId: string) => post<ChangeRequestDetail>(`/api/ontologies/${e(id)}/public-reports/${e(reportId)}/accept`),
  dismissPublicReport: (id: string, reportId: string) => post<{ ok: true }>(`/api/ontologies/${e(id)}/public-reports/${e(reportId)}/dismiss`),
  publication: (id: string) => get<Publication>(`/api/change-requests/${e(id)}/publication`),
  approvePublication: (id: string, fingerprint: string) => post<ChangeRequestDetail>(`/api/change-requests/${e(id)}/approve-publication`, { fingerprint }),
  publicHolds: (id: string) => get<PublicHoldReview[]>(`/api/ontologies/${e(id)}/public-holds`),
  approvePublicHold: (id: string, version: string, fingerprint: string) => post<{ ok: true }>(`/api/ontologies/${e(id)}/public-holds/${e(version)}/approve`, { fingerprint }),
  updateChangeRequest: (id: string, body: { title?: string; description?: string; ops?: ChangeOp[]; basis?: string }) =>
    patch<ChangeRequestDetail>(`/api/change-requests/${e(id)}`, body),
  submitChangeRequest: (id: string) => post<ChangeRequestDetail>(`/api/change-requests/${e(id)}/submit`),
  /** `round` is the review round of the version on screen; the server refuses a decision on one that has since changed. */
  review: (id: string, decision: ReviewDecision, comment: string | undefined, round: number) => post<ChangeRequestDetail>(`/api/change-requests/${e(id)}/reviews`, { decision, comment, round }),
  voteChangeRequest: (id: string, choice: VoteChoice, comment: string | undefined, round: number) => post<ChangeRequestDetail>(`/api/change-requests/${e(id)}/votes`, { choice, comment, round }),
  merge: (id: string) => post<ChangeRequestDetail>(`/api/change-requests/${e(id)}/merge`),
  withdraw: (id: string) => post<ChangeRequestDetail>(`/api/change-requests/${e(id)}/withdraw`),
  revise: (id: string, instruction: string) => post<ChangeRequestDetail>(`/api/change-requests/${e(id)}/revise`, { instruction }),

  // Federations (Advanced features)
  federations: () => get<Federation[]>('/api/federations'),
  federation: (fed: string) => get<FederationDetail>(`/api/federations/${e(fed)}`),
  createFederation: (body: { title: string; description?: string; members?: FederationMember[]; parentId?: string }) => post<FederationDetail>('/api/federations', body as unknown as Json),
  updateFederation: (fed: string, body: { title?: string; description?: string; members?: FederationMember[]; parentId?: string | null }) => patch<FederationDetail>(`/api/federations/${e(fed)}`, body as unknown as Json),
  forkFederation: (fed: string, body: { title?: string; kind: 'development' | 'divergent' }) => post<FederationDetail>(`/api/federations/${e(fed)}/forks`, body),
  proposeFederationBack: (fed: string, note?: string) => post<FederationDetail>(`/api/federations/${e(fed)}/propose-back`, { note }),
  decideFederationProposal: (fed: string, proposal: string, accept: boolean) => post<FederationDetail>(`/api/federations/${e(fed)}/proposals/${e(proposal)}`, { accept }),
  proposeUpstream: (fed: string, body: { ontologyId: string; terms: string[]; title?: string; description?: string }) =>
    post<{ changeRequest: ChangeRequestDetail; mapping: Record<string, string>; warnings: string[] }>(`/api/federations/${e(fed)}/upstream`, body),
  compareFederations: (fed: string, other: string) => get<FederationComparison>(`/api/federations/${e(fed)}/compare/${e(other)}`),
  federationCheck: (fed: string) => get<FederationCheck>(`/api/federations/${e(fed)}/check`),
  federationReleases: (fed: string) => get<Omit<FederationRelease, 'manifest' | 'shapes'>[]>(`/api/federations/${e(fed)}/releases`),
  federationReleasePlan: (fed: string) => get<FederationReleasePlan>(`/api/federations/${e(fed)}/release-plan`),
  releaseFederation: (fed: string, body: { version?: string; notes?: string }) => post<Omit<FederationRelease, 'manifest' | 'shapes'>>(`/api/federations/${e(fed)}/releases`, body),
  ontologyFederations: (id: string) => get<(Federation & { committed: boolean })[]>(`/api/ontologies/${e(id)}/federations`),
  setFederationCommitment: (id: string, fed: string, committed: boolean) => post<FederationDetail>(`/api/ontologies/${e(id)}/federations/${e(fed)}/commitment`, { committed }),

  // Development forks
  forks: (id: string) => get<ForkSummary[]>(`/api/ontologies/${e(id)}/forks`),
  myForks: () => get<ForkSummary[]>('/api/forks'),
  createFork: (id: string, body: { name: string; purpose?: string }) => post<ForkDetail>(`/api/ontologies/${e(id)}/forks`, body),
  fork: (id: string, fork: string) => get<ForkDetail>(`/api/ontologies/${e(id)}/forks/${e(fork)}`),
  checkFork: (id: string, fork: string) => get<ForkCheck>(`/api/ontologies/${e(id)}/forks/${e(fork)}/check`),
  editFork: (id: string, fork: string, body: { description?: string; ops?: ChangeOp[]; message?: string }) =>
    post<ForkEditResult>(`/api/ontologies/${e(id)}/forks/${e(fork)}/edits`, body),
  proposeFork: (id: string, fork: string, body: { title?: string; description?: string } = {}) =>
    post<{ fork: ForkSummary; changeRequest: ChangeRequestDetail }>(`/api/ontologies/${e(id)}/forks/${e(fork)}/propose`, body),
  syncFork: (id: string, fork: string) => post<ForkSyncResult>(`/api/ontologies/${e(id)}/forks/${e(fork)}/sync`),
  discardForkChanges: (id: string, fork: string, terms: string[] | 'all', includeRelated = false) =>
    post<ForkSummary>(`/api/ontologies/${e(id)}/forks/${e(fork)}/discard`, terms === 'all' ? { all: true } : { terms, includeRelated }),
  closeFork: (id: string, fork: string) => post<ForkSummary>(`/api/ontologies/${e(id)}/forks/${e(fork)}/close`),

  // Releases
  /** POST data to the ontology's public IRI to validate it (see apps/server/src/public/validate.ts). */
  validateData: (slug: string, version: string, data: string, mediaType?: string) =>
    request<DataValidation>('POST', `/def/${e(slug)}/${e(version)}`, data, { headers: mediaType ? { 'Content-Type': mediaType } : { 'Content-Type': 'text/plain' } }),
  validationReportTurtle: (slug: string, version: string, data: string, mediaType?: string) =>
    request<string>('POST', `/def/${e(slug)}/${e(version)}`, data, { raw: true, headers: { Accept: 'text/turtle', 'Content-Type': mediaType ?? 'text/plain' } }),
  releases: (id: string) => get<Release[]>(`/api/ontologies/${e(id)}/releases`),
  draftRelease: (id: string, notes?: string) => post<ReleaseDetail>(`/api/ontologies/${e(id)}/releases`, { notes }),
  release: (id: string) => get<ReleaseDetail>(`/api/releases/${e(id)}`),
  voteRelease: (id: string, choice: VoteChoice, comment?: string) => post<ReleaseDetail>(`/api/releases/${e(id)}/votes`, { choice, comment }),
  publishRelease: (id: string) => post<ReleaseDetail>(`/api/releases/${e(id)}/publish`),

  // Agents
  agentTokens: () => get<AgentToken[]>('/api/agent-tokens'),
  createAgentToken: (name: string) => post<AgentToken>('/api/agent-tokens', { name }),
  deleteAgentToken: (id: string) => del<unknown>(`/api/agent-tokens/${e(id)}`),
  // MCP clients connected with OAuth
  oauthRequest: (id: string) => get<OAuthRequestInfo>(`/api/oauth/requests/${e(id)}`),
  approveOAuth: (id: string) => post<{ redirect: string }>(`/api/oauth/requests/${e(id)}/approve`),
  denyOAuth: (id: string) => post<{ redirect: string }>(`/api/oauth/requests/${e(id)}/deny`),
  oauthConnections: () => get<OAuthConnection[]>('/api/oauth/connections'),
  disconnectOAuth: (id: string) => del<unknown>(`/api/oauth/connections/${e(id)}`),
  agentReports: (id: string) => get<AgentReport[]>(`/api/ontologies/${e(id)}/agent-reports`),
  createAgentReport: (id: string, body: Partial<AgentReport>) => post<AgentReport>(`/api/ontologies/${e(id)}/agent-reports`, body as Json),

  // Connected apps (CI checks against proposed changes, autopilot)
  apps: (id: string) => get<ConnectedApp[]>(`/api/ontologies/${e(id)}/apps`),
  createApp: (id: string, body: { name: string; repo?: string; autopilot?: Partial<AutopilotSettings> }) => post<ConnectedApp>(`/api/ontologies/${e(id)}/apps`, body),
  updateApp: (appId: string, body: { name?: string; repo?: string; autopilot?: Partial<AutopilotSettings> }) => patch<ConnectedApp>(`/api/apps/${e(appId)}`, body),
  rotateAppToken: (appId: string) => post<ConnectedApp>(`/api/apps/${e(appId)}/token`),
  deleteApp: (appId: string) => del<unknown>(`/api/apps/${e(appId)}`),
  // Connecting an app through the Concord GitHub App instead of a token
  githubApp: () => get<GithubAppStatus>('/api/github-app'),
  startGithubInstall: (appId: string) => post<{ url: string }>(`/api/apps/${e(appId)}/github/install`),
  unlinkGithub: (appId: string) => del<ConnectedApp>(`/api/apps/${e(appId)}/github`),
  openWorkflowPr: (appId: string) => post<{ app: ConnectedApp; alreadyThere?: boolean }>(`/api/apps/${e(appId)}/github/workflow-pr`),
  runGithubNow: (appId: string) => post<ConnectedApp>(`/api/apps/${e(appId)}/github/run`),

  // Simulation
  simulationStep: (ontologyId: string) => post<{ events: ActivityItem[] }>('/api/simulation/step', { ontologyId }),
  advanceClock: (advanceDays: number) => post<SessionInfo>('/api/simulation/clock', { advanceDays }),
  resetSimulation: () => post<Record<string, never>>('/api/simulation/reset'),

  // Activity
  activity: (ontologyId?: string) => get<ActivityItem[]>(`/api/activity${qs({ ontologyId })}`),

  // Feedback
  feedbackQuestions: (scope: FeedbackScope = {}) => get<FeedbackQuestion[]>(`/api/feedback/questions${qs({ pathway: scope.pathway, since: scope.since, role: scope.role, version: scope.version })}`),
  feedbackChat: (body: { pathway: FeedbackSubmission['pathway']; messages: ChatMessage[]; answers: FeedbackAnswers; currentQuestionId?: string } & FeedbackScope) =>
    post<FeedbackChatResponse>('/api/feedback/chat', body),
  submitFeedback: (body: Omit<FeedbackSubmission, 'id' | 'createdAt'>) =>
    post<FeedbackSubmission & { savedTo?: { kind: 'solid' | 'local'; url: string } }>('/api/feedback', body as unknown as Json),
  feedbackPublishing: () => get<{ enabled: boolean; noticeVersion: number }>('/api/feedback/publishing'),
  withdrawFeedbackPublication: (feedbackId: string, token: string) => post<FeedbackPublicationStatus>(`/api/feedback/${encodeURIComponent(feedbackId)}/publication/withdraw`, { token }),
  resolveFeedbackPublication: (
    feedbackId: string,
    ref: string,
    body: { action: 'check' | 'repost' | 'confirm' } | { action: 'adopt'; issue: number } | { action: 'comment'; comment: number },
  ) => post<FeedbackPublicationStatus>(`/api/feedback/${encodeURIComponent(feedbackId)}/publication/resolve`, { ...body, ref }),
  publicationsNeedingAdmin: () => get<PublicationNeedingAdmin[]>('/api/feedback/publications/attention'),
  feedback: () => get<FeedbackSubmission[]>('/api/feedback'),
  feedbackSummary: () => get<FeedbackSummary>('/api/feedback/summary'),
  podFeedback: () => get<PodFeedbackReport>('/api/feedback/pods'),
  // Alpha testing: the tester's own account and the app versions they've tested
  alphaMe: () => get<AlphaMe>('/api/alpha/me'),
  alphaVisit: (body: { version: string; commit?: string; role?: string }) => post<AlphaMe>('/api/alpha/visit', body),
  transcribe: (audio: Blob) => request<{ text: string }>('POST', '/api/transcribe', audio, { headers: { 'Content-Type': audio.type || 'audio/webm' } }),
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
