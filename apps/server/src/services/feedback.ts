import { APP_VERSION, changesFor, changesSince, findRelease, TESTER_ROLE_KEYS, type ChatMessage, type FeedbackQuestion, type FeedbackSubmission, type PodFeedbackFolder, type PodFeedbackReport, type TesterRoleKey, type User } from '@concord/shared';
import { Parser } from 'n3';
import { clock } from '../clock.js';
import { config } from '../config.js';
import { get, HttpError, list, put } from '../db.js';
import { newId } from '../ids.js';
import { FEEDBACK_INTERVIEWER, FEEDBACK_SUMMARY } from '../llm/prompts.js';
import { llm } from '../llm/provider.js';
import { FeedbackSummarySchema, FeedbackTurnSchema } from '../llm/schemas.js';
import { GOVERNANCE_TEMPLATES } from './governance.js';
import { acceptVersion, recordVersion } from './alpha.js';
import { solid } from './solid.js';

const scale = (id: string, section: string, text: string, minLabel: string, maxLabel: string, optional = false): FeedbackQuestion => ({
  id,
  section,
  text,
  type: 'scale',
  min: 1,
  max: 5,
  minLabel,
  maxLabel,
  optional,
});

/** The structured questionnaire. The governance block is the part the ODI most needs answered. */
export const FEEDBACK_QUESTIONS: FeedbackQuestion[] = [
  { id: 'role', section: 'About you', text: 'Which best describes your work with data standards?', type: 'choice', options: ['Standards lead or programme manager', 'Ontologist / data modeller', 'Developer or implementer', 'Domain expert (e.g. local government, charity)', 'Policy or research', 'Other'] },
  scale('familiarity', 'About you', 'How familiar are you with ontologies and OWL?', 'Not at all', 'Expert'),
  scale('elicitation_chat', 'Gathering requirements', 'How useful was the AI interviewer for describing a use case?', 'Not useful', 'Very useful'),
  { id: 'elicitation_pref', section: 'Gathering requirements', text: 'How would you rather contribute requirements?', type: 'multi', options: ['Chat with the AI interviewer', 'Live calls with a co-facilitator bot', 'Uploading call transcripts', 'Writing use cases myself', 'Through my coding agent (MCP)', 'Email or documents'] },
  { id: 'meeting_bot', section: 'Gathering requirements', text: 'Would your group be comfortable with an AI co-facilitator joining Google Meet calls?', type: 'choice', options: ['Yes, leading the call', 'Yes, as a quiet note-taker that asks the odd question', 'Only transcripts after the call', 'No'] },
  scale('agents', 'Gathering requirements', 'How useful would it be for coding agents to read the ontology and report gaps directly?', 'Not useful', 'Very useful', true),
  { id: 'gov_models', section: 'Governance', text: 'Which governance models should the hub offer?', type: 'multi', options: Object.values(GOVERNANCE_TEMPLATES).map((t) => t.name) },
  { id: 'gov_signoff', section: 'Governance', text: 'For a minor change (new terms, nothing breaks), how many sign-offs feel right?', type: 'choice', options: ['None: lazy consensus after a review period', '1 editor', '2 reviewers', 'A member vote'] },
  { id: 'gov_major', section: 'Governance', text: 'Who should approve a major (breaking) version?', type: 'multi', options: ['The steward/chair', 'Editors', 'A vote of members', 'The ODI', 'Implementers who would be affected'] },
  { id: 'gov_odi', section: 'Governance', text: 'What privilege should the ODI hold over standards on the hub?', type: 'choice', options: ['None: the community decides', 'Veto on breaking changes', 'Final say on major releases', 'Depends on the standard'] },
  { id: 'gov_ownership', section: 'Governance', text: 'How should ownership of a standard be transferred?', type: 'choice', options: ['The current owner decides', 'A vote of members', 'Needs ODI approval', 'Not sure'] },
  scale('gov_automation', 'Governance', 'How much of the lifecycle are you comfortable automating (classifying, merging, drafting releases)?', 'As little as possible', 'As much as possible'),
  scale('gov_ai_trust', 'Governance', 'How much do you trust the automatic patch/minor/major classification?', 'Not at all', 'Completely'),
  { id: 'gov_other', section: 'Governance', text: 'Is there a governance rule or role we have not thought of?', type: 'text', optional: true },
  { id: 'formats', section: 'Formats', text: 'Which formats do you want to view or download ontologies in?', type: 'multi', options: ['Turtle', 'LinkML', 'JSON-LD', 'RDF/XML', 'Manchester syntax', 'SHACL', 'JSON Schema', 'A diagram'] },
  scale('overall', 'Overall', 'How likely are you to use this for a real standards project?', 'Very unlikely', 'Very likely'),
  { id: 'valuable', section: 'Overall', text: 'What was most valuable?', type: 'text' },
  { id: 'missing', section: 'Overall', text: 'What is missing or got in your way?', type: 'text' },
  { id: 'comments', section: 'Any other comments', text: 'Any other comments? Anything at all.', type: 'text', optional: true },
];

