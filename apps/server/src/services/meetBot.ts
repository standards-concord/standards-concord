import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { MeetBotInfo, Meeting, OntologyProject, User } from '@concord/shared';
import { clock } from '../clock.js';
import { config } from '../config.js';
import { get, HttpError, list, put, remove } from '../db.js';
import { newId } from '../ids.js';
import { withLock } from '../locks.js';
import { parseOccurrences, type CalendarOccurrence } from './calendarFeed.js';
import { findProject, rolesFor } from './ontologies.js';
import { dispatchBot, emit, endLiveMeeting, FACILITATOR_ROLES, lastLineTime, meetingLock, NO_BOT_PROVIDER, saveMeeting } from './meetings.js';
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
 * invite moves or cancels the bot.
 *
 * Only invites from the ontology's facilitators (or MEET_BOT_ALLOWED_INVITERS)
 * book a bot straight away; anyone else's wait for a facilitator to approve, so
 * a stranger can't send a paid bot into a call. People can also import a .ics
 * invite on the Meetings page: a one-off import of the next two weeks' calls.
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
/* Who invited the bot, and which ontology the call is about                  */
/* ------------------------------------------------------------------------ */

const words = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;

function splitInvite() {
  const invite = config.meetBot.inviteEmail?.toLowerCase();
  if (!invite?.includes('@')) return undefined;
  const [local, domain] = invite.split('@');
  return { local, domain };
}

/** The address the bot was invited as (its own, or a plus-address of it), if it was invited at all. */
export function botAttendee(occ: Pick<CalendarOccurrence, 'attendees'>): string | undefined {
  const inv = splitInvite();
  if (!inv) return undefined;
  return occ.attendees.find((a) => {
    const [l, d] = a.split('@');
    return d === inv.domain && (l === inv.local || l?.startsWith(`${inv.local}+`));
  });
}

/**
 * In order: a plus-address on the invite (concord.bot+volunteering@gmail.com),
 * a tag in the title or description ("#volunteering" or "concord: volunteering"),
 * the one ontology whose title or slug the invite mentions, then the default.
 * These only choose the ontology; they never authorise the bot.
 */
