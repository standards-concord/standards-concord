import { EventEmitter } from 'node:events';
import type { ChangeRequest, FacilitatorPrompt, Meeting, MeetingAnalysis, OntologyProject, TranscriptLine, UseCase, User } from '@concord/shared';
import { clock } from '../clock.js';
import { config } from '../config.js';
import { get, HttpError, list, mustGet, put } from '../db.js';
import { newId, newToken } from '../ids.js';
import { ontologyDigest } from '../llm/context.js';
import { FACILITATOR, MEETING_ANALYST } from '../llm/prompts.js';
import { llm } from '../llm/provider.js';
import { FacilitatorSchema, MeetingAnalysisSchema } from '../llm/schemas.js';
import { ontologyStore } from './ontologyStore.js';
import { getProject } from './ontologies.js';
import { recall } from './recall.js';
import { createUseCase, synthesise } from './useCases.js';
import { logActivity } from './users.js';

export const getMeeting = (id: string) => mustGet<Meeting>('meetings', id);
export const listMeetings = (ontologyId: string) => list<Meeting>('meetings', ontologyId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
export const saveMeeting = (m: Meeting) => put('meetings', m, m.ontologyId);
const save = saveMeeting;

/** Live updates for the meeting page (SSE). */
export const meetingEvents = new EventEmitter();
meetingEvents.setMaxListeners(200);
type MeetingEvent =
  | { type: 'line'; line: TranscriptLine }
  | { type: 'prompt'; prompt: FacilitatorPrompt }
  | { type: 'status'; status: Meeting['status']; bot?: Meeting['bot'] }
  | { type: 'meeting'; meeting: Meeting };
export const emit = (m: Meeting, e: MeetingEvent) => meetingEvents.emit(m.id, e);

/* ------------------------------------------------------------------------ */
/* Transcript parsing                                                        */
/* ------------------------------------------------------------------------ */

const toSeconds = (ts: string) => {
  const parts = ts.replace(',', '.').split(':').map(Number);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
};

/**
 * Accepts the transcript formats people actually have:
 * - Google Meet / Gemini "Transcript" docs (speaker line, then text; `00:01:02` timestamps on their own line)
 * - WebVTT (`<v Speaker>text` or `Speaker: text` cues)
 * - SRT
 * - plain `Speaker: text` lines
 */
export function parseTranscript(raw: string): TranscriptLine[] {
  const text = raw.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
  const lines: TranscriptLine[] = [];
  const push = (speaker: string, said: string, t?: number) => {
    said = said.replace(/<[^>]+>/g, '').trim();
    if (!said) return;
    const prev = lines.at(-1);
    if (prev && prev.speaker === speaker && (t === undefined || prev.t === undefined || t - prev.t < 30)) prev.text += ` ${said}`;
    else lines.push({ speaker: speaker.trim() || 'Unknown', text: said, t });
  };

  // WebVTT / SRT cues
  if (/^WEBVTT/.test(text) || /^\d+\n\d{2}:\d{2}:\d{2}[,.]\d{3} --> /m.test(text)) {
    for (const block of text.split(/\n{2,}/)) {
      const m = block.match(/(\d{2}:\d{2}:\d{2}[,.]\d{3}) --> [^\n]+\n([\s\S]+)/);
      if (!m) continue;
      const t = toSeconds(m[1]);
      const body = m[2].trim();
      const v = body.match(/^<v\s+([^>]+)>([\s\S]*?)(?:<\/v>)?$/);
      const colon = body.match(/^([^:\n]{1,40}):\s*([\s\S]+)$/);
      if (v) push(v[1], v[2], t);
      else if (colon) push(colon[1], colon[2], t);
      else push(lines.at(-1)?.speaker ?? 'Unknown', body, t);
    }
    return lines;
  }

  // Gemini/Meet transcript doc: optional header up to "Transcript", timestamps on their own line, "Name: text"
  const body = text.includes('\nTranscript\n') ? text.slice(text.indexOf('\nTranscript\n') + 12) : text;
  let t: number | undefined;
  let speaker: string | undefined;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(\d{1,2}:)?\d{1,2}:\d{2}$/.test(line)) {
      t = toSeconds(line);
      continue;
    }
    const m = line.match(/^(?:\[?((?:\d{1,2}:)?\d{1,2}:\d{2})\]?\s+)?([A-Z][^:]{0,40}?):\s+(.+)$/);
    if (m) {
      if (m[1]) t = toSeconds(m[1]);
      speaker = m[2];
      push(speaker, m[3], t);
    } else if (/^Meeting ended|^Transcription ended|^This editable transcript/i.test(line)) {
      continue;
    } else if (speaker) {
      push(speaker, line, t);
    }
  }
  return lines;
}