export type Pathway = FeedbackSubmission['pathway'];

/** How many changes the "what's changed" questionnaire asks about, at most. */
export const MAX_CHANGE_QUESTIONS = 6;

export interface QuestionScope {
  pathway?: Pathway;
  /** The version the tester last tested. */
  since?: string;
  /** The tester role they're giving feedback as. */
  role?: TesterRoleKey | string;
  /** The version they're testing now (defaults to this server's version). */
  version?: string;
}

const asRole = (r: unknown) => (TESTER_ROLE_KEYS.includes(r as TesterRoleKey) ? (r as TesterRoleKey) : undefined);

/**
 * Questions for a returning tester: one about each change since the version
 * they last tested (their role's changes first, features before fixes), then
 * the few overall questions. Fixes are only asked about when they say what to ask.
 */
export function changeQuestions(since: string, role?: TesterRoleKey | string, version: string = APP_VERSION): FeedbackQuestion[] {
  const upTo = findRelease(version)?.version ?? APP_VERSION;
  const changes = changesFor(changesSince(since, upTo), asRole(role)).filter((c) => c.type !== 'fix' || c.ask);
  if (!changes.length) return [];
  const section = `What’s new since ${since}`;
  const asked = changes.slice(0, MAX_CHANGE_QUESTIONS).map((c) =>
    scale(`new:${c.id}`, section, `New in ${c.version}: ${c.ask ?? `how well does this work for you: ${c.title.replace(/[.!]$/, '')}?`}`, 'Not well', 'Very well', true),
  );
  const core = FEEDBACK_QUESTIONS.filter((q) => ['overall', 'missing', 'comments'].includes(q.id));
  return [
    ...asked,
    { id: 'new:other', section, text: `Did anything else change since ${since} that helped or got in your way?`, type: 'text', optional: true },
    ...core,
  ];
}

/** The questionnaire for a pathway. "changes" falls back to the full set when there's nothing new to ask about. */
export function questionsFor(scope: QuestionScope = {}): FeedbackQuestion[] {
  if (scope.pathway === 'changes' && scope.since) {
    const qs = changeQuestions(scope.since, scope.role, scope.version);
    if (qs.length) return qs;
  }
  return FEEDBACK_QUESTIONS;
}

type Answers = FeedbackSubmission['answers'];

