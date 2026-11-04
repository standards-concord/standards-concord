import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { MeetBotInfo, Meeting, OntologyProject, User } from '@concord/shared';
import { clock } from '../clock.js';
import { config } from '../config.js';
import { get, HttpError, list, put, remove } from '../db.js';
import { newId } from '../ids.js';
import { parseOccurrences, type CalendarOccurrence } from './calendarFeed.js';
import { findProject } from './ontologies.js';
import { dispatchBot, emit, endLiveMeeting, lastLineTime, NO_BOT_PROVIDER, saveMeeting } from './meetings.js';
import { recall } from './recall.js';
import { allUsers, logActivity } from './users.js';

/**
 * Invite-by-email for the co-lead bot.
 *
 * The bot has its own address (MEET_BOT_EMAIL, for example a Gmail account).
 * Adding that address to a calendar invite, for one call or a recurring series,
 * puts the call on the bot's calendar. The server reads that calendar as an
 * iCal feed (MEET_BOT_ICS_URL), files each upcoming call under an ontology, and
 * books a Recall.ai bot shortly before it starts. Moving or cancelling the
 * invite moves or cancels the bot. People can also upload a .ics invite on the
 * Meetings page, which schedules the same way without the email address.
 */

/** Calls further ahead than this aren't listed yet. */
const HORIZON_MS = 14 * 24 * 60 * 60 * 1000;
/** Recall.ai asks for ten minutes' notice to guarantee a bot; book a little earlier. */
export const BOOK_AHEAD_MS = 15 * 60 * 1000;
/** A call that arrives by invite ends this long after its slot once the transcript goes quiet. */
const QUIET_MS = 10 * 60 * 1000;
const OVERRUN_MAX_MS = 3 * 60 * 60 * 1000;

type SyncState = NonNullable<MeetBotInfo['lastSync']>;
const SYNC_KEY = 'meet-bot:last-sync';

export function meetBotInfo(): MeetBotInfo {
  const last = get<SyncState & { id: string }>('kv', SYNC_KEY);
  return {
    provider: recall.enabled() ? 'recall' : 'simulated',
    inviteEmail: config.meetBot.inviteEmail,
    calendarConnected: !!config.meetBot.calendarIcsUrl,
    postToChatDefault: config.meetBot.postToChatDefault,
    lastSync: last ? { at: last.at, ok: last.ok, events: last.events, error: last.error } : undefined,
  };
}

/* ------------------------------------------------------------------------ */
/* Which ontology an invite is about                                          */
/* ------------------------------------------------------------------------ */

const words = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;

/**
 * In order: a plus-address on the invite (concord.bot+volunteering@gmail.com),
 * a tag in the title or description ("#volunteering" or "concord: volunteering"),
 * the one ontology whose title or slug the invite mentions, then the default.
 */
export function routeOccurrence(occ: Pick<CalendarOccurrence, 'title' | 'description' | 'attendees'>): OntologyProject | undefined {
  const projects = list<OntologyProject>('ontologies');
  const bySlug = (tag: string) => findProject(tag.toLowerCase());

  const invite = config.meetBot.inviteEmail?.toLowerCase();
  if (invite?.includes('@')) {
    const [local, domain] = invite.split('@');
    for (const a of occ.attendees) {
      const [aLocal, aDomain] = a.split('@');
      if (aDomain !== domain || !aLocal?.startsWith(`${local}+`)) continue;
      const p = bySlug(aLocal.slice(local.length + 1));
      if (p) return p;
    }
  }

  const text = `${occ.title}\n${occ.description}`;
  for (const m of text.matchAll(/(?:concord:\s*|#)([a-z0-9][a-z0-9-]*)/gi)) {
    const p = bySlug(m[1]);
    if (p) return p;
  }

  const haystack = words(text);
  const mentioned = projects.filter((p) => haystack.includes(words(p.slug)) || haystack.includes(words(p.title)));
  if (mentioned.length === 1) return mentioned[0];

  if (config.meetBot.defaultOntology) {
    const p = findProject(config.meetBot.defaultOntology);
    if (p) return p;
  }
  return projects.find((p) => p.demo) ?? (projects.length === 1 ? projects[0] : undefined);
}

/* ------------------------------------------------------------------------ */
/* Calendar sync                                                             */
/* ------------------------------------------------------------------------ */

async function readFeed(url: string) {
  if (url.startsWith('file:')) return fs.readFile(fileURLToPath(url), 'utf8');
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { Accept: 'text/calendar' } });
  if (!res.ok) throw new Error(`The calendar feed returned ${res.status}`);
  const text = await res.text();
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('The calendar feed is not an iCal file. Use the “Secret address in iCal format” from the calendar’s settings.');
  return text;
}