/* ------------------------------------------------------------------------ */
/* Analysis                                                                  */
/* ------------------------------------------------------------------------ */

export async function analyseMeeting(m: Meeting): Promise<Meeting> {
  if (!m.transcript.length) throw new HttpError(409, 'The transcript is empty');
  const project = getProject(m.ontologyId);
  m.status = 'processing';
  save(m);
  emit(m, { type: 'status', status: m.status });
  const graph = await ontologyStore.working(project);
  const { value } = await llm.json<MeetingAnalysis>({
    task: 'meeting-analysis',
    system: MEETING_ANALYST,
    schema: MeetingAnalysisSchema as never,
    maxTokens: 20000,
    messages: [
      {
        role: 'user',
        content: `Ontology being designed: ${project.title}. ${project.description}\n\nIts current terms (to recognise when people talk about something that already exists):\n${ontologyDigest(graph, 150)}\n\nTranscript of "${m.title}":\n\n${m.transcript.map((l) => `${l.speaker}: ${l.text}`).join('\n')}`,
      },
    ],
    fallback: () => heuristicAnalysis(m.transcript, graph.view().classes.map((c) => c.label ?? '')),
  });
  m.analysis = value;
  m.status = 'analysed';
  save(m);
  emit(m, { type: 'status', status: m.status });
  logActivity({ ontologyId: m.ontologyId, type: 'meeting.analysed', message: `analysed the call “${m.title}”: ${value.useCases.length} use case(s), ${value.terms.length} candidate terms`, link: `/o/${m.ontologyId}/meetings/${m.id}` });
  return m;
}

/** Offline analysis: questions become competency questions, "X means/is" become terms, speakers become use-case authors. */
export function heuristicAnalysis(transcript: TranscriptLine[], existingLabels: string[]): MeetingAnalysis {
  const have = new Set(existingLabels.map((l) => l.toLowerCase()));
  const cqs: MeetingAnalysis['competencyQuestions'] = [];
  const terms = new Map<string, MeetingAnalysis['terms'][number]>();
  const decisions: string[] = [];
  const open: string[] = [];
  const bySpeaker = new Map<string, string[]>();
  for (const l of transcript) {
    bySpeaker.set(l.speaker, [...(bySpeaker.get(l.speaker) ?? []), l.text]);
    for (const sentence of l.text.split(/(?<=[.!?])\s+/)) {
      const s = sentence.trim();
      if (/^(which|what|how many|where|when|who|can we|do we know)\b.*\?$/i.test(s) && s.length > 25 && !/concord/i.test(l.speaker)) cqs.push({ question: s, askedBy: l.speaker });
      const def = s.match(/\b(?:an?|the)\s+["“]?([a-z][a-z -]{2,30}?)["”]?\s+(?:is|means|would be)\s+(?:basically\s+|really\s+|just\s+)?(an?\s+[^.?!]{8,140})/i);
      if (def && !have.has(def[1].toLowerCase())) terms.set(def[1].toLowerCase(), { label: def[1].toLowerCase(), kind: 'class', definition: def[2], evidence: [s] });
      if (/\b(let's|we agree|agreed|we'll go with|decision)\b/i.test(s)) decisions.push(`${l.speaker}: ${s}`);
      if (/\b(not sure|open question|need to check|follow up|unclear)\b/i.test(s)) open.push(`${l.speaker}: ${s}`);
    }
  }
  const useCases: MeetingAnalysis['useCases'] = [...bySpeaker.entries()]
    .filter(([speaker, said]) => !/concord/i.test(speaker) && said.join(' ').length > 300)
    .map(([speaker, said]) => ({
      title: `${speaker}'s use case`,
      speaker,
      sections: { name: `${speaker}'s use case`, description: said.slice(0, 3).join(' ').slice(0, 600), usageScenarios: said.filter((x) => /for example|e\.g\.|last week|say /i.test(x)).slice(0, 2) },
    }));
  return {
    summary: `A call with ${bySpeaker.size} participants (${[...bySpeaker.keys()].join(', ')}). ${cqs.length} question(s) the data should answer and ${terms.size} candidate term(s) were identified automatically.`,
    useCases,
    terms: [...terms.values()],
    competencyQuestions: cqs.slice(0, 12),
    disagreements: [],
    openQuestions: open.slice(0, 8),
    decisions: decisions.slice(0, 8),
  };
}

