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
  recurring: boolean;
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

function details(c: ICAL.Component) {
  const conference = c.getAllProperties().find((p) => p.name === 'x-google-conference')?.getFirstValue();
  const description = str(c.getFirstPropertyValue('description'));
  const location = str(c.getFirstPropertyValue('location'));
  const url = str(c.getFirstPropertyValue('url'));
  return {
    title: str(c.getFirstPropertyValue('summary')).trim() || 'Calendar call',
    description,
    meetingUrl: findMeetUrl(str(conference), location, url, description),
    attendees: c
      .getAllProperties('attendee')
      .map((p) => email(p.getFirstValue()))
      .filter((e): e is string => !!e),
    organizer: email(c.getFirstPropertyValue('organizer')),
    cancelled: str(c.getFirstPropertyValue('status')).toUpperCase() === 'CANCELLED',
  };
}

/** Occurrences that overlap [from, to). Cancelled occurrences and events without a start are left out. */
export function parseOccurrences(ics: string, window: { from: Date; to: Date }): CalendarOccurrence[] {
  const root = new ICAL.Component(ICAL.parse(ics));
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    const tzid = str(tz.getFirstPropertyValue('tzid'));
    if (tzid && !ICAL.TimezoneService.has(tzid)) ICAL.TimezoneService.register(new ICAL.Timezone(tz));
  }

  // Masters and their modified instances (RECURRENCE-ID), grouped by UID.
  const byUid = new Map<string, { master?: ICAL.Event; exceptions: ICAL.Event[] }>();
  for (const vevent of root.getAllSubcomponents('vevent')) {
    const ev = new ICAL.Event(vevent);
    if (!ev.uid || !ev.startDate) continue;
    const entry = byUid.get(ev.uid) ?? { exceptions: [] };
    if (ev.isRecurrenceException()) entry.exceptions.push(ev);
    else entry.master = ev;
    byUid.set(ev.uid, entry);
  }

  const out: CalendarOccurrence[] = [];
  const from = window.from.getTime();
  const to = window.to.getTime();
  const add = (uid: string, item: ICAL.Event, start: ICAL.Time, end: ICAL.Time, original: ICAL.Time, recurring: boolean) => {
    const s = start.toJSDate();
    const e = end.toJSDate();
    if (e.getTime() <= from || s.getTime() >= to) return;
    const d = details(item.component);
    if (d.cancelled) return;
    const { cancelled: _, ...rest } = d;
    out.push({ key: recurring ? `${uid}@${original.toJSDate().toISOString()}` : uid, uid, start: s, end: e, recurring, ...rest });
  };

  for (const [uid, { master, exceptions }] of byUid) {
    if (!master) {
      // An invite for a single changed instance of someone else's series.
      for (const ex of exceptions) add(uid, ex, ex.startDate, ex.endDate ?? ex.startDate, ex.recurrenceId ?? ex.startDate, true);
      continue;
    }
    for (const ex of exceptions) master.relateException(ex);
    if (!master.isRecurring()) {
      add(uid, master, master.startDate, master.endDate ?? master.startDate, master.startDate, false);
      continue;
    }
    const it = master.iterator();
    for (let i = 0, next = it.next(); next && i < MAX_STEPS; i++, next = it.next()) {
      // Moved instances can start before their original slot, so look a day past the window.
      if (next.toJSDate().getTime() >= to + 86_400_000) break;
      const occ = master.getOccurrenceDetails(next);
      add(uid, occ.item, occ.startDate, occ.endDate, occ.recurrenceId, true);
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}