/** Interpret a free-text (often spoken) answer for a question. */
export function interpretAnswer(q: FeedbackQuestion, raw: string): string | number | string[] | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  const lc = t.toLowerCase();
  if (q.type === 'scale') {
    const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
    const m = lc.match(/\b([1-5])\b/) ?? lc.match(/\b(one|two|three|four|five)\b/);
    if (m) return Number(words[m[1]] ?? m[1]);
    if (/\b(very|really|extremely|definitely)\b.*\b(useful|likely|comfortable|much|good)\b/.test(lc)) return 5;
    if (/\bnot\b.*\bat all\b|\buseless\b|\bnever\b/.test(lc)) return 1;
    return undefined;
  }
  if (q.type === 'choice' || q.type === 'multi') {
    const opts = q.options ?? [];
    const score = (o: string) =>
      o
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2 && !['the', 'and', 'with', 'for'].includes(w))
        .filter((w) => lc.includes(w)).length;
    const indexed = opts.map((o, i) => ({ o, i, s: score(o) })).filter((x) => x.s > 0);
    const byNumber = [...lc.matchAll(/\b([1-9])\b/g)].map((m) => opts[Number(m[1]) - 1]).filter(Boolean);
    if (q.type === 'choice') {
      if (byNumber.length && t.length < 4) return byNumber[0];
      const best = indexed.sort((a, b) => b.s - a.s)[0];
      return best ? best.o : t;
    }
    const picked = [...new Set([...indexed.map((x) => x.o), ...(t.length < 12 ? byNumber : [])])];
    return picked.length ? picked : [t];
  }
  return t;
}

const unanswered = (questions: FeedbackQuestion[], answers: Answers) => questions.filter((q) => answers[q.id] === undefined || answers[q.id] === '');

function ask(q: FeedbackQuestion) {
  const opts =
    q.type === 'scale'
      ? ` (1 = ${q.minLabel}, 5 = ${q.maxLabel})`
      : q.options
        ? `\n\n${q.options.map((o, i) => `${i + 1}. ${o}`).join('\n')}${q.type === 'multi' ? '\n\nPick as many as you like.' : ''}`
        : '';
  return `${q.text}${opts}${q.optional ? ' You can skip this one.' : ''}`;
}

export interface FeedbackChatInput extends QuestionScope {
  pathway: Pathway;
  messages: ChatMessage[];
  answers: Answers;
  /** Question the client last asked (structured pathway). */
  currentQuestionId?: string;
}

export async function feedbackChat(input: FeedbackChatInput) {
  const answers: Answers = { ...input.answers };
  const questions = questionsFor(input);
  const last = [...input.messages].reverse().find((m) => m.role === 'user');
  const fallback = () => heuristicFeedbackTurn(input, questions, answers, last?.content);
  const { value } = await llm.json({
    task: 'feedback',
    system: FEEDBACK_INTERVIEWER,
    schema: FeedbackTurnSchema,
    effort: 'low',
    maxTokens: 3000,
    messages: [
      {
        role: 'user',
        content: `Pathway: ${input.pathway === 'changes' ? `changes (a returning tester, last tested ${input.since}; ask only about what changed)` : input.pathway}\n\nQuestionnaire:\n${questions.map((q) => `- ${q.id} [${q.section}] (${q.type}${q.optional ? ', optional' : ''}) ${q.text}${q.options ? ` Options: ${q.options.join(' | ')}` : ''}`).join('\n')}\n\nAnswers so far: ${JSON.stringify(answers)}\n\nConversation:\n${input.messages.map((m) => `${m.role === 'assistant' ? 'Interviewer' : 'Tester'}: ${m.content}`).join('\n')}\n\nGive the next turn.`,
      },
    ],
    fallback: () => {
      const r = fallback();
      return { reply: r.reply, answers: Object.entries(r.answers).filter(([k]) => input.answers[k] === undefined).map(([questionId, v]) => ({ questionId, value: Array.isArray(v) ? v.join(' | ') : String(v) })), nextQuestionId: r.nextQuestionId, done: r.done };
    },
  });
  for (const a of value.answers) {
    const q = questions.find((x) => x.id === a.questionId);
    if (a.questionId === 'general') answers.general = [answers.general, a.value].filter(Boolean).join('\n');
    else if (q) answers[q.id] = q.type === 'multi' ? a.value.split(/\s*\|\s*/) : q.type === 'scale' ? (interpretAnswer(q, a.value) ?? a.value) : a.value;
  }
  return { reply: value.reply, answers, done: value.done, nextQuestionId: value.nextQuestionId };
}

