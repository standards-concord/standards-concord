import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { MeetBotInfo, Meeting, OntologyProject, User } from '@concord/shared';
import { clock } from '../clock.js';
import { config } from '../config.js';
import { transaction, get, HttpError, list, put } from '../db.js';
import { newId } from '../ids.js';
import { withLock } from '../locks.js';
import { parseCancellations, parseOccurrences, type CalendarOccurrence } from './calendarFeed.js';
import { findProject } from './ontologies.js';
import { beginBooking, beginRelease, background, bump, drive, driveDue, droppable, idleBot, lanesIdle, normalise, releasingCount, settled, tracked } from './botLifecycle.js';
import { botActive, botOutstanding, dropMeeting, emit, endLiveMeeting, lastLineTime, meetingLock, NO_BOT_PROVIDER, pruneSecrets, recordSeriesApproval, saveMeeting, seriesApproved } from './meetings.js';
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
 * An invite can't prove who sent it (its organiser is just text), so a call
 * that arrives this way waits for one of the ontology's owners, stewards or
 * editors to approve it (once for a whole series, while its organiser and Meet
 * link stay the same) before a bot is booked. People can also import a .ics
 * invite on the Meetings page: a one-off import of the next two weeks' calls,
 * approved by whoever imports it.
 */

/** Calls further ahead than this aren't listed yet. */
const HORIZON_MS = 14 * 24 * 60 * 60 * 1000;
/** Without a Recall.ai key, an approved call says it can't have a bot this long before it starts. */
const NO_PROVIDER_NOTICE_MS = 15 * 60 * 1000;
/** A call that arrives by invite ends this long after its slot once the transcript goes quiet. */
const QUIET_MS = 10 * 60 * 1000;
const OVERRUN_MAX_MS = 3 * 60 * 60 * 1000;

type SyncState = NonNullable<MeetBotInfo['lastSync']>;
const SYNC_KEY = 'meet-bot:last-sync';