/** Turn an analysed meeting into draft use cases (one per participant use case) and a proposed change request. */
export async function proposeFromMeeting(m: Meeting, actor: User): Promise<{ useCases: UseCase[]; changeRequest?: ChangeRequest }> {
  if (!m.analysis) m = await analyseMeeting(m);
  const a = m.analysis!;
  const project = getProject(m.ontologyId);
  const ucs: UseCase[] = [];
  const groups = a.useCases.length ? a.useCases : [{ title: m.title, sections: { name: m.title, description: a.summary } }];
  groups.forEach((g, i) => {
    ucs.push(
      createUseCase(project, actor, {
        source: 'meeting',
        sourceRef: m.id,
        status: 'ready',
        sections: { ...g.sections, name: g.sections.name ?? g.title, notes: `From the call “${m.title}”${'speaker' in g && g.speaker ? `, described by ${g.speaker}` : ''}.` },
        // Attach the call's questions and terms to the first use case so they are not duplicated.
        competencyQuestions:
          i === 0 ? a.competencyQuestions.map((q) => ({ id: newId('cq'), question: q.question, status: 'untested' as const, exampleAnswer: undefined })) : [],
        terms: i === 0 ? a.terms : [],
      }),
    );
  });
  let changeRequest: ChangeRequest | undefined;
  try {
    changeRequest = await synthesise(project, actor, ucs.map((u) => u.id));
    changeRequest.origin = { type: 'meeting', meetingId: m.id };
    put('changeRequests', changeRequest, changeRequest.ontologyId);
  } catch (err) {
    console.warn(`[meeting] synthesis failed: ${(err as Error).message}`);
  }
  return { useCases: ucs, changeRequest };
}

/* ------------------------------------------------------------------------ */
/* Creating meetings                                                         */
/* ------------------------------------------------------------------------ */

export function newMeeting(project: OntologyProject, user: User, title: string, source: Meeting['source'], extra: Partial<Meeting> = {}): Meeting {
  return save({
    id: newId('mtg'),
    ontologyId: project.id,
    title: title || 'Working group call',
    source,
    transcript: [],
    facilitatorPrompts: [],
    status: 'live',
    createdAt: clock.iso(),
    createdBy: user.id,
    ...extra,
  });
}

export async function uploadTranscript(project: OntologyProject, user: User, title: string, raw: string) {
  const transcript = parseTranscript(raw);
  if (!transcript.length) throw new HttpError(400, 'Could not find any speaker turns in that transcript. Expected “Name: text” lines, a Google Meet transcript, or a .vtt/.srt file.');
  const m = newMeeting(project, user, title, 'upload', { transcript, status: 'processing' });
  logActivity({ ontologyId: project.id, actorId: user.id, type: 'meeting.uploaded', message: `uploaded the transcript of “${m.title}”`, link: `/o/${project.id}/meetings/${m.id}` });
  return analyseMeeting(m);
}

/* ------------------------------------------------------------------------ */
/* Live co-facilitation                                                      */
/* ------------------------------------------------------------------------ */

const lastPromptAt = new Map<string, number>();
const lastLineAt = new Map<string, number>();

/** When the last transcript line of a live call arrived (this process only). */
export const lastLineTime = (meetingId: string) => lastLineAt.get(meetingId);