function heuristicFeedbackTurn(input: FeedbackChatInput, questions: FeedbackQuestion[], answers: Answers, lastText?: string) {
  if (input.pathway === 'general') {
    if (lastText) answers.general = [answers.general, lastText].filter(Boolean).join('\n');
    const turns = input.messages.filter((m) => m.role === 'user').length;
    if (!lastText) return { reply: 'Tell me anything about your experience: what worked, what was confusing, what you would change. You can type or use the microphone.', answers, done: false, nextQuestionId: undefined };
    if (/^(no|nope|nothing|that's all|that is all|done)\b/i.test(lastText.trim()) || turns >= 4)
      return { reply: 'Thank you, that is really helpful. Your feedback has been recorded for the team.', answers, done: true, nextQuestionId: undefined };
    const follow = [
      'Thanks. Could you say a bit more about why, or give an example of where that happened?',
      'That helps. Is there anything about governance (how changes get approved and released) you would want done differently?',
      'Anything else? Say “that’s all” when you are done.',
    ][Math.min(turns - 1, 2)];
    return { reply: follow, answers, done: false, nextQuestionId: undefined };
  }
  const current = input.currentQuestionId ? questions.find((q) => q.id === input.currentQuestionId) : lastText ? unanswered(questions, answers)[0] : undefined;
  let prefix = '';
  if (current && lastText) {
    const skip = current.optional && /^(skip|pass|no|none|nothing|n\/a)\b/i.test(lastText.trim());
    const v = skip ? '(skipped)' : interpretAnswer(current, lastText);
    if (v === undefined) return { reply: `Sorry, I didn't catch that. ${ask(current)}`, answers, done: false, nextQuestionId: current.id };
    answers[current.id] = v;
    prefix = 'Thanks. ';
  }
  const next = unanswered(questions, answers)[0];
  if (!next) return { reply: 'That’s everything. Thank you! Press “Submit feedback” to send it to the team.', answers, done: true, nextQuestionId: undefined };
  const sectionIntro = !current || current.section !== next.section ? `**${next.section}.** ` : '';
  return { reply: `${prefix}${sectionIntro}${ask(next)}`, answers, done: false, nextQuestionId: next.id };
}

/**
 * Store feedback. `tester` is the tester's own account, which differs from `user`
 * while they play a persona: their copy goes to their own pod, with the app
 * version they tested.
 */
export async function submitFeedback(user: User | undefined, input: Omit<FeedbackSubmission, 'id' | 'createdAt'>, tester: User | undefined = user && !user.simulated ? user : undefined) {
  if (!input.answers || typeof input.answers !== 'object') throw new HttpError(400, 'answers required');
  const appVersion = acceptVersion(input.appVersion);
  const sub: FeedbackSubmission = {
    ...input,
    appVersion,
    sinceVersion: input.sinceVersion && findRelease(input.sinceVersion) ? findRelease(input.sinceVersion)!.version : undefined,
    id: newId('fb'),
    userId: user?.id,
    testerId: tester && tester.id !== user?.id ? tester.id : undefined,
    name: input.name ?? (user?.simulated ? undefined : user?.name),
    createdAt: clock.iso(),
  };
  put('feedback', sub);
  // Testers' own copy of what they said goes in their pod too, with the version they tested.
  let savedTo: { kind: 'solid' | 'local'; url: string } | undefined;
  if (tester) {
    savedTo = await solid.write(tester.id, `feedback/${sub.id}.json`, JSON.stringify(sub, null, 2), 'application/json').catch(() => undefined);
    if (savedTo?.kind === 'solid') await shareFeedbackFolder(tester.id);
    if (appVersion) await recordVersion(tester, { version: appVersion, commit: input.appCommit, role: input.role, feedbackId: sub.id }).catch(() => undefined);
  }
  return { ...sub, savedTo };
}

/* ------------------------------------------------------------------------ */
/* Administrators read testers' feedback in their pods                       */
/* ------------------------------------------------------------------------ */

export const FEEDBACK_FOLDER = 'feedback/';

/**
 * Share a tester's pod feedback folder read-only with the administrators'
 * WebIDs (ADMIN_WEBIDS). Testers are told this on the feedback page.
 */
export async function shareFeedbackFolder(userId: string, opts: { create?: boolean; force?: boolean } = {}) {
  try {
    return await solid.shareRead(userId, FEEDBACK_FOLDER, config.adminWebIds, opts);
  } catch (err) {
    console.warn(`[solid] could not share the feedback folder of ${userId}: ${(err as Error).message}`);
    return 'error' as const;
  }
}

/** Bring every tester's feedback folder in line with ADMIN_WEBIDS (run at start-up: the list may have changed). */
export async function syncFeedbackSharing() {
  if (!solid.enabled) return { shared: 0, unchanged: 0, missing: 0, failed: 0 };
  const counts = { shared: 0, unchanged: 0, missing: 0, failed: 0 };
  for (const pod of solid.pods()) {
    const r = await shareFeedbackFolder(pod.userId);
    if (r === 'shared') counts.shared++;
    else if (r === 'unchanged') counts.unchanged++;
    else if (r === 'missing' || r === 'local') counts.missing++;
    else counts.failed++;
  }
  return counts;
}

const LDP_CONTAINS = 'http://www.w3.org/ns/ldp#contains';
const MAX_POD_ITEMS = 100;

/** Keep only what looks like a feedback submission (the pod is read over the network, so check its shape). */
function asSubmission(doc: unknown): FeedbackSubmission | undefined {
  if (!doc || typeof doc !== 'object') return undefined;
  const d = doc as Record<string, unknown>;
  if (typeof d.id !== 'string' || typeof d.createdAt !== 'string' || !d.answers || typeof d.answers !== 'object' || Array.isArray(d.answers)) return undefined;
  return { ...(d as unknown as FeedbackSubmission), transcript: Array.isArray(d.transcript) ? (d.transcript as FeedbackSubmission['transcript']) : [] };
}

/** Run `fn` over `items`, a few at a time. */
async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

async function readFolder(as: typeof fetch, testerId: string, url: string): Promise<PodFeedbackFolder> {
  const testerName = get<User>('users', testerId)?.name ?? testerId;
  const base = { testerId, testerName, url, items: [] as FeedbackSubmission[] };
  let res: Response;
  try {
    res = await as(url, { headers: { accept: 'text/turtle' } });
  } catch {
    return { ...base, status: 'error' };
  }
  if (res.status === 401 || res.status === 403) return { ...base, status: 'forbidden' };
  if (res.status === 404) return { ...base, status: 'missing' };
  if (!res.ok) return { ...base, status: 'error' };
  let members: string[];
  try {
    const quads = new Parser({ baseIRI: url, format: 'text/turtle' }).parse(await res.text());
    members = [...new Set(quads.filter((q) => q.predicate.value === LDP_CONTAINS && q.object.value.startsWith(url) && q.object.value.endsWith('.json')).map((q) => q.object.value))];
  } catch {
    return { ...base, status: 'error' };
  }
  const items = await pool(members.slice(0, MAX_POD_ITEMS), 4, async (m) => {
    try {
      const r = await as(m, { headers: { accept: 'application/json' } });
      return r.ok ? asSubmission(await r.json()) : undefined;
    } catch {
      return undefined;
    }
  });
  return { ...base, status: 'ok', items: items.filter((x): x is FeedbackSubmission => !!x).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
}

/**
 * Read every tester's feedback folder straight from their pod, as the
 * administrator's own WebID (their DPoP-bound Solid login). What comes back is
 * exactly what the pods' access control lets that WebID read.
 */
export async function readPodFeedback(as: { fetch: typeof fetch; webId: string }): Promise<PodFeedbackReport> {
  if (!solid.enabled) return { readAs: as.webId, readers: config.adminWebIds, folders: [] };
  const pods = solid.pods().filter((p) => !get<User>('users', p.userId)?.simulated);
  const folders = pods.map((p) => ({ testerId: p.userId, url: `${p.podUrl}concord/${FEEDBACK_FOLDER}` }));
  const read = await pool(folders, 4, (f) => readFolder(as.fetch, f.testerId, f.url));
  // Testers who never sent feedback have no folder: leave them out.
  return { readAs: as.webId, readers: config.adminWebIds, folders: read.filter((f) => f.status !== 'missing') };
}

export const listFeedback = () => list<FeedbackSubmission>('feedback').sort((a, b) => b.createdAt.localeCompare(a.createdAt));

export async function summariseFeedback() {
  const subs = listFeedback();
  if (!subs.length) return { summary: 'No feedback yet.', themes: [], count: 0, tallies: {} };
  const tallies: Record<string, Record<string, number>> = {};
  // Questions about specific changes ("new:<change id>") are tallied alongside the standard ones.
  const changeIds = [...new Set(subs.flatMap((s) => Object.keys(s.answers).filter((k) => k.startsWith('new:') && k !== 'new:other')))];
  for (const q of [...FEEDBACK_QUESTIONS.filter((x) => x.type !== 'text'), ...changeIds.map((id) => ({ id }))]) {
    tallies[q.id] = {};
    for (const s of subs) {
      const v = s.answers[q.id];
      for (const x of Array.isArray(v) ? v : v === undefined ? [] : [String(v)]) tallies[q.id][x] = (tallies[q.id][x] ?? 0) + 1;
    }
  }
  const { value } = await llm.json({
    task: 'feedback-summary',
    system: FEEDBACK_SUMMARY,
    schema: FeedbackSummarySchema,
    effort: 'medium',
    messages: [{ role: 'user', content: `Questionnaire tallies: ${JSON.stringify(tallies)}\n\nSubmissions:\n${subs.map((s) => JSON.stringify({ role: s.role, pathway: s.pathway, appVersion: s.appVersion, sinceVersion: s.sinceVersion, answers: s.answers })).join('\n')}` }],
    fallback: () => {
      const texts = subs.flatMap((s) => ['valuable', 'missing', 'comments', 'general', 'gov_other', 'new:other'].map((k) => s.answers[k]).filter((x): x is string => typeof x === 'string' && x !== '(skipped)'));
      const words = new Map<string, number>();
      for (const t of texts)
        for (const w of new Set(t.toLowerCase().match(/[a-z]{5,}/g) ?? [])) if (!['about', 'would', 'there', 'their', 'which', 'think', 'really', 'could', 'should'].includes(w)) words.set(w, (words.get(w) ?? 0) + 1);
      const themes = [...words.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([theme, count]) => ({ theme, count }));
      const top = (id: string) => Object.entries(tallies[id] ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0];
      return {
        summary: `${subs.length} submission(s). Most chosen governance model: ${top('gov_models') ?? '—'}. Preferred ODI privilege: ${top('gov_odi') ?? '—'}. Minor-change sign-off: ${top('gov_signoff') ?? '—'}.`,
        themes,
      };
    },
  });
  return { ...value, count: subs.length, tallies };
}

/** Server-side speech-to-text fallback for browsers without the Web Speech API (e.g. Firefox). */
export async function transcribe(audio: Buffer, mimeType: string): Promise<string> {
  if (config.stt.provider !== 'openai' || !config.stt.openaiKey) throw new HttpError(501, 'Server-side transcription is not configured. Use Chrome, Edge or Safari for voice input, or type instead.');
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), `audio.${mimeType.includes('webm') ? 'webm' : 'm4a'}`);
  form.append('model', 'whisper-1');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${config.stt.openaiKey}` }, body: form });
  if (!res.ok) throw new HttpError(502, `Transcription failed (${res.status})`);
  return ((await res.json()) as { text: string }).text;
}
