/**
 * Typed client for the Concord REST API. Mirrors the route list in
 * packages/shared/src/index.ts. Every call sends cookies and throws ApiError
 * (with the server's `{error}` message when there is one).
 */
import type {
  Publication,
  ActivityItem,
  AlphaMe,
  FeedbackPublicationStatus,
  AgentReport,
  AgentToken,
  OAuthConnection,
  OAuthRequestInfo,
  ChangeOp,
  ChangeRequest,
  ChangeRequestDetail,
  ChangeRequestKind,
  ChangeRequestStatus,
  ChatMessage,
  CompetencyQuestion,
  FeedbackQuestion,
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
  Release,
  ReleaseDetail,
  Role,
  SessionInfo,
  TermView,
  TranscriptLine,
  UseCase,
  UseCaseSections,
  User,
  ValidationReport,
} from '@concord/shared';

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

async function request<T>(method: string, path: string, body?: Json | BodyInit, opts: { raw?: boolean; headers?: Record<string, string> } = {}): Promise<T> {
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
    throw new ApiError(0, OFFLINE_MESSAGE);
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText || 'Request failed'}`;
    let parsed: unknown;
    const text = await res.text().catch(() => '');
    // The Vite dev proxy answers 500 with an empty body when the API is down.
    if ([500, 502, 503, 504].includes(res.status) && !text.trim()) throw new ApiError(503, OFFLINE_MESSAGE);
    try {
      parsed = text ? JSON.parse(text) : undefined;
      if (parsed && typeof parsed === 'object' && 'error' in parsed) {
        const e = (parsed as { error: unknown }).error;
        message = typeof e === 'string' ? e : (e as { message?: string })?.message ?? message;
      }
    } catch {
      // Dev proxy returns plain text/HTML when the server is down.
      if ([500, 502, 503, 504].includes(res.status) && (!text || /ECONNREFUSED|proxy|<html/i.test(text))) {
        throw new ApiError(503, OFFLINE_MESSAGE);
      }
      if (text && text.length < 300) message = text;
    }
    throw new ApiError(res.status, message, parsed);
  }
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

export type MemberWithUser = Membership & { user: User };
export type OntologyDetail = OntologySummary & { members: MemberWithUser[] };
export type UsedBy = { iri: string; label?: string; via: string };
export type TermDetail = TermView & { usedBy: UsedBy[] };
export type InterviewDetail = InterviewSession & { useCase: UseCase };
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
  title: string;
  description: string;
  kind: ChangeRequestKind;
  ops?: ChangeOp[];
  naturalLanguage?: string;
};
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

export const api = {
  // Auth
  session: () => get<SessionInfo>('/api/session'),
  demoLogin: (body: { userId?: string; name?: string; role?: Role } = {}) => post<SessionInfo>('/api/auth/demo', body),
  logout: () => post<Record<string, never>>('/api/auth/logout'),
  personas: () => get<(User & { roles?: Role[] })[]>('/api/personas'),
  oauthUrl: (provider: 'google' | 'github', returnTo?: string) => `/auth/${provider}${qs({ returnTo })}`,
  /** Sign in with a WebID (or the address of a Solid provider). */
  solidLoginUrl: (webId: string, returnTo?: string) => `/auth/solid${qs({ webId, returnTo })}`,

  // Ontologies
  ontologies: () => get<OntologySummary[]>('/api/ontologies'),
  createOntology: (body: NewOntologyInput) => post<OntologySummary>('/api/ontologies', body),
  ontology: (id: string) => get<OntologyDetail>(`/api/ontologies/${e(id)}`),
  view: (id: string, ref = 'working') => get<OntologyView>(`/api/ontologies/${e(id)}/view${qs({ ref })}`),
  term: (id: string, iri: string) => get<TermDetail>(`/api/ontologies/${e(id)}/terms/${e(iri)}`),
  search: (id: string, q: string) => get<TermView[]>(`/api/ontologies/${e(id)}/search${qs({ q })}`),
  sourceUrl: (id: string, format: OutputFormat, ref = 'working', download = false) =>
    `/api/ontologies/${e(id)}/source${qs({ format, ref, download: download ? 1 : undefined })}`,
  source: (id: string, format: OutputFormat, ref = 'working') =>
    request<string>('GET', `/api/ontologies/${e(id)}/source${qs({ format, ref })}`, undefined, { raw: true }),
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
  useCase: (id: string) => get<UseCase>(`/api/use-cases/${e(id)}`),
  updateUseCase: (id: string, body: { sections?: UseCaseSections; competencyQuestions?: CompetencyQuestion[]; status?: UseCase['status'] }) =>
    patch<UseCase>(`/api/use-cases/${e(id)}`, body),
  startInterview: (id: string, useCaseId?: string) => post<InterviewSession>(`/api/ontologies/${e(id)}/interviews`, { useCaseId }),
  interview: (id: string) => get<InterviewDetail>(`/api/interviews/${e(id)}`),
  sendInterviewMessage: (id: string, content: string) =>
    post<{ session: InterviewSession; useCase: UseCase }>(`/api/interviews/${e(id)}/messages`, { content }),
  finishInterview: (id: string) => post<{ useCase: UseCase }>(`/api/interviews/${e(id)}/finish`),
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
  updateMeeting: (id: string, changes: { postPromptsToChat?: boolean; skip?: boolean; approve?: boolean }) => patch<Meeting>(`/api/meetings/${e(id)}`, changes),
  postPrompt: (id: string, index: number) => post<Meeting>(`/api/meetings/${e(id)}/prompts/${index}/post`),
  endMeeting: (id: string) => post<Meeting>(`/api/meetings/${e(id)}/end`),
  dismissBooking: (id: string) => post<Meeting>(`/api/meetings/${e(id)}/bot/dismiss`),
  analyseMeeting: (id: string) => post<Meeting>(`/api/meetings/${e(id)}/analyse`),
  proposeFromMeeting: (id: string) => post<{ useCases: UseCase[]; changeRequest?: ChangeRequest }>(`/api/meetings/${e(id)}/propose`),

  // Change requests
  changeRequests: (id: string, status?: ChangeRequestStatus) => get<ChangeRequest[]>(`/api/ontologies/${e(id)}/change-requests${qs({ status })}`),
  createChangeRequest: (id: string, body: NewChangeRequestInput) => post<ChangeRequestDetail>(`/api/ontologies/${e(id)}/change-requests`, body),
  reportBug: (id: string, body: { title: string; description: string; termIri?: string }) =>
    post<ChangeRequestDetail>(`/api/ontologies/${e(id)}/bug-reports`, body),
  changeRequest: (id: string) => get<ChangeRequestDetail>(`/api/change-requests/${e(id)}`),
  publicReports: (id: string) => get<PublicReport[]>(`/api/ontologies/${e(id)}/public-reports`),
  acceptPublicReport: (id: string, reportId: string) => post<ChangeRequestDetail>(`/api/ontologies/${e(id)}/public-reports/${e(reportId)}/accept`),
  dismissPublicReport: (id: string, reportId: string) => post<{ ok: true }>(`/api/ontologies/${e(id)}/public-reports/${e(reportId)}/dismiss`),
  publication: (id: string) => get<Publication>(`/api/change-requests/${e(id)}/publication`),
  approvePublication: (id: string, fingerprint: string) => post<ChangeRequestDetail>(`/api/change-requests/${e(id)}/approve-publication`, { fingerprint }),
  publicHolds: (id: string) => get<PublicHoldReview[]>(`/api/ontologies/${e(id)}/public-holds`),
  approvePublicHold: (id: string, version: string, fingerprint: string) => post<{ ok: true }>(`/api/ontologies/${e(id)}/public-holds/${e(version)}/approve`, { fingerprint }),
  updateChangeRequest: (id: string, body: { title?: string; description?: string; ops?: ChangeOp[] }) =>
    patch<ChangeRequestDetail>(`/api/change-requests/${e(id)}`, body),
  submitChangeRequest: (id: string) => post<ChangeRequestDetail>(`/api/change-requests/${e(id)}/submit`),
  review: (id: string, decision: ReviewDecision, comment?: string) => post<ChangeRequestDetail>(`/api/change-requests/${e(id)}/reviews`, { decision, comment }),
  voteChangeRequest: (id: string, choice: VoteChoice, comment?: string) => post<ChangeRequestDetail>(`/api/change-requests/${e(id)}/votes`, { choice, comment }),
  merge: (id: string) => post<ChangeRequestDetail>(`/api/change-requests/${e(id)}/merge`),
  withdraw: (id: string) => post<ChangeRequestDetail>(`/api/change-requests/${e(id)}/withdraw`),
  revise: (id: string, instruction: string) => post<ChangeRequestDetail>(`/api/change-requests/${e(id)}/revise`, { instruction }),

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

/* ---------------------------------------------------------------- SSE */

export type MeetingStreamEvent =
  | { type: 'line'; line: TranscriptLine }
  | { type: 'prompt'; prompt: Meeting['facilitatorPrompts'][number] }
  | { type: 'status'; status: Meeting['status']; meeting?: Meeting }
  | { type: 'meeting'; meeting: Meeting };

/**
 * Subscribe to a live meeting. Accepts either `{type:'line', line:{...}}` or a
 * flattened `{type:'line', speaker, text, t}` payload (and likewise for
 * prompts), so the server can choose either shape. Returns an unsubscribe fn.
 */
export function streamMeeting(meetingId: string, onEvent: (ev: MeetingStreamEvent) => void, onError?: () => void): () => void {
  if (typeof EventSource === 'undefined') return () => {};
  const es = new EventSource(`/api/meetings/${e(meetingId)}/stream`, { withCredentials: true });
  const handle = (raw: string, fallbackType?: string) => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    const type = (data.type as string) ?? fallbackType;
    if (type === 'line') {
      const line = (data.line as TranscriptLine) ?? { speaker: String(data.speaker ?? ''), text: String(data.text ?? ''), t: data.t as number | undefined };
      onEvent({ type: 'line', line });
    } else if (type === 'prompt') {
      const prompt = (data.prompt as Meeting['facilitatorPrompts'][number]) ?? {
        at: String(data.at ?? new Date().toISOString()),
        t: data.t as number | undefined,
        text: String(data.text ?? ''),
        posted: Boolean(data.posted),
      };
      onEvent({ type: 'prompt', prompt });
    } else if (type === 'status') {
      onEvent({ type: 'status', status: data.status as Meeting['status'], meeting: data.meeting as Meeting | undefined });
    } else if (type === 'meeting' && data.meeting) {
      onEvent({ type: 'meeting', meeting: data.meeting as Meeting });
    }
  };
  es.onmessage = (m) => handle(m.data);
  for (const t of ['line', 'prompt', 'status', 'meeting']) es.addEventListener(t, (m) => handle((m as MessageEvent).data, t));
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) onError?.();
  };
  return () => es.close();
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