/** Called for every new transcript line from a live call (bot webhook or simulation). */
export async function onLiveLine(m: Meeting, line: TranscriptLine, opts: { minGapLines?: number } = {}) {
  m.transcript.push(line);
  save(m);
  lastLineAt.set(m.id, Date.now());
  emit(m, { type: 'line', line });
  const n = m.transcript.length;
  const gap = opts.minGapLines ?? 4;
  if (n - (lastPromptAt.get(m.id) ?? 0) < gap) return;
  const prompt = await facilitate(m);
  if (!prompt) return;
  lastPromptAt.set(m.id, n);
  const fresh = getMeeting(m.id);
  const entry: FacilitatorPrompt = { at: clock.iso(), t: line.t, text: prompt, posted: false };
  if (fresh.postPromptsToChat) await postToChat(fresh, entry);
  fresh.facilitatorPrompts.push(entry);
  // keep the in-memory object in sync for the caller
  m.facilitatorPrompts = fresh.facilitatorPrompts;
  save(fresh);
  emit(fresh, { type: 'prompt', prompt: entry });
}

/** Posts one prompt into the meeting's chat through the bot. Simulated calls pretend to. */
async function postToChat(m: Meeting, p: FacilitatorPrompt) {
  if (m.bot?.provider === 'recall') {
    if (!m.bot.botId || !['joining', 'in-call'].includes(m.bot.status)) {
      p.postError = 'The bot is not in the call, so it can’t post in the chat.';
      return;
    }
    const r = await recall.sendChat(m.bot.botId, p.text);
    if (!r.ok) {
      p.postError = r.error;
      return;
    }
  } else if (m.source !== 'simulation') {
    p.postError = 'No meeting bot is connected to this call, so there is no chat to post in.';
    return;
  }
  p.posted = true;
  p.postedAt = clock.iso();
  delete p.postError;
}

/** "Post in the Meet chat" on one prompt the bot only suggested to the facilitator. */
export async function postPrompt(m: Meeting, index: number) {
  const p = m.facilitatorPrompts[index];
  if (!p) throw new HttpError(404, 'No such prompt');
  if (!p.posted) {
    await postToChat(m, p);
    save(m);
    emit(m, { type: 'meeting', meeting: m });
  }
  if (p.postError) throw new HttpError(409, p.postError);
  return m;
}

/** Meeting options people can change before or during a call. */
export async function updateMeeting(m: Meeting, patch: { postPromptsToChat?: boolean; skip?: boolean }) {
  if (patch.postPromptsToChat !== undefined) m.postPromptsToChat = patch.postPromptsToChat;
  if (patch.skip !== undefined) {
    if (!m.calendar) throw new HttpError(400, 'Only calls from a calendar invite can be skipped');
    if (m.status !== 'scheduled') throw new HttpError(409, 'The bot has already joined this call. End it instead.');
    m.calendar.skip = patch.skip;
    // A bot already booked with Recall.ai for this call is cancelled; it is booked again if un-skipped.
    if (patch.skip && m.bot?.botId) {
      await recall.deleteBot(m.bot.botId);
      m.bot = { provider: m.bot.provider, status: 'scheduled' };
    }
  }
  save(m);
  emit(m, { type: 'meeting', meeting: m });
  return m;
}

async function facilitate(m: Meeting): Promise<string | undefined> {
  const project = getProject(m.ontologyId);
  const recent = m.transcript.slice(-14);
  const { value } = await llm.json({
    task: 'facilitate',
    system: FACILITATOR,
    schema: FacilitatorSchema,
    effort: 'low',
    maxTokens: 1500,
    messages: [
      {
        role: 'user',
        content: `Ontology: ${project.title}. ${project.description}\n\nPrompts you already raised in this call:\n${m.facilitatorPrompts.map((p) => `- ${p.text}`).join('\n') || '(none)'}\n\nRecent transcript:\n${recent.map((l) => `${l.speaker}: ${l.text}`).join('\n')}`,
      },
    ],
    fallback: () => heuristicFacilitation(m),
  });
  return value.speak && value.prompt ? value.prompt : undefined;
}