export function routeOccurrence(occ: Pick<CalendarOccurrence, 'title' | 'description' | 'attendees'>): OntologyProject | undefined {
  const projects = list<OntologyProject>('ontologies');
  const bySlug = (tag: string) => findProject(tag.toLowerCase());

  const inv = splitInvite();
  if (inv) {
    for (const a of occ.attendees) {
      const [aLocal, aDomain] = a.split('@');
      if (aDomain !== inv.domain || !aLocal?.startsWith(`${inv.local}+`)) continue;
      const p = bySlug(aLocal.slice(inv.local.length + 1));
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

const userByEmail = (email?: string) => (email ? allUsers().find((u) => u.email?.toLowerCase() === email) : undefined);

/** May this organiser book the bot for this ontology without a facilitator approving it? */
export function inviterAuthorised(organizer: string | undefined, project: OntologyProject) {
  if (!organizer) return false;
  const allowed = config.meetBot.allowedInviters;
  if (allowed.includes(organizer) || allowed.some((a) => a.startsWith('@') && organizer.endsWith(a))) return true;
  const u = userByEmail(organizer);
  return !!u && (!!u.isPlatformAdmin || config.adminEmails.includes(organizer) || rolesFor(project.id, u.id).some((r) => FACILITATOR_ROLES.includes(r)));
}

/* ------------------------------------------------------------------------ */
/* Reading the calendar                                                       */
/* ------------------------------------------------------------------------ */

/** Errors about the feed never repeat its address: it is a secret, and the error is shown publicly. */
export function sanitise(message: string) {
  let out = message;
  const url = config.meetBot.calendarIcsUrl;
  if (url) out = out.split(url).join('[calendar address]');
  return out.replace(/\b(?:https?|webcal|file):\/\/\S+/gi, '[calendar address]');
}

/** Checks MEET_BOT_ICS_URL before it is used. Returns a problem to report, if any. */
export function feedProblem(url: string): string | undefined {
  try {
    const u = new URL(url.replace(/^webcal:/i, 'https:'));
    if (!['https:', 'http:', 'file:'].includes(u.protocol)) return 'MEET_BOT_ICS_URL must be an https:// address (the calendar’s secret address in iCal format).';
  } catch {
    return 'MEET_BOT_ICS_URL is not a valid address. Paste the calendar’s secret address in iCal format, without quotes.';
  }
  return undefined;
}

async function readFeed(url: string) {
  const problem = feedProblem(url);
  if (problem) throw new Error(problem);
  if (url.startsWith('file:')) return fs.readFile(fileURLToPath(url), 'utf8');
  let res: Response;
  try {
    res = await fetch(url.replace(/^webcal:/i, 'https:'), { signal: AbortSignal.timeout(20_000), headers: { Accept: 'text/calendar' } });
  } catch {
    throw new Error('Could not reach the calendar feed.');
  }
  if (!res.ok) throw new Error(`The calendar feed returned ${res.status}${res.status === 404 ? '. The secret address may have been reset; copy it again from the calendar’s settings' : ''}.`);
  const text = await res.text();
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('The calendar feed is not an iCal file. Use the “Secret address in iCal format” from the calendar’s settings.');
  return text;
}

/* ------------------------------------------------------------------------ */
/* Keeping scheduled meetings in line with the calendar                        */
/* ------------------------------------------------------------------------ */

/** Drops a scheduled call, cancelling its booked bot first. If Recall.ai won't cancel, it is kept and retried. */
async function cancelScheduled(meetingId: string): Promise<boolean> {
  return meetingLock(meetingId, async () => {
    const m = get<Meeting>('meetings', meetingId);
    if (!m) return true;
    if (m.bot?.botId) {
      const r = await recall.cancelBot(m.bot.botId);
      if (!r.ok) {
        m.calendar = { ...m.calendar!, cancelPending: true };
        m.bot = { ...m.bot, error: r.error };
        saveMeeting(m);
        return false;
      }
    }
    remove('meetings', m.id);
    return true;
  });
}

const calendarMeetings = () => list<Meeting>('meetings').filter((m) => m.source === 'calendar-invite' && m.calendar);

/**
 * Brings the scheduled meetings in line with a feed's occurrences. One meeting per
 * occurrence, whichever way it arrived. Calls that disappeared from the bot's
 * calendar (cancelled, or the bot was taken off the invite) are dropped, and so
 * are weeks missing from a re-imported .ics of the same series.
 */
async function reconcile(occs: CalendarOccurrence[], feed: 'calendar' | 'upload', opts: { now: Date; project?: OntologyProject; actor?: User; postPromptsToChat?: boolean }) {
  const byKey = new Map(calendarMeetings().map((m) => [m.calendar!.key, m]));
  const touched: Meeting[] = [];
  const seen = new Set<string>();

  for (const occ of occs) {
    if (!occ.meetingUrl) continue;
    // From the calendar, only invites the bot is on (and hasn't declined) count.
    if (feed === 'calendar' && config.meetBot.inviteEmail) {
      const me = botAttendee(occ);
      if (!me || occ.attendeeStatus[me] === 'DECLINED') continue;
    }
    seen.add(occ.key);
    const existing = byKey.get(occ.key);

    if (!existing) {
      if (occ.end <= opts.now) continue;
      const project = opts.project ?? routeOccurrence(occ);
      if (!project) continue;
      const approved = feed === 'upload' || inviterAuthorised(occ.organizer, project);
      const by = opts.actor ?? userByEmail(occ.organizer);
      const postPromptsToChat = opts.postPromptsToChat ?? config.meetBot.postToChatDefault;
      const m = saveMeeting({
        id: newId('mtg'),
        ontologyId: project.id,
        title: occ.title,
        source: 'calendar-invite',
        meetingUrl: occ.meetingUrl,
        calendar: {
          key: occ.key,
          uid: occ.uid,
          feed,
          start: occ.start.toISOString(),
          end: occ.end.toISOString(),
          organizer: occ.organizer,
          recurring: occ.recurring,
          approval: approved ? 'approved' : 'pending',
          approvedBy: approved ? by?.id : undefined,
        },
        postPromptsToChat,
        chatModeAnnounced: postPromptsToChat,
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
        message: approved
          ? `${by ? '' : 'A calendar invite '}scheduled the co-lead bot for “${m.title}” on ${occ.start.toISOString().slice(0, 16).replace('T', ' ')} UTC`
          : `An invite from ${occ.organizer ?? 'an unknown organiser'} asks the co-lead bot to join “${m.title}”. A facilitator needs to approve it.`,
        link: `/o/${project.id}/meetings/${m.id}`,
      });
      touched.push(m);
      continue;
    }

    if (opts.project && existing.ontologyId !== opts.project.id) {
      const other = findProject(existing.ontologyId);
      throw new HttpError(409, `“${existing.title}” is already scheduled under ${other?.title ?? 'another ontology'}.`);
    }
    const updated = await meetingLock(existing.id, async () => {
      const m = get<Meeting>('meetings', existing.id);
      if (!m) return undefined;
      // The calendar is the better source: it reports moves and cancellations.
      if (feed === 'calendar' && m.calendar!.feed === 'upload') m.calendar!.feed = 'calendar';
      if (m.status !== 'scheduled') return m;
      const cal = m.calendar!;
      const moved = cal.start !== occ.start.toISOString() || m.meetingUrl !== occ.meetingUrl;
      if (!moved && m.title === occ.title && cal.end === occ.end.toISOString()) return saveMeeting(m);
      if (moved && m.bot?.botId) {
        const r = await recall.cancelBot(m.bot.botId);
        // Keep the old booking (and retry) rather than lose track of a bot that may still join.
        if (!r.ok) {
          m.bot = { ...m.bot, error: r.error };
          return saveMeeting(m);
        }
        m.bot = { provider: m.bot.provider, status: 'scheduled' };
      }
      m.title = occ.title;
      m.meetingUrl = occ.meetingUrl;
      m.calendar = { ...cal, start: occ.start.toISOString(), end: occ.end.toISOString(), organizer: occ.organizer, cancelPending: undefined };
      return saveMeeting(m);
    });
    if (updated) {
      emit(updated, { type: 'meeting', meeting: updated });
      touched.push(updated);
    }
  }

  // Scheduled calls this feed no longer lists.
  const uids = new Set(occs.map((o) => o.uid));
  for (const m of calendarMeetings()) {
    const cal = m.calendar!;
    if (m.status !== 'scheduled' || seen.has(cal.key) || new Date(cal.end) <= opts.now) continue;
    const gone = feed === 'calendar' ? cal.feed === 'calendar' : cal.feed === 'upload' && m.ontologyId === opts.project?.id && !!cal.uid && uids.has(cal.uid) && new Date(cal.start).getTime() < opts.now.getTime() + HORIZON_MS;
    if (gone) await cancelScheduled(m.id);
  }
  return touched;
}

/** Re-reads the bot's calendar. Without MEET_BOT_ICS_URL this does nothing. */
export async function syncCalendar(now = new Date()): Promise<MeetBotInfo['lastSync']> {
  const url = config.meetBot.calendarIcsUrl;
  if (!url) return undefined;
  return withLock('meet-bot:calendar', async () => {
    let state: SyncState;
    try {
      const occs = parseOccurrences(await readFeed(url), { from: new Date(now.getTime() - OVERRUN_MAX_MS), to: new Date(now.getTime() + HORIZON_MS) });
      await reconcile(occs, 'calendar', { now });
      state = { at: now.toISOString(), ok: true, events: occs.filter((o) => o.meetingUrl && (!config.meetBot.inviteEmail || botAttendee(o))).length };
    } catch (err) {
      state = { at: now.toISOString(), ok: false, events: 0, error: sanitise((err as Error).message) };
      console.warn(`[meet-bot] calendar sync failed: ${state.error}`);
    }
    put('kv', { id: SYNC_KEY, ...state });
    return state;
  });
}

/**
 * "Import calendar occurrences": schedules the bot for the calls in a .ics file
 * over the next two weeks, under this ontology. A one-off import: later weeks of
 * a series need another import, or an invite to the bot's address.
 */
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
  const touched = await withLock('meet-bot:calendar', () => reconcile(occs, 'upload', { now, project, actor: user, postPromptsToChat: opts.postPromptsToChat }));
  await dispatchDue(now);
  return touched.map((m) => get<Meeting>('meetings', m.id) ?? m);
}

/* ------------------------------------------------------------------------ */
/* Booking bots and ending calls                                             */
/* ------------------------------------------------------------------------ */

/** One scheduled call: book its bot when it's due, go live when it starts, tidy up when it's over. Runs under the meeting's lock. */
async function dispatchOne(meetingId: string, now: Date) {
  return meetingLock(meetingId, async () => {
    const m = get<Meeting>('meetings', meetingId);
    if (!m || m.status !== 'scheduled' || !m.calendar) return;
    const cal = m.calendar;
    const start = new Date(cal.start).getTime();
    const end = new Date(cal.end).getTime();
    const t = now.getTime();
    const changed = () => {
      saveMeeting(m);
      emit(m, { type: 'meeting', meeting: m });
    };

    if (cal.cancelPending) {
      const r = m.bot?.botId ? await recall.cancelBot(m.bot.botId) : ({ ok: true } as const);
      if (r.ok) remove('meetings', m.id);
      return;
    }
    if (t >= end) {
      if (cal.skip || cal.approval === 'pending') remove('meetings', m.id);
      else {
        m.status = 'error';
        m.bot = { provider: m.bot?.provider ?? 'simulated', status: 'error', error: m.bot?.error ?? 'The call ended before the bot could join.' };
        changed();
      }
      return;
    }
    if (m.bot?.botId) {
      // Booked: the call goes live when it starts (or when the first transcript line arrives).
      if (t >= start) {
        m.status = 'live';
        m.bot = { ...m.bot, status: 'joining' };
        changed();
      }
      return;
    }
    if (cal.skip || cal.approval === 'pending' || t < start - BOOK_AHEAD_MS) return;
    if (!recall.enabled()) {
      m.status = 'error';
      m.bot = { provider: 'simulated', status: 'error', error: NO_BOT_PROVIDER };
      changed();
      return;
    }
    const bot = await dispatchBot(m, start - t > 60_000 ? new Date(start).toISOString() : undefined);
    // A failed booking is retried on the next tick until the call ends.
    if (bot.status === 'error') m.bot = { provider: 'recall', status: 'scheduled', error: bot.error };
    else if (t >= start) {
      m.bot = bot;
      m.status = 'live';
    } else m.bot = { ...bot, status: 'scheduled' };
    m.chatModeAnnounced = !!m.postPromptsToChat;
    changed();
  });
}

/** Books bots for calls starting soon, closes out calls that have finished. */
export async function dispatchDue(now = new Date()) {
  for (const m of calendarMeetings()) {
    if (m.status === 'scheduled') await dispatchOne(m.id, now);
    else if (m.status === 'live' && now.getTime() > new Date(m.calendar!.end).getTime()) {
      const t = now.getTime();
      const end = new Date(m.calendar!.end).getTime();
      const quietFor = t - (lastLineTime(m.id) ?? 0);
      if ((t > end + QUIET_MS && quietFor > QUIET_MS) || t > end + OVERRUN_MAX_MS) await endLiveMeeting(m.id).catch((err) => console.warn(`[meet-bot] ending ${m.id}: ${(err as Error).message}`));
    }
  }
}

let lastSyncAt = 0;
let ticking = false;

/** Runs every minute from the server's clock loop. Overlapping ticks are skipped. */
export async function meetBotTick(now = new Date()) {
  if (ticking) return;
  ticking = true;
  try {
    if (config.meetBot.calendarIcsUrl && now.getTime() - lastSyncAt >= config.meetBot.calendarPollMs - 1000) {
      lastSyncAt = now.getTime();
      await syncCalendar(now);
    }
    await dispatchDue(now);
  } finally {
    ticking = false;
  }
}
