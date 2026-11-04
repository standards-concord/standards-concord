import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { MeetBotInfo, Meeting, OntologyProject, User } from '@concord/shared';
import { clock } from '../clock.js';
import { config } from '../config.js';
import { get, HttpError, list, put, remove } from '../db.js';
import { newId } from '../ids.js';
import { withLock } from '../locks.js';
import { parseCancellations, parseOccurrences, type CalendarOccurrence } from './calendarFeed.js';
import { findProject } from './ontologies.js';
import {
  botActive,
  cancelMeetingBot,
  dispatchBot,
  emit,
  endLiveMeeting,
  findLostBooking,
  bookingsInFlight,
  lastLineTime,
  meetingLock,
  NO_BOT_PROVIDER,
  recordSeriesApproval,
  saveMeeting,
  seriesApproved,
} from './meetings.js';
import { recall } from './recall.js';
import { retireDue, retiringCount, watchBooking } from './retiring.js';
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
 * An invite can't prove who sent it (its organiser is just text), so a call
 * that arrives this way waits for one of the ontology's owners, stewards or
 * editors to approve it (once for a whole series, while its organiser and Meet
 * link stay the same) before a bot is booked. People can also import a .ics
 * invite on the Meetings page: a one-off import of the next two weeks' calls,
 * approved by whoever imports it.
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
    cancelling: retiringCount() || undefined,
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

