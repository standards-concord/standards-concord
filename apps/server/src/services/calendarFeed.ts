import ICAL from 'ical.js';

/**
 * Reads an iCalendar feed (the bot account's calendar, or a single .ics invite)
 * and lists the calls in a time window, expanding recurring series so each
 * occurrence of a weekly working-group call is its own entry.
 */

export interface CalendarOccurrence {
  /** Stable per occurrence: the event UID, plus the original start for one week of a series. */
  key: string;
  uid: string;
  title: string;
  description: string;
  start: Date;
  end: Date;
  meetingUrl?: string;
  /** Lower-cased attendee emails. */
  attendees: string[];
  organizer?: string;
  /** Who sent the invite on the organiser's behalf (ORGANIZER;SENT-BY), if anyone. */
  sentBy?: string;
  recurring: boolean;
  /** The bot's own response to the invite, if the feed says (ACCEPTED, DECLINED, NEEDS-ACTION…). */
  attendeeStatus: Record<string, string>;
}

const MEET_URL = /https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i;
/** Expanding a long-running daily series from its first date costs one step per day; stop well before that matters. */
const MAX_STEPS = 20_000;

export function findMeetUrl(...texts: (string | undefined)[]): string | undefined {
  for (const t of texts) {
    const m = t?.match(MEET_URL);
    if (m) return m[0].toLowerCase();
  }
  return undefined;
}

const email = (v: unknown) =>
  typeof v === 'string'
    ? v
        .replace(/^mailto:/i, '')
        .trim()
        .toLowerCase()
    : undefined;

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));

type Details = {
  title: string;
  description: string;
  meetingUrl?: string;
  attendees: string[];
  attendeeStatus: Record<string, string>;
  organizer?: string;
  sentBy?: string;
  cancelled: boolean;
};

function details(c: ICAL.Component): Details {
  const conference = c.getAllProperties().find((p) => p.name === 'x-google-conference')?.getFirstValue();
  const description = str(c.getFirstPropertyValue('description'));
  const location = str(c.getFirstPropertyValue('location'));
  const url = str(c.getFirstPropertyValue('url'));
  const attendeeStatus: Record<string, string> = {};
  for (const p of c.getAllProperties('attendee')) {
    const e = email(p.getFirstValue());
    if (e) attendeeStatus[e] = str(p.getParameter('partstat') ?? 'NEEDS-ACTION').toUpperCase();
  }
  return {
    title: str(c.getFirstPropertyValue('summary')).trim(),
    description,
    meetingUrl: findMeetUrl(str(conference), location, url, description),
    attendees: Object.keys(attendeeStatus),
    attendeeStatus,
    organizer: email(c.getFirstPropertyValue('organizer')),
    sentBy: email(c.getFirstProperty('organizer')?.getParameter('sent-by')),
    cancelled: str(c.getFirstPropertyValue('status')).toUpperCase() === 'CANCELLED',
  };
}

/** A modified week of a series often repeats only what changed; the rest comes from the series. */
function inherit(own: Details, series?: Details): Details {
  if (!series) return own;
  return {
    title: own.title || series.title,
    description: own.description || series.description,
    meetingUrl: own.meetingUrl ?? series.meetingUrl,
    attendees: own.attendees.length ? own.attendees : series.attendees,
    attendeeStatus: own.attendees.length ? own.attendeeStatus : series.attendeeStatus,
    organizer: own.organizer ?? series.organizer,
    sentBy: own.organizer ? own.sentBy : series.sentBy,
    cancelled: own.cancelled,
  };
}

const iso = (t: ICAL.Time) => t.toJSDate().toISOString();

type Grouped = Map<string, { master?: ICAL.Event; exceptions: ICAL.Event[] }>;

