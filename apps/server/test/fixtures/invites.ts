/**
 * Calendar invites shaped like the ones Google Calendar sends (and serves in a
 * calendar's "secret address in iCal format"): a VTIMEZONE block, the Meet link
 * in X-GOOGLE-CONFERENCE and in the description, attendees as mailto: URIs.
 */

const LONDON = `BEGIN:VTIMEZONE
TZID:Europe/London
X-LIC-LOCATION:Europe/London
BEGIN:DAYLIGHT
TZOFFSETFROM:+0000
TZOFFSETTO:+0100
TZNAME:BST
DTSTART:19700329T010000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:+0100
TZOFFSETTO:+0000
TZNAME:GMT
DTSTART:19701025T020000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
END:VTIMEZONE`;

export interface InviteOpts {
  /** Address the bot was invited as. */
  bot?: string;
  title?: string;
  description?: string;
  meet?: string;
}

/** A weekly working-group call on Tuesdays 10:00 London time, from 6 October 2026. */
export function weeklySeries(o: InviteOpts = {}) {
  const meet = o.meet ?? 'https://meet.google.com/abc-defg-hij';
  return `BEGIN:VEVENT
DTSTART;TZID=Europe/London:20261006T100000
DTEND;TZID=Europe/London:20261006T110000
RRULE:FREQ=WEEKLY;BYDAY=TU
EXDATE;TZID=Europe/London:20261117T100000
DTSTAMP:20261001T120000Z
ORGANIZER;CN=Priya Shah:mailto:priya@example.org
UID:series-1@google.com
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=priya@example.org:mailto:priya@example.org
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=${o.bot ?? 'concord.bot@example.org'}:mailto:${o.bot ?? 'concord.bot@example.org'}
X-GOOGLE-CONFERENCE:${meet}
DESCRIPTION:${o.description ?? 'Weekly call.'}\\n\\nJoin with Google Meet: ${meet}
SUMMARY:${o.title ?? 'Working group call'}
STATUS:CONFIRMED
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Europe/London:20261124T140000
DTEND;TZID=Europe/London:20261124T150000
RECURRENCE-ID;TZID=Europe/London:20261124T100000
DTSTAMP:20261001T120000Z
UID:series-1@google.com
X-GOOGLE-CONFERENCE:${meet}
SUMMARY:${o.title ?? 'Working group call'} (moved)
STATUS:CONFIRMED
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Europe/London:20261201T100000
DTEND;TZID=Europe/London:20261201T110000
RECURRENCE-ID;TZID=Europe/London:20261201T100000
DTSTAMP:20261001T120000Z
UID:series-1@google.com
SUMMARY:${o.title ?? 'Working group call'}
STATUS:CANCELLED
END:VEVENT`;
}

/** A one-off call. Times are UTC. */
export function oneOff(o: InviteOpts & { uid?: string; start: string; end: string; organizer?: string; partstat?: string }) {
  const meet = o.meet ?? 'https://meet.google.com/xyz-abcd-efg';
  const ics = (d: string) => d.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return `BEGIN:VEVENT
DTSTART:${ics(o.start)}
DTEND:${ics(o.end)}
DTSTAMP:20261001T120000Z
ORGANIZER;CN=Organiser:mailto:${o.organizer ?? 'tom@example.org'}
UID:${o.uid ?? 'one-off-1@google.com'}
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=${o.partstat ?? 'NEEDS-ACTION'};CN=${o.bot ?? 'concord.bot@example.org'}:mailto:${o.bot ?? 'concord.bot@example.org'}
X-GOOGLE-CONFERENCE:${meet}
DESCRIPTION:${o.description ?? ''}
SUMMARY:${o.title ?? 'Use case workshop'}
STATUS:CONFIRMED
END:VEVENT`;
}

export const calendar = (...events: string[]) =>
  `BEGIN:VCALENDAR\r\nPRODID:-//Google Inc//Google Calendar 70.9054//EN\r\nVERSION:2.0\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\n${[LONDON, ...events].join('\n').replace(/\r?\n/g, '\r\n')}\r\nEND:VCALENDAR\r\n`;