/** Whether this occurrence's series was already approved, with the same organiser and Meet link. */
function preApproved(occ: CalendarOccurrence, project: OntologyProject) {
  const series = seriesApproved(project.id, occ.uid, occ.organizer, occ.meetingUrl);
  return series ? { by: series.approvedBy } : undefined;
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

/**
 * A call that has been cancelled (or the bot taken off it). Before it starts, the
 * booked bot is cancelled (including one whose booking reply was lost) and the
 * meeting dropped; if Recall.ai won't cancel, the meeting is kept, marked, and
 * retried every minute. Once the bot is in the call, it is taken out and what it
 * heard so far is analysed. Returns whether that is done, or still being retried.
 */
async function withdrawCall(meetingId: string): Promise<'done' | 'retrying'> {
  const live = get<Meeting>('meetings', meetingId);
  if (live && live.status !== 'scheduled') {
    if (!botActive(live) || live.bot?.leaving) return live.bot?.leaving ? 'retrying' : 'done';
    return endLiveMeeting(meetingId).then(
      () => 'done' as const,
      () => 'retrying' as const,
    );
  }
  return meetingLock(meetingId, async () => {
    const m = get<Meeting>('meetings', meetingId);
    if (!m) return 'done';
    // The bot is recorded for cancelling first (retried every minute until Recall.ai
    // confirms, and any line it sends meanwhile dropped), so the meeting can go now.
    const r = await cancelMeetingBot(m);
    remove('meetings', m.id);
    return r.ok ? 'done' : 'retrying';
  });
}

const calendarMeetings = () => list<Meeting>('meetings').filter((m) => m.source === 'calendar-invite' && m.calendar);

/**
 * Brings the scheduled meetings in line with a feed's occurrences. One meeting per
 * occurrence, whichever way it arrived. Calls that disappeared from the bot's
 * calendar (cancelled, or the bot was taken off the invite) are dropped, and so
 * are weeks missing from a re-imported .ics of the same series.
 */
async function reconcile(
  occs: CalendarOccurrence[],
  feed: 'calendar' | 'upload',
  opts: { now: Date; project?: OntologyProject; actor?: User; postPromptsToChat?: boolean; cancelled?: { uids: string[]; keys: string[] } },
) {
  const byKey = new Map(calendarMeetings().map((m) => [m.calendar!.key, m]));
  const touched: Meeting[] = [];
  const seen = new Set<string>();
  /** Live calls whose invite changed under them: the bot is taken out once the loop is done. */
  const endAfter: string[] = [];

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
      // Importing a file is the importer's own approval (only facilitators can import).
      const approval = feed === 'upload' && opts.actor ? { by: opts.actor.id } : preApproved(occ, project);
      const approved = !!approval;
      if (feed === 'upload' && opts.actor) recordSeriesApproval(project.id, occ.uid, occ.organizer, occ.meetingUrl, opts.actor.id);
      const by = opts.actor ?? (approval ? allUsers().find((u) => u.id === approval.by) : undefined);
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
          sentBy: occ.sentBy,
          recurring: occ.recurring,
          approval: approved ? 'approved' : 'pending',
          approvedBy: approval?.by,
        },
        postPromptsToChat,
        chatModeAnnounced: postPromptsToChat,
        bot: { provider: recall.enabled() ? 'recall' : 'simulated', status: 'scheduled' },
        transcript: [],
        facilitatorPrompts: [],
        status: 'scheduled',
        createdAt: clock.iso(),
        // Who sent an invite is unproven, so a calendar call belongs to no one in particular.
        createdBy: feed === 'upload' && opts.actor ? opts.actor.id : 'calendar',
      });
      logActivity({
        ontologyId: project.id,
        actorId: by?.id,
        type: 'meeting.scheduled',
        message: approved
          ? `${by ? '' : 'A calendar invite '}scheduled the co-lead bot for “${m.title}” on ${occ.start.toISOString().slice(0, 16).replace('T', ' ')} UTC`
          : 'A calendar invite asks the co-lead bot to join a call. A facilitator needs to approve it on the Meetings page.',
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
      const cal = m.calendar!;
      const importer = feed === 'upload' ? opts.actor : undefined;
      // A new organiser or Meet link needs approving again, unless its series was approved as it now stands (or a facilitator imports it).
      const detailsChanged = cal.organizer !== occ.organizer || m.meetingUrl !== occ.meetingUrl;
      const reapprove =
        detailsChanged && cal.approval === 'approved' && !importer && !preApproved(occ, findProject(m.ontologyId)!)
          ? m.meetingUrl !== occ.meetingUrl
            ? 'The invite’s Meet link changed since it was approved.'
            : 'The invite’s organiser changed since it was approved.'
          : undefined;
      if (m.status !== 'scheduled') {
        // Changed under a call the bot is already in: the bot leaves (once this loop is done, refusing
        // anything it sends meanwhile) and what it heard is analysed. Later weeks with the new details
        // need approving again, since the series approval no longer matches them.
        if (reapprove && botActive(m) && !m.bot?.leaving) {
          m.calendar = { ...cal, organizer: occ.organizer, sentBy: occ.sentBy, approvalNote: `${reapprove} The bot left the call; calls with the new details need approving again.` };
          m.bot = { ...m.bot!, leaving: true };
          saveMeeting(m);
          logActivity({
            ontologyId: m.ontologyId,
            type: 'meeting.updated',
            message: 'The co-lead bot is leaving a call because its invite changed.',
            link: `/o/${m.ontologyId}/meetings/${m.id}`,
          });
          endAfter.push(m.id);
        }
        return m;
      }
      // Importing the invite is the importer's approval, for a call waiting for one too.
      if (importer) {
        recordSeriesApproval(m.ontologyId, occ.uid, occ.organizer, occ.meetingUrl, importer.id);
        if (cal.approval === 'pending') {
          cal.approval = 'approved';
          cal.approvedBy = importer.id;
          delete cal.approvalNote;
        }
      }
      const moved = cal.start !== occ.start.toISOString() || m.meetingUrl !== occ.meetingUrl;
      if (!moved && !detailsChanged && m.title === occ.title && cal.end === occ.end.toISOString()) return saveMeeting(m);
      if (reapprove) {
        m.calendar = { ...cal, approval: 'pending', approvedBy: undefined, approvalNote: reapprove };
        logActivity({ ontologyId: m.ontologyId, type: 'meeting.updated', message: 'A call needs approving again because its invite changed.', link: `/o/${m.ontologyId}/meetings/${m.id}` });
      }
      // The booked bot is let go: recorded for cancelling (with the Meet link it was booked for,
      // retried until Recall.ai confirms), so a later approval books a fresh one.
      if ((moved || reapprove) && (m.bot?.botId || m.bot?.uncertain || m.bot?.bookingId)) {
        const r = await cancelMeetingBot(m);
        m.bot = { provider: m.bot!.provider, status: 'scheduled', cancelError: r.ok ? undefined : r.error };
      }
      m.title = occ.title;
      m.meetingUrl = occ.meetingUrl;
      m.calendar = { ...m.calendar!, start: occ.start.toISOString(), end: occ.end.toISOString(), organizer: occ.organizer, sentBy: occ.sentBy, cancelPending: undefined };
      return saveMeeting(m);
    });
    if (updated) {
      emit(updated, { type: 'meeting', meeting: updated });
      touched.push(updated);
    }
  }

  for (const id of endAfter) await endLiveMeeting(id).catch(() => undefined);

  // Calls this feed no longer lists: cancelled before they start, or the bot taken out
  // if it's already in (past the scheduled end too, while the call overruns).
  const uids = new Set(occs.map((o) => o.uid));
  for (const m of calendarMeetings()) {
    const cal = m.calendar!;
    if (seen.has(cal.key) || cal.cancelPending) continue;
    if (m.status === 'scheduled' ? new Date(cal.end) <= opts.now : !botActive(m) || m.bot?.leaving) continue;
    // Older than the feed window: the clock ends that call by itself.
    if (new Date(cal.end).getTime() < opts.now.getTime() - OVERRUN_MAX_MS) continue;
    const gone = feed === 'calendar' ? cal.feed === 'calendar' : cal.feed === 'upload' && m.ontologyId === opts.project?.id && !!cal.uid && uids.has(cal.uid) && new Date(cal.start).getTime() < opts.now.getTime() + HORIZON_MS;
    if (gone) await withdrawCall(m.id);
  }
  return touched;
}