/** Masters and their modified instances (RECURRENCE-ID), grouped by UID. */
function readEvents(ics: string): Grouped {
  const root = new ICAL.Component(ICAL.parse(ics));
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    const tzid = str(tz.getFirstPropertyValue('tzid'));
    if (tzid && !ICAL.TimezoneService.has(tzid)) ICAL.TimezoneService.register(new ICAL.Timezone(tz));
  }

  const byUid: Grouped = new Map();
  for (const vevent of root.getAllSubcomponents('vevent')) {
    const ev = new ICAL.Event(vevent);
    if (!ev.uid || !ev.startDate) continue;
    const entry = byUid.get(ev.uid) ?? { exceptions: [] };
    if (ev.isRecurrenceException()) entry.exceptions.push(ev);
    else entry.master = ev;
    byUid.set(ev.uid, entry);
  }
  return byUid;
}

/**
 * What an invite cancels: whole events or series (by UID) and single weeks of a
 * series (by occurrence key). A cancellation sent on its own lists no calls, so
 * it is read separately from the occurrences.
 */
export function parseCancellations(ics: string): { uids: string[]; keys: string[] } {
  // Read straight from the components: a cancellation needn't repeat the event's start (RFC 5546 §3.2.5).
  const root = new ICAL.Component(ICAL.parse(ics));
  const method = str(root.getFirstPropertyValue('method')).toUpperCase();
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    const tzid = str(tz.getFirstPropertyValue('tzid'));
    if (tzid && !ICAL.TimezoneService.has(tzid)) ICAL.TimezoneService.register(new ICAL.Timezone(tz));
  }
  const uids: string[] = [];
  const keys: string[] = [];
  for (const c of root.getAllSubcomponents('vevent')) {
    const uid = str(c.getFirstPropertyValue('uid'));
    const cancelled = method === 'CANCEL' || str(c.getFirstPropertyValue('status')).toUpperCase() === 'CANCELLED';
    if (!uid || !cancelled) continue;
    const rid = c.getFirstPropertyValue('recurrence-id');
    if (rid instanceof ICAL.Time) keys.push(`${uid}@${iso(rid)}`);
    else uids.push(uid);
  }
  return { uids, keys };
}

/** Occurrences that overlap [from, to). Cancelled occurrences and events without a start are left out. */
export function parseOccurrences(ics: string, window: { from: Date; to: Date }): CalendarOccurrence[] {
  const byUid = readEvents(ics);
  const out: CalendarOccurrence[] = [];
  const from = window.from.getTime();
  const to = window.to.getTime();
  const add = (uid: string, d: Details, start: ICAL.Time, end: ICAL.Time, key: string, recurring: boolean) => {
    const s = start.toJSDate();
    const e = end.toJSDate();
    if (e.getTime() <= from || s.getTime() >= to || d.cancelled) return;
    out.push({
      key,
      uid,
      start: s,
      end: e,
      recurring,
      title: d.title || 'Calendar call',
      description: d.description,
      meetingUrl: d.meetingUrl,
      attendees: d.attendees,
      attendeeStatus: d.attendeeStatus,
      organizer: d.organizer,
      sentBy: d.sentBy,
    });
  };

  for (const [uid, { master, exceptions }] of byUid) {
    const series = master ? details(master.component) : undefined;
    // A cancelled series takes its modified weeks with it.
    if (series?.cancelled) continue;
    const recurring = !!master?.isRecurring() || !master;
    // Modified weeks are judged by their actual dates, wherever they moved to.
    const moved = new Set<string>();
    for (const ex of exceptions) {
      const original = ex.recurrenceId ?? ex.startDate;
      moved.add(iso(original));
      add(uid, inherit(details(ex.component), series), ex.startDate, ex.endDate ?? ex.startDate, `${uid}@${iso(original)}`, true);
    }
    if (!master) continue;
    if (!master.isRecurring()) {
      add(uid, series!, master.startDate, master.endDate ?? master.startDate, uid, false);
      continue;
    }
    const length = (master.endDate ?? master.startDate).toJSDate().getTime() - master.startDate.toJSDate().getTime();
    const it = master.iterator();
    for (let i = 0, next = it.next(); next && i < MAX_STEPS; i++, next = it.next()) {
      if (next.toJSDate().getTime() >= to) break;
      if (moved.has(iso(next))) continue;
      const end = next.clone();
      end.addDuration(ICAL.Duration.fromSeconds(Math.round(length / 1000)));
      add(uid, series!, next, end, `${uid}@${iso(next)}`, recurring);
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}