/** Offline facilitator: asks for examples, definitions of new terms, and competency questions. */
function heuristicFacilitation(m: Meeting): { speak: boolean; prompt?: string } {
  const recent = m.transcript.slice(-6);
  const already = new Set(m.facilitatorPrompts.map((p) => p.text));
  const candidates: string[] = [];
  for (const l of recent) {
    const q = l.text.match(/\b(?:a|the)\s+([a-z]+(?:\s[a-z]+)?)\s+(?:is|means)\b/i);
    const quoted = l.text.match(/["“]([^"”]{3,30})["”]/);
    const term = quoted?.[1] ?? q?.[1];
    if (term) candidates.push(`${l.speaker.split(' ')[0]}, when you say “${term}”, does everyone here use it the same way? A one-line definition would help us model it.`);
  }
  if (!m.transcript.some((l) => /\?/.test(l.text) && /which|how many|what/i.test(l.text)))
    candidates.push('Could someone phrase a question they would want to ask of this data, with an example answer? That helps us test the standard.');
  candidates.push('Do we have a concrete example of that, with real places or dates, that we can write down as a scenario?');
  const prompt = candidates.find((c) => !already.has(c));
  return prompt ? { speak: true, prompt } : { speak: false };
}

/* ------------------------------------------------------------------------ */
/* Meeting bot adapters                                                      */
/* ------------------------------------------------------------------------ */

export const NO_BOT_PROVIDER =
  'No meeting-bot provider is configured on this server (set RECALL_API_KEY). Use “Simulate a call” to see how the co-facilitator works, or upload the transcript afterwards.';

export const isMeetUrl = (url: string) => /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/.test(url);

/** Books a Recall.ai bot for a meeting (now, or at joinAt). Returns the bot state to store. */
export async function dispatchBot(m: Meeting, joinAt?: string): Promise<NonNullable<Meeting['bot']>> {
  if (!recall.enabled()) return { provider: 'simulated', status: 'error', error: NO_BOT_PROVIDER };
  let secret = get<{ id: string; secret: string }>('kv', `meeting-secret:${m.id}`)?.secret;
  if (!secret) {
    secret = newToken();
    put('kv', { id: `meeting-secret:${m.id}`, secret });
  }
  try {
    const bot = await recall.createBot({
      meetingUrl: m.meetingUrl!,
      joinAt,
      postPromptsToChat: !!m.postPromptsToChat,
      webhookUrl: `${config.publicUrl}/api/webhooks/recall?meeting=${m.id}&secret=${secret}`,
    });
    return { provider: 'recall', botId: bot.id, status: 'joining' };
  } catch (err) {
    return { provider: 'recall', status: 'error', error: (err as Error).message };
  }
}

export async function inviteBot(project: OntologyProject, user: User, title: string, meetingUrl: string, opts: { postPromptsToChat?: boolean } = {}) {
  if (!isMeetUrl(meetingUrl)) throw new HttpError(400, 'That does not look like a Google Meet link (https://meet.google.com/abc-defg-hij)');
  const m = newMeeting(project, user, title, 'google-meet-bot', {
    meetingUrl,
    postPromptsToChat: !!opts.postPromptsToChat,
    bot: { provider: recall.enabled() ? 'recall' : 'simulated', status: 'scheduled' },
  });
  m.bot = await dispatchBot(m);
  save(m);
  logActivity({ ontologyId: project.id, actorId: user.id, type: 'meeting.bot', message: `invited the co-facilitator to “${m.title}”`, link: `/o/${project.id}/meetings/${m.id}` });
  return m;
}

/** Recall.ai real-time transcript webhook. */
export async function recallWebhook(meetingId: string, secret: string, body: unknown) {
  const stored = get<{ id: string; secret: string }>('kv', `meeting-secret:${meetingId}`);
  if (!stored || stored.secret !== secret) throw new HttpError(401, 'Bad webhook secret');
  const m = getMeeting(meetingId);
  const evt = body as { event?: string; data?: { data?: { words?: { text: string; start_timestamp?: { relative?: number } }[]; participant?: { name?: string } } } };
  if (evt.event === 'transcript.data' && evt.data?.data?.words?.length) {
    if (m.bot) m.bot.status = 'in-call';
    if (m.status === 'scheduled') m.status = 'live';
    const words = evt.data.data.words;
    await onLiveLine(m, { speaker: evt.data.data.participant?.name ?? 'Unknown', text: words.map((w) => w.text).join(' '), t: words[0].start_timestamp?.relative });
  }
}

export async function endLiveMeeting(m: Meeting) {
  if (m.bot?.provider === 'recall' && m.bot.botId) await recall.leave(m.bot.botId);
  if (m.bot) m.bot.status = 'done';
  save(m);
  emit(m, { type: 'status', status: m.status, bot: m.bot });
  return m.transcript.length ? analyseMeeting(m) : m;
}

/* ------------------------------------------------------------------------ */
/* Simulated call (alpha walkthrough)                                        */
/* ------------------------------------------------------------------------ */

export const SIMULATED_CALL: TranscriptLine[] = [
  { speaker: 'Priya Shah', text: "Thanks for joining. Today I'd like to hear how each of you would use the volunteering standard day to day, so we can check the ontology covers it. Aisha, do you want to start?" },
  { speaker: 'Aisha Rahman', text: 'Sure. At Northvale we run a lot of regular volunteering: the library, the food bank, park clean-ups. Coordinators think in terms of shifts. A "shift" is a fixed slot on a rota, say Saturday 9 till 1 at the food bank, and each shift needs a certain number of people.' },
  { speaker: 'Tom Okafor', text: 'Is a shift different from what we call a session in the ontology? A session is basically an occurrence of an opportunity at a particular time.' },
  { speaker: 'Aisha Rahman', text: "Close, but a shift repeats every week and people sign up to the rota, not to one date. And for some shifts you need a DBS check, for others you don't." },
  { speaker: 'Gareth Lewis', text: 'In our CRM we store shifts as recurring sessions with an iCal recurrence rule. If the standard had a recurrence property we could map straight to it.' },
  { speaker: 'Mei Chen', text: 'For us the big gap is recording what actually happened. Which volunteers did how many hours last quarter, and for which cause? Funders ask for that constantly.' },
  { speaker: 'Mei Chen', text: 'So something like a volunteering activity record: a person, an opportunity, a date and the hours they gave.' },
  { speaker: 'Aisha Rahman', text: "And expenses. A lot of our volunteers can only come if we reimburse travel. People want to know which opportunities pay expenses before they apply." },
  { speaker: 'Gareth Lewis', text: 'Can we keep personal data out of the core standard though? Hours per person is sensitive. Maybe aggregate figures only.' },
  { speaker: 'Mei Chen', text: "That's fair. I'd be happy with aggregate hours per opportunity per month for the open data, and the individual records stay private." },
  { speaker: 'Tom Okafor', text: "Let's agree to model shift as a kind of session with a recurrence rule, and add an expenses flag to the opportunity. The activity records need more thought because of the personal data question." },
  { speaker: 'Priya Shah', text: "Agreed. So the questions we need to answer are: which opportunities near me reimburse expenses, which weekly shifts still need volunteers, and how many hours were given per cause last quarter?" },
  { speaker: 'Aisha Rahman', text: 'Yes. And one more: which shifts next week need someone with a DBS check?' },
  { speaker: 'Priya Shah', text: "Great. I'll ask Concord to write this up as use cases and a draft change request, and we'll review it asynchronously rather than meeting again." },
];

const runningSimulations = new Set<string>();

/** Replays the scripted call line by line so testers can watch the co-facilitator work. */
export async function simulateCall(project: OntologyProject, user: User, title: string, opts: { delayMs?: number; postPromptsToChat?: boolean } = {}) {
  const m = newMeeting(project, user, title || 'Volunteering standard: use case call (simulated)', 'simulation', {
    meetingUrl: 'https://meet.google.com/sim-ulat-ion',
    postPromptsToChat: !!opts.postPromptsToChat,
    bot: { provider: 'simulated', status: 'in-call' },
  });
  const delay = opts.delayMs ?? 1800;
  runningSimulations.add(m.id);
  const run = async () => {
    for (const line of SIMULATED_CALL) {
      if (!runningSimulations.has(m.id)) return;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      await onLiveLine(getMeeting(m.id), { ...line, t: getMeeting(m.id).transcript.length * 20 }, { minGapLines: 4 });
    }
    runningSimulations.delete(m.id);
    const done = getMeeting(m.id);
    done.bot = { provider: 'simulated', status: 'done' };
    save(done);
    emit(done, { type: 'status', status: done.status, bot: done.bot });
    await analyseMeeting(done);
  };
  if (delay) void run().catch((err) => console.warn(`[meeting-sim] ${(err as Error).message}`));
  else await run();
  logActivity({ ontologyId: project.id, actorId: user.id, type: 'meeting.simulated', message: `started a simulated call “${m.title}”`, link: `/o/${project.id}/meetings/${m.id}` });
  return getMeeting(m.id);
}

export function stopSimulation(id: string) {
  runningSimulations.delete(id);
}