export async function meetBotInfo(): Promise<MeetBotInfo> {
  const last = await get<SyncState & { id: string }>('kv', SYNC_KEY);
  return {
    provider: recall.enabled() ? 'recall' : 'simulated',
    inviteEmail: config.meetBot.inviteEmail,
    calendarConnected: !!config.meetBot.calendarIcsUrl,
    postToChatDefault: config.meetBot.postToChatDefault,
    lastSync: last ? { at: last.at, ok: last.ok, events: last.events, error: last.error } : undefined,
    cancelling: await releasingCount() || undefined,
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
export async function routeOccurrence(occ: Pick<CalendarOccurrence, 'title' | 'description' | 'attendees'>): Promise<OntologyProject | undefined> {
  const projects = await list<OntologyProject>('ontologies');
  const bySlug = async (tag: string) => await findProject(tag.toLowerCase());

  const inv = splitInvite();
  if (inv) {
    for (const a of occ.attendees) {
      const [aLocal, aDomain] = a.split('@');
      if (aDomain !== inv.domain || !aLocal?.startsWith(`${inv.local}+`)) continue;
      const p = await bySlug(aLocal.slice(inv.local.length + 1));
      if (p) return p;
    }
  }

  const text = `${occ.title}\n${occ.description}`;
  for (const m of text.matchAll(/(?:concord:\s*|#)([a-z0-9][a-z0-9-]*)/gi)) {
    const p = await bySlug(m[1]);
    if (p) return p;
  }

  const haystack = words(text);
  const mentioned = projects.filter((p) => haystack.includes(words(p.slug)) || haystack.includes(words(p.title)));
  if (mentioned.length === 1) return mentioned[0];

  if (config.meetBot.defaultOntology) {
    const p = await findProject(config.meetBot.defaultOntology);
    if (p) return p;
  }
  return projects.find((p) => p.demo) ?? (projects.length === 1 ? projects[0] : undefined);
}

/** Whether this occurrence's series was already approved, with the same organiser and Meet link. */
async function preApproved(occ: CalendarOccurrence, project: OntologyProject) {
  const series = await seriesApproved(project.id, occ.uid, occ.organizer, occ.meetingUrl);
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

/** What's left to do for a call once the calendar has been read: run after the calendar lock is let go, so it never holds up other calls. */
type Finish = () => Promise<'done' | 'retrying'>;

/**
 * A call that has been cancelled (or the bot taken off it). Before it starts, it is
 * withdrawn: hidden, its bot released, and deleted once Recall.ai confirms the bot
 * has gone. Once the bot is in the call, it is taken out (End call) and what it
 * heard so far is analysed. The decision is recorded now, under the call's lock;
 * the requests to Recall.ai are what the returned step does.
 */
async function withdrawCall(meetingId: string): Promise<Finish> {
  const live = await get<Meeting>('meetings', meetingId);
  if (!live) return async () => 'done';
  if (live.status !== 'scheduled') {
    if (!botActive(live) && !botOutstanding(live)) return async () => 'done';
    return () =>
      endLiveMeeting(meetingId).then(
        () => 'done' as const,
        () => 'retrying' as const,
      );
  }
  await meetingLock(meetingId, async () => { return transaction(async () => {
    const m = await get<Meeting>('meetings', meetingId);
    if (!m) return;
    normalise(m);
    const gen = m.bot?.gen;
    const was = m.withdrawn;
    m.withdrawn = true;
    beginRelease(m, 'cancel', 'idle');
    // Nothing booked: it goes now. Otherwise it is kept (hidden) until the bot is confirmed gone.
    if (!tracked(m) || droppable(m.bot)) await dropMeeting(m.id);
    else if (!was || m.bot.gen !== gen) emit(await saveMeeting(m), { type: 'meeting', meeting: m });
  }); });
  return async () => {
    if (await get('meetings', meetingId)) await drive(meetingId);
    const m = await get<Meeting>('meetings', meetingId);
    return !m || !tracked(m) || settled(m.bot) ? 'done' : 'retrying';
  };
}

/** Calendar calls still on the books (withdrawn ones only wait for their bot to go). */
const calendarMeetings = async () => (await list<Meeting>('meetings')).filter((m) => m.source === 'calendar-invite' && m.calendar && !m.withdrawn);
/** Every calendar call Concord still holds, withdrawn ones included: each occurrence has one record until its bots are gone. */
const heldMeetings = async () => (await list<Meeting>('meetings')).filter((m) => m.source === 'calendar-invite' && m.calendar);

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
  later: Finish[],
) {
  // A withdrawn record still waiting for its bot to go keeps its occurrence: if the call comes back, it is that record again.
  const byKey = new Map((await heldMeetings()).map((m) => [m.calendar!.key, m]));
  const touched: Meeting[] = [];
  const seen = new Set<string>();
  /** Live calls whose invite changed under them: the bot is taken out once the loop is done. */
  const endAfter: string[] = [];
  /** Calls whose booked bot was let go: released once the loop is done. */
  const releasing: string[] = [];

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
      const project = opts.project ?? await routeOccurrence(occ);
      if (!project) continue;
      // Importing a file is the importer's own approval (only facilitators can import).
      const approval = feed === 'upload' && opts.actor ? { by: opts.actor.id } : await preApproved(occ, project);
      const approved = !!approval;
      if (feed === 'upload' && opts.actor) await recordSeriesApproval(project.id, occ.uid, occ.organizer, occ.meetingUrl, opts.actor.id);
      const by = opts.actor ?? (approval ? (await allUsers()).find((u) => u.id === approval.by) : undefined);
      const postPromptsToChat = opts.postPromptsToChat ?? config.meetBot.postToChatDefault;
      const m = await saveMeeting({
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
        bot: recall.enabled() ? idleBot() : { provider: 'simulated', status: 'scheduled' },
        transcript: [],
        facilitatorPrompts: [],
        status: 'scheduled',
        createdAt: clock.iso(),
        // Who sent an invite is unproven, so a calendar call belongs to no one in particular.
        createdBy: feed === 'upload' && opts.actor ? opts.actor.id : 'calendar',
      });
      await logActivity({
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
      const other = await findProject(existing.ontologyId);
      throw new HttpError(409, `“${existing.title}” is already scheduled under ${other?.title ?? 'another ontology'}.`);
    }
    const updated = await meetingLock(existing.id, async () => {
      const m = await get<Meeting>('meetings', existing.id);
      if (!m) return undefined;
      normalise(m);
      // Back on the calendar after being withdrawn: the same call, with the same bot record (still
      // releasing its old bot, if that isn't confirmed gone yet; a fresh one is booked after that).
      if (m.withdrawn) m.withdrawn = undefined;
      // The calendar is the better source: it reports moves and cancellations.
      if (feed === 'calendar' && m.calendar!.feed === 'upload') m.calendar!.feed = 'calendar';
      const cal = m.calendar!;
      const importer = feed === 'upload' ? opts.actor : undefined;
      // A new organiser or Meet link needs approving again, unless its series was approved as it now stands (or a facilitator imports it).
      const detailsChanged = cal.organizer !== occ.organizer || m.meetingUrl !== occ.meetingUrl;
      const reapprove =
        detailsChanged && cal.approval === 'approved' && !importer && !await preApproved(occ, (await findProject(m.ontologyId))!)
          ? m.meetingUrl !== occ.meetingUrl
            ? 'The invite’s Meet link changed since it was approved.'
            : 'The invite’s organiser changed since it was approved.'
          : undefined;
      if (m.status !== 'scheduled') {
        // Changed under a call the bot is already in: the bot leaves (once this loop is done, refusing
        // anything it sends meanwhile) and what it heard is analysed. Later weeks with the new details
        // need approving again, since the series approval no longer matches them.
        if (reapprove && botActive(m)) {
          m.calendar = { ...cal, organizer: occ.organizer, sentBy: occ.sentBy, approvalNote: `${reapprove} The bot left the call; calls with the new details need approving again.` };
          // Released here, under the lock, so anything it sends from now on is refused.
          beginRelease(m, 'leave', 'done');
          await saveMeeting(m);
          await logActivity({
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
        await recordSeriesApproval(m.ontologyId, occ.uid, occ.organizer, occ.meetingUrl, importer.id);
        if (cal.approval === 'pending') {
          cal.approval = 'approved';
          cal.approvedBy = importer.id;
          delete cal.approvalNote;
        }
      }
      const moved = cal.start !== occ.start.toISOString() || m.meetingUrl !== occ.meetingUrl;
      if (!moved && !detailsChanged && m.title === occ.title && cal.end === occ.end.toISOString()) return await saveMeeting(m);
      if (reapprove) {
        m.calendar = { ...cal, approval: 'pending', approvedBy: undefined, approvalNote: reapprove };
        await logActivity({ ontologyId: m.ontologyId, type: 'meeting.updated', message: 'A call needs approving again because its invite changed.', link: `/o/${m.ontologyId}/meetings/${m.id}` });
      }
      // The booked bot is released (its record keeps the Meet link it was booked for); once
      // Recall.ai confirms it has gone, the call can book a fresh one for the new details.
      if ((moved || reapprove) && beginRelease(m, 'cancel', 'idle')) releasing.push(m.id);
      m.title = occ.title;
      m.meetingUrl = occ.meetingUrl;
      m.calendar = { ...m.calendar!, start: occ.start.toISOString(), end: occ.end.toISOString(), organizer: occ.organizer, sentBy: occ.sentBy, cancelPending: undefined };
      return await saveMeeting(m);
    });
    if (updated) {
      emit(updated, { type: 'meeting', meeting: updated });
      touched.push(updated);
    }
  }

  // Requests to Recall.ai run once the calendar lock is let go (see Finish).
  for (const id of endAfter)
    later.push(() =>
      endLiveMeeting(id).then(
        () => 'done' as const,
        () => 'retrying' as const,
      ),
    );
  for (const id of releasing) later.push(() => drive(id).then(() => 'done' as const));

  // Calls this feed no longer lists: cancelled before they start, or the bot taken out
  // if it's already in (past the scheduled end too, while the call overruns).
  const uids = new Set(occs.map((o) => o.uid));
  for (const m of await calendarMeetings()) {
    const cal = m.calendar!;
    if (seen.has(cal.key) || cal.cancelPending) continue;
    if (m.status === 'scheduled' ? new Date(cal.end) <= opts.now : !botActive(m)) continue;
    // Older than the feed window: the clock ends that call by itself.
    if (new Date(cal.end).getTime() < opts.now.getTime() - OVERRUN_MAX_MS) continue;
    const gone = feed === 'calendar' ? cal.feed === 'calendar' : cal.feed === 'upload' && m.ontologyId === opts.project?.id && !!cal.uid && uids.has(cal.uid) && new Date(cal.start).getTime() < opts.now.getTime() + HORIZON_MS;
    if (gone) later.push(await withdrawCall(m.id));
  }
  return touched;
}

/**
 * Calls an imported cancellation names (a whole event or series, or single weeks), in
 * this ontology, withdrawn ones still getting rid of a bot included: a step for each,
 * which says whether it is done or still being retried.
 */
async function applyCancellations(project: OntologyProject, cancelled: { uids: string[]; keys: string[] }) {
  const steps: Finish[] = [];
  for (const m of await heldMeetings()) {
    const cal = m.calendar!;
    if (m.ontologyId !== project.id || (m.status !== 'scheduled' && !botActive(m) && !botOutstanding(m))) continue;
    if (!cancelled.keys.includes(cal.key) && !(cal.uid && cancelled.uids.includes(cal.uid))) continue;
    steps.push(await withdrawCall(m.id));
  }
  return steps;
}

/** Re-reads the bot's calendar. Without MEET_BOT_ICS_URL this does nothing. */
export async function syncCalendar(now = new Date()): Promise<MeetBotInfo['lastSync']> {
  const url = config.meetBot.calendarIcsUrl;
  if (!url) return undefined;
  const later: Finish[] = [];
  const result = await withLock('meet-bot:calendar', async () => {
    let state: SyncState;
    try {
      const occs = parseOccurrences(await readFeed(url), { from: new Date(now.getTime() - OVERRUN_MAX_MS), to: new Date(now.getTime() + HORIZON_MS) });
      await reconcile(occs, 'calendar', { now }, later);
      state = { at: now.toISOString(), ok: true, events: occs.filter((o) => o.meetingUrl && (!config.meetBot.inviteEmail || botAttendee(o))).length };
    } catch (err) {
      state = { at: now.toISOString(), ok: false, events: 0, error: sanitise((err as Error).message) };
      console.warn(`[meet-bot] calendar sync failed: ${state.error}`);
    }
    await put('kv', { id: SYNC_KEY, ...state });
    return state;
  });
  // Beside the bookings, never holding them (or the calendar) up.
  for (const step of later) void background(step());
  return result;
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
  const later: Finish[] = [];
  const { touched, steps } = await withLock('meet-bot:calendar', async () => ({
    steps: cancels ? await applyCancellations(project, cancelled) : [],
    touched: occs.length ? await reconcile(occs, 'upload', { now, project, actor: user, postPromptsToChat: opts.postPromptsToChat }, later) : [],
  }));
  // Recall.ai is asked once the calendar lock is let go, so the clock's bookings go ahead meanwhile.
  const [outcomes] = await Promise.all([Promise.all(steps.map((step) => step())), Promise.all(later.map((step) => step()))]);
  const c = { cancelled: outcomes.filter((o) => o === 'done').length, retrying: outcomes.filter((o) => o === 'retrying').length };
  if (c.cancelled + c.retrying)
    await logActivity({
      ontologyId: project.id,
      actorId: user.id,
      type: 'meeting.updated',
      message: `imported a cancellation for ${c.cancelled + c.retrying === 1 ? 'one call' : `${c.cancelled + c.retrying} calls`}${c.retrying ? '; cancelling the bot is being retried' : ''}`,
      link: `/o/${project.id}/meetings`,
    });
  await dispatchDue(now);
  return { meetings: (await Promise.all(touched.map(async (m) => await get<Meeting>('meetings', m.id) ?? m))), cancelled: c.cancelled, cancelRetrying: c.retrying };
}

/* ------------------------------------------------------------------------ */
/* Booking bots and ending calls                                             */
/* ------------------------------------------------------------------------ */

/**
 * One calendar call, decided on its latest copy under its lock, without asking
 * Recall.ai anything: book its bot when it's due, go live when it starts, release
 * the bot when the call is skipped, waiting for approval or over, and end the call
 * once it's past its slot and quiet. Requests happen afterwards, in the call's lane.
 */
function planOne(meetingId: string, now: Date) {
  return meetingLock(meetingId, async () => { return transaction(async () => {
    const m = await get<Meeting>('meetings', meetingId);
    if (!m?.calendar || m.withdrawn) return;
    const before = JSON.stringify(m);
    // A record from before the state machine is read as one first (and saved so), never replaced unread.
    normalise(m);
    const cal = m.calendar;
    const t = now.getTime();
    const start = new Date(cal.start).getTime();
    const end = new Date(cal.end).getTime();
    const blocked = !!cal.skip || cal.approval === 'pending';
    const withdraw = async () => { return transaction(async () => {
      m.withdrawn = true;
      beginRelease(m, 'cancel', 'idle');
      if (!tracked(m) || droppable(m.bot)) await dropMeeting(m.id);
      else emit(await saveMeeting(m), { type: 'meeting', meeting: m });
    }); };

    // Left over from before the bot state machine: withdrawn like any cancelled call.
    if (cal.cancelPending) return await withdraw();
    if (m.status === 'scheduled') {
      // A bot booked for a call that's now skipped or waiting for approval is let go.
      if (blocked) beginRelease(m, 'cancel', 'idle');
      if (t >= end) {
        if (blocked) return await withdraw();
        m.status = 'error';
        if (tracked(m)) {
          beginRelease(m, 'cancel', 'done');
          m.bot.fault ??= 'The call ended before the bot could join.';
        } else m.bot = { provider: m.bot?.provider ?? 'simulated', status: 'error', error: m.bot?.error ?? 'The call ended before the bot could join.' };
      } else if (tracked(m) && m.bot.phase === 'booked' && t >= start) {
        // Booked: the call goes live when it starts (or when the first transcript line arrives).
        m.status = 'live';
      } else if (!blocked && (!tracked(m) || m.bot.phase === 'idle')) {
        // Booked as soon as the call is approved, to join at its start. Recall.ai only guarantees a bot booked
        // more than ten minutes ahead (and recommends booking as early as possible), so a few missed ticks
        // close to the start can't cost the call its bot. A moved call releases this bot and books again.
        if (!recall.enabled()) {
          if (t >= start - NO_PROVIDER_NOTICE_MS) {
            m.status = 'error';
            m.bot = { provider: 'simulated', status: 'error', error: NO_BOT_PROVIDER };
          }
        } else {
          if (!tracked(m)) m.bot = idleBot();
          // Recorded here; sent from the call's lane under the booking's idempotency key.
          beginBooking(m, start - t > 60_000 ? new Date(start).toISOString() : undefined, now);
        }
      }
    } else if (m.status === 'live' && botActive(m)) {
      // A calendar call ends by itself once it's past its slot and quiet (or long overrun). The bot
      // is released here; taking it out happens in the call's lane, beside every other call's.
      const quietFor = t - (lastLineTime(m) ?? 0);
      if ((t > end + QUIET_MS && quietFor > QUIET_MS) || t > end + OVERRUN_MAX_MS) beginRelease(m, 'leave', 'done');
    }
    if (JSON.stringify(m) === before) return;
    if (tracked(m)) bump(m);
    emit(await saveMeeting(m), { type: 'meeting', meeting: m });
  }); });
}

/**
 * Books bots for calls starting soon, releases bots no longer wanted, closes out
 * calls that have finished, and retries whatever Recall.ai hasn't confirmed. The
 * decisions are made first (quickly, call by call); then every call with something
 * to ask Recall.ai gets its own lane, side by side, so a slow one never holds up
 * another. wait: false (the clock) leaves the lanes running.
 */
export async function dispatchDue(now = new Date(), opts: { wait?: boolean } = {}) {
  for (const m of await calendarMeetings()) await planOne(m.id, now);
  await pruneSecrets();
  const runs = await driveDue(now.getTime());
  if (opts.wait !== false) await Promise.all(runs);
}

/** Resolves once every call's lane, and work started in the background, has finished. For tests and shutdown. */
export const meetBotIdle = lanesIdle;

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
    // Requests to Recall.ai run in each call's own lane, beside the tick rather than inside it.
    await dispatchDue(now, { wait: false });
  } finally {
    ticking = false;
  }
}