const organizerUser = (email?: string) => (email ? allUsers().find((u) => u.email?.toLowerCase() === email) : undefined);

/**
 * Brings the scheduled meetings for one feed in line with its occurrences.
 * Calls that disappeared from the bot's calendar (cancelled, or the bot was
 * removed from the invite) are dropped, with their booked bot cancelled.
 */
async function reconcile(occs: CalendarOccurrence[], feed: 'calendar' | 'upload', opts: { now: Date; project?: OntologyProject; actor?: User; postPromptsToChat?: boolean }) {
  const all = list<Meeting>('meetings').filter((m) => m.calendar?.feed === feed && (!opts.project || m.ontologyId === opts.project.id));
  const byKey = new Map(all.map((m) => [m.calendar!.key, m]));
  const touched: Meeting[] = [];

  for (const occ of occs) {
    if (!occ.meetingUrl) continue;
    const existing = byKey.get(occ.key);
    if (!existing) {
      if (occ.end <= opts.now) continue;
      const project = opts.project ?? routeOccurrence(occ);
      if (!project) continue;
      const by = opts.actor ?? organizerUser(occ.organizer);
      const m = saveMeeting({
        id: newId('mtg'),
        ontologyId: project.id,
        title: occ.title,
        source: 'calendar-invite',
        meetingUrl: occ.meetingUrl,
        calendar: { key: occ.key, feed, start: occ.start.toISOString(), end: occ.end.toISOString(), organizer: occ.organizer, recurring: occ.recurring },
        postPromptsToChat: opts.postPromptsToChat ?? config.meetBot.postToChatDefault,
        bot: { provider: recall.enabled() ? 'recall' : 'simulated', status: 'scheduled' },
        transcript: [],
        facilitatorPrompts: [],
        status: 'scheduled',
        createdAt: clock.iso(),
        createdBy: by?.id ?? 'calendar',
      });
      logActivity({
        ontologyId: project.id,
        actorId: by?.id,
        type: 'meeting.scheduled',
        message: `${by ? '' : 'A calendar invite '}scheduled the co-lead bot for “${m.title}” on ${occ.start.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
        link: `/o/${project.id}/meetings/${m.id}`,
      });
      touched.push(m);
      continue;
    }
    touched.push(existing);
    if (existing.status !== 'scheduled') continue;
    const cal = existing.calendar!;
    const moved = cal.start !== occ.start.toISOString() || existing.meetingUrl !== occ.meetingUrl;
    if (!moved && existing.title === occ.title && cal.end === occ.end.toISOString()) continue;
    if (moved && existing.bot?.botId) {
      await recall.deleteBot(existing.bot.botId);
      existing.bot = { provider: existing.bot.provider, status: 'scheduled' };
    }
    existing.title = occ.title;
    existing.meetingUrl = occ.meetingUrl;
    existing.calendar = { ...cal, start: occ.start.toISOString(), end: occ.end.toISOString(), organizer: occ.organizer };
    saveMeeting(existing);
    emit(existing, { type: 'meeting', meeting: existing });
  }

  if (feed === 'calendar') {
    const live = new Set(occs.filter((o) => o.meetingUrl).map((o) => o.key));
    for (const m of all) {
      if (m.status !== 'scheduled' || live.has(m.calendar!.key)) continue;
      if (new Date(m.calendar!.end) <= opts.now) continue; // past; the dispatcher tidies it up
      if (m.bot?.botId) await recall.deleteBot(m.bot.botId);
      remove('meetings', m.id);
    }
  }
  return touched;
}

/** Re-reads the bot's calendar. Without MEET_BOT_ICS_URL this does nothing. */
export async function syncCalendar(now = new Date()): Promise<MeetBotInfo['lastSync']> {
  const url = config.meetBot.calendarIcsUrl;
  if (!url) return undefined;
  let state: SyncState;
  try {
    const occs = parseOccurrences(await readFeed(url), { from: new Date(now.getTime() - OVERRUN_MAX_MS), to: new Date(now.getTime() + HORIZON_MS) });
    await reconcile(occs, 'calendar', { now });
    state = { at: now.toISOString(), ok: true, events: occs.filter((o) => o.meetingUrl).length };
  } catch (err) {
    state = { at: now.toISOString(), ok: false, events: 0, error: (err as Error).message };
    console.warn(`[meet-bot] calendar sync failed: ${state.error}`);
  }
  put('kv', { id: SYNC_KEY, ...state });
  return state;
}

/** "Upload a calendar invite": schedules the bot for every call in a .ics file, under this ontology. */
export async function scheduleFromInvite(project: OntologyProject, user: User, ics: string, opts: { postPromptsToChat?: boolean; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  let occs: CalendarOccurrence[];
  try {
    occs = parseOccurrences(ics, { from: now, to: new Date(now.getTime() + HORIZON_MS) });
  } catch {
    throw new HttpError(400, 'That file is not a calendar invite (.ics).');
  }
  if (!occs.length) throw new HttpError(400, 'That invite has no calls in the next two weeks.');
  if (!occs.some((o) => o.meetingUrl)) throw new HttpError(400, 'That invite has no Google Meet link.');
  const touched = await reconcile(occs, 'upload', { now, project, actor: user, postPromptsToChat: opts.postPromptsToChat });
  await dispatchDue(now);
  return touched.map((m) => get<Meeting>('meetings', m.id) ?? m);
}

/* ------------------------------------------------------------------------ */
/* Booking bots and ending calls                                             */
/* ------------------------------------------------------------------------ */

/** Books bots for calls starting soon, closes out calls that have finished. */
export async function dispatchDue(now = new Date()) {
  for (const m of list<Meeting>('meetings')) {
    if (m.source !== 'calendar-invite' || !m.calendar) continue;
    const start = new Date(m.calendar.start).getTime();
    const end = new Date(m.calendar.end).getTime();
    const t = now.getTime();

    if (m.status === 'scheduled') {
      if (t >= end) {
        if (m.calendar.skip) remove('meetings', m.id);
        else {
          m.status = 'error';
          m.bot = { provider: m.bot?.provider ?? 'simulated', status: 'error', error: m.bot?.error ?? 'The call ended before the bot could join.' };
          saveMeeting(m);
        }
        continue;
      }
      if (m.bot?.botId) {
        // Booked: the call goes live when it starts (or when the first transcript line arrives).
        if (t >= start) {
          m.status = 'live';
          m.bot = { ...m.bot, status: 'joining' };
          saveMeeting(m);
          emit(m, { type: 'meeting', meeting: m });
        }
        continue;
      }
      if (m.calendar.skip || t < start - BOOK_AHEAD_MS) continue;
      if (!recall.enabled()) {
        m.status = 'error';
        m.bot = { provider: 'simulated', status: 'error', error: NO_BOT_PROVIDER };
        saveMeeting(m);
        emit(m, { type: 'meeting', meeting: m });
        continue;
      }
      const bot = await dispatchBot(m, start - t > 60_000 ? new Date(start).toISOString() : undefined);
      // A failed booking is retried on the next tick until the call ends.
      if (bot.status === 'error') m.bot = { provider: 'recall', status: 'scheduled', error: bot.error };
      else if (t >= start) {
        m.bot = bot;
        m.status = 'live';
      } else m.bot = { ...bot, status: 'scheduled' };
      saveMeeting(m);
      emit(m, { type: 'meeting', meeting: m });
      continue;
    }

    if (m.status === 'live' && t > end) {
      const quietFor = t - (lastLineTime(m.id) ?? 0);
      if ((t > end + QUIET_MS && quietFor > QUIET_MS) || t > end + OVERRUN_MAX_MS) await endLiveMeeting(m).catch((err) => console.warn(`[meet-bot] ending ${m.id}: ${(err as Error).message}`));
    }
  }
}

let lastSyncAt = 0;

/** Runs every minute from the server's clock loop. */
export async function meetBotTick(now = new Date()) {
  if (config.meetBot.calendarIcsUrl && now.getTime() - lastSyncAt >= config.meetBot.calendarPollMs - 1000) {
    lastSyncAt = now.getTime();
    await syncCalendar(now);
  }
  await dispatchDue(now);
}