/** Calls an imported cancellation names (a whole event or series, or single weeks), in this ontology: how many are done, and how many are still being retried. */
async function applyCancellations(project: OntologyProject, cancelled: { uids: string[]; keys: string[] }) {
  const out = { cancelled: 0, retrying: 0 };
  for (const m of calendarMeetings()) {
    const cal = m.calendar!;
    if (m.ontologyId !== project.id || (m.status !== 'scheduled' && !botActive(m))) continue;
    if (!cancelled.keys.includes(cal.key) && !(cal.uid && cancelled.uids.includes(cal.uid))) continue;
    if ((await withdrawCall(m.id)) === 'done') out.cancelled++;
    else out.retrying++;
  }
  return out;
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
  let cancelled: { uids: string[]; keys: string[] };
  try {
    occs = parseOccurrences(ics, { from: now, to: new Date(now.getTime() + HORIZON_MS) });
    cancelled = parseCancellations(ics);
  } catch {
    throw new HttpError(400, 'That file is not a calendar invite (.ics).');
  }
  const cancels = cancelled.uids.length + cancelled.keys.length > 0;
  if (!occs.length && !cancels) throw new HttpError(400, 'That invite has no calls in the next two weeks.');
  if (occs.length && !occs.some((o) => o.meetingUrl)) throw new HttpError(400, 'That invite has no Google Meet link.');
  const { touched, c } = await withLock('meet-bot:calendar', async () => ({
    c: cancels ? await applyCancellations(project, cancelled) : { cancelled: 0, retrying: 0 },
    touched: occs.length ? await reconcile(occs, 'upload', { now, project, actor: user, postPromptsToChat: opts.postPromptsToChat }) : [],
  }));
  if (c.cancelled + c.retrying)
    logActivity({
      ontologyId: project.id,
      actorId: user.id,
      type: 'meeting.updated',
      message: `imported a cancellation for ${c.cancelled + c.retrying === 1 ? 'one call' : `${c.cancelled + c.retrying} calls`}${c.retrying ? '; cancelling the bot is being retried' : ''}`,
      link: `/o/${project.id}/meetings`,
    });
  await dispatchDue(now);
  return { meetings: touched.map((m) => get<Meeting>('meetings', m.id) ?? m), cancelled: c.cancelled, cancelRetrying: c.retrying };
}

/* ------------------------------------------------------------------------ */
/* Booking bots and ending calls                                             */
/* ------------------------------------------------------------------------ */

