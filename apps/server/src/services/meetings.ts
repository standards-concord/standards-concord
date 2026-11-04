import { EventEmitter } from 'node:events';
import type { ChangeRequest, FacilitatorPrompt, Meeting, MeetingAnalysis, OntologyProject, Role, TranscriptLine, UseCase, User } from '@concord/shared';
import { clock } from '../clock.js';
import { config } from '../config.js';
import { get, HttpError, list, mustGet, put } from '../db.js';
import { newId, newToken } from '../ids.js';
import { ontologyDigest } from '../llm/context.js';
import { FACILITATOR, MEETING_ANALYST } from '../llm/prompts.js';
import { llm } from '../llm/provider.js';
import { FacilitatorSchema, MeetingAnalysisSchema } from '../llm/schemas.js';
import { ontologyStore } from './ontologyStore.js';
import { getProject, rolesFor } from './ontologies.js';
import { withLock } from '../locks.js';
import { BookingError, recall } from './recall.js';
import { isRetired, retireBot } from './retiring.js';
import { createUseCase, synthesise } from './useCases.js';
import { logActivity } from './users.js';

export const getMeeting = (id: string) => mustGet<Meeting>('meetings', id);
export const listMeetings = (ontologyId: string) => list<Meeting>('meetings', ontologyId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
export const saveMeeting = (m: Meeting) => put('meetings', m, m.ontologyId);
const save = saveMeeting;

/** Serialises changes to one meeting (bookings, webhooks, posting, skipping). */
export const meetingLock = <T>(id: string, fn: () => Promise<T> | T) => withLock(`meeting:${id}`, fn);

/** Applies a change to the latest stored copy of a meeting, under its lock, so concurrent updates aren't lost. */
export function mutateMeeting(id: string, change: (m: Meeting) => void): Promise<Meeting> {
  return meetingLock(id, () => {
    const m = getMeeting(id);
    change(m);
    return save(m);
  });
}

/** Roles that can run a call: bring the bot in, skip or approve calls, post in its chat. */
export const FACILITATOR_ROLES: Role[] = ['owner', 'steward', 'editor'];

/**
 * Running a call (approving, skipping, chat posting, ending it) is for the
 * ontology's owners, stewards and editors only. Having added the call, or
 * having sent the invite, doesn't count: invites can come from anyone.
 */
export function canFacilitate(m: Pick<Meeting, 'ontologyId'>, user: User | undefined) {
  if (!user) return false;
  return !!user.isPlatformAdmin || config.adminEmails.includes(user.email?.toLowerCase() ?? '') || rolesFor(m.ontologyId, user.id).some((r) => FACILITATOR_ROLES.includes(r));
}

export function requireFacilitator(m: Pick<Meeting, 'ontologyId'>, user: User | undefined, action: string) {
  if (!user) throw new HttpError(401, 'Sign in first');
  if (!canFacilitate(m, user)) throw new HttpError(403, `Only the ontology's owners, stewards and editors can ${action}`);
}

/** Analysing (or re-analysing) a call: facilitators, or whoever uploaded the transcript or ran the simulation. */
export function requireAnalyst(m: Meeting, user: User | undefined) {
  if (!user) throw new HttpError(401, 'Sign in first');
  const own = m.createdBy === user.id && (m.source === 'upload' || m.source === 'simulation');
  if (!own && !canFacilitate(m, user)) throw new HttpError(403, "Only the ontology's owners, stewards and editors can analyse this call");
}

/** Whether a bot is still in (or on its way into) the call. */
export const botActive = (m: Meeting) => !!m.bot && (m.bot.status === 'joining' || m.bot.status === 'in-call');

/**
 * What a signed-in person may see of a meeting. Invites waiting for approval are
 * for facilitators only, and so are the call's Meet link, organiser and bot id.
 */
export function visibleMeeting(m: Meeting, user: User | undefined): Meeting | undefined {
  if (canFacilitate(m, user)) return m;
  if (m.calendar?.approval === 'pending') return undefined;
  const { meetingUrl: _url, ...rest } = m;
  return {
    ...rest,
    // Bot ids, booking ids and the link a bot was booked for are for facilitators too.
    bot: m.bot && { ...m.bot, botId: undefined, bookingId: undefined, bookedUrl: undefined, booked: !!m.bot.botId || undefined },
    calendar: m.calendar && { ...m.calendar, organizer: undefined, sentBy: undefined, uid: undefined, key: '' },
  };
}

/* Series approval: one approval covers every week of a series, while its organiser and Meet link stay the same. */

type SeriesApproval = { id: string; organizer?: string; meetingUrl?: string; approvedBy: string; at: string };
const approvalKey = (ontologyId: string, uid: string) => `meet-bot:approval:${ontologyId}:${uid}`;

export function seriesApproved(ontologyId: string, uid: string | undefined, organizer: string | undefined, meetingUrl: string | undefined) {
  if (!uid) return undefined;
  const a = get<SeriesApproval>('kv', approvalKey(ontologyId, uid));
  return a && a.organizer === organizer && a.meetingUrl === meetingUrl ? a : undefined;
}

export function recordSeriesApproval(ontologyId: string, uid: string | undefined, organizer: string | undefined, meetingUrl: string | undefined, userId: string) {
  if (uid) put('kv', { id: approvalKey(ontologyId, uid), organizer, meetingUrl, approvedBy: userId, at: clock.iso() });
}

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
  m = getMeeting(m.id);
  if (botActive(m) || m.bot?.uncertain || m.bot?.leaving) throw new HttpError(409, 'The bot may still be in the call. End the call first.');
  if (!m.transcript.length) throw new HttpError(409, 'The transcript is empty');
  const project = getProject(m.ontologyId);
  m = await mutateMeeting(m.id, (x) => {
    x.status = 'processing';
  });
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
  m = await mutateMeeting(m.id, (x) => {
    x.analysis = value;
    x.status = 'analysed';
  });
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
export async function onLiveLine(
  meetingId: string,
  line: TranscriptLine,
  opts: { minGapLines?: number; accept?: (m: Meeting) => boolean; before?: (m: Meeting) => void } = {},
): Promise<boolean> {
  // Whether to keep the line is decided on the latest copy, under the lock, so a skip or cancellation that just happened counts.
  let accepted = true;
  const m = await meetingLock(meetingId, () => {
    const x = getMeeting(meetingId);
    if (opts.accept && !opts.accept(x)) {
      accepted = false;
      return x;
    }
    opts.before?.(x);
    x.transcript.push(line);
    return save(x);
  });
  if (!accepted) return false;
  lastLineAt.set(m.id, Date.now());
  emit(m, { type: 'line', line });
  // A notice about chat posting that failed earlier is retried as the call goes on.
  if (m.chatNoticeError || (m.bot?.status === 'in-call' && m.source !== 'simulation' && !!m.postPromptsToChat !== !!m.chatModeAnnounced)) await announceChatMode(meetingId).catch(() => undefined);
  const n = m.transcript.length;
  const gap = opts.minGapLines ?? 4;
  if (n - (lastPromptAt.get(m.id) ?? 0) < gap) return true;
  lastPromptAt.set(m.id, n);
  const prompt = await facilitate(m);
  if (!prompt) return true;
  const entry: FacilitatorPrompt = { at: clock.iso(), t: line.t, text: prompt, posted: false };
  let index = -1;
  const fresh = await mutateMeeting(meetingId, (x) => {
    index = x.facilitatorPrompts.push(entry) - 1;
  });
  emit(fresh, { type: 'prompt', prompt: entry });
  // A notice about chat posting that failed earlier is retried first. Prompts go
  // into the chat automatically only once the call has been told they will.
  await announceChatMode(meetingId).catch(() => undefined);
  const now = getMeeting(meetingId);
  if (now.postPromptsToChat && (now.source === 'simulation' || now.chatModeAnnounced)) await postPrompt(meetingId, index, { quiet: true });
  return true;
}

/** Sends text into the meeting's chat through the bot. Simulated calls pretend to. */
async function sendToChat(m: Meeting, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (m.bot?.provider === 'recall') {
    if (!m.bot.botId || !['joining', 'in-call'].includes(m.bot.status)) return { ok: false, error: 'The bot is not in the call, so it can’t post in the chat.' };
    return recall.sendChat(m.bot.botId, text);
  }
  if (m.source === 'simulation') return { ok: true };
  return { ok: false, error: 'No meeting bot is connected to this call, so there is no chat to post in.' };
}

const posting = new Set<string>();

/** Posts one prompt into the meeting chat. Only that prompt is updated, on the latest copy of the meeting. */
export async function postPrompt(meetingId: string, index: number, opts: { quiet?: boolean } = {}) {
  const m = getMeeting(meetingId);
  const p = m.facilitatorPrompts[index];
  if (!p) throw new HttpError(404, 'No such prompt');
  if (p.posted) return m;
  const key = `${meetingId}:${index}`;
  if (posting.has(key)) throw new HttpError(409, 'That prompt is being posted already');
  posting.add(key);
  try {
    const r = await sendToChat(m, p.text);
    const fresh = await mutateMeeting(meetingId, (x) => {
      const q = x.facilitatorPrompts[index];
      if (r.ok) {
        q.posted = true;
        q.postedAt = clock.iso();
        delete q.postError;
      } else q.postError = r.error;
    });
    emit(fresh, { type: 'meeting', meeting: fresh });
    if (!r.ok && !opts.quiet) throw new HttpError(409, r.error);
    return fresh;
  } finally {
    posting.delete(key);
  }
}

/**
 * Tells the call when posting in its chat is switched on or off, so what the bot
 * said when it joined stays true. Only once the bot is in the call; until then
 * the next check (when it joins) does it.
 */
const announcing = new Set<string>();

export async function announceChatMode(meetingId: string) {
  if (announcing.has(meetingId)) return;
  announcing.add(meetingId);
  try {
    await announceOnce(meetingId);
  } finally {
    announcing.delete(meetingId);
  }
}

async function announceOnce(meetingId: string) {
  const m = getMeeting(meetingId);
  const want = !!m.postPromptsToChat;
  if (m.source === 'simulation' || m.bot?.status !== 'in-call' || (m.chatModeAnnounced ?? false) === want) return;
  const r = await sendToChat(
    m,
    want
      ? `${config.meetBot.botName}: from now on I'll post follow-up questions here in the chat.`
      : `${config.meetBot.botName}: I'll stop posting questions in the chat. I'm still transcribing; my suggestions now go to the facilitator in Concord.`,
  );
  const fresh = await mutateMeeting(meetingId, (x) => {
    if (r.ok) {
      x.chatModeAnnounced = want;
      delete x.chatNoticeError;
    } else x.chatNoticeError = `Couldn’t tell the call that posting is now ${want ? 'on' : 'off'} (${r.error}). Concord will try again${want ? ', and holds back automatic posts until it has' : ''}.`;
  });
  emit(fresh, { type: 'meeting', meeting: fresh });
}

/** Meeting options facilitators can change before or during a call. Every change is logged. */
export async function updateMeeting(meetingId: string, user: User, patch: { postPromptsToChat?: boolean; skip?: boolean; approve?: boolean }) {
  const before = getMeeting(meetingId);
  requireFacilitator(before, user, 'change this call');
  const changes: string[] = [];
  // A call waiting for approval is only for facilitators to see, so the activity log doesn't name it.
  let named = before.calendar?.approval !== 'pending';
  const m = await meetingLock(meetingId, async () => {
    const m = getMeeting(meetingId);
    if (patch.postPromptsToChat !== undefined && patch.postPromptsToChat !== !!m.postPromptsToChat) {
      m.postPromptsToChat = patch.postPromptsToChat;
      changes.push(patch.postPromptsToChat ? 'switched on posting prompts in the Meet chat for' : 'switched off posting prompts in the Meet chat for');
    }
    if (patch.skip !== undefined || patch.approve !== undefined) {
      if (!m.calendar) throw new HttpError(400, 'Only calls from a calendar invite can be skipped or approved');
      if (m.status !== 'scheduled') throw new HttpError(409, 'The bot has already joined this call. End it instead.');
    }
    if (patch.approve && m.calendar!.approval === 'pending') {
      m.calendar!.approval = 'approved';
      m.calendar!.approvedBy = user.id;
      delete m.calendar!.approvalNote;
      recordSeriesApproval(m.ontologyId, m.calendar!.uid, m.calendar!.organizer, m.meetingUrl, user.id);
      named = true;
      changes.push(m.calendar!.recurring ? 'approved the co-lead bot joining the series' : 'approved the co-lead bot joining');
    }
    if (patch.skip !== undefined && patch.skip !== !!m.calendar!.skip) {
      // A bot already booked for this call is cancelled first; if that fails, nothing changes.
      if (patch.skip && (m.bot?.botId || m.bot?.uncertain)) {
        const r = await cancelMeetingBot(m);
        // Forgotten here either way: if Recall.ai didn't confirm, the cancellation is retried and anything that bot sends is dropped.
        m.bot = { provider: m.bot.provider, status: 'scheduled', cancelError: r.ok ? undefined : r.error };
      }
      m.calendar!.skip = patch.skip;
      changes.push(patch.skip ? 'told the co-lead bot to skip' : 'told the co-lead bot to join');
    }
    return save(m);
  });
  for (const c of changes) logActivity({ ontologyId: m.ontologyId, actorId: user.id, type: 'meeting.updated', message: `${c} ${named ? `“${m.title}”` : 'a call waiting for approval'}`, link: `/o/${m.ontologyId}/meetings/${m.id}` });
  emit(m, { type: 'meeting', meeting: m });
  // The other weeks of an approved series, with the same organiser and Meet link, are approved too.
  if (patch.approve && m.calendar?.uid) {
    for (const other of list<Meeting>('meetings', m.ontologyId)) {
      if (other.id === m.id || other.calendar?.uid !== m.calendar.uid || other.calendar.approval !== 'pending') continue;
      if (!seriesApproved(m.ontologyId, other.calendar.uid, other.calendar.organizer, other.meetingUrl)) continue;
      const o = await mutateMeeting(other.id, (x) => {
        x.calendar!.approval = 'approved';
        x.calendar!.approvedBy = user.id;
        delete x.calendar!.approvalNote;
      });
      emit(o, { type: 'meeting', meeting: o });
    }
  }
  if (patch.postPromptsToChat !== undefined) await announceChatMode(meetingId).catch(() => undefined);
  return getMeeting(meetingId);
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
/** Meetings whose "Join a call now" booking request is still out, in this process (none after a restart). */
export const bookingsInFlight = new Set<string>();

/** bookingId: the booking already recorded on the meeting before sending, when there is one. */
export async function dispatchBot(m: Meeting, joinAt?: string, givenBookingId?: string): Promise<NonNullable<Meeting['bot']>> {
  if (!recall.enabled()) return { provider: 'simulated', status: 'error', error: NO_BOT_PROVIDER };
  let secret = get<{ id: string; secret: string }>('kv', `meeting-secret:${m.id}`)?.secret;
  if (!secret) {
    secret = newToken();
    put('kv', { id: `meeting-secret:${m.id}`, secret });
  }
  const bookingId = givenBookingId ?? newId('bk');
  const booking = { bookingId, bookedUrl: m.meetingUrl };
  try {
    const bot = await recall.createBot({
      meetingId: m.id,
      bookingId,
      meetingUrl: m.meetingUrl!,
      joinAt,
      postPromptsToChat: !!m.postPromptsToChat,
      webhookUrl: `${config.publicUrl}/api/webhooks/recall?meeting=${m.id}&secret=${secret}`,
    });
    return { provider: 'recall', botId: bot.id, status: 'joining', ...booking };
  } catch (err) {
    const uncertain = err instanceof BookingError && err.uncertain;
    // An unconfirmed booking keeps its id and Meet link, to find (or cancel) that bot later.
    return { provider: 'recall', status: 'error', error: (err as Error).message, ...(uncertain ? { uncertain: true, ...booking } : {}) };
  }
}

/**
 * Lets go of whatever bot a meeting has booked, including one whose booking reply
 * was lost: it is recorded for cancelling (retried every minute until Recall.ai
 * confirms, whatever happens to the meeting) and tried straight away. The caller
 * forgets the bot on the meeting either way; the result says whether it's gone yet.
 */
export async function cancelMeetingBot(m: Meeting): Promise<{ ok: true } | { ok: false; error: string }> {
  return retireBot(m.id, m.bot, m.meetingUrl, { retryNow: true });
}

/**
 * After a booking whose answer was lost: adopts the bot if Recall.ai did create
 * it (cancelling any duplicates), so it isn't booked twice. Undefined when
 * Recall.ai can't be asked yet; an empty object when there is no bot.
 */
export async function findLostBooking(m: Meeting): Promise<{ botId?: string } | undefined> {
  let ids: string[];
  try {
    const want = m.bot?.bookingId;
    // Exactly this booking: never another one for the same meeting.
    ids = (await recall.findBots(m.bot?.bookedUrl ?? m.meetingUrl!, m.id)).filter((b) => b.booking === want).map((b) => b.id);
  } catch {
    return undefined;
  }
  for (const extra of ids.slice(1)) await retireBot(m.id, { provider: 'recall', botId: extra });
  return { botId: ids[0] };
}

export async function inviteBot(project: OntologyProject, user: User, title: string, meetingUrl: string, opts: { postPromptsToChat?: boolean } = {}) {
  if (!isMeetUrl(meetingUrl)) throw new HttpError(400, 'That does not look like a Google Meet link (https://meet.google.com/abc-defg-hij)');
  const m = newMeeting(project, user, title, 'google-meet-bot', {
    meetingUrl,
    postPromptsToChat: !!opts.postPromptsToChat,
    // The booking is recorded before it is sent (as unconfirmed until Recall.ai answers), so the bot's
    // first words can identify it, and a restart mid-booking looks for it instead of booking another.
    bot: recall.enabled()
      ? { provider: 'recall', status: 'scheduled', bookingId: newId('bk'), bookedUrl: meetingUrl, uncertain: true }
      : { provider: 'simulated', status: 'scheduled' },
    chatModeAnnounced: !!opts.postPromptsToChat,
  });
  const bookingId = m.bot?.bookingId;
  bookingsInFlight.add(m.id);
  let bot: NonNullable<Meeting['bot']>;
  try {
    bot = await dispatchBot(m, undefined, bookingId);
  } finally {
    bookingsInFlight.delete(m.id);
  }
  // Transcript lines, End call or a cancellation can all happen before Recall.ai answers:
  // the reply only fills in this booking, on the latest copy, and never undoes them.
  let stray: string | undefined;
  const fresh = await mutateMeeting(m.id, (x) => {
    const b = x.bot;
    if (!b || b.bookingId !== bookingId || b.status === 'done' || b.leaving) {
      if (bot.botId && b?.botId !== bot.botId) stray = bot.botId;
      return;
    }
    // The webhook already said which bot it is.
    if (b.botId) {
      if (bot.botId && bot.botId !== b.botId) stray = bot.botId;
      x.bot = { ...b, uncertain: undefined, error: undefined };
      return;
    }
    // In the call already (its lines carried no bot id): keep that, with the reply's id if there is one.
    if (b.status === 'in-call') {
      x.bot = bot.botId ? { ...bot, status: 'in-call' } : { ...b, uncertain: true, error: bot.error };
      return;
    }
    x.bot = bot;
  });
  // A bot booked for a call that has already been ended (or replaced) goes straight away.
  if (stray) await retireBot(m.id, { provider: 'recall', botId: stray });
  logActivity({ ontologyId: project.id, actorId: user.id, type: 'meeting.bot', message: `invited the co-facilitator to “${m.title}”`, link: `/o/${project.id}/meetings/${m.id}` });
  return fresh;
}

/** Recall.ai real-time transcript webhook. */
export async function recallWebhook(meetingId: string, secret: string, body: unknown) {
  const stored = get<{ id: string; secret: string }>('kv', `meeting-secret:${meetingId}`);
  if (!stored || stored.secret !== secret) throw new HttpError(401, 'Bad webhook secret');
  getMeeting(meetingId);
  const evt = body as {
    event?: string;
    data?: {
      bot?: { id?: string; metadata?: Record<string, string> };
      data?: { words?: { text: string; start_timestamp?: { relative?: number } }[]; participant?: { name?: string } };
    };
  };
  if (evt.event === 'transcript.data' && evt.data?.data?.words?.length) {
    const fromBot = evt.data.bot?.id;
    const fromBooking = evt.data.bot?.metadata?.concord_booking;
    const words = evt.data.data.words;
    let joined = false;
    let staleBot: string | undefined;
    // Decided on the latest copy under the meeting's lock: a bot that should not be
    // in this call (skipped, cancelled, unapproved, replaced or ended) is told to
    // leave, and what it hears is dropped.
    const kept = await onLiveLine(
      meetingId,
      { speaker: evt.data.data.participant?.name ?? 'Unknown', text: words.map((w) => w.text).join(' '), t: words[0].start_timestamp?.relative },
      {
        accept: (x) => {
          // Without a confirmed bot id, only the bot of the current booking is expected (told by its booking id when Recall.ai sends it).
          // A bot that doesn't say which booking it belongs to is never assumed to be the current one.
          const awaited = !x.bot?.botId && !!x.bot?.bookingId && fromBooking === x.bot.bookingId;
          const unwanted =
            (!!fromBot && isRetired(fromBot)) ||
            (!!fromBot && !!x.bot?.botId && fromBot !== x.bot.botId) ||
            (!!fromBot && !x.bot?.botId && !awaited) ||
            !!x.bot?.leaving ||
            x.bot?.status === 'done' ||
            (!!x.calendar && (!!x.calendar.cancelPending || !!x.calendar.skip || x.calendar.approval === 'pending'));
          if (unwanted) staleBot = fromBot ?? x.bot?.botId;
          return !unwanted;
        },
        before: (x) => {
          joined = x.bot?.status !== 'in-call';
          // The current booking's reply was slow or lost: the webhook (signed with this meeting's secret) says which bot it is.
          if (x.bot && !x.bot.botId && fromBot) x.bot = { ...x.bot, botId: fromBot, uncertain: undefined, error: undefined };
          if (x.bot) x.bot.status = 'in-call';
          if (x.status === 'scheduled') x.status = 'live';
        },
      },
    );
    if (!kept) {
      if (staleBot && recall.enabled()) void retireBot(meetingId, { provider: 'recall', botId: staleBot });
      return;
    }
    if (joined) await announceChatMode(meetingId).catch(() => undefined);
  }
}

/**
 * Takes the bot out of the call, then analyses the transcript. If Recall.ai won't
 * remove the bot, the call stays open (marked as leaving, retried every minute)
 * and this throws, rather than say the call ended while the bot is still in it.
 */
export async function endLiveMeeting(meetingId: string) {
  let error: string | undefined;
  const m = await meetingLock(meetingId, async () => {
    const m = getMeeting(meetingId);
    // A booking whose reply was lost has no bot id: find (and remove) that bot through Recall.ai first.
    if (m.bot?.provider === 'recall' && !m.bot.botId && (m.bot.uncertain || m.bot.bookingId) && m.bot.status !== 'done') {
      const r = await cancelMeetingBot(m);
      if (!r.ok) {
        error = r.error;
        m.bot = { ...m.bot, leaving: true, error: r.error };
        return save(m);
      }
    }
    if (m.bot?.provider === 'recall' && m.bot.botId && m.bot.status !== 'done') {
      const r = await recall.leave(m.bot.botId);
      if (!r.ok) {
        error = r.error;
        m.bot = { ...m.bot, leaving: true, error: r.error };
        return save(m);
      }
    }
    if (m.bot) m.bot = { ...m.bot, status: 'done', leaving: undefined, error: undefined, uncertain: undefined };
    return save(m);
  });
  emit(m, { type: 'meeting', meeting: m });
  if (error) throw new HttpError(502, `${error} Concord will keep trying; the call is analysed once the bot has left.`);
  emit(m, { type: 'status', status: m.status, bot: m.bot });
  return m.transcript.length && m.status !== 'analysed' ? analyseMeeting(m) : m;
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
      await onLiveLine(m.id, { ...line, t: getMeeting(m.id).transcript.length * 20 }, { minGapLines: 4 });
    }
    runningSimulations.delete(m.id);
    const done = await mutateMeeting(m.id, (x) => {
      x.bot = { provider: 'simulated', status: 'done' };
    });
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
