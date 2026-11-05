import { EventEmitter } from 'node:events';
import type { ChangeRequest, FacilitatorPrompt, Meeting, MeetingAnalysis, OntologyProject, Role, TranscriptLine, UseCase, User } from '@concord/shared';
import { clock } from '../clock.js';
import { config } from '../config.js';
import { transaction, get, HttpError, list, mustGet, put, remove } from '../db.js';
import { newId, newToken } from '../ids.js';
import { ontologyDigest } from '../llm/context.js';
import { FACILITATOR, MEETING_ANALYST } from '../llm/prompts.js';
import { llm } from '../llm/provider.js';
import { FacilitatorSchema, MeetingAnalysisSchema } from '../llm/schemas.js';
import { ontologyStore } from './ontologyStore.js';
import { getProject, rolesFor } from './ontologies.js';
import { withLock } from '../locks.js';
import { adoptInPlace, background, beginBooking, beginRelease, bump, dismissUnconfirmed, drive, driveStrays, idleBot, knownGone, MAX_DISMISSED, normalise, noteStray, settled, tracked } from './botLifecycle.js';
import { recall } from './recall.js';
import { updateCR } from './changeRequests.js';
import { createUseCase, synthesise } from './useCases.js';
import { logActivity } from './users.js';

export const getMeeting = async (id: string) => await mustGet<Meeting>('meetings', id);
export const listMeetings = async (ontologyId: string) => (await list<Meeting>('meetings', ontologyId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
export const saveMeeting = async (m: Meeting) => await put('meetings', m, m.ontologyId);
const save = saveMeeting;

/**
 * Serialises changes to one meeting (bookings, webhooks, posting, skipping), within this process. That is enough
 * while the backend is one server (the VM). Known limit: on several instances (Vercel Functions) two of them could
 * still interleave a meeting's read and write, so before the backend runs there, every meetingLock and the
 * calendar lock must also hold the database's writer lock (a transaction) for their read-modify-write. See
 * docs/deploy.md, "Before the backend runs on more than one instance".
 */
export const meetingLock = <T>(id: string, fn: () => Promise<T> | T) => withLock(`meeting:${id}`, fn);

/** Applies a change to the latest stored copy of a meeting, under its lock, so concurrent updates aren't lost. */
export function mutateMeeting(id: string, change: (m: Meeting) => void): Promise<Meeting> {
  return meetingLock(id, async () => {
    const m = await getMeeting(id);
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
export async function canFacilitate(m: Pick<Meeting, 'ontologyId'>, user: User | undefined) {
  if (!user) return false;
  return !!user.isPlatformAdmin || config.adminEmails.includes(user.email?.toLowerCase() ?? '') || (await rolesFor(m.ontologyId, user.id)).some((r) => FACILITATOR_ROLES.includes(r));
}

export async function requireFacilitator(m: Pick<Meeting, 'ontologyId'>, user: User | undefined, action: string) {
  if (!user) throw new HttpError(401, 'Sign in first');
  if (!await canFacilitate(m, user)) throw new HttpError(403, `Only the ontology's owners, stewards and editors can ${action}`);
}

/** Analysing (or re-analysing) a call: facilitators, or whoever uploaded the transcript or ran the simulation. */
export async function requireAnalyst(m: Meeting, user: User | undefined) {
  if (!user) throw new HttpError(401, 'Sign in first');
  const own = m.createdBy === user.id && (m.source === 'upload' || m.source === 'simulation');
  if (!own && !await canFacilitate(m, user)) throw new HttpError(403, "Only the ontology's owners, stewards and editors can analyse this call");
}

/** Whether a bot is still in (or on its way into) the call. */
export const botActive = (m: Meeting) =>
  // Records from before the state machine are read as one here too (normalise is idempotent).
  (normalise(m), tracked(m)) ? (m.bot.phase === 'booking' || m.bot.phase === 'booked') && m.status !== 'scheduled' : !!m.bot && (m.bot.status === 'joining' || m.bot.status === 'in-call');

/** Whether a Recall.ai bot may still be around: booked, unanswered, or not yet confirmed gone. */
export const botOutstanding = (m: Meeting) => (normalise(m), tracked(m)) && (m.bot.phase === 'booking' || m.bot.phase === 'booked' || m.bot.phase === 'releasing' || !!m.bot.strays?.length);

/**
 * What a signed-in person may see of a meeting. Invites waiting for approval, and
 * withdrawn calls kept until their bot has gone, are for facilitators only, and so
 * are the call's Meet link, organiser, bot and booking ids, and Recall.ai's errors.
 */
export async function visibleMeeting(m: Meeting, user: User | undefined): Promise<Meeting | undefined> {
  // A withdrawn call whose bots are all gone is only kept to keep looking for a dismissed booking: it is gone for everyone.
  if (m.withdrawn && tracked(m) && settled(m.bot)) return undefined;
  if (await canFacilitate(m, user)) return m;
  if (m.calendar?.approval === 'pending' || m.withdrawn) return undefined;
  const { meetingUrl: _url, ...rest } = m;
  // Recall.ai's diagnostics can echo the Meet link: others just learn that something went wrong.
  const problem = (e?: string) => (e ? 'Something went wrong with the bot; a facilitator can see the details.' : undefined);
  const b = m.bot;
  return {
    ...rest,
    chatNoticeError: problem(m.chatNoticeError),
    facilitatorPrompts: m.facilitatorPrompts.map((q) => ({ ...q, postError: problem(q.postError) })),
    // Only what the page shows: whether a bot is booked and how it's doing.
    bot: b && {
      provider: b.provider,
      phase: b.phase,
      status: b.status,
      booked: (b.phase ? b.phase === 'booked' : !!b.botId) || undefined,
      uncertain: b.uncertain,
      leaving: b.leaving,
      unconfirmed: b.unconfirmed,
      error: problem(b.error),
      cancelError: problem(b.cancelError),
    },
    calendar: m.calendar && { ...m.calendar, organizer: undefined, sentBy: undefined, uid: undefined, key: '' },
  };
}

/* Series approval: one approval covers every week of a series, while its organiser and Meet link stay the same. */

type SeriesApproval = { id: string; organizer?: string; meetingUrl?: string; approvedBy: string; at: string };
const approvalKey = (ontologyId: string, uid: string) => `meet-bot:approval:${ontologyId}:${uid}`;

export async function seriesApproved(ontologyId: string, uid: string | undefined, organizer: string | undefined, meetingUrl: string | undefined) {
  if (!uid) return undefined;
  const a = await get<SeriesApproval>('kv', approvalKey(ontologyId, uid));
  return a && a.organizer === organizer && a.meetingUrl === meetingUrl ? a : undefined;
}

export async function recordSeriesApproval(ontologyId: string, uid: string | undefined, organizer: string | undefined, meetingUrl: string | undefined, userId: string) {
  if (uid) await put('kv', { id: approvalKey(ontologyId, uid), organizer, meetingUrl, approvedBy: userId, at: clock.iso() });
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
  m = await getMeeting(m.id);
  if (botActive(m) || botOutstanding(m)) throw new HttpError(409, 'The bot may still be in the call. End the call first.');
  if (!m.transcript.length) throw new HttpError(409, 'The transcript is empty');
  const project = await getProject(m.ontologyId);
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
  await logActivity({ ontologyId: m.ontologyId, type: 'meeting.analysed', message: `analysed the call “${m.title}”: ${value.useCases.length} use case(s), ${value.terms.length} candidate terms`, link: `/o/${m.ontologyId}/meetings/${m.id}` });
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
  const project = await getProject(m.ontologyId);
  const ucs: UseCase[] = [];
  const groups = a.useCases.length ? a.useCases : [{ title: m.title, sections: { name: m.title, description: a.summary } }];
  for (const [i, g] of groups.entries()) {
    ucs.push(
      await createUseCase(project, actor, {
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
  }
  let changeRequest: ChangeRequest | undefined;
  try {
    changeRequest = await synthesise(project, actor, ucs.map((u) => u.id));
    await updateCR(changeRequest, (c) => {
      c.origin = { type: 'meeting', meetingId: m.id };
    });
  } catch (err) {
    console.warn(`[meeting] synthesis failed: ${(err as Error).message}`);
  }
  return { useCases: ucs, changeRequest };
}

/* ------------------------------------------------------------------------ */
/* Creating meetings                                                         */
/* ------------------------------------------------------------------------ */

export async function newMeeting(project: OntologyProject, user: User, title: string, source: Meeting['source'], extra: Partial<Meeting> = {}): Promise<Meeting> {
  return await save({
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
  const m = await newMeeting(project, user, title, 'upload', { transcript, status: 'processing' });
  await logActivity({ ontologyId: project.id, actorId: user.id, type: 'meeting.uploaded', message: `uploaded the transcript of “${m.title}”`, link: `/o/${project.id}/meetings/${m.id}` });
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
  const m = await meetingLock(meetingId, async () => {
    const x = await getMeeting(meetingId);
    const gen = x.bot?.gen;
    if (opts.accept && !opts.accept(x)) {
      accepted = false;
      // Refusing the line can still change the bot record (a bot named, a stray noted).
      if (x.bot?.gen !== gen) {
        await save(x);
        emit(x, { type: 'meeting', meeting: x });
      }
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
  const now = await getMeeting(meetingId);
  if (now.postPromptsToChat && (now.source === 'simulation' || now.chatModeAnnounced)) await postPrompt(meetingId, index, { quiet: true });
  return true;
}

/** Sends text into the meeting's chat through the bot. Simulated calls pretend to. */
async function sendToChat(m: Meeting, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (m.bot?.provider === 'recall') {
    if (!m.bot.botId || m.bot.phase !== 'booked' || !['joining', 'in-call'].includes(m.bot.status)) return { ok: false, error: 'The bot is not in the call, so it can’t post in the chat.' };
    return recall.sendChat(m.bot.botId, text);
  }
  if (m.source === 'simulation') return { ok: true };
  return { ok: false, error: 'No meeting bot is connected to this call, so there is no chat to post in.' };
}

const posting = new Set<string>();

/** Posts one prompt into the meeting chat. Only that prompt is updated, on the latest copy of the meeting. */
export async function postPrompt(meetingId: string, index: number, opts: { quiet?: boolean } = {}) {
  const m = await getMeeting(meetingId);
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
  const m = await getMeeting(meetingId);
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
  const before = await getMeeting(meetingId);
  await requireFacilitator(before, user, 'change this call');
  const changes: string[] = [];
  // A call waiting for approval is only for facilitators to see, so the activity log doesn't name it.
  let named = before.calendar?.approval !== 'pending';
  const m = await meetingLock(meetingId, async () => {
    const m = await getMeeting(meetingId);
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
      await recordSeriesApproval(m.ontologyId, m.calendar!.uid, m.calendar!.organizer, m.meetingUrl, user.id);
      named = true;
      changes.push(m.calendar!.recurring ? 'approved the co-lead bot joining the series' : 'approved the co-lead bot joining');
    }
    if (patch.skip !== undefined && patch.skip !== !!m.calendar!.skip) {
      // A bot already booked for this call is released (anything it sends is dropped from now on), until Recall.ai confirms.
      if (patch.skip) beginRelease(m, 'cancel', 'idle');
      m.calendar!.skip = patch.skip;
      changes.push(patch.skip ? 'told the co-lead bot to skip' : 'told the co-lead bot to join');
    }
    return save(m);
  });
  for (const c of changes) await logActivity({ ontologyId: m.ontologyId, actorId: user.id, type: 'meeting.updated', message: `${c} ${named ? `“${m.title}”` : 'a call waiting for approval'}`, link: `/o/${m.ontologyId}/meetings/${m.id}` });
  emit(m, { type: 'meeting', meeting: m });
  // The other weeks of an approved series, with the same organiser and Meet link, are approved too.
  if (patch.approve && m.calendar?.uid) {
    for (const other of await list<Meeting>('meetings', m.ontologyId)) {
      if (other.id === m.id || other.calendar?.uid !== m.calendar.uid || other.calendar.approval !== 'pending') continue;
      if (!await seriesApproved(m.ontologyId, other.calendar.uid, other.calendar.organizer, other.meetingUrl)) continue;
      const o = await mutateMeeting(other.id, (x) => {
        x.calendar!.approval = 'approved';
        x.calendar!.approvedBy = user.id;
        delete x.calendar!.approvalNote;
      });
      emit(o, { type: 'meeting', meeting: o });
    }
  }
  if (patch.skip) await drive(meetingId);
  if (patch.postPromptsToChat !== undefined) await announceChatMode(meetingId).catch(() => undefined);
  return await getMeeting(meetingId);
}

async function facilitate(m: Meeting): Promise<string | undefined> {
  const project = await getProject(m.ontologyId);
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

/** Removes a meeting along with its webhook secret (only once its bot record has settled: see botLifecycle). */
export async function dropMeeting(id: string) { return transaction(async () => {
  await remove('meetings', id);
  await remove('kv', `meeting-secret:${id}`);
}); }

/** Webhook secrets whose meeting has gone (removed some other way). */
export async function pruneSecrets() { return transaction(async () => {
  for (const k of await list<{ id: string }>('kv')) if (k.id.startsWith('meeting-secret:') && !await get('meetings', k.id.slice('meeting-secret:'.length))) await remove('kv', k.id);
}); }

/** "Join a call now": the booking is recorded before it is sent, then sent (see botLifecycle). */
export async function inviteBot(project: OntologyProject, user: User, title: string, meetingUrl: string, opts: { postPromptsToChat?: boolean } = {}) {
  if (!isMeetUrl(meetingUrl)) throw new HttpError(400, 'That does not look like a Google Meet link (https://meet.google.com/abc-defg-hij)');
  const m = await newMeeting(project, user, title, 'google-meet-bot', {
    meetingUrl,
    postPromptsToChat: !!opts.postPromptsToChat,
    bot: recall.enabled() ? idleBot() : { provider: 'simulated', status: 'error', error: NO_BOT_PROVIDER },
    chatModeAnnounced: !!opts.postPromptsToChat,
  });
  if (recall.enabled()) {
    await meetingLock(m.id, async () => {
      const x = await getMeeting(m.id);
      beginBooking(x, undefined, new Date());
      return save(x);
    });
    await drive(m.id);
  }
  await logActivity({ ontologyId: project.id, actorId: user.id, type: 'meeting.bot', message: `invited the co-facilitator to “${m.title}”`, link: `/o/${project.id}/meetings/${m.id}` });
  return await getMeeting(m.id);
}

/** Recall.ai real-time transcript webhook. */
export async function recallWebhook(meetingId: string, secret: string, body: unknown) {
  const stored = await get<{ id: string; secret: string }>('kv', `meeting-secret:${meetingId}`);
  if (!stored || stored.secret !== secret) throw new HttpError(401, 'Bad webhook secret');
  await getMeeting(meetingId);
  const evt = body as {
    event?: string;
    data?: {
      bot?: { id?: string; metadata?: Record<string, string> };
      data?: { words?: { text: string; start_timestamp?: { relative?: number } }[]; participant?: { name?: string } };
    };
  };
  if (evt.event !== 'transcript.data' || !evt.data?.data?.words?.length) return;
  const fromBot = evt.data.bot?.id;
  const fromBooking = evt.data.bot?.metadata?.concord_booking;
  const words = evt.data.data.words;
  let joined = false;
  let kick = false;
  let strayKick = false;
  let strayLine = false;
  // Decided on the latest copy under the meeting's lock, by the bot's identity: only the
  // meeting's own bot, while it is wanted, is heard. A bot of this meeting's that isn't
  // its current one is cancelled; the current one, once unwanted, is released by the clock.
  const kept = await onLiveLine(
    meetingId,
    { speaker: evt.data.data.participant?.name ?? 'Unknown', text: words.map((w) => w.text).join(' '), t: words[0].start_timestamp?.relative },
    {
      accept: (x) => {
        normalise(x);
        if (!tracked(x)) return false;
        const b = x.bot;
        if (fromBot && knownGone(b, fromBot)) {
          // A stray still speaking: its removal is tried again (at most once a minute from its lines).
          if (b.strays?.includes(fromBot)) strayLine = true;
          return false;
        }
        // A line that names another booking than the current one is never the current bot's.
        if (!fromBot && fromBooking && fromBooking !== b.bookingId) return false;
        if (fromBot && fromBot !== b.botId) {
          // The current booking's bot, before Recall.ai's reply named it (the webhook is signed with this meeting's secret).
          // A bot that doesn't say which booking it belongs to is never taken for the current one.
          if (!b.botId && fromBooking && adoptInPlace(x, fromBooking, [{ id: fromBot }])) {
            bump(x);
            if (x.bot.phase !== 'booked') {
              kick = true;
              return false;
            }
          } else {
            strayKick = noteStray(x, fromBot) || strayKick;
            return false;
          }
        }
        const blocked = !!x.withdrawn || (!!x.calendar && (!!x.calendar.cancelPending || !!x.calendar.skip || x.calendar.approval === 'pending'));
        return (x.bot.phase === 'booked' || x.bot.phase === 'booking') && !blocked;
      },
      before: (x) => {
        joined = !x.bot!.inCall;
        if (x.status === 'scheduled') x.status = 'live';
        x.bot!.inCall = true;
        bump(x);
      },
    },
  );
  if (kick) void background(drive(meetingId));
  // A stray (new, or still speaking at most once a minute): only its removal, never the booking's lookups.
  else if (strayKick || (strayLine && strayKickDue(meetingId))) void background(driveStrays(meetingId));
  if (kept && joined) await announceChatMode(meetingId).catch(() => undefined);
}

/** When a stray's own lines last set off an attempt to remove it, per meeting (real time). */
const strayKicks = new Map<string, number>();
function strayKickDue(meetingId: string) {
  const last = strayKicks.get(meetingId) ?? 0;
  if (Date.now() - last < 60_000) return false;
  strayKicks.set(meetingId, Date.now());
  return true;
}

/** After the bot has gone: what it heard is analysed (once, however many ask). */
const finishing = new Map<string, Promise<Meeting>>();
export function finishCall(meetingId: string): Promise<Meeting> {
  const running = finishing.get(meetingId);
  if (running) return running;
  const run = (async () => {
    const m = await getMeeting(meetingId);
    emit(m, { type: 'status', status: m.status, bot: m.bot });
    return m.transcript.length && m.status !== 'analysed' && m.status !== 'processing' ? analyseMeeting(m) : m;
  })().finally(() => finishing.delete(meetingId));
  finishing.set(meetingId, run);
  return run;
}

/**
 * End call: the bot is released (marked under the lock, so anything it sends is
 * refused from now on), and the call is analysed only once Recall.ai confirms the
 * bot has gone. Until then this throws, and the clock keeps trying.
 */
export async function endLiveMeeting(meetingId: string) {
  if ((await getMeeting(meetingId)).bot?.provider === 'recall') {
    await meetingLock(meetingId, async () => {
      const m = await getMeeting(meetingId);
      const gen = m.bot?.gen;
      beginRelease(m, 'leave', 'done');
      if (m.bot?.gen !== gen) emit(await save(m), { type: 'meeting', meeting: m });
    });
    await drive(meetingId);
    const m = await getMeeting(meetingId);
    // Every bot of the call's, strays included, must be confirmed gone.
    if (tracked(m) && (m.bot.phase !== 'done' || !settled(m.bot))) {
      const what = m.bot.phase === 'done' ? 'Another bot that turned up in this call hasn’t been removed yet.' : 'The bot hasn’t left yet.';
      throw new HttpError(502, `${m.bot.fault ?? what} Concord will keep trying; the call is analysed once the bot has left.`);
    }
    return finishCall(meetingId);
  }
  const m = await mutateMeeting(meetingId, (x) => {
    if (x.bot && x.bot.status !== 'done') x.bot = { ...x.bot, status: 'done' };
  });
  emit(m, { type: 'meeting', meeting: m });
  return finishCall(meetingId);
}

/** A facilitator lets go of a booking Recall.ai never confirmed and that can no longer be checked. */
export async function dismissBooking(meetingId: string, user: User) {
  const before = await getMeeting(meetingId);
  await requireFacilitator(before, user, 'dismiss an unconfirmed booking');
  if ((before.bot?.dismissed?.length ?? 0) >= MAX_DISMISSED)
    throw new HttpError(409, `${MAX_DISMISSED} dismissed bookings for this call are still being looked for. This one stays unconfirmed, and is looked for too.`);
  const m = await dismissUnconfirmed(meetingId);
  if (!m) throw new HttpError(409, 'Only a booking Recall.ai never confirmed, and that can no longer be checked by sending it again, can be dismissed.');
  await logActivity({
    ontologyId: before.ontologyId,
    actorId: user.id,
    type: 'meeting.updated',
    message: `confirmed that an unconfirmed bot booking for ${before.calendar?.approval === 'pending' || before.withdrawn ? 'a call' : `“${before.title}”`} can be let go`,
    link: `/o/${before.ontologyId}/meetings/${before.id}`,
  });
  return await get<Meeting>('meetings', meetingId) ?? m;
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
  const m = await newMeeting(project, user, title || 'Volunteering standard: use case call (simulated)', 'simulation', {
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
      await onLiveLine(m.id, { ...line, t: (await getMeeting(m.id)).transcript.length * 20 }, { minGapLines: 4 });
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
  await logActivity({ ontologyId: project.id, actorId: user.id, type: 'meeting.simulated', message: `started a simulated call “${m.title}”`, link: `/o/${project.id}/meetings/${m.id}` });
  return await getMeeting(m.id);
}

export function stopSimulation(id: string) {
  runningSimulations.delete(id);
}