/** One calendar call: book its bot when it's due, go live when it starts, tidy up when it's over. Runs under the meeting's lock. */
async function dispatchOne(meetingId: string, now: Date) {
  return meetingLock(meetingId, async () => {
    const m = get<Meeting>('meetings', meetingId);
    if (!m || !m.calendar) return;
    const cal = m.calendar;
    const start = new Date(cal.start).getTime();
    const end = new Date(cal.end).getTime();
    const t = now.getTime();
    const changed = () => {
      saveMeeting(m);
      emit(m, { type: 'meeting', meeting: m });
    };

    // Left over from before the cancellation ledger: hand the bot to it and drop the call.
    if (cal.cancelPending) {
      await cancelMeetingBot(m);
      remove('meetings', m.id);
      return;
    }
    // A booked bot on a call that's now skipped or waiting for approval is let go: the
    // ledger retries the cancellation until Recall.ai confirms, and drops anything it sends.
    if ((m.bot?.botId || m.bot?.uncertain || m.bot?.bookingId) && m.bot.status !== 'done' && m.bot.status !== 'in-call' && (cal.skip || cal.approval === 'pending')) {
      const r = await cancelMeetingBot(m);
      m.bot = { provider: m.bot.provider, status: 'scheduled', cancelError: r.ok ? undefined : r.error };
      if (m.status === 'live') m.status = 'scheduled';
      changed();
    }
    if (m.status !== 'scheduled') return;

    if (t >= end) {
      // Whatever was booked (or may have been, if the reply was lost) is let go before the meeting forgets it.
      if (m.bot?.botId || m.bot?.uncertain || m.bot?.bookingId) await cancelMeetingBot(m);
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
    // The last booking's answer was lost: look for that bot before booking another.
    if (m.bot?.uncertain) {
      const lost = await findLostBooking(m);
      if (!lost) return;
      if (lost.botId) {
        m.bot = { provider: 'recall', botId: lost.botId, status: t >= start ? 'joining' : 'scheduled', bookingId: m.bot.bookingId, bookedUrl: m.bot.bookedUrl };
        if (t >= start) m.status = 'live';
        m.chatModeAnnounced = !!m.postPromptsToChat;
        changed();
        return;
      }
      // Not listed (yet): a slow create could still land, so that booking is watched for (and cancelled if it turns up) while a new one is made.
      watchBooking(m.id, m.bot.bookingId, m.bot.bookedUrl ?? m.meetingUrl);
    }
    // The attempt is recorded before it is sent (as unconfirmed until Recall.ai answers), so a restart
    // mid-booking looks for this bot instead of booking another.
    const bookingId = newId('bk');
    m.bot = { provider: 'recall', status: 'scheduled', bookingId, bookedUrl: m.meetingUrl, uncertain: true, error: m.bot?.error, cancelError: m.bot?.cancelError };
    saveMeeting(m);
    const bot = await dispatchBot(m, start - t > 60_000 ? new Date(start).toISOString() : undefined, bookingId);
    // A failed booking is retried on the next tick until the call ends.
    // An unconfirmed booking keeps its booking id and Meet link, so the bot can still be found (or cancelled) later.
    if (bot.status === 'error')
      m.bot = {
        provider: 'recall',
        status: 'scheduled',
        error: bot.error,
        uncertain: bot.uncertain,
        bookingId: bot.uncertain ? bot.bookingId : undefined,
        bookedUrl: bot.uncertain ? bot.bookedUrl : undefined,
      };
    else if (t >= start) {
      m.bot = bot;
      m.status = 'live';
    } else m.bot = { ...bot, status: 'scheduled' };
    m.chatModeAnnounced = !!m.postPromptsToChat;
    changed();
  });
}

/** A "Join a call now" booking whose answer was lost: adopt the bot if it exists, otherwise say booking failed. */
async function settleLostBooking(meetingId: string) {
  return meetingLock(meetingId, async () => {
    const m = get<Meeting>('meetings', meetingId);
    // Still being booked by this process: the reply will settle it.
    if (!m?.bot?.uncertain || bookingsInFlight.has(meetingId)) return;
    const lost = await findLostBooking(m);
    if (!lost) return;
    if (lost.botId) m.bot = { ...m.bot, botId: lost.botId, status: m.bot.status === 'in-call' ? 'in-call' : 'joining', uncertain: undefined, error: undefined };
    // Already heard in the call: keep looking rather than call it failed.
    else if (m.bot.status === 'in-call') return;
    else {
      watchBooking(m.id, m.bot.bookingId, m.bot.bookedUrl ?? m.meetingUrl);
      m.bot = { provider: 'recall', status: 'error', error: 'Booking the bot failed. Send it again.' };
    }
    saveMeeting(m);
    emit(m, { type: 'meeting', meeting: m });
  });
}

/** Books bots for calls starting soon, closes out calls that have finished, and retries anything that failed. */
/** sweep: also retry the cancellation ledger, after the bookings (the clock loop runs it in its own lane instead). */
export async function dispatchDue(now = new Date(), opts: { sweep?: boolean } = {}) {
  const t = now.getTime();
  for (const m of calendarMeetings()) {
    await dispatchOne(m.id, now);
    const fresh = get<Meeting>('meetings', m.id);
    // A calendar call ends by itself once it's past its slot and quiet (or long overrun), whatever has happened to its analysis.
    if (!fresh?.calendar || !botActive(fresh) || fresh.bot?.leaving) continue;
    const end = new Date(fresh.calendar.end).getTime();
    const quietFor = t - (lastLineTime(fresh.id) ?? 0);
    if ((t > end + QUIET_MS && quietFor > QUIET_MS) || t > end + OVERRUN_MAX_MS) await endLiveMeeting(fresh.id).catch((err) => console.warn(`[meet-bot] ending ${fresh.id}: ${(err as Error).message}`));
  }
  for (const m of list<Meeting>('meetings')) {
    // Removing a bot from a call someone ended, until Recall.ai confirms.
    if (m.bot?.leaving) await endLiveMeeting(m.id).catch(() => undefined);
    else if (m.bot?.uncertain && m.source === 'google-meet-bot') await settleLostBooking(m.id);
  }
  if (opts.sweep !== false) await retireDue(now);
}

let sweeping = false;
/** Cancellation retries run beside the bookings, so a stalled one never holds up a call that's due. */
function sweepLedger(now: Date) {
  if (sweeping) return;
  sweeping = true;
  void retireDue(now)
    .catch((err) => console.warn(`[meet-bot] cancellation retries: ${(err as Error).message}`))
    .finally(() => (sweeping = false));
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
    sweepLedger(now);
    await dispatchDue(now, { sweep: false });
  } finally {
    ticking = false;
  }
}
