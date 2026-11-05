import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import request from 'supertest';
import type { Meeting } from '@concord/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { list, openDb, put, remove } from '../src/db.js';
import { parseCancellations, parseOccurrences } from '../src/services/calendarFeed.js';
import { findProject, setRoles } from '../src/services/ontologies.js';
import { createUser } from '../src/services/users.js';
import { dispatchDue, meetBotIdle, meetBotInfo, meetBotTick, routeOccurrence, sanitise, syncCalendar as syncNow } from '../src/services/meetBot.js';
import { canFacilitate, getMeeting, recallWebhook, recordSeriesApproval, saveMeeting } from '../src/services/meetings.js';
import { chatText } from '../src/services/recall.js';
import { releasingCount as retiringCount, SLOW_LOOKUP_AFTER_MS } from '../src/services/botLifecycle.js';
import { seedDemo } from '../src/services/simulation.js';
import { calendar, oneOff, weeklySeries } from './fixtures/invites.js';

const app = createApp();

/* A stand-in for the Recall.ai API that records what the server asked it to do. */
type Call = { method: string; url: string; body: Record<string, unknown> };
const calls: Call[] = [];
let stub: http.Server;
let nextBot = 0;
/** How the stand-in misbehaves, per test. */
const stubMode = { failCancel: false, chatDelayMs: 0, botDelayMs: 0, failChat: false, dropCreate: false, truncateCreate: false, failList: false, listHides: false, cancelDelayMs: 0, rejectCreate: false, conflictReplay: false, keysExpired: false, garbledCreate: false, leaveDelayMs: 0, failCreate: false, nullCreate: false, listDelayMs: 0, authFail: false, refuseIds: [] as string[], refuseDelayMs: 0, holdCreate: null as Promise<void> | null };
/** Called when a booking request whose reply is held (holdDroppedReply) reaches the stub. */
let createArrived: (() => void) | undefined;
/**
 * Holds the next dropped booking reply until the test releases it, so a test can act while the
 * booking is sent and unanswered without relying on timers. `arrived` resolves once Recall.ai has the request.
 */
function holdDroppedReply() {
  let release!: () => void;
  stubMode.holdCreate = new Promise<void>((r) => (release = r));
  const arrived = new Promise<void>((r) => (createArrived = r));
  return { arrived, release };
}
/** Bots the stand-in has created, for listing and status. */
const idempotent = new Map<string, string>();
const bots = new Map<string, { id: string; meeting_url: string; metadata?: Record<string, string>; status_changes: { code: string }[] }>();

beforeAll(async () => {
  await openDb();
  await seedDemo();
  stub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      calls.push({ method: req.method!, url: req.url!, body: raw ? JSON.parse(raw) : {} });
      res.setHeader('Content-Type', 'application/json');
      const reply = (status: number, body: string, delay = 0) =>
        setTimeout(() => {
          res.statusCode = status;
          res.end(body);
        }, delay);
      // The API key was disabled: every request is turned away before Recall.ai looks at it.
      if (stubMode.authFail) return reply(401, '{"detail":"Invalid API token"}');
      if (req.method === 'POST' && req.url === '/bot/') {
        // Recall.ai is down: nothing is booked, and nothing said.
        if (stubMode.failCreate) return reply(503, '{"detail":"Service unavailable"}');
        const body = JSON.parse(raw) as { meeting_url: string; metadata?: Record<string, string> };
        // Like Recall.ai, a repeated Idempotency-Key gets the bot the first request made.
        const key = req.headers['idempotency-key'] as string | undefined;
        // Recall.ai forgets keys after an hour (keysExpired), and answers 409 while a request with the key is still in progress.
        const earlier = key && !stubMode.keysExpired ? idempotent.get(key) : undefined;
        if (earlier && stubMode.conflictReplay) return reply(409, '{"detail":"A request with this idempotency key is in progress."}');
        if (earlier) return reply(201, JSON.stringify({ id: earlier }));
        if (stubMode.rejectCreate) return reply(400, JSON.stringify({ meeting_url: [`${body.meeting_url} is not a meeting I can join`] }));
        const bot = { id: `bot-${++nextBot}`, meeting_url: body.meeting_url, metadata: body.metadata, status_changes: [{ code: 'ready' }] };
        bots.set(bot.id, bot);
        if (key) idempotent.set(key, bot.id);
        if (stubMode.garbledCreate) return reply(201, body.meeting_url.replace('https://meet.google.com/', ''));
        // Booked, but the reply's body is JSON null.
        if (stubMode.nullCreate) return reply(201, 'null');
        // Recall.ai took the booking, but the answer never arrives.
        if (stubMode.dropCreate && stubMode.holdCreate) {
          createArrived?.();
          return void stubMode.holdCreate.then(() => res.destroy());
        }
        if (stubMode.dropCreate) return void setTimeout(() => res.destroy(), stubMode.botDelayMs);
        // Or the headers arrive and the body is cut off.
        if (stubMode.truncateCreate) {
          res.writeHead(201, { 'Content-Type': 'application/json', 'Content-Length': '200' });
          res.write('{"id":"bo');
          return void setTimeout(() => res.destroy(), 20);
        }
        return reply(201, JSON.stringify({ id: bot.id }), stubMode.botDelayMs);
      }
      if (req.method === 'GET' && req.url?.startsWith('/bot/?')) {
        if (stubMode.failList) return reply(503, '{"detail":"try later"}', stubMode.listDelayMs);
        const url = new URL(req.url, 'http://x').searchParams.get('meeting_url');
        // listHides: Recall.ai hasn't listed new bots yet (a slow create).
        return reply(200, JSON.stringify({ next: null, results: stubMode.listHides ? [] : [...bots.values()].filter((b) => b.meeting_url === url) }));
      }
      const own = req.url?.match(/^\/bot\/(bot-\d+)\/$/);
      if (req.method === 'GET' && own) return reply(bots.has(own[1]) ? 200 : 404, JSON.stringify(bots.get(own[1]) ?? {}));
      // failCancel: every bot refuses to be removed; refuseIds: just these ones (after refuseDelayMs).
      const refuses = stubMode.failCancel || stubMode.refuseIds.some((id) => req.url?.startsWith(`/bot/${id}/`));
      if (refuses && (req.method === 'DELETE' || req.url?.includes('leave_call'))) return reply(405, '{"detail":"Method not allowed"}', stubMode.refuseDelayMs);
      if (req.url?.includes('send_chat_message')) return stubMode.failChat ? reply(500, '{"detail":"chat unavailable"}') : reply(200, '{}', stubMode.chatDelayMs);
      const done = req.url?.match(/^\/bot\/(bot-\d+)\/(?:leave_call\/)?$/);
      if (done && (req.method === 'DELETE' || req.method === 'POST')) bots.get(done[1])?.status_changes.push({ code: 'done' });
      if (req.method === 'DELETE' && stubMode.cancelDelayMs) return reply(200, '{}', stubMode.cancelDelayMs);
      if (req.url?.endsWith('/leave_call/') && stubMode.leaveDelayMs) return reply(200, '{}', stubMode.leaveDelayMs);
      if (req.url?.includes('private-')) return reply(404, 'Not found');
      reply(200, '{}');
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  config.meetBot.recallApiBase = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  config.meetBot.inviteEmail = 'concord.bot@example.org';
});

afterAll(() => {
  stub.close();
  config.meetBot.recallApiKey = undefined;
  config.meetBot.calendarIcsUrl = undefined;
});

beforeEach(async () => {
  calls.length = 0;
  Object.assign(stubMode, { failCancel: false, chatDelayMs: 0, botDelayMs: 0, failChat: false, dropCreate: false, truncateCreate: false, failList: false, listHides: false, cancelDelayMs: 0, rejectCreate: false, conflictReplay: false, keysExpired: false, garbledCreate: false, leaveDelayMs: 0, failCreate: false, nullCreate: false, listDelayMs: 0, authFail: false, refuseIds: [], refuseDelayMs: 0, holdCreate: null });
  createArrived = undefined;
  for (const m of await list<Meeting>('meetings')) if (m.source === 'calendar-invite') await remove('meetings', m.id);
  for (const k of await list<{ id: string }>('kv')) if (/^meet-bot:(approval|retire|retired):/.test(k.id)) await remove('kv', k.id);
});

const at = (iso: string) => new Date(iso);
/** A calendar sync, and the cancellations it set off in the background. */
const syncCalendar = async (now?: Date) => {
  const r = await syncNow(now);
  await meetBotIdle();
  return r;
};

describe('reading calendar invites', () => {
  it('expands a weekly series in London time, with skipped, moved and cancelled weeks', () => {
    const occs = parseOccurrences(calendar(weeklySeries()), { from: at('2026-10-12T00:00:00Z'), to: at('2026-12-10T00:00:00Z') });
    expect(occs.map((o) => [o.start.toISOString(), o.title])).toEqual([
      ['2026-10-13T09:00:00.000Z', 'Working group call'], // BST
      ['2026-10-20T09:00:00.000Z', 'Working group call'],
      ['2026-10-27T10:00:00.000Z', 'Working group call'], // GMT from 25 October
      ['2026-11-03T10:00:00.000Z', 'Working group call'],
      ['2026-11-10T10:00:00.000Z', 'Working group call'],
      // 17 November is an EXDATE; 1 December is cancelled
      ['2026-11-24T14:00:00.000Z', 'Working group call (moved)'],
      ['2026-12-08T10:00:00.000Z', 'Working group call'],
    ]);
    expect(occs.every((o) => o.meetingUrl === 'https://meet.google.com/abc-defg-hij' && o.recurring)).toBe(true);
    // The moved week keeps the key of its original slot, so moving it doesn't book a second bot.
    expect(occs[5].key).toBe('series-1@google.com@2026-11-24T10:00:00.000Z');
    expect(occs[0].attendees).toContain('concord.bot@example.org');
    expect(occs[0].organizer).toBe('priya@example.org');
  });

  it('reads a one-off invite and finds the Meet link in the description when there is no conference field', () => {
    const ics = calendar(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }).replace(/X-GOOGLE-CONFERENCE:.*\n/, ''), '').replace('DESCRIPTION:', 'DESCRIPTION:Join: https://meet.google.com/xyz-abcd-efg');
    const [o] = parseOccurrences(ics, { from: at('2026-11-01T00:00:00Z'), to: at('2026-11-30T00:00:00Z') });
    expect(o).toMatchObject({ title: 'Use case workshop', meetingUrl: 'https://meet.google.com/xyz-abcd-efg', recurring: false });
  });

  it('drops a cancelled series with its modified weeks, and finds a week moved to before the window’s end', () => {
    const cancelled = calendar(weeklySeries().replace('STATUS:CONFIRMED\nEND:VEVENT', 'STATUS:CANCELLED\nEND:VEVENT'));
    expect(parseOccurrences(cancelled, { from: at('2026-10-12T00:00:00Z'), to: at('2026-12-10T00:00:00Z') })).toEqual([]);
    // The 8 December week moved forward to 20 November: a window ending 21 November includes it.
    const movedEarly = calendar(
      weeklySeries(),
      `BEGIN:VEVENT
DTSTART;TZID=Europe/London:20261120T090000
DTEND;TZID=Europe/London:20261120T100000
RECURRENCE-ID;TZID=Europe/London:20261208T100000
DTSTAMP:20261001T120000Z
UID:series-1@google.com
SUMMARY:Working group call (brought forward)
STATUS:CONFIRMED
END:VEVENT`,
    );
    const occs = parseOccurrences(movedEarly, { from: at('2026-11-18T00:00:00Z'), to: at('2026-11-21T00:00:00Z') });
    expect(occs.map((o) => [o.start.toISOString(), o.title])).toEqual([['2026-11-20T09:00:00.000Z', 'Working group call (brought forward)']]);
    // A modified week that only says what changed keeps the series' guests, organiser and Meet link.
    expect(occs[0]).toMatchObject({ organizer: 'priya@example.org', meetingUrl: 'https://meet.google.com/abc-defg-hij' });
    expect(occs[0].attendees).toContain('concord.bot@example.org');
  });

  it('never repeats the calendar’s secret address in an error', () => {
    config.meetBot.calendarIcsUrl = 'https://calendar.google.com/calendar/ical/bot%40gmail.com/private-abc123/basic.ics';
    expect(sanitise(`fetch failed for ${config.meetBot.calendarIcsUrl}: 404`)).toBe('fetch failed for [calendar address]: 404');
    expect(sanitise('bad "https://x.example/private-zzz"')).not.toMatch(/private-zzz/);
    config.meetBot.calendarIcsUrl = undefined;
  });

  it('files an invite under the ontology its address, tag or title names, else the default', async () => {
    const base = { title: 'Call', description: '', attendees: ['someone@example.org'] };
    expect((await routeOccurrence({ ...base, attendees: ['concord.bot+volunteering@example.org'] }))?.slug).toBe('volunteering');
    expect((await routeOccurrence({ ...base, description: 'Agenda for #volunteering' }))?.slug).toBe('volunteering');
    expect((await routeOccurrence({ ...base, title: 'Volunteering Data Standard: use cases' }))?.slug).toBe('volunteering');
    expect((await routeOccurrence(base))?.slug).toBe('volunteering'); // the demo ontology is the default
  });

  it('keeps chat messages within Google Meet’s limit', () => {
    expect(chatText('x'.repeat(800)).length).toBe(500);
    expect(chatText('short')).toBe('short');
  });
});

describe('invite-by-email', () => {
  let feed: string;
  const writeFeed = (...events: string[]) => fs.writeFileSync(feed, calendar(...events));

  beforeAll(async () => {
    feed = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'concord-cal-')), 'bot.ics');
    config.meetBot.calendarIcsUrl = pathToFileURL(feed).href;
    config.meetBot.recallApiKey = 'test-key';
    // The fixtures' organisers are stewards of the demo ontology, with accounts under those emails.
    for (const email of ['tom@example.org', 'priya@example.org']) {
      const u = await createUser({ name: email, email, provider: 'demo', subject: `test-${email}` });
      await setRoles((await findProject('volunteering'))!.id, u.id, ['steward']);
    }
  });
  beforeEach(() => {
    config.meetBot.calendarIcsUrl = pathToFileURL(feed).href;
  });
  /** Reads the calendar, then approves every call waiting for it as a steward would (for tests about what happens next). */
  const sync = async (t: Date) => {
    const r = await syncCalendar(t);
    for (const m of await list<Meeting>('meetings')) {
      if (m.calendar?.approval !== 'pending') continue;
      await recordSeriesApproval(m.ontologyId, m.calendar.uid, m.calendar.organizer, m.meetingUrl, 'test-steward');
      await saveMeeting({ ...m, calendar: { ...m.calendar, approval: 'approved', approvedBy: 'test-steward' } });
    }
    return r;
  };
  const steward = async (name: string) => {
    const agent = request.agent(app);
    const r = await agent.post('/api/auth/demo').send({ name, role: 'steward' });
    return Object.assign(agent, { userId: r.body.user.id as string });
  };

  /** Calendar calls on the books; withdrawn ones are kept, hidden, only until their bot is confirmed gone. */
  const calendarMeetings = async () => (await list<Meeting>('meetings')).filter((m) => m.source === 'calendar-invite' && !m.withdrawn);
  const withdrawnMeetings = async () => (await list<Meeting>('meetings')).filter((m) => m.source === 'calendar-invite' && m.withdrawn);

  it('schedules a call when the bot is invited, books a bot before it starts, and follows moves and cancellations', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z', bot: 'concord.bot+volunteering@example.org' }));
    const synced = await sync(at('2026-11-09T09:00:00Z'));
    expect(synced).toMatchObject({ ok: true, events: 1 });
    let [m] = await calendarMeetings();
    expect(m).toMatchObject({ status: 'scheduled', title: 'Use case workshop', meetingUrl: 'https://meet.google.com/xyz-abcd-efg', bot: { provider: 'recall', status: 'scheduled' } });
    expect(m.calendar).toMatchObject({ feed: 'calendar', start: '2026-11-10T15:00:00.000Z', organizer: 'tom@example.org', recurring: false });

    // A day ahead: nothing is booked yet.
    await dispatchDue(at('2026-11-09T15:00:00Z'));
    expect(calls).toEqual([]);

    // Fifteen minutes ahead: a bot is booked to join at the start time.
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/bot/', body: { meeting_url: 'https://meet.google.com/xyz-abcd-efg', join_at: '2026-11-10T15:00:00.000Z' } });
    m = await getMeeting(m.id);
    expect(m.status).toBe('scheduled');
    expect(m.bot?.botId).toBe(`bot-${nextBot}`);

    // The organiser moves the call: the booked bot is cancelled and booked again for the new time.
    calls.length = 0;
    writeFeed(oneOff({ start: '2026-11-10T16:00:00Z', end: '2026-11-10T17:00:00Z', bot: 'concord.bot+volunteering@example.org' }));
    await sync(at('2026-11-10T14:50:00Z'));
    expect(calls).toEqual([expect.objectContaining({ method: 'DELETE', url: `/bot/bot-${nextBot}/` })]);
    m = await getMeeting(m.id);
    expect(m.calendar?.start).toBe('2026-11-10T16:00:00.000Z');
    expect(m.bot?.botId).toBeUndefined();

    // Then cancels it: the meeting goes.
    writeFeed();
    await sync(at('2026-11-10T14:55:00Z'));
    expect(await calendarMeetings()).toEqual([]);
  });

  it('goes live when the call starts, keeps prompts out of the chat unless asked, and ends after the call', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    await dispatchDue(at('2026-11-10T14:50:00Z'));
    await dispatchDue(at('2026-11-10T15:00:30Z'));
    let [m] = await calendarMeetings();
    expect(m).toMatchObject({ status: 'live', postPromptsToChat: false, bot: { status: 'joining' } });
    const intro = (calls.find((c) => c.url === '/bot/')!.body.chat as { on_bot_join: { message: string } }).on_bot_join.message;
    expect(intro).toMatch(/not this chat/);

    const secret = (await list<{ id: string; secret: string }>('kv')).find((k) => k.id === `meeting-secret:${m.id}`)!.secret;
    const say = (name: string, text: string) => recallWebhook(m.id, secret, { event: 'transcript.data', data: { data: { participant: { name }, words: [{ text, start_timestamp: { relative: 5 } }] } } });
    calls.length = 0;
    for (let i = 0; i < 4; i++) await say('Aisha Rahman', `A "shift" is a fixed slot on a rota, part ${i}.`);
    m = await getMeeting(m.id);
    expect(m.bot?.status).toBe('in-call');
    expect(m.facilitatorPrompts.length).toBe(1);
    expect(m.facilitatorPrompts[0].posted).toBe(false);
    expect(calls.filter((c) => c.url.includes('send_chat_message'))).toEqual([]);

    // Someone posts that prompt by hand, then switches posting on for the rest of the call.
    const steward = request.agent(app);
    await steward.post('/api/auth/demo').send({ name: 'Steward Sam', role: 'steward' });
    const posted = await steward.post(`/api/meetings/${m.id}/prompts/0/post`);
    expect(posted.status).toBe(200);
    expect(posted.body.facilitatorPrompts[0]).toMatchObject({ posted: true });
    expect(calls.filter((c) => c.url === `/bot/${m.bot!.botId}/send_chat_message/`)).toEqual([expect.objectContaining({ body: { to: 'everyone', message: m.facilitatorPrompts[0].text } })]);

    expect((await steward.patch(`/api/meetings/${m.id}`).send({ postPromptsToChat: true })).body.postPromptsToChat).toBe(true);
    calls.length = 0;
    for (let i = 0; i < 4; i++) await say('Mei Chen', `The "activity record" is a person, an opportunity and hours, note ${i}.`);
    m = await getMeeting(m.id);
    expect(m.facilitatorPrompts.length).toBe(2);
    expect(m.facilitatorPrompts[1].posted).toBe(true);
    expect(calls.filter((c) => c.url.includes('send_chat_message'))).toHaveLength(1);

    // Well after the slot, with the transcript quiet, the call is closed and analysed.
    await dispatchDue(at('2026-11-10T16:05:00Z'));
    expect((await getMeeting(m.id)).status).toBe('live');
    await dispatchDue(at('2026-11-10T16:20:00Z'));
    // The analysis runs in the background once the bot has left (with the async store it no longer finishes
    // within the few turns before the next read).
    await meetBotIdle();
    m = await getMeeting(m.id);
    expect(m.status).toBe('analysed');
    expect(m.bot?.status).toBe('done');
    expect(calls.some((c) => c.url === `/bot/${m.bot!.botId}/leave_call/`)).toBe(true);
  });

  it('books each week of a recurring series separately, and skips a week on request', async () => {
    writeFeed(weeklySeries({ description: 'Notes: #volunteering' }));
    await sync(at('2026-11-09T09:00:00Z'));
    const weeks = (await calendarMeetings()).sort((a, b) => a.calendar!.start.localeCompare(b.calendar!.start));
    // 10 and 24 November in the next two weeks (17th is an EXDATE).
    expect(weeks.map((w) => w.calendar!.start)).toEqual(['2026-11-10T10:00:00.000Z']);
    const steward = request.agent(app);
    await steward.post('/api/auth/demo').send({ name: 'Steward Sky', role: 'steward' });
    const skip = await steward.patch(`/api/meetings/${weeks[0].id}`).send({ skip: true });
    expect(skip.body.calendar.skip).toBe(true);
    await dispatchDue(at('2026-11-10T09:50:00Z'));
    expect(calls.filter((c) => c.url === '/bot/')).toEqual([]);
    // A skipped call is tidied away once it's over.
    await dispatchDue(at('2026-11-10T11:01:00Z'));
    expect((await calendarMeetings()).find((w) => w.id === weeks[0].id)).toBeUndefined();

    // Next sync, a week on: the 24th (moved to 14:00) appears.
    await sync(at('2026-11-16T09:00:00Z'));
    expect((await calendarMeetings()).map((w) => w.calendar!.start)).toContain('2026-11-24T14:00:00.000Z');
  });

  it('holds invites from people who aren’t facilitators until one approves, and ignores invites the bot isn’t on or declined', async () => {
    writeFeed(
      oneOff({ uid: 'stranger', organizer: 'stranger@elsewhere.test', start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }),
      oneOff({ uid: 'declined', partstat: 'DECLINED', start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }),
      oneOff({ uid: 'not-invited', bot: 'someone.else@example.org', start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }),
    );
    await syncCalendar(at('2026-11-09T09:00:00Z'));
    const [m, ...rest] = await calendarMeetings();
    expect(rest).toEqual([]);
    expect(m.calendar).toMatchObject({ key: 'stranger', approval: 'pending' });
    // Due, but not approved: no bot.
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    expect(calls).toEqual([]);

    // A contributor can't approve it, or change the call at all.
    const contributor = request.agent(app);
    await contributor.post('/api/auth/demo').send({ name: 'Contributor Cal', role: 'contributor' });
    expect((await contributor.patch(`/api/meetings/${m.id}`).send({ approve: true })).status).toBe(403);
    expect((await contributor.patch(`/api/meetings/${m.id}`).send({ skip: true })).status).toBe(403);
    // A steward can, and the approval is on record.
    const steward = request.agent(app);
    const who = await steward.post('/api/auth/demo').send({ name: 'Steward Stella', role: 'steward' });
    const ok = await steward.patch(`/api/meetings/${m.id}`).send({ approve: true });
    expect(ok.body.calendar).toMatchObject({ approval: 'approved', approvedBy: who.body.user.id });
    const activity = (await steward.get(`/api/activity?ontologyId=${m.ontologyId}`)).body as { message: string }[];
    expect(activity.some((a) => /approved the co-lead bot joining/.test(a.message))).toBe(true);
    // Nobody signed out sees what happens to meetings, and the request for approval names no call or organiser.
    expect((await request(app).get(`/api/activity?ontologyId=${m.ontologyId}`)).status).toBe(401);
    expect(activity.find((a) => /asks the co-lead bot/.test(a.message))?.message).not.toMatch(/stranger@|Use case workshop/);
    await dispatchDue(at('2026-11-10T14:47:00Z'));
    expect(calls.filter((c) => c.url === '/bot/')).toHaveLength(1);
  });

  it('only books one bot when bookings overlap, and a skip during booking still cancels it', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-09T09:00:00Z'));
    const [m] = await calendarMeetings();
    stubMode.botDelayMs = 150;
    const steward = request.agent(app);
    await steward.post('/api/auth/demo').send({ name: 'Steward Sol', role: 'steward' });
    const [, , skip] = await Promise.all([dispatchDue(at('2026-11-10T14:46:00Z')), dispatchDue(at('2026-11-10T14:46:00Z')), steward.patch(`/api/meetings/${m.id}`).send({ skip: true })]);
    expect(calls.filter((c) => c.url === '/bot/')).toHaveLength(1);
    expect(skip.status).toBe(200);
    const after = await getMeeting(m.id);
    expect(after.calendar?.skip).toBe(true);
    expect(after.bot?.botId).toBeUndefined();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('a skip lets the booked bot go even when Recall.ai won’t cancel it yet, and keeps retrying', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-09T09:00:00Z'));
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    const [m] = await calendarMeetings();
    const botId = (await getMeeting(m.id)).bot!.botId!;
    stubMode.failCancel = true;
    const steward = request.agent(app);
    await steward.post('/api/auth/demo').send({ name: 'Steward Sue', role: 'steward' });
    const skip = await steward.patch(`/api/meetings/${m.id}`).send({ skip: true });
    expect(skip.status).toBe(200);
    // The bot is being released, and the meeting says the cancellation is still being retried.
    expect(await getMeeting(m.id)).toMatchObject({ calendar: { skip: true }, bot: { phase: 'releasing', botId, cancelError: expect.any(String) } });
    expect(await retiringCount()).toBe(1);
    expect((await steward.get('/api/meet-bot')).body.cancelling).toBe(1);
    // Anything the bot sends meanwhile is dropped.
    const secret = await secretOf(m.id);
    await recallWebhook(m.id, secret, { event: 'transcript.data', data: { bot: { id: botId }, data: { participant: { name: 'Aisha' }, words: [{ text: 'Still here.' }] } } });
    expect((await getMeeting(m.id)).transcript).toEqual([]);
    // Unskipping books a fresh bot, but only once the old one is confirmed gone: never two at once.
    await steward.patch(`/api/meetings/${m.id}`).send({ skip: false });
    await dispatchDue(at('2026-11-10T14:47:00Z'));
    expect(calls.filter((c) => c.url === '/bot/')).toHaveLength(1);
    stubMode.failCancel = false;
    calls.length = 0;
    await dispatchDue(at('2026-11-10T14:49:00Z'));
    expect(calls.some((c) => c.method === 'DELETE' && c.url === `/bot/${botId}/`)).toBe(true);
    expect(await retiringCount()).toBe(0);
    await dispatchDue(at('2026-11-10T14:50:00Z'));
    expect((await getMeeting(m.id)).bot?.botId).not.toBe(botId);
    expect((await getMeeting(m.id)).bot?.botId).toBeDefined();
  });

  it('an invite cancelled while Recall.ai won’t cancel the bot drops the call and keeps retrying the bot', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-09T09:00:00Z'));
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    const [m] = await calendarMeetings();
    const botId = (await getMeeting(m.id)).bot!.botId!;
    stubMode.failCancel = true;
    writeFeed();
    await sync(at('2026-11-10T14:48:00Z'));
    // Withdrawn: hidden, and kept only until Recall.ai confirms the bot has gone.
    expect(await calendarMeetings()).toEqual([]);
    expect(await withdrawnMeetings()).toEqual([expect.objectContaining({ id: m.id, bot: expect.objectContaining({ phase: 'releasing', botId }) })]);
    stubMode.failCancel = false;
    await dispatchDue(at('2026-11-10T14:49:00Z'));
    expect(await retiringCount()).toBe(0);
    expect((await list<Meeting>('meetings')).some((x) => x.id === m.id)).toBe(false);
    expect(calls.filter((c) => c.method === 'DELETE' && c.url === `/bot/${botId}/`).length).toBeGreaterThanOrEqual(2);
  });

  it('posting a prompt doesn’t lose transcript lines that arrive meanwhile, and tells the call when posting is switched on', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    await dispatchDue(at('2026-11-10T14:50:00Z'));
    const [m] = await calendarMeetings();
    const secret = (await list<{ id: string; secret: string }>('kv')).find((k) => k.id === `meeting-secret:${m.id}`)!.secret;
    const say = (text: string) => recallWebhook(m.id, secret, { event: 'transcript.data', data: { data: { participant: { name: 'Aisha Rahman' }, words: [{ text }] } } });
    for (let i = 0; i < 4; i++) await say(`A "rota" is a weekly pattern, part ${i}.`);
    expect((await getMeeting(m.id)).facilitatorPrompts).toHaveLength(1);

    const steward = request.agent(app);
    await steward.post('/api/auth/demo').send({ name: 'Steward Sid', role: 'steward' });
    stubMode.chatDelayMs = 150;
    const [posted] = await Promise.all([steward.post(`/api/meetings/${m.id}/prompts/0/post`), (async () => {
      await new Promise((r) => setTimeout(r, 30));
      await say('This line arrives while the prompt is being posted.');
    })()]);
    expect(posted.status).toBe(200);
    const after = await getMeeting(m.id);
    expect(after.transcript.at(-1)?.text).toBe('This line arrives while the prompt is being posted.');
    expect(after.facilitatorPrompts[0].posted).toBe(true);

    calls.length = 0;
    stubMode.chatDelayMs = 0;
    await steward.patch(`/api/meetings/${m.id}`).send({ postPromptsToChat: true });
    const notices = calls.filter((c) => c.url.includes('send_chat_message')).map((c) => c.body.message as string);
    expect(notices).toEqual([expect.stringMatching(/from now on I'll post follow-up questions here/)]);
    expect((await getMeeting(m.id)).chatModeAnnounced).toBe(true);
  });

  it('an imported .ics of a call already on the bot’s calendar doesn’t book a second bot', async () => {
    writeFeed(oneOff({ uid: 'shared-1', start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-09T09:00:00Z'));
    const steward = request.agent(app);
    await steward.post('/api/auth/demo').send({ name: 'Steward Sam', role: 'steward' });
    const { scheduleFromInvite } = await import('../src/services/meetBot.js');
    const { getProject } = await import('../src/services/ontologies.js');
    const [m] = await calendarMeetings();
    const got = await scheduleFromInvite(await getProject(m.ontologyId), { id: 'u', name: 'x' } as never, calendar(oneOff({ uid: 'shared-1', start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' })), {
      now: at('2026-11-09T10:00:00Z'),
    });
    expect(got.meetings.map((x) => x.id)).toEqual([m.id]);
    expect(await calendarMeetings()).toHaveLength(1);
  });

  it('keeps the secret calendar address out of what it reports', async () => {
    const port = (stub.address() as AddressInfo).port;
    config.meetBot.calendarIcsUrl = `http://127.0.0.1:${port}/calendar/ical/bot/private-s3cr3t/basic.ics`;
    const synced = await syncCalendar(at('2026-11-09T09:00:00Z'));
    expect(synced).toMatchObject({ ok: false, error: expect.stringMatching(/returned 404/) });
    config.meetBot.calendarIcsUrl = '"https://calendar.google.com/calendar/ical/bot/private-s3cr3t/basic.ics"';
    await syncCalendar(at('2026-11-09T09:02:00Z'));
    const info = (await (await steward('Steward Kit')).get('/api/meet-bot')).body;
    expect(JSON.stringify(info)).not.toMatch(/s3cr3t/);
    expect(JSON.stringify(await meetBotInfo())).not.toMatch(/s3cr3t/);
    expect(info.lastSync.error).toMatch(/not a valid address/);
  });

  /* ----- Fixes from the second review ----- */

  const secretOf = async (id: string) => (await list<{ id: string; secret: string }>('kv')).find((k) => k.id === `meeting-secret:${id}`)!.secret;
  const line = async (id: string, text: string, botId?: string) =>
    // Like Recall.ai, a line names its bot and carries the metadata that bot was booked with.
    recallWebhook(id, await secretOf(id), {
      event: 'transcript.data',
      data: { ...(botId ? { bot: { id: botId, metadata: bots.get(botId)?.metadata } } : {}), data: { participant: { name: 'Aisha Rahman' }, words: [{ text }] } },
    });
  /** A one-off call at 15:00 on 10 November, with its bot booked and in the call. */
  const liveCall = async () => {
    writeFeed(oneOff({ uid: 'live-1', start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    await dispatchDue(at('2026-11-10T14:50:00Z'));
    const [m] = await calendarMeetings();
    await line(m.id, 'Hello everyone.', (await getMeeting(m.id)).bot!.botId);
    return await getMeeting(m.id);
  };

  it('by default every invite waits for approval; one approval covers the series, until its Meet link changes', async () => {
    writeFeed(weeklySeries({ description: '#volunteering' }));
    await syncCalendar(at('2026-11-02T09:00:00Z'));
    let weeks = await calendarMeetings();
    expect(weeks.map((w) => w.calendar!.approval)).toEqual(['pending', 'pending']);
    // Organised by a steward, but the invite can't prove that, so nothing is booked.
    await dispatchDue(at('2026-11-03T09:50:00Z'));
    expect(calls.filter((c) => c.url === '/bot/')).toEqual([]);

    const s = await steward('Steward Ava');
    expect((await s.patch(`/api/meetings/${weeks[0].id}`).send({ approve: true })).status).toBe(200);
    weeks = await calendarMeetings();
    expect(weeks.map((w) => w.calendar!.approval)).toEqual(['approved', 'approved']);
    // Weeks that turn up later are covered too.
    await syncCalendar(at('2026-11-16T09:00:00Z'));
    const moved = (await calendarMeetings()).find((w) => w.calendar!.start === '2026-11-24T14:00:00.000Z')!;
    expect(moved.calendar!.approval).toBe('approved');
    await dispatchDue(at('2026-11-24T13:46:00Z'));
    const botId = (await getMeeting(moved.id)).bot!.botId!;
    expect(botId).toBeTruthy();

    // The Meet link changes: the booking is cancelled and the call needs approving again.
    calls.length = 0;
    writeFeed(weeklySeries({ description: '#volunteering', meet: 'https://meet.google.com/new-linx-abc' }));
    await syncCalendar(at('2026-11-24T13:50:00Z'));
    const after = await getMeeting(moved.id);
    expect(after.calendar).toMatchObject({ approval: 'pending', approvalNote: expect.stringMatching(/Meet link changed/) });
    expect(after.bot?.botId).toBeUndefined();
    expect(calls).toContainEqual(expect.objectContaining({ method: 'DELETE', url: `/bot/${botId}/` }));
    await dispatchDue(at('2026-11-24T13:55:00Z'));
    expect(calls.filter((c) => c.url === '/bot/')).toEqual([]);
  });

  it('a facilitator’s own invite, a forwarded one and a non-member’s all wait; a changed organiser revokes approval even if cancelling fails', async () => {
    const olive = await createUser({ name: 'Olive', email: 'olive@elsewhere.test', provider: 'demo', subject: 'test-olive' });
    writeFeed(
      oneOff({ uid: 'fwd', sentBy: 'tom@example.org', start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }),
      oneOff({ uid: 'olive', organizer: 'olive@elsewhere.test', start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }),
      oneOff({ uid: 'tom', start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }),
    );
    await syncCalendar(at('2026-11-09T09:00:00Z'));
    const byUid = async (uid: string) => (await calendarMeetings()).find((m) => m.calendar!.uid === uid)!;
    // Even an invite whose organiser is a steward can't prove it: everything waits.
    expect((await Promise.all(['fwd', 'olive', 'tom'].map(async (u) => (await byUid(u)).calendar!.approval)))).toEqual(['pending', 'pending', 'pending']);
    expect((await byUid('fwd')).calendar!.sentBy).toBe('tom@example.org');
    // Organising the call gives Olive no say over it.
    expect((await byUid('olive')).createdBy).toBe('calendar');
    expect(await canFacilitate(await byUid('olive'), olive)).toBe(false);

    // Tom's call is approved and booked, then taken over by someone else while Recall.ai is refusing cancellations.
    const s = await steward('Steward Quinn');
    await s.patch(`/api/meetings/${(await byUid('tom')).id}`).send({ approve: true });
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    const botId = (await getMeeting((await byUid('tom')).id)).bot!.botId!;
    stubMode.failCancel = true;
    writeFeed(oneOff({ uid: 'tom', organizer: 'mallory@elsewhere.test', meet: 'https://meet.google.com/mal-lory-abc', start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await syncCalendar(at('2026-11-10T14:50:00Z'));
    const tom = await getMeeting((await byUid('tom')).id);
    expect(tom.calendar).toMatchObject({ approval: 'pending', organizer: 'mallory@elsewhere.test', approvalNote: expect.stringMatching(/changed/) });
    // The old bot is being released (retried in the background), and no longer counts as booked.
    expect(tom.bot).toMatchObject({ phase: 'releasing', botId });
    expect(await retiringCount()).toBe(1);
    // The old bot joins anyway: what it hears is dropped, and the call doesn't go live.
    await line(tom.id, 'Should not be kept.', botId);
    expect(await getMeeting(tom.id)).toMatchObject({ status: 'scheduled', transcript: [] });
    // Approved again before Recall.ai recovers: no fresh bot until the old one is confirmed gone (never two at once).
    await s.patch(`/api/meetings/${tom.id}`).send({ approve: true });
    calls.length = 0;
    await dispatchDue(at('2026-11-10T14:51:00Z'));
    expect(calls.filter((c) => c.url === '/bot/')).toEqual([]);
    await line(tom.id, 'Still not kept.', botId);
    expect((await getMeeting(tom.id)).transcript).toEqual([]);
    stubMode.failCancel = false;
    calls.length = 0;
    await dispatchDue(at('2026-11-10T14:52:00Z'));
    expect(calls).toContainEqual(expect.objectContaining({ method: 'DELETE', url: `/bot/${botId}/` }));
    // Then a fresh bot is booked for the new link.
    await dispatchDue(at('2026-11-10T14:53:00Z'));
    expect(calls.filter((c) => c.url === '/bot/').map((c) => c.body.meeting_url)).toEqual(['https://meet.google.com/mal-lory-abc']);
    const fresh = (await getMeeting(tom.id)).bot!.botId!;
    expect(fresh).not.toBe(botId);
    expect(calls.some((c) => c.url.startsWith(`/bot/${fresh}/`) && c.method === 'DELETE')).toBe(false);
    expect(await retiringCount()).toBe(0);
    await line(tom.id, 'An old bot is never heard.', botId);
    expect((await getMeeting(tom.id)).transcript).toEqual([]);
  });

  it('analysing needs a facilitator and an ended call; ending reports a bot it couldn’t remove and keeps trying', async () => {
    const m = await liveCall();
    expect(m.bot?.status).toBe('in-call');
    const contributor = request.agent(app);
    await contributor.post('/api/auth/demo').send({ name: 'Contributor Cy', role: 'reviewer' });
    expect((await contributor.post(`/api/meetings/${m.id}/analyse`)).status).toBe(403);
    expect((await contributor.post(`/api/meetings/${m.id}/propose`)).status).toBe(403);
    const s = await steward('Steward Eve');
    expect((await s.post(`/api/meetings/${m.id}/analyse`)).status).toBe(409);

    stubMode.failCancel = true;
    const end = await s.post(`/api/meetings/${m.id}/end`);
    expect(end.status).toBe(502);
    expect(await getMeeting(m.id)).toMatchObject({ status: 'live', bot: { status: 'in-call', leaving: true } });
    // Retried every minute; once the bot is out, the call is analysed.
    stubMode.failCancel = false;
    await dispatchDue(at('2026-11-10T15:30:00Z'));
    await meetBotIdle(); // the analysis runs in the background once the bot has left
    expect(await getMeeting(m.id)).toMatchObject({ status: 'analysed', bot: { status: 'done' } });
  });

  it('finds a booking whose answer was lost instead of booking a second bot', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    stubMode.dropCreate = true;
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    const booked = `bot-${nextBot}`;
    const [m] = await calendarMeetings();
    expect((await getMeeting(m.id)).bot).toMatchObject({ uncertain: true });
    stubMode.dropCreate = false;
    await dispatchDue(at('2026-11-10T14:47:00Z'));
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/bot/')).toHaveLength(1);
    expect(calls.some((c) => c.method === 'GET' && c.url.startsWith('/bot/?'))).toBe(true);
    expect((await getMeeting(m.id)).bot).toMatchObject({ botId: booked });
    expect((await getMeeting(m.id)).bot?.uncertain).toBeUndefined();
  });

  it('importing only a cancellation cancels the booked call', async () => {
    const start = new Date(Date.now() + 10 * 60_000);
    const one = (status?: string) => calendar(oneOff({ uid: 'import-cancel', start: start.toISOString(), end: new Date(start.getTime() + 3600e3).toISOString(), status }));
    expect(parseCancellations(one('CANCELLED'))).toEqual({ uids: ['import-cancel'], keys: [] });
    const s = await steward('Steward Ivy');
    const made = await s.post('/api/ontologies/volunteering/meetings/calendar').send({ ics: one() });
    const id = made.body.meetings[0].id as string;
    const botId = (await getMeeting(id)).bot!.botId!;
    expect(botId).toBeTruthy();
    const res = await s.post('/api/ontologies/volunteering/meetings/calendar').send({ ics: one('CANCELLED') });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ meetings: [], cancelled: 1, cancelRetrying: 0 });
    expect(calls).toContainEqual(expect.objectContaining({ method: 'DELETE', url: `/bot/${botId}/` }));
    expect((await list<Meeting>('meetings')).some((x) => x.id === id)).toBe(false);
  });

  it('retries a chat notice that failed, and holds back automatic posts until the call has been told', async () => {
    const m = await liveCall();
    const s = await steward('Steward Noor');
    stubMode.failChat = true;
    expect((await s.patch(`/api/meetings/${m.id}`).send({ postPromptsToChat: true })).status).toBe(200);
    expect(await getMeeting(m.id)).toMatchObject({ postPromptsToChat: true, chatModeAnnounced: false, chatNoticeError: expect.stringMatching(/Couldn’t tell the call/) });
    for (let i = 0; i < 4; i++) await line(m.id, `A "rota" is a weekly pattern, part ${i}.`);
    expect((await getMeeting(m.id)).facilitatorPrompts.at(-1)?.posted).toBe(false);

    stubMode.failChat = false;
    calls.length = 0;
    for (let i = 0; i < 4; i++) await line(m.id, `The "activity record" holds hours, note ${i}.`);
    const after = await getMeeting(m.id);
    expect(after.chatModeAnnounced).toBe(true);
    expect(after.chatNoticeError).toBeUndefined();
    const sent = calls.filter((c) => c.url.includes('send_chat_message')).map((c) => c.body.message as string);
    expect(sent[0]).toMatch(/from now on I'll post follow-up questions here/);
    expect(after.facilitatorPrompts.at(-1)?.posted).toBe(true);
  });

  // Calls are working group business (services/useCases.ts canSeeMeeting): these checks use a reviewer, who is in the
  // group but isn't a facilitator. A contributor, outside the group, doesn't see calls at all.
  it('shows meetings to the working group only, and invites awaiting approval, Meet links and organisers to facilitators only', async () => {
    writeFeed(oneOff({ uid: 'private-call', start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await syncCalendar(at('2026-11-09T09:00:00Z'));
    const [m] = await calendarMeetings();
    expect((await request(app).get('/api/ontologies/volunteering/meetings')).status).toBe(401);
    expect((await request(app).get(`/api/meetings/${m.id}`)).status).toBe(401);
    const contributor = request.agent(app);
    await contributor.post('/api/auth/demo').send({ name: 'Contributor Dee', role: 'reviewer' });
    expect(((await contributor.get('/api/ontologies/volunteering/meetings')).body as Meeting[]).some((x) => x.id === m.id)).toBe(false);
    expect((await contributor.get(`/api/meetings/${m.id}`)).status).toBe(404);

    const s = await steward('Steward Uma');
    expect((await s.get(`/api/meetings/${m.id}`)).body.calendar.organizer).toBe('tom@example.org');
    await s.patch(`/api/meetings/${m.id}`).send({ approve: true });
    const seen = (await contributor.get(`/api/meetings/${m.id}`)).body as Meeting;
    expect(seen.title).toBe('Use case workshop');
    expect(seen.meetingUrl).toBeUndefined();
    expect(seen.calendar?.organizer).toBeUndefined();
    expect((await contributor.post('/api/meet-bot/sync')).status).toBe(403);
    const outsider = request.agent(app);
    await outsider.post('/api/auth/demo').send({ name: 'Contributor Dee Outside', role: 'contributor' });
    expect((await outsider.get(`/api/meetings/${m.id}`)).status).toBe(404);
    expect(((await outsider.get('/api/ontologies/volunteering/meetings')).body as Meeting[]).some((x) => x.id === m.id)).toBe(false);
  });

  it('“Join a call now” keeps transcript lines that arrive before Recall.ai answers', async () => {
    const s = await steward('Steward Raj');
    stubMode.botDelayMs = 200;
    const sending = s.post('/api/ontologies/volunteering/meetings/bot').send({ title: 'Join now race', meetingUrl: 'https://meet.google.com/abc-defg-hij' });
    const req = sending.then((r) => r);
    await new Promise((r) => setTimeout(r, 80));
    const m = (await list<Meeting>('meetings')).find((x) => x.title === 'Join now race')!;
    await line(m.id, 'Said before the booking came back.');
    const res = await req;
    expect(res.status).toBe(201);
    const after = await getMeeting(m.id);
    expect(after.transcript).toHaveLength(1);
    expect(after.bot).toMatchObject({ botId: `bot-${nextBot}`, status: 'in-call' });
  });

  /* ----- Fixes from the third review ----- */

  it('a cancellation that arrives once the bot is in the call takes it out and analyses what it heard', async () => {
    const m = await liveCall();
    calls.length = 0;
    writeFeed();
    await sync(at('2026-11-10T15:10:00Z'));
    expect(calls).toContainEqual(expect.objectContaining({ method: 'POST', url: `/bot/${m.bot!.botId}/leave_call/` }));
    expect(await getMeeting(m.id)).toMatchObject({ status: 'analysed', bot: { status: 'done' } });
  });

  it('cancelling a call whose booking reply was lost finds that bot and cancels it', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    stubMode.dropCreate = true;
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    const booked = `bot-${nextBot}`;
    const [m] = await calendarMeetings();
    stubMode.dropCreate = false;
    // Recall.ai can't be asked at first: the call is withdrawn (hidden), and kept until that booking is settled.
    stubMode.failList = true;
    stubMode.failCreate = true;
    writeFeed();
    await sync(at('2026-11-10T14:47:00Z'));
    expect(await calendarMeetings()).toEqual([]);
    expect(await withdrawnMeetings()).toEqual([expect.objectContaining({ id: m.id, bot: expect.objectContaining({ phase: 'releasing', uncertain: true }) })]);
    expect(await retiringCount()).toBe(1);
    stubMode.failList = false;
    stubMode.failCreate = false;
    calls.length = 0;
    await dispatchDue(at('2026-11-10T14:48:00Z'));
    expect(calls).toContainEqual(expect.objectContaining({ method: 'DELETE', url: `/bot/${booked}/` }));
    expect(await retiringCount()).toBe(0);
    expect((await list<Meeting>('meetings')).some((x) => x.id === m.id)).toBe(false);
  });

  it('a booking reply cut off after its headers counts as unconfirmed, not failed', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    stubMode.truncateCreate = true;
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    const booked = `bot-${nextBot}`;
    const [m] = await calendarMeetings();
    expect((await getMeeting(m.id)).bot).toMatchObject({ uncertain: true });
    stubMode.truncateCreate = false;
    await dispatchDue(at('2026-11-10T14:47:00Z'));
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/bot/')).toHaveLength(1);
    expect((await getMeeting(m.id)).bot?.botId).toBe(booked);
  });

  it('after a lost booking reply, the bot’s first words identify it, and End call removes it', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    stubMode.dropCreate = true;
    await dispatchDue(at('2026-11-10T14:58:00Z'));
    const booked = `bot-${nextBot}`;
    stubMode.dropCreate = false;
    const [m] = await calendarMeetings();
    await line(m.id, 'We can start.', booked);
    expect(await getMeeting(m.id)).toMatchObject({ status: 'live', bot: { botId: booked, status: 'in-call' } });
    const s = await steward('Steward Vic');
    stubMode.failCancel = true;
    expect((await s.post(`/api/meetings/${m.id}/end`)).status).toBe(502);
    stubMode.failCancel = false;
    calls.length = 0;
    expect((await s.post(`/api/meetings/${m.id}/end`)).status).toBe(200);
    expect(calls).toContainEqual(expect.objectContaining({ url: `/bot/${booked}/leave_call/` }));
  });

  it('End call on a call whose booking was never confirmed looks the bot up first', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    stubMode.dropCreate = true;
    await dispatchDue(at('2026-11-10T15:00:30Z'));
    const booked = `bot-${nextBot}`;
    stubMode.dropCreate = false;
    const [m] = await calendarMeetings();
    // Live (it's past the start) with no bot id yet, and Recall.ai can't be asked.
    const { mutateMeeting } = await import('../src/services/meetings.js');
    await mutateMeeting(m.id, (x) => {
      x.status = 'live';
      x.bot = { ...x.bot!, status: 'joining', uncertain: true };
    });
    const s = await steward('Steward Wes');
    stubMode.failList = true;
    stubMode.failCreate = true;
    expect((await s.post(`/api/meetings/${m.id}/end`)).status).toBe(502);
    expect((await getMeeting(m.id)).bot).toMatchObject({ leaving: true });
    stubMode.failList = false;
    stubMode.failCreate = false;
    calls.length = 0;
    await dispatchDue(at('2026-11-10T15:05:00Z'));
    // Found by the ledger's lookup and cancelled (Recall.ai refuses DELETE for a bot in a call, and Concord then tells it to leave).
    expect(calls.some((c) => c.url.startsWith(`/bot/${booked}/`) && c.method !== 'GET')).toBe(true);
    expect((await getMeeting(m.id)).bot?.status).toBe('done');
  });

  it('a skip that lands just before a transcript line wins: the line is dropped', async () => {
    const m = await liveCall();
    const { meetingLock } = await import('../src/services/meetings.js');
    // Hold the meeting's lock, queue the webhook behind it, then mark the call skipped before releasing.
    let release!: () => void;
    const held = meetingLock(m.id, () => new Promise<void>((r) => (release = r)));
    const hook = line(m.id, 'Arrives during the skip.', m.bot!.botId);
    await new Promise((r) => setTimeout(r, 20));
    const fresh = await getMeeting(m.id);
    await saveMeeting({ ...fresh, calendar: { ...fresh.calendar!, skip: true } });
    release();
    await held;
    await hook;
    expect((await getMeeting(m.id)).transcript.map((l) => l.text)).toEqual(['Hello everyone.']);
  });

  it('retries a failed chat notice on every line, even when the bot has nothing new to suggest', async () => {
    const m = await liveCall();
    const s = await steward('Steward Xan');
    stubMode.failChat = true;
    await s.patch(`/api/meetings/${m.id}`).send({ postPromptsToChat: true });
    expect((await getMeeting(m.id)).chatNoticeError).toBeTruthy();
    stubMode.failChat = false;
    calls.length = 0;
    // One plain line, too few for a new suggestion.
    await line(m.id, 'Okay.');
    expect(calls.filter((c) => c.url.includes('send_chat_message')).map((c) => c.body.message)).toEqual([expect.stringMatching(/from now on/)]);
    expect((await getMeeting(m.id)).chatModeAnnounced).toBe(true);
  });

  it('importing an invite that is waiting for approval approves it', async () => {
    const start = new Date(Date.now() + 10 * 60_000);
    const ics = calendar(oneOff({ uid: 'pending-then-import', start: start.toISOString(), end: new Date(start.getTime() + 3600e3).toISOString() }));
    writeFeed(oneOff({ uid: 'pending-then-import', start: start.toISOString(), end: new Date(start.getTime() + 3600e3).toISOString() }));
    await syncCalendar(new Date());
    const [m] = await calendarMeetings();
    expect(m.calendar?.approval).toBe('pending');
    const s = await steward('Steward Yan');
    const res = await s.post('/api/ontologies/volunteering/meetings/calendar').send({ ics });
    expect(res.body.meetings[0]).toMatchObject({ id: m.id, calendar: { approval: 'approved', approvedBy: s.userId } });
    expect((await getMeeting(m.id)).bot?.botId).toBeTruthy();
  });

  it('a cancellation without a start time still cancels, and says when cancelling the bot is still being retried', async () => {
    const start = new Date(Date.now() + 10 * 60_000);
    const s = await steward('Steward Zed');
    await s.post('/api/ontologies/volunteering/meetings/calendar').send({ ics: calendar(oneOff({ uid: 'bare-cancel', start: start.toISOString(), end: new Date(start.getTime() + 3600e3).toISOString() })) });
    const [m] = await calendarMeetings();
    expect((await getMeeting(m.id)).bot?.botId).toBeTruthy();
    const bare = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:CANCEL\r\nBEGIN:VEVENT\r\nUID:bare-cancel\r\nDTSTAMP:20261104T120000Z\r\nSEQUENCE:2\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    expect(parseCancellations(bare)).toEqual({ uids: ['bare-cancel'], keys: [] });
    stubMode.failCancel = true;
    const res = await s.post('/api/ontologies/volunteering/meetings/calendar').send({ ics: bare });
    expect(res.body).toEqual({ meetings: [], cancelled: 0, cancelRetrying: 1 });
    expect(await calendarMeetings()).toEqual([]);
    expect(await retiringCount()).toBe(1);
    expect((await s.get('/api/meet-bot')).body.cancelling).toBe(1);
  });

  /* ----- Fixes from the fourth review ----- */

  it('“Join a call now”: a bot already heard from survives a lost booking reply, and the call can’t be analysed under it', async () => {
    // Used to sleep 60 ms and hope the booking had reached Recall.ai and not yet lost its reply (150 ms later). Under
    // CI load the line could go first and name an earlier test's bot, so the booking's bot was never heard from.
    const s = await steward('Steward Ada');
    stubMode.dropCreate = true;
    const reply = holdDroppedReply();
    const req = s
      .post('/api/ontologies/volunteering/meetings/bot')
      .send({ title: 'Lost reply race', meetingUrl: 'https://meet.google.com/abc-defg-hij' })
      .then((r) => r);
    await reply.arrived;
    const m = (await list<Meeting>('meetings')).find((x) => x.title === 'Lost reply race')!;
    const booked = `bot-${nextBot}`;
    await line(m.id, 'We’ve started.', booked);
    reply.release();
    await req;
    stubMode.dropCreate = false;
    expect((await getMeeting(m.id)).bot).toMatchObject({ botId: booked, status: 'in-call' });
    expect((await s.post(`/api/meetings/${m.id}/analyse`)).status).toBe(409);
  });

  it('“Join a call now”: a line with no bot id before a lost reply leaves the booking to be looked up, not forgotten', async () => {
    // Same timing as above: the line has to arrive while the booking is sent and unanswered, so the reply is held, not timed.
    const s = await steward('Steward Bo');
    stubMode.dropCreate = true;
    const reply = holdDroppedReply();
    const req = s
      .post('/api/ontologies/volunteering/meetings/bot')
      .send({ title: 'Anonymous line race', meetingUrl: 'https://meet.google.com/abc-defg-hij' })
      .then((r) => r);
    await reply.arrived;
    const m = (await list<Meeting>('meetings')).find((x) => x.title === 'Anonymous line race')!;
    await line(m.id, 'Hello?');
    reply.release();
    await req;
    stubMode.dropCreate = false;
    expect((await getMeeting(m.id)).bot).toMatchObject({ status: 'in-call', uncertain: true, bookingId: expect.any(String) });
    expect((await s.post(`/api/meetings/${m.id}/analyse`)).status).toBe(409);
  });

  it('an unconfirmed booking is still found and cancelled after the Meet link changes', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    stubMode.dropCreate = true;
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    stubMode.dropCreate = false;
    const booked = `bot-${nextBot}`;
    const [m] = await calendarMeetings();
    expect((await getMeeting(m.id)).bot).toMatchObject({ uncertain: true, bookedUrl: 'https://meet.google.com/xyz-abcd-efg' });
    calls.length = 0;
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z', meet: 'https://meet.google.com/new-link-xyz' }));
    await syncCalendar(at('2026-11-10T14:47:00Z'));
    // Looked up by the link it was booked for, not the new one.
    expect(calls).toContainEqual(expect.objectContaining({ method: 'GET', url: `/bot/?meeting_url=${encodeURIComponent('https://meet.google.com/xyz-abcd-efg')}` }));
    expect(calls).toContainEqual(expect.objectContaining({ method: 'DELETE', url: `/bot/${booked}/` }));
    expect((await getMeeting(m.id)).calendar).toMatchObject({ approval: 'pending' });
    expect((await getMeeting(m.id)).bot?.uncertain).toBeUndefined();
  });

  it('a call cancelled while it overruns its slot still takes the bot out', async () => {
    const m = await liveCall();
    calls.length = 0;
    writeFeed();
    await sync(at('2026-11-10T16:10:00Z'));
    expect(calls).toContainEqual(expect.objectContaining({ method: 'POST', url: `/bot/${m.bot!.botId}/leave_call/` }));
    expect(await getMeeting(m.id)).toMatchObject({ status: 'analysed', bot: { status: 'done' } });
  });

  it('a new organiser on a call the bot is in takes the bot out, and the call is analysed with a note why', async () => {
    const m = await liveCall();
    calls.length = 0;
    writeFeed(oneOff({ uid: 'live-1', organizer: 'mallory@elsewhere.test', start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await syncCalendar(at('2026-11-10T15:10:00Z'));
    expect(calls).toContainEqual(expect.objectContaining({ method: 'POST', url: `/bot/${m.bot!.botId}/leave_call/` }));
    // The call is analysed (not left waiting for an approval it can no longer get), and says why the bot left.
    const after = await getMeeting(m.id);
    expect(after.status).toBe('analysed');
    expect(after.calendar).toMatchObject({ approval: 'approved', organizer: 'mallory@elsewhere.test', approvalNote: expect.stringMatching(/organiser changed.*bot left/) });
    expect(after.bot?.status).toBe('done');
    // Nothing more it sends is kept, and later syncs leave it alone.
    await line(m.id, 'After the change.', m.bot!.botId);
    expect((await getMeeting(m.id)).transcript.map((l) => l.text)).toEqual(['Hello everyone.']);
    calls.length = 0;
    await syncCalendar(at('2026-11-10T15:12:00Z'));
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('a call that runs out while its booking is unconfirmed still has that bot cancelled', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    stubMode.dropCreate = true;
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    const booked = `bot-${nextBot}`;
    const [m] = await calendarMeetings();
    // Recall.ai can't be asked until the call is over.
    stubMode.failList = true;
    stubMode.failCreate = true;
    await dispatchDue(at('2026-11-10T15:30:00Z'));
    stubMode.dropCreate = false;
    await dispatchDue(at('2026-11-10T16:01:00Z'));
    expect((await getMeeting(m.id)).status).toBe('error');
    expect(await retiringCount()).toBe(1);
    stubMode.failList = false;
    stubMode.failCreate = false;
    calls.length = 0;
    await dispatchDue(at('2026-11-10T16:02:00Z'));
    expect(calls).toContainEqual(expect.objectContaining({ method: 'DELETE', url: `/bot/${booked}/` }));
    expect(await retiringCount()).toBe(0);
  });

  it('a late line from a cancelled bot doesn’t bring its booking back', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    const [m] = await calendarMeetings();
    const old = (await getMeeting(m.id)).bot!.botId!;
    const s = await steward('Steward Cal');
    await s.patch(`/api/meetings/${m.id}`).send({ skip: true });
    expect(await retiringCount()).toBe(0);
    await s.patch(`/api/meetings/${m.id}`).send({ skip: false });
    await line(m.id, 'Late, from the cancelled bot.', old);
    expect(await getMeeting(m.id)).toMatchObject({ status: 'scheduled', transcript: [] });
    expect((await getMeeting(m.id)).bot?.botId).toBeUndefined();
    await dispatchDue(at('2026-11-10T14:50:00Z'));
    const fresh = (await getMeeting(m.id)).bot!.botId!;
    expect(fresh).not.toBe(old);
    await line(m.id, 'Late again.', old);
    await line(m.id, 'From the new bot.', fresh);
    expect((await getMeeting(m.id)).transcript.map((l) => l.text)).toEqual(['From the new bot.']);
  });

  it('what happens to a call waiting for approval isn’t shown to people who can’t see the call', async () => {
    writeFeed(oneOff({ uid: 'quiet', title: 'Board restructure', start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await syncCalendar(at('2026-11-10T14:00:00Z'));
    const [m] = await calendarMeetings();
    const s = await steward('Steward Dee');
    await s.patch(`/api/meetings/${m.id}`).send({ approve: true });
    // Approved and named in the activity; then the link changes and it waits again; then it is skipped.
    writeFeed(oneOff({ uid: 'quiet', title: 'Board restructure', meet: 'https://meet.google.com/oth-erli-nkk', start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await syncCalendar(at('2026-11-10T14:10:00Z'));
    await s.patch(`/api/meetings/${m.id}`).send({ skip: true });
    const contributor = request.agent(app);
    await contributor.post('/api/auth/demo').send({ name: 'Contributor Eli', role: 'reviewer' });
    const theirs = (await contributor.get(`/api/activity?ontologyId=${m.ontologyId}`)).body as { message: string; link?: string }[];
    expect(theirs.filter((a) => a.link?.includes(m.id) || a.message.includes('Board restructure'))).toEqual([]);
    const stewards = (await s.get(`/api/activity?ontologyId=${m.ontologyId}`)).body as { message: string; link?: string }[];
    expect(stewards.some((a) => a.link?.includes(m.id))).toBe(true);
    // Withdrawn while it waits: the call is gone, and what happened to it stays hidden.
    writeFeed();
    await syncCalendar(at('2026-11-10T14:20:00Z'));
    expect(await calendarMeetings()).toEqual([]);
    const later = (await contributor.get(`/api/activity?ontologyId=${m.ontologyId}`)).body as { message: string; link?: string }[];
    expect(later.filter((a) => a.link?.includes(m.id) || a.message.includes('Board restructure'))).toEqual([]);
    expect(((await s.get(`/api/activity?ontologyId=${m.ontologyId}`)).body as { link?: string }[]).some((a) => a.link?.includes(m.id))).toBe(true);
  });

  /* ----- Fixes from the fifth review ----- */

  it('the Meet link a bot was booked for stays hidden from people who can’t see the link', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    const [m] = await calendarMeetings();
    expect((await getMeeting(m.id)).bot).toMatchObject({ botId: expect.any(String), bookedUrl: 'https://meet.google.com/xyz-abcd-efg' });
    const contributor = request.agent(app);
    await contributor.post('/api/auth/demo').send({ name: 'Contributor Gus', role: 'reviewer' });
    const detail = await contributor.get(`/api/meetings/${m.id}`);
    const listed = await contributor.get(`/api/ontologies/${m.ontologyId}/meetings`);
    expect(detail.status).toBe(200);
    for (const body of [detail.text, listed.text]) {
      expect(body).not.toContain('meet.google.com');
      expect(body).not.toMatch(/bk_|bot-\d/);
    }
    expect(detail.body.bot.booked).toBe(true);
  });

  it('a restart in the middle of booking finds that bot instead of booking another', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    const [m] = await calendarMeetings();
    stubMode.botDelayMs = 200;
    const booking = dispatchDue(at('2026-11-10T14:46:00Z'));
    await new Promise((r) => setTimeout(r, 80));
    // While the request is out, the attempt is already on record.
    const midway = await getMeeting(m.id);
    expect(midway.bot).toMatchObject({ uncertain: true, bookingId: expect.stringMatching(/^bk_/), bookedUrl: 'https://meet.google.com/xyz-abcd-efg' });
    expect(midway.bot?.botId).toBeUndefined();
    await booking;
    const booked = `bot-${nextBot}`;
    stubMode.botDelayMs = 0;
    // The process died before saving the reply: the database still says what it said midway.
    await saveMeeting(midway);
    calls.length = 0;
    await dispatchDue(at('2026-11-10T14:47:00Z'));
    // Sent again under the same idempotency key, which answers with the bot already made rather than a second one.
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/bot/').map((c) => (c.body.metadata as { concord_booking: string }).concord_booking)).toEqual([midway.bot!.bookingId]);
    expect(`bot-${nextBot}`).toBe(booked);
    expect((await getMeeting(m.id)).bot).toMatchObject({ botId: booked });
    expect((await getMeeting(m.id)).bot?.uncertain).toBeUndefined();
  });

  it('a restart mid-booking doesn’t double-book even while Recall.ai doesn’t list the bot yet', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    const [m] = await calendarMeetings();
    stubMode.botDelayMs = 200;
    const booking = dispatchDue(at('2026-11-10T14:46:00Z'));
    await new Promise((r) => setTimeout(r, 80));
    const midway = await getMeeting(m.id);
    await booking;
    stubMode.botDelayMs = 0;
    const booked = `bot-${nextBot}`;
    await saveMeeting(midway);
    stubMode.listHides = true;
    calls.length = 0;
    await dispatchDue(at('2026-11-10T14:47:00Z'));
    // Sent again under the same idempotency key: Recall.ai answers with the bot it already made.
    const posts = calls.filter((c) => c.method === 'POST' && c.url === '/bot/');
    expect(posts).toHaveLength(1);
    expect((posts[0].body as { metadata: { concord_booking: string } }).metadata.concord_booking).toBe(midway.bot!.bookingId);
    expect(`bot-${nextBot}`).toBe(booked);
    expect((await getMeeting(m.id)).bot).toMatchObject({ botId: booked });
  });

  it('a lost booking that isn’t listed yet is sent again under the same key, which returns that bot instead of a second one', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    stubMode.dropCreate = true;
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    stubMode.dropCreate = false;
    const lost = `bot-${nextBot}`;
    const [m] = await calendarMeetings();
    const bookingId = (await getMeeting(m.id)).bot!.bookingId!;
    stubMode.listHides = true;
    calls.length = 0;
    await dispatchDue(at('2026-11-10T14:47:00Z'));
    const posts = calls.filter((c) => c.method === 'POST' && c.url === '/bot/');
    expect(posts).toHaveLength(1);
    expect(nextBot).toBe(Number(lost.slice(4)));
    expect((await getMeeting(m.id)).bot).toMatchObject({ botId: lost, bookingId });
    expect((await getMeeting(m.id)).bot?.uncertain).toBeUndefined();
  });

  it('an unconfirmed booking that is being let go blocks a fresh one until it is settled; then the fresh one is booked', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    stubMode.dropCreate = true;
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    stubMode.dropCreate = false;
    const lost = `bot-${nextBot}`;
    const [m] = await calendarMeetings();
    const s = await steward('Steward Lou');
    // Skipped while Recall.ai can't confirm anything: still being settled, and counted as being cancelled.
    stubMode.listHides = true;
    stubMode.failCreate = true;
    await s.patch(`/api/meetings/${m.id}`).send({ skip: true });
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'releasing', uncertain: true, cancelError: expect.any(String) });
    expect(await retiringCount()).toBe(1);
    expect((await s.get('/api/meet-bot')).body.cancelling).toBe(1);
    // Unskipped: no fresh booking while the old one's outcome is unknown.
    await s.patch(`/api/meetings/${m.id}`).send({ skip: false });
    stubMode.failCreate = false;
    calls.length = 0;
    await dispatchDue(at('2026-11-10T14:48:00Z'));
    // Sent again under its own key, which names the bot it made: that bot is cancelled, and nothing new is booked.
    expect(calls.filter((c) => c.url === '/bot/').map((c) => (c.body.metadata as { concord_booking: string }).concord_booking)).toEqual([expect.stringMatching(/^bk_/)]);
    expect(`bot-${nextBot}`).toBe(lost);
    expect(calls).toContainEqual(expect.objectContaining({ method: 'DELETE', url: `/bot/${lost}/` }));
    expect(await retiringCount()).toBe(0);
    // Only then is a fresh one booked.
    stubMode.listHides = false;
    await dispatchDue(at('2026-11-10T14:49:00Z'));
    const fresh = (await getMeeting(m.id)).bot!.botId!;
    expect(fresh).toBe(`bot-${nextBot}`);
    expect(fresh).not.toBe(lost);
    expect(calls.some((c) => c.url.startsWith(`/bot/${fresh}/`) && c.method !== 'GET')).toBe(false);
  });

  it('a booking that never turns up is looked for less and less often, never let go by itself, and a facilitator can dismiss it', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    const t0 = at('2026-11-10T14:46:00Z').getTime();
    stubMode.dropCreate = true;
    await dispatchDue(new Date(t0));
    stubMode.dropCreate = false;
    const [m] = await calendarMeetings();
    // Recall.ai never confirms it, and never lists it.
    stubMode.listHides = true;
    stubMode.failCreate = true;
    const lookups = () => calls.filter((c) => c.method === 'GET' && c.url.startsWith('/bot/?')).length;
    const s = await steward('Steward Nell');
    // While the booking can still be sent again under its key, it can't be dismissed.
    await dispatchDue(new Date(t0 + 60_000));
    expect((await s.post(`/api/meetings/${m.id}/bot/dismiss`)).status).toBe(409);
    // The call ends without it; the booking is still being settled.
    await dispatchDue(new Date(t0 + 76 * 60_000));
    expect(await getMeeting(m.id)).toMatchObject({ status: 'error', bot: { phase: 'releasing', uncertain: true } });
    // After six hours of looking, only every six hours.
    await dispatchDue(new Date(t0 + SLOW_LOOKUP_AFTER_MS + 60_000));
    calls.length = 0;
    for (let h = 1; h < 6; h++) await dispatchDue(new Date(t0 + SLOW_LOOKUP_AFTER_MS + h * 3600e3));
    expect(lookups()).toBe(0);
    await dispatchDue(new Date(t0 + 2 * SLOW_LOOKUP_AFTER_MS + 2 * 60_000));
    expect(lookups()).toBe(1);
    // Never let go by itself, however long it takes.
    await dispatchDue(new Date(t0 + 30 * 24 * 3600e3));
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'releasing', unconfirmed: true });
    expect(await retiringCount()).toBe(1);
    // A facilitator can confirm it can go; nobody else can.
    const contributor = request.agent(app);
    await contributor.post('/api/auth/demo').send({ name: 'Contributor Ola', role: 'contributor' });
    expect((await contributor.post(`/api/meetings/${m.id}/bot/dismiss`)).status).toBe(403);
    expect((await s.post(`/api/meetings/${m.id}/bot/dismiss`)).status).toBe(200);
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'done' });
    expect(await retiringCount()).toBe(0);
  });

  it('End call after a lost booking reply waits until the bot it finds is actually removed', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    stubMode.dropCreate = true;
    await dispatchDue(at('2026-11-10T15:00:30Z'));
    stubMode.dropCreate = false;
    const booked = `bot-${nextBot}`;
    const [m] = await calendarMeetings();
    const { mutateMeeting } = await import('../src/services/meetings.js');
    await mutateMeeting(m.id, (x) => {
      x.status = 'live';
      x.bot = { ...x.bot!, status: 'joining', uncertain: true };
    });
    const s = await steward('Steward Hal');
    // The lookup works, but Recall.ai won't remove the bot it finds.
    stubMode.failCancel = true;
    expect((await s.post(`/api/meetings/${m.id}/end`)).status).toBe(502);
    // The bot it found is now the record's bot, still being released.
    expect(await getMeeting(m.id)).toMatchObject({ status: 'live', bot: { leaving: true, phase: 'releasing', botId: booked } });
    expect(await retiringCount()).toBe(1);
    stubMode.failCancel = false;
    calls.length = 0;
    await dispatchDue(at('2026-11-10T15:05:00Z'));
    expect(calls).toContainEqual(expect.objectContaining({ method: 'POST', url: `/bot/${booked}/leave_call/` }));
    expect((await getMeeting(m.id)).bot?.status).toBe('done');
    expect(await retiringCount()).toBe(0);
  });

  it('an imported cancellation counts a bot it found but couldn’t remove as still being retried', async () => {
    const start = new Date(Date.now() + 10 * 60_000);
    const one = (status?: string) => calendar(oneOff({ uid: 'found-not-removed', start: start.toISOString(), end: new Date(start.getTime() + 3600e3).toISOString(), status }));
    const s = await steward('Steward Ike');
    stubMode.dropCreate = true;
    await s.post('/api/ontologies/volunteering/meetings/calendar').send({ ics: one() });
    stubMode.dropCreate = false;
    const [m] = await calendarMeetings();
    expect((await getMeeting(m.id)).bot).toMatchObject({ uncertain: true });
    stubMode.failCancel = true;
    const res = await s.post('/api/ontologies/volunteering/meetings/calendar').send({ ics: one('CANCELLED') });
    expect(res.body).toMatchObject({ cancelled: 0, cancelRetrying: 1 });
  });

  it('a booking reply that arrives after End call doesn’t undo it', async () => {
    const s = await steward('Steward Jo');
    stubMode.botDelayMs = 250;
    const req = s.post('/api/ontologies/volunteering/meetings/bot').send({ title: 'Ended before the reply', meetingUrl: 'https://meet.google.com/abc-defg-hij' }).then((r) => r);
    await new Promise((r) => setTimeout(r, 60));
    const m = (await list<Meeting>('meetings')).find((x) => x.title === 'Ended before the reply')!;
    const booked = `bot-${nextBot}`;
    await line(m.id, 'We’re done already.', booked);
    expect((await s.post(`/api/meetings/${m.id}/end`)).status).toBe(200);
    expect((await getMeeting(m.id)).bot?.status).toBe('done');
    await req;
    expect((await getMeeting(m.id)).bot).toMatchObject({ botId: booked, status: 'done' });
    await line(m.id, 'A late line.', booked);
    expect((await getMeeting(m.id)).transcript.map((l) => l.text)).toEqual(['We’re done already.']);
  });

  it('stale lines don’t each send a cancellation, and failing cancellations back off', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    const [m] = await calendarMeetings();
    const old = (await getMeeting(m.id)).bot!.botId!;
    const s = await steward('Steward Kit');
    stubMode.failCancel = true;
    await s.patch(`/api/meetings/${m.id}`).send({ skip: true });
    calls.length = 0;
    for (let i = 0; i < 30; i++) await line(m.id, `Stale ${i}`, old);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
    // Two sweeps at once ask once.
    await Promise.all([dispatchDue(at('2026-11-10T14:47:00Z')), dispatchDue(at('2026-11-10T14:47:00Z'))]);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    // Then the gaps grow: 1, 2, 4 minutes...
    const deletesBy = async (iso: string) => {
      await dispatchDue(at(iso));
      return calls.filter((c) => c.method === 'DELETE').length;
    };
    expect(await deletesBy('2026-11-10T14:48:00Z')).toBe(2);
    expect(await deletesBy('2026-11-10T14:49:00Z')).toBe(2);
    expect(await deletesBy('2026-11-10T14:50:00Z')).toBe(3);
    expect(await deletesBy('2026-11-10T14:52:00Z')).toBe(3);
    expect(await deletesBy('2026-11-10T14:54:00Z')).toBe(4);
    stubMode.failCancel = false;
  });

  it('a stalled cancellation doesn’t hold up booking another call', async () => {
    writeFeed(oneOff({ uid: 'due', start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }), oneOff({ uid: 'other', start: '2026-11-10T14:30:00Z', end: '2026-11-10T14:40:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    await dispatchDue(at('2026-11-10T14:16:00Z'));
    const m = (await calendarMeetings()).find((x) => x.calendar!.uid === 'due')!;
    const other = (await calendarMeetings()).find((x) => x.calendar!.uid === 'other')!;
    expect((await getMeeting(other.id)).bot?.botId).toBeTruthy();
    // The other call is skipped, and Recall.ai takes its time cancelling that bot.
    await saveMeeting({ ...await getMeeting(other.id), calendar: { ...(await getMeeting(other.id)).calendar!, skip: true } });
    stubMode.cancelDelayMs = 1500;
    const t0 = Date.now();
    await meetBotTick(at('2026-11-10T14:20:00Z'));
    await meetBotTick(at('2026-11-10T14:46:00Z'));
    expect(Date.now() - t0).toBeLessThan(1000);
    while (!(await getMeeting(m.id)).bot?.botId && Date.now() - t0 < 1000) await new Promise((r) => setTimeout(r, 10));
    expect((await getMeeting(m.id)).bot?.botId).toBeTruthy();
    expect(Date.now() - t0).toBeLessThan(1000);
    await meetBotIdle();
    stubMode.cancelDelayMs = 0;
  });

  /* ----- Fixes from the sixth review ----- */

  it('End call that found the bot but couldn’t remove it keeps waiting for that bot, even if the listing then misses it', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    stubMode.dropCreate = true;
    await dispatchDue(at('2026-11-10T15:00:30Z'));
    stubMode.dropCreate = false;
    const booked = `bot-${nextBot}`;
    const [m] = await calendarMeetings();
    const { mutateMeeting } = await import('../src/services/meetings.js');
    await mutateMeeting(m.id, (x) => {
      x.status = 'live';
      x.bot = { ...x.bot!, status: 'joining', uncertain: true };
    });
    const s = await steward('Steward Mo');
    stubMode.failCancel = true;
    expect((await s.post(`/api/meetings/${m.id}/end`)).status).toBe(502);
    // The bot it found is now the one this call waits for.
    expect((await getMeeting(m.id)).bot).toMatchObject({ botId: booked, leaving: true });
    stubMode.listHides = true;
    expect((await s.post(`/api/meetings/${m.id}/end`)).status).toBe(502);
    expect((await getMeeting(m.id)).status).toBe('live');
    stubMode.failCancel = false;
    expect((await s.post(`/api/meetings/${m.id}/end`)).status).toBe(200);
    expect((await getMeeting(m.id)).bot?.status).toBe('done');
    expect(await retiringCount()).toBe(0);
  });

  it('automatic End call retries back off and never overlap', async () => {
    const m = await liveCall();
    const s = await steward('Steward Nia');
    stubMode.failCancel = true;
    calls.length = 0;
    expect((await s.post(`/api/meetings/${m.id}/end`)).status).toBe(502);
    const leaves = () => calls.filter((c) => c.url === `/bot/${m.bot!.botId}/leave_call/`).length;
    expect(leaves()).toBe(1);
    // Two sweeps (each with the clock's End retry) at the same moment send one request between them.
    await Promise.all([dispatchDue(at('2026-11-10T15:00:30Z')), dispatchDue(at('2026-11-10T15:00:30Z'))]);
    expect(leaves()).toBe(2);
    const by = async (iso: string) => {
      await dispatchDue(at(iso));
      return leaves();
    };
    // Then 1, 2, 4 minutes apart.
    expect(await by('2026-11-10T15:01:00Z')).toBe(2);
    expect(await by('2026-11-10T15:02:00Z')).toBe(3);
    expect(await by('2026-11-10T15:03:00Z')).toBe(3);
    expect(await by('2026-11-10T15:04:00Z')).toBe(4);
    expect(await by('2026-11-10T15:06:00Z')).toBe(4);
    expect(await by('2026-11-10T15:08:00Z')).toBe(5);
    stubMode.failCancel = false;
    await by('2026-11-10T15:24:00Z');
    expect((await getMeeting(m.id)).bot?.status).toBe('done');
  });

  it('a bot that has already finished counts as gone even though Recall.ai refuses to cancel it', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    const [m] = await calendarMeetings();
    const botId = (await getMeeting(m.id)).bot!.botId!;
    bots.get(botId)!.status_changes.push({ code: 'done' });
    // Recall.ai refuses DELETE and leave for a finished bot.
    stubMode.failCancel = true;
    const s = await steward('Steward Fin');
    await s.patch(`/api/meetings/${m.id}`).send({ skip: true });
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'idle', released: [botId] });
    expect(await retiringCount()).toBe(0);
  });

  it('Recall.ai errors that echo the Meet link are scrubbed, and only facilitators see bot errors at all', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    stubMode.rejectCreate = true;
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    const [m] = await calendarMeetings();
    const err = (await getMeeting(m.id)).bot!.error!;
    expect(err).toMatch(/Recall.ai returned 400/);
    expect(err).not.toContain('meet.google.com');
    expect(err).not.toContain('xyz-abcd-efg');
    const contributor = request.agent(app);
    await contributor.post('/api/auth/demo').send({ name: 'Contributor Oz', role: 'reviewer' });
    const detail = await contributor.get(`/api/meetings/${m.id}`);
    const listed = await contributor.get(`/api/ontologies/${m.ontologyId}/meetings`);
    for (const body of [detail.text, listed.text]) {
      expect(body).not.toContain('meet.google.com');
      expect(body).not.toContain('Recall.ai returned');
    }
    expect(detail.body.bot.error).toMatch(/facilitator can see the details/);
  });

  it('cancelling found in a calendar sync runs beside the bookings, not before them', async () => {
    writeFeed(
      oneOff({ uid: 'goes', start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }),
      oneOff({ uid: 'stays', meet: 'https://meet.google.com/sta-ysxx-put', start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }),
    );
    await sync(at('2026-11-10T14:00:00Z'));
    const byUid = async (uid: string) => (await calendarMeetings()).find((x) => x.calendar!.uid === uid)!;
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    const goes = (await getMeeting((await byUid('goes')).id)).bot!.botId!;
    // 'stays' loses its booking (as if it hadn't booked yet), and 'goes' is cancelled slowly.
    const { mutateMeeting } = await import('../src/services/meetings.js');
    await mutateMeeting((await byUid('stays')).id, (x) => {
      x.bot = { provider: 'recall', status: 'scheduled' };
    });
    writeFeed(oneOff({ uid: 'stays', meet: 'https://meet.google.com/sta-ysxx-put', start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    stubMode.cancelDelayMs = 1500;
    const t0 = Date.now();
    await syncNow(at('2026-11-10T14:47:00Z'));
    await dispatchDue(at('2026-11-10T14:47:00Z'));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect((await getMeeting((await byUid('stays')).id)).bot?.botId).toBeTruthy();
    await meetBotIdle();
    stubMode.cancelDelayMs = 0;
    expect(calls).toContainEqual(expect.objectContaining({ method: 'DELETE', url: `/bot/${goes}/` }));
  });

  it('an imported cancellation counts a booking it is still looking for as still being retried', async () => {
    const start = new Date(Date.now() + 10 * 60_000);
    const one = (status?: string) => calendar(oneOff({ uid: 'still-looking', start: start.toISOString(), end: new Date(start.getTime() + 3600e3).toISOString(), status }));
    const s = await steward('Steward Pat');
    stubMode.dropCreate = true;
    await s.post('/api/ontologies/volunteering/meetings/calendar').send({ ics: one() });
    stubMode.dropCreate = false;
    stubMode.listHides = true;
    stubMode.failCreate = true;
    const res = await s.post('/api/ontologies/volunteering/meetings/calendar').send({ ics: one('CANCELLED') });
    expect(res.body).toMatchObject({ cancelled: 0, cancelRetrying: 1 });
    expect((await s.get('/api/meet-bot')).body.cancelling).toBe(1);
  });

  /* ----- Fixes from the seventh review ----- */

  /** A call at 15:00 whose booking reply was lost at 14:46. */
  const lostBooking = async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    stubMode.dropCreate = true;
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    stubMode.dropCreate = false;
    const [m] = await calendarMeetings();
    return { m, lost: `bot-${nextBot}`, bookingId: (await getMeeting(m.id)).bot!.bookingId! };
  };

  it('every booking caps how long its bot can live, which bounds how long a lost booking is looked for', async () => {
    await lostBooking();
    const post = calls.find((c) => c.method === 'POST' && c.url === '/bot/')!;
    expect((post.body as { automatic_leave: Record<string, number> }).automatic_leave).toMatchObject({ waiting_room_timeout: 1200, noone_joined_timeout: 1200, in_call_recording_timeout: 21600 });
  });

  it('a replay answered with 409 keeps the booking unconfirmed instead of making a new one', async () => {
    const { m, lost, bookingId } = await lostBooking();
    stubMode.listHides = true;
    stubMode.conflictReplay = true;
    await dispatchDue(at('2026-11-10T14:47:00Z'));
    expect((await getMeeting(m.id)).bot).toMatchObject({ uncertain: true, bookingId });
    stubMode.conflictReplay = false;
    await dispatchDue(at('2026-11-10T14:48:00Z'));
    expect((await getMeeting(m.id)).bot).toMatchObject({ botId: lost, bookingId });
    expect(`bot-${nextBot}`).toBe(lost);
  });

  it('once the idempotency key has expired, the booking is only looked up: never sent again, and no second bot is booked', async () => {
    const { m, lost, bookingId } = await lostBooking();
    // Recall.ai can't be asked until it has forgotten the key.
    stubMode.failList = true;
    stubMode.failCreate = true;
    await dispatchDue(at('2026-11-10T15:00:00Z'));
    stubMode.failList = false;
    stubMode.failCreate = false;
    stubMode.listHides = true;
    stubMode.keysExpired = true;
    calls.length = 0;
    await dispatchDue(at('2026-11-10T15:40:00Z'));
    await dispatchDue(at('2026-11-10T15:43:00Z'));
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/bot/')).toEqual([]);
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'booking', bookingId, uncertain: true, unconfirmed: true });
    // When it turns up, it is the call's bot: nothing cancelled, nothing new booked.
    stubMode.listHides = false;
    await dispatchDue(at('2026-11-10T15:50:00Z'));
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'booked', botId: lost, bookingId });
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/bot/')).toEqual([]);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(`bot-${nextBot}`).toBe(lost);
    stubMode.keysExpired = false;
  });

  it('End call that can’t ask Recall.ai hands the lookup to the ledger, which backs off', async () => {
    const { m } = await lostBooking();
    const { mutateMeeting } = await import('../src/services/meetings.js');
    await mutateMeeting(m.id, (x) => {
      x.status = 'live';
      x.bot = { ...x.bot!, status: 'joining', uncertain: true };
    });
    const s = await steward('Steward Rae');
    stubMode.failList = true;
    stubMode.failCreate = true;
    expect((await s.post(`/api/meetings/${m.id}/end`)).status).toBe(502);
    expect(await retiringCount()).toBe(1);
    calls.length = 0;
    const lookups = async (iso: string) => {
      await dispatchDue(at(iso));
      return calls.filter((c) => c.method === 'GET' && c.url.startsWith('/bot/?')).length;
    };
    expect(await lookups('2026-11-10T15:01:00Z')).toBe(1);
    expect(await lookups('2026-11-10T15:02:00Z')).toBe(2);
    expect(await lookups('2026-11-10T15:03:00Z')).toBe(2);
    expect(await lookups('2026-11-10T15:04:00Z')).toBe(3);
    expect(await lookups('2026-11-10T15:05:00Z')).toBe(3);
    stubMode.failList = false;
    stubMode.failCreate = false;
    await dispatchDue(at('2026-11-10T15:08:00Z'));
    expect((await getMeeting(m.id)).bot?.status).toBe('done');
    expect(await retiringCount()).toBe(0);
  });

  it('taking a bot out of a cancelled live call doesn’t hold up booking another call', async () => {
    const m = await liveCall();
    writeFeed(
      oneOff({ uid: 'live-1', start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }),
      oneOff({ uid: 'next', meet: 'https://meet.google.com/nex-tcal-lxx', start: '2026-11-10T15:10:00Z', end: '2026-11-10T16:00:00Z' }),
    );
    await sync(at('2026-11-10T14:58:00Z'));
    const next = (await calendarMeetings()).find((x) => x.calendar!.uid === 'next')!;
    // The live call is cancelled, and Recall.ai is slow to take its bot out.
    writeFeed(oneOff({ uid: 'next', meet: 'https://meet.google.com/nex-tcal-lxx', start: '2026-11-10T15:10:00Z', end: '2026-11-10T16:00:00Z' }));
    stubMode.leaveDelayMs = 1500;
    const t0 = Date.now();
    await syncNow(at('2026-11-10T15:00:00Z'));
    await dispatchDue(at('2026-11-10T15:00:00Z'));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect((await getMeeting(next.id)).bot?.botId).toBeTruthy();
    await meetBotIdle();
    stubMode.leaveDelayMs = 0;
    expect((await getMeeting(m.id)).bot?.status).toBe('done');
  });

  it('an imported cancellation of a live call whose booking is still being looked for counts as still retrying', async () => {
    const start = new Date(Date.now() - 5 * 60_000);
    const one = (status?: string) => calendar(oneOff({ uid: 'live-looking', start: start.toISOString(), end: new Date(start.getTime() + 3600e3).toISOString(), status }));
    const s = await steward('Steward Sky');
    stubMode.dropCreate = true;
    await s.post('/api/ontologies/volunteering/meetings/calendar').send({ ics: one() });
    stubMode.dropCreate = false;
    const [m] = await calendarMeetings();
    const { mutateMeeting } = await import('../src/services/meetings.js');
    await mutateMeeting(m.id, (x) => {
      x.status = 'live';
      x.bot = { ...x.bot!, status: 'joining', uncertain: true };
    });
    stubMode.listHides = true;
    stubMode.failCreate = true;
    const res = await s.post('/api/ontologies/volunteering/meetings/calendar').send({ ics: one('CANCELLED') });
    expect(res.body).toMatchObject({ cancelled: 0, cancelRetrying: 1 });
  });

  it('a known bot that keeps refusing is retried every 30 minutes, however long it has been', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T06:00:00Z'));
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    const [m] = await calendarMeetings();
    stubMode.failCancel = true;
    const s = await steward('Steward Stu');
    await s.patch(`/api/meetings/${m.id}`).send({ skip: true });
    const { mutateMeeting } = await import('../src/services/meetings.js');
    await mutateMeeting(m.id, (x) => {
      x.bot = { ...x.bot!, attempts: 40, bookedAt: '2026-11-01T00:00:00.000Z' };
    });
    const now = at('2026-11-10T15:00:00Z');
    await dispatchDue(now);
    expect((await getMeeting(m.id)).bot!.nextAt! - now.getTime()).toBe(30 * 60_000);
    stubMode.failCancel = false;
  });

  it('a garbled booking reply doesn’t carry the Meet code into the error', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    stubMode.garbledCreate = true;
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    stubMode.garbledCreate = false;
    const [m] = await calendarMeetings();
    expect((await getMeeting(m.id)).bot).toMatchObject({ uncertain: true });
    expect((await getMeeting(m.id)).bot!.error).not.toContain('xyz-abcd-efg');
  });

  it('withdrawn calls leave no webhook secrets behind', async () => {
    writeFeed(
      oneOff({ uid: 'w1', start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }),
      oneOff({ uid: 'w2', meet: 'https://meet.google.com/www-twoo-xyz', start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }),
    );
    await sync(at('2026-11-10T14:00:00Z'));
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    const ids = (await calendarMeetings()).map((x) => x.id);
    const kv = await list<{ id: string }>('kv');
    expect(ids.every((id) => kv.some((k) => k.id === `meeting-secret:${id}`))).toBe(true);
    writeFeed();
    await syncCalendar(at('2026-11-10T14:48:00Z'));
    expect((await list<{ id: string }>('kv')).filter((k) => ids.some((id) => k.id === `meeting-secret:${id}`))).toEqual([]);
  });

  it('a line that doesn’t say which booking it belongs to isn’t taken for the current one', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    stubMode.dropCreate = true;
    await dispatchDue(at('2026-11-10T14:58:00Z'));
    stubMode.dropCreate = false;
    const booked = `bot-${nextBot}`;
    const [m] = await calendarMeetings();
    // A bot with no booking metadata (an older booking, say) is refused...
    await recallWebhook(m.id, await secretOf(m.id), { event: 'transcript.data', data: { bot: { id: 'bot-unknown' }, data: { participant: { name: 'X' }, words: [{ text: 'Who am I?' }] } } });
    expect((await getMeeting(m.id)).bot?.botId).toBeUndefined();
    expect((await getMeeting(m.id)).transcript).toEqual([]);
    // ...and the bot of this booking is still recognised.
    await line(m.id, 'This booking’s bot.', booked);
    expect((await getMeeting(m.id)).bot).toMatchObject({ botId: booked, status: 'in-call' });
  });

  /* ----- Eighth review: one state machine per meeting ----- */

  const joinNow = async (title: string) => {
    const s = await steward(`Steward ${title}`);
    const res = await s.post('/api/ontologies/volunteering/meetings/bot').send({ title, meetingUrl: 'https://meet.google.com/abc-defg-hij' });
    return { s, res, m: (await list<Meeting>('meetings')).find((x) => x.title === title)! };
  };
  const bookings = () => calls.filter((c) => c.method === 'POST' && c.url === '/bot/');

  it('8.1: a lost booking is never followed by a second one, at 50 or 61 minutes, even when Recall.ai forgets the key', async () => {
    const { m, lost, bookingId } = await lostBooking();
    // Recall.ai never lists it, refuses to cancel anything, and (past the hour) has forgotten the key.
    stubMode.listHides = true;
    stubMode.failCancel = true;
    stubMode.keysExpired = true;
    calls.length = 0;
    for (const t of ['2026-11-10T15:36:00Z', '2026-11-10T15:47:00Z', '2026-11-10T15:58:00Z']) await dispatchDue(at(t));
    expect(bookings()).toEqual([]);
    expect(`bot-${nextBot}`).toBe(lost);
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'booking', bookingId, unconfirmed: true });
    // Its first words name it: it becomes the call's bot, and still no second one is booked.
    await line(m.id, 'Hello, can everyone hear me?', lost);
    expect(await getMeeting(m.id)).toMatchObject({ status: 'live', bot: { phase: 'booked', botId: lost, status: 'in-call' } });
    await dispatchDue(at('2026-11-10T15:59:00Z'));
    expect(bookings()).toEqual([]);
    Object.assign(stubMode, { listHides: false, failCancel: false, keysExpired: false });
  });

  it('8.2: End call whose lookup comes back empty doesn’t say the call ended, or analyse it, while the bot may still be there', async () => {
    const { m, res } = await (async () => {
      stubMode.dropCreate = true;
      const r = await joinNow('Empty lookup');
      stubMode.dropCreate = false;
      return r;
    })();
    expect(res.status).toBe(201);
    const lost = `bot-${nextBot}`;
    await line(m.id, 'Said while the booking was unconfirmed.');
    const s = await steward('Steward Empty');
    stubMode.listHides = true;
    stubMode.failCreate = true;
    expect((await s.post(`/api/meetings/${m.id}/end`)).status).toBe(502);
    expect(await getMeeting(m.id)).toMatchObject({ status: 'live', bot: { phase: 'releasing', leaving: true, uncertain: true } });
    expect((await s.post(`/api/meetings/${m.id}/analyse`)).status).toBe(409);
    // The clock keeps at it; nothing is marked done until the bot is found and removed.
    await dispatchDue(new Date(Date.now() + 2 * 60_000));
    expect((await getMeeting(m.id)).status).toBe('live');
    stubMode.listHides = false;
    stubMode.failCreate = false;
    await dispatchDue(new Date(Date.now() + 5 * 60_000));
    await meetBotIdle();
    expect(calls.some((c) => c.method !== 'GET' && c.url.startsWith(`/bot/${lost}/`))).toBe(true);
    expect(await getMeeting(m.id)).toMatchObject({ status: 'analysed', bot: { phase: 'done' } });
  });

  it('8.3: a withdrawn call whose booking never turns up is kept (hidden) and looked for, not deleted after a week', async () => {
    const { m, lost } = await lostBooking();
    stubMode.listHides = true;
    stubMode.failCreate = true;
    writeFeed();
    await sync(at('2026-11-10T14:50:00Z'));
    for (const days of [1, 7, 8, 30]) await dispatchDue(new Date(at('2026-11-10T14:50:00Z').getTime() + days * 24 * 3600e3));
    expect((await withdrawnMeetings()).map((x) => x.id)).toEqual([m.id]);
    const contributor = request.agent(app);
    await contributor.post('/api/auth/demo').send({ name: 'Contributor Wren', role: 'contributor' });
    expect((await contributor.get(`/api/meetings/${m.id}`)).status).toBe(404);
    // It turns up a month later: cancelled, and only then is the call deleted.
    stubMode.listHides = false;
    stubMode.failCreate = false;
    await dispatchDue(new Date(at('2026-11-10T14:50:00Z').getTime() + 31 * 24 * 3600e3));
    expect(calls).toContainEqual(expect.objectContaining({ method: 'DELETE', url: `/bot/${lost}/` }));
    expect((await list<Meeting>('meetings')).some((x) => x.id === m.id)).toBe(false);
  });

  it('8.4: a clock tick during End’s first lookup doesn’t finish the call', async () => {
    const { m } = await lostBooking();
    const { mutateMeeting } = await import('../src/services/meetings.js');
    await mutateMeeting(m.id, (x) => {
      x.status = 'live';
    });
    await line(m.id, 'Heard before End.');
    const s = await steward('Steward Tick');
    // A slow, failing lookup, and Recall.ai won't take bookings either.
    stubMode.failList = true;
    stubMode.listDelayMs = 300;
    stubMode.failCreate = true;
    const ending = s.post(`/api/meetings/${m.id}/end`).then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    await dispatchDue(at('2026-11-10T15:01:00Z'));
    await meetBotTick(at('2026-11-10T15:02:00Z'));
    expect(await getMeeting(m.id)).toMatchObject({ status: 'live', bot: { phase: 'releasing', leaving: true } });
    expect((await ending).status).toBe(502);
    await meetBotIdle();
    expect(await getMeeting(m.id)).toMatchObject({ status: 'live', bot: { phase: 'releasing', leaving: true } });
    Object.assign(stubMode, { failList: false, listDelayMs: 0, failCreate: false });
  });

  it('8.5: a bot named by a late line while End is still looking keeps its booking, and the call waits for that bot', async () => {
    const { m, lost, bookingId } = await lostBooking();
    const { mutateMeeting } = await import('../src/services/meetings.js');
    await mutateMeeting(m.id, (x) => {
      x.status = 'live';
    });
    const s = await steward('Steward Late');
    stubMode.failList = true;
    stubMode.failCreate = true;
    expect((await s.post(`/api/meetings/${m.id}/end`)).status).toBe(502);
    // The bot speaks: the line is refused, but it names the bot of this booking, which the release now targets.
    stubMode.failCancel = true;
    await line(m.id, 'Is anyone still here?', lost);
    await meetBotIdle();
    expect(await getMeeting(m.id)).toMatchObject({ transcript: [], bot: { phase: 'releasing', botId: lost, bookingId, leaving: true } });
    // Removing it keeps failing: the call is never marked done meanwhile.
    stubMode.failList = false;
    stubMode.failCreate = false;
    for (const t of ['2026-11-10T15:01:00Z', '2026-11-10T15:03:00Z', '2026-11-10T15:10:00Z']) await dispatchDue(at(t));
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'releasing', botId: lost });
    stubMode.failCancel = false;
    await dispatchDue(at('2026-11-10T15:30:00Z'));
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'done', botId: lost });
  });

  it('8.6: “Join a call now” keeps the booking’s time through a lost reply, so it is sent again under its key, never as a second bot', async () => {
    stubMode.dropCreate = true;
    const { m, s } = await joinNow('Keeps booking time');
    stubMode.dropCreate = false;
    const first = (await getMeeting(m.id)).bot!;
    const lost = `bot-${nextBot}`;
    expect(first).toMatchObject({ phase: 'booking', bookedAt: expect.any(String), bookingId: expect.stringMatching(/^bk_/) });
    stubMode.listHides = true;
    // The clock's first tick, well inside the key's hour: the same booking goes again, and Recall.ai answers with the bot it made.
    await dispatchDue(new Date(Date.now() + 60_000));
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'booked', botId: lost, bookingId: first.bookingId, bookedAt: first.bookedAt });
    expect(`bot-${nextBot}`).toBe(lost);
    // This call's bookings only: the clock also retries other tests' unanswered bookings, depending on which tests ran first.
    const mine = bookings().filter((c) => (c.body.metadata as { concord_meeting: string }).concord_meeting === m.id);
    expect(new Set(mine.map((c) => (c.body.metadata as { concord_booking: string }).concord_booking))).toEqual(new Set([first.bookingId]));
    void s;
  });

  it('8.7: End call only finishes the bot it was asked to remove; skipping and unskipping meanwhile books no replacement', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    const [m] = await calendarMeetings();
    const first = (await getMeeting(m.id)).bot!.botId!;
    const { mutateMeeting } = await import('../src/services/meetings.js');
    await mutateMeeting(m.id, (x) => {
      x.status = 'live';
    });
    const s = await steward('Steward Swap');
    stubMode.leaveDelayMs = 400;
    const ending = s.post(`/api/meetings/${m.id}/end`).then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    // Meanwhile the call is skipped and unskipped (refused: it's live), and the clock runs.
    await s.patch(`/api/meetings/${m.id}`).send({ skip: true });
    await s.patch(`/api/meetings/${m.id}`).send({ skip: false });
    await dispatchDue(at('2026-11-10T14:47:00Z'));
    expect((await ending).status).toBe(200);
    await dispatchDue(at('2026-11-10T14:48:00Z'));
    expect(bookings()).toHaveLength(1);
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'done', botId: first });
    stubMode.leaveDelayMs = 0;
  });

  it('8.8: a booking answered with JSON null stays unconfirmed, and is settled without a second bot', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    stubMode.nullCreate = true;
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    stubMode.nullCreate = false;
    const made = `bot-${nextBot}`;
    const [m] = await calendarMeetings();
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'booking', uncertain: true, error: expect.stringMatching(/no bot id/) });
    await dispatchDue(at('2026-11-10T14:47:00Z'));
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'booked', botId: made });
    expect(`bot-${nextBot}`).toBe(made);
  });

  it('8.9: a call ending by itself takes its bot out beside the other calls, not before them', async () => {
    writeFeed(
      oneOff({ uid: 'ending', start: '2026-11-10T14:00:00Z', end: '2026-11-10T15:00:00Z' }),
      oneOff({ uid: 'next', meet: 'https://meet.google.com/nex-tcal-lxx', start: '2026-11-10T15:25:00Z', end: '2026-11-10T16:00:00Z' }),
    );
    await sync(at('2026-11-10T13:30:00Z'));
    await dispatchDue(at('2026-11-10T13:50:00Z'));
    await dispatchDue(at('2026-11-10T14:00:00Z'));
    const ending = (await calendarMeetings()).find((x) => x.calendar!.uid === 'ending')!;
    const next = (await calendarMeetings()).find((x) => x.calendar!.uid === 'next')!;
    expect((await getMeeting(ending.id)).status).toBe('live');
    // Past its slot and quiet; Recall.ai is slow to take the bot out. The next call is due at the same tick.
    stubMode.leaveDelayMs = 1500;
    const t0 = Date.now();
    await meetBotTick(at('2026-11-10T15:11:00Z'));
    while (!(await getMeeting(next.id)).bot?.botId && Date.now() - t0 < 1000) await new Promise((r) => setTimeout(r, 10));
    expect((await getMeeting(next.id)).bot?.botId).toBeTruthy();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect((await getMeeting(ending.id)).bot).toMatchObject({ phase: 'releasing', leaving: true });
    await meetBotIdle();
    stubMode.leaveDelayMs = 0;
    expect((await getMeeting(ending.id)).bot).toMatchObject({ phase: 'done' });
  });

  it('a line from a bot of this call that isn’t its bot gets that bot cancelled once, and is never heard', async () => {
    const m = await liveCall();
    calls.length = 0;
    for (let i = 0; i < 5; i++) await line(m.id, `Interloper ${i}`, 'bot-999');
    await meetBotIdle();
    expect((await getMeeting(m.id)).transcript.map((l) => l.text)).toEqual(['Hello everyone.']);
    expect(calls.filter((c) => c.method === 'DELETE' && c.url === '/bot/bot-999/')).toHaveLength(1);
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'booked', botId: m.bot!.botId, released: ['bot-999'] });
  });

  it('a line that names another booking, with no bot id, is never heard as the call’s bot', async () => {
    // Used to be heard: a line without a bot id skipped the identity check altogether.
    const m = await liveCall();
    await recallWebhook(m.id, await secretOf(m.id), {
      event: 'transcript.data',
      data: { bot: { metadata: { concord_booking: 'some-other-booking' } }, data: { participant: { name: 'Aisha Rahman' }, words: [{ text: 'Not from this booking.' }] } },
    });
    await meetBotIdle();
    expect((await getMeeting(m.id)).transcript.map((l) => l.text)).toEqual(['Hello everyone.']);
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'booked', botId: m.bot!.botId, bookingId: m.bot!.bookingId });
  });

  /* ----- Fixes from the ninth review ----- */

  it('9.1: a lost booking whose lookup and replay are refused for authentication stays unconfirmed, so End doesn’t finish the call', async () => {
    // Used to count any 4xx as "no bot was made", so a disabled API key let End mark the call done and analyse it.
    stubMode.dropCreate = true;
    const { m, s } = await joinNow('Auth refused');
    stubMode.dropCreate = false;
    const lost = `bot-${nextBot}`;
    await line(m.id, 'Said while the booking was unconfirmed.');
    stubMode.authFail = true;
    const res = await s.post(`/api/meetings/${m.id}/end`);
    expect(res.status).toBe(502);
    expect(await getMeeting(m.id)).toMatchObject({ status: 'live', bot: { phase: 'releasing', uncertain: true } });
    expect((await s.post(`/api/meetings/${m.id}/analyse`)).status).toBe(409);
    await dispatchDue(new Date(Date.now() + 5 * 60_000));
    expect((await getMeeting(m.id)).status).toBe('live');
    // With the key working again, the bot is found and taken out, and only then is the call analysed.
    stubMode.authFail = false;
    await dispatchDue(new Date(Date.now() + 40 * 60_000));
    await meetBotIdle();
    expect(calls.some((c) => c.method !== 'GET' && c.url.startsWith(`/bot/${lost}/`))).toBe(true);
    expect(await getMeeting(m.id)).toMatchObject({ status: 'analysed', bot: { phase: 'done', botId: lost } });
  });

  it('9.1: only a request Recall.ai read and rejected (400) counts as no bot; a first booking turned away for authentication stays unconfirmed', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    stubMode.authFail = true;
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    const [m] = await calendarMeetings();
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'booking', uncertain: true });
    stubMode.authFail = false;
    stubMode.rejectCreate = true;
    await dispatchDue(at('2026-11-10T14:48:00Z'));
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'idle' });
    expect((await getMeeting(m.id)).bot?.fault).toMatch(/400/);
  });

  it('9.2: a call taken off the calendar and put back while its bot can’t be cancelled stays one call with one bot', async () => {
    // Used to make a second record for the same occurrence, and book a second bot while the first was still in the call.
    const invite = () => oneOff({ uid: 'back-again', start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' });
    writeFeed(invite());
    await sync(at('2026-11-10T14:00:00Z'));
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    const [m] = await calendarMeetings();
    const first = (await getMeeting(m.id)).bot!.botId!;
    stubMode.failCancel = true;
    writeFeed();
    await sync(at('2026-11-10T14:47:00Z'));
    expect((await withdrawnMeetings()).map((x) => x.id)).toEqual([m.id]);
    writeFeed(invite());
    await sync(at('2026-11-10T14:48:00Z'));
    await dispatchDue(at('2026-11-10T14:48:00Z'));
    const held = (await list<Meeting>('meetings')).filter((x) => x.calendar?.uid === 'back-again');
    expect(held.map((x) => x.id)).toEqual([m.id]);
    expect(held[0].withdrawn).toBeFalsy();
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'releasing', botId: first });
    expect(bookings()).toHaveLength(1);
    // Once the old bot is confirmed gone, the call books its fresh one.
    stubMode.failCancel = false;
    await dispatchDue(at('2026-11-10T14:52:00Z'));
    await dispatchDue(at('2026-11-10T14:53:00Z'));
    const removed = calls.findIndex((c) => c.method === 'DELETE' && c.url === `/bot/${first}/`);
    const rebooked = calls.findIndex((c, i) => i > 0 && c.method === 'POST' && c.url === '/bot/' && calls.slice(0, i).some((p) => p.method === 'POST' && p.url === '/bot/'));
    expect(removed).toBeGreaterThan(-1);
    expect(rebooked).toBeGreaterThan(removed);
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'booked' });
    expect((await getMeeting(m.id)).bot!.botId).not.toBe(first);
  });

  it('9.3: End call waits for a bot that turned up uninvited and refuses to leave, and the call isn’t analysed meanwhile', async () => {
    // Used to say the call ended (and analyse it) while the stray bot was still recording.
    const m = await liveCall();
    bots.set('bot-777', { id: 'bot-777', meeting_url: m.meetingUrl!, status_changes: [{ code: 'in_call_recording' }] });
    stubMode.refuseIds = ['bot-777'];
    await line(m.id, 'Someone else’s bot.', 'bot-777');
    await meetBotIdle();
    expect((await getMeeting(m.id)).bot!.strays).toEqual(['bot-777']);
    const s = await steward('Steward Stray');
    expect((await s.post(`/api/meetings/${m.id}/end`)).status).toBe(502);
    expect(await getMeeting(m.id)).toMatchObject({ status: 'live', bot: { phase: 'done', strays: ['bot-777'] } });
    expect((await s.post(`/api/meetings/${m.id}/analyse`)).status).toBe(409);
    stubMode.refuseIds = [];
    await dispatchDue(new Date(Date.now() + 40 * 60_000));
    await meetBotIdle();
    expect(await getMeeting(m.id)).toMatchObject({ status: 'analysed', bot: { phase: 'done' } });
    expect((await getMeeting(m.id)).bot!.strays).toBeUndefined();
  });

  it('9.3: a call doesn’t book its bot while another bot of its own still refuses to leave', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    const [m] = await calendarMeetings();
    bots.set('bot-778', { id: 'bot-778', meeting_url: m.meetingUrl!, status_changes: [{ code: 'in_call_recording' }] });
    stubMode.refuseIds = ['bot-778'];
    await put('kv', { id: `meeting-secret:${m.id}`, secret: 'early-secret' });
    await line(m.id, 'Before the call.', 'bot-778');
    await meetBotIdle();
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    expect(bookings()).toHaveLength(0);
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'idle', strays: ['bot-778'] });
    stubMode.refuseIds = [];
    await dispatchDue(at('2026-11-10T14:50:00Z'));
    await dispatchDue(at('2026-11-10T14:51:00Z'));
    expect(bookings()).toHaveLength(1);
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'booked' });
  });

  it('9.4: dismissing a withdrawn call’s unconfirmed booking keeps its record and webhook secret, so its bot is still caught and cancelled', async () => {
    // Used to delete the call and its secret at once: the bot's own lines were then refused, and nothing could find it again.
    const { m, lost } = await lostBooking();
    stubMode.listHides = true;
    stubMode.failCreate = true;
    writeFeed();
    await sync(at('2026-11-10T14:50:00Z'));
    await dispatchDue(at('2026-11-10T15:50:00Z'));
    const s = await steward('Steward Dismiss');
    expect((await s.post(`/api/meetings/${m.id}/bot/dismiss`)).status).toBe(200);
    // Gone for everyone, but kept, with its secret, while the booking is still looked for.
    expect((await s.get(`/api/meetings/${m.id}`)).status).toBe(404);
    expect((await list<Meeting>('meetings')).some((x) => x.id === m.id)).toBe(true);
    expect(await secretOf(m.id)).toBeTruthy();
    // The bot speaks up: it is cancelled.
    await line(m.id, 'Still here.', lost);
    await meetBotIdle();
    expect(calls).toContainEqual(expect.objectContaining({ method: 'DELETE', url: `/bot/${lost}/` }));
    expect((await getMeeting(m.id)).transcript).toHaveLength(0);
    // Once a lookup shows what the booking made has ended, the call (and its secret) go.
    stubMode.listHides = false;
    stubMode.failCreate = false;
    await dispatchDue(new Date(Date.now() + 7 * 3600e3));
    expect((await list<Meeting>('meetings')).some((x) => x.id === m.id)).toBe(false);
    expect((await list<{ id: string }>('kv')).some((k) => k.id === `meeting-secret:${m.id}`)).toBe(false);
  });

  it('9.4: a dismissed booking is still looked for, every six hours, and its bot cancelled when it turns up', async () => {
    const { m, lost } = await lostBooking();
    stubMode.listHides = true;
    stubMode.failCreate = true;
    await dispatchDue(at('2026-11-10T15:50:00Z'));
    const s = await steward('Steward Lookout');
    expect((await s.post(`/api/meetings/${m.id}/bot/dismiss`)).status).toBe(200);
    expect((await getMeeting(m.id)).bot!.dismissed).toHaveLength(1);
    const t = Date.now() + 24 * 3600e3;
    await dispatchDue(new Date(t));
    stubMode.listHides = false;
    calls.length = 0;
    await dispatchDue(new Date(t + 3600e3));
    expect(calls.filter((c) => c.method === 'GET' && c.url.startsWith('/bot/?'))).toHaveLength(0);
    await dispatchDue(new Date(t + 6 * 3600e3 + 60_000));
    await meetBotIdle();
    expect(calls).toContainEqual(expect.objectContaining({ method: 'DELETE', url: `/bot/${lost}/` }));
    expect((await getMeeting(m.id)).bot!.dismissed).toBeUndefined();
  });

  it('9.5: a bot first taken for a stray, then found to be the booking’s own, is adopted and never cancelled', async () => {
    // Used to stay in the strays list after adoption, so the call's own bot was cancelled.
    // The booking's reply carries no bot id (as good as lost).
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    stubMode.nullCreate = true;
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    stubMode.nullCreate = false;
    const [m] = await calendarMeetings();
    const lost = `bot-${nextBot}`;
    stubMode.failList = true;
    stubMode.failCreate = true;
    stubMode.failCancel = true;
    // Its line carries no booking metadata, so it can't be taken for the booking's bot yet.
    await recallWebhook(m.id, await secretOf(m.id), { event: 'transcript.data', data: { bot: { id: lost }, data: { participant: { name: 'Aisha Rahman' }, words: [{ text: 'No metadata.' }] } } });
    await meetBotIdle();
    await dispatchDue(at('2026-11-10T14:47:00Z'));
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'booking', strays: [lost] });
    stubMode.failList = false;
    // Backing off by now: the next lookup is at its next turn.
    await dispatchDue(at('2026-11-10T14:58:00Z'));
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'booked', botId: lost });
    const adoptedAt = calls.length;
    stubMode.failCancel = false;
    stubMode.failCreate = false;
    await dispatchDue(at('2026-11-10T15:10:00Z'));
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'booked', botId: lost });
    expect((await getMeeting(m.id)).bot!.strays).toBeUndefined();
    expect((await getMeeting(m.id)).bot!.released ?? []).not.toContain(lost);
    // Its cancellation as a stray was refused earlier; once adopted, nothing tries to remove it again.
    expect(calls.slice(adoptedAt).some((c) => (c.method === 'DELETE' || c.url.includes('leave_call')) && c.url.startsWith(`/bot/${lost}/`))).toBe(false);
    expect(bots.get(lost)!.status_changes.map((x) => x.code)).not.toContain('done');
    await line(m.id, 'Heard now.', lost);
    expect((await getMeeting(m.id)).transcript.map((l) => l.text)).toContain('Heard now.');
  });

  it('9.6: a booked record from before the state machine is read as booked, never replaced by a second booking', async () => {
    // Used to be overwritten with an idle record by the next sweep, which then booked another bot.
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    const [m] = await calendarMeetings();
    const b = (await getMeeting(m.id)).bot!;
    await saveMeeting({ ...await getMeeting(m.id), bot: { provider: 'recall', status: 'scheduled', botId: b.botId, bookingId: b.bookingId, bookedUrl: b.bookedUrl } });
    await dispatchDue(at('2026-11-10T14:47:00Z'));
    expect(bookings()).toHaveLength(1);
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'booked', botId: b.botId });
    // And cancelling the call cancels that bot.
    writeFeed();
    await sync(at('2026-11-10T14:48:00Z'));
    expect(calls).toContainEqual(expect.objectContaining({ method: 'DELETE', url: `/bot/${b.botId}/` }));
  });

  it('9.7: an imported cancellation waiting on Recall.ai doesn’t hold up the clock’s bookings for other calls', async () => {
    // Used to hold the calendar lock while cancelling, so the clock's sync (and the bookings after it) waited.
    const start = new Date(Date.now() + 10 * 60_000);
    const end = new Date(start.getTime() + 3600e3);
    const x = (status?: string) => calendar(oneOff({ uid: 'imported-x', meet: 'https://meet.google.com/imp-ortx-cal', start: start.toISOString(), end: end.toISOString(), status }));
    const s = await steward('Steward Lanes');
    await s.post('/api/ontologies/volunteering/meetings/calendar').send({ ics: x() });
    expect(bookings()).toHaveLength(1);
    writeFeed(oneOff({ uid: 'feed-b', meet: 'https://meet.google.com/fee-dbbb-cal', start: start.toISOString(), end: end.toISOString() }));
    await sync(new Date());
    stubMode.cancelDelayMs = 1500;
    const cancelling = s.post('/api/ontologies/volunteering/meetings/calendar').send({ ics: x('CANCELLED') }).then((r) => r);
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    await syncNow(new Date());
    await dispatchDue(new Date());
    expect(Date.now() - t0).toBeLessThan(1000);
    expect((await calendarMeetings()).find((mm) => mm.calendar!.uid === 'feed-b')!.bot!.botId).toBeTruthy();
    expect((await cancelling).body).toMatchObject({ cancelled: 1, cancelRetrying: 0 });
    stubMode.cancelDelayMs = 0;
  });

  it('9.8: importing the same cancellation again still counts a bot that is being cancelled as retrying', async () => {
    // Used to skip calls already releasing, so the second import said nothing was left to do.
    const start = new Date(Date.now() + 10 * 60_000);
    const one = (status?: string) => calendar(oneOff({ uid: 'twice-cancelled', start: start.toISOString(), end: new Date(start.getTime() + 3600e3).toISOString(), status }));
    const s = await steward('Steward Twice');
    await s.post('/api/ontologies/volunteering/meetings/calendar').send({ ics: one() });
    stubMode.failCancel = true;
    expect((await s.post('/api/ontologies/volunteering/meetings/calendar').send({ ics: one('CANCELLED') })).body).toMatchObject({ cancelled: 0, cancelRetrying: 1 });
    expect((await s.post('/api/ontologies/volunteering/meetings/calendar').send({ ics: one('CANCELLED') })).body).toMatchObject({ cancelled: 0, cancelRetrying: 1 });
    stubMode.failCancel = false;
    expect((await s.post('/api/ontologies/volunteering/meetings/calendar').send({ ics: one('CANCELLED') })).body).toMatchObject({ cancelled: 1, cancelRetrying: 0 });
  });

  it('8.7 (scheduled call): skipping and unskipping while the old bot is being cancelled books its replacement only after Recall.ai confirms', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    const [m] = await calendarMeetings();
    const first = (await getMeeting(m.id)).bot!.botId!;
    const s = await steward('Steward Toggle');
    stubMode.cancelDelayMs = 400;
    const skipping = s.patch(`/api/meetings/${m.id}`).send({ skip: true }).then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    const unskip = await s.patch(`/api/meetings/${m.id}`).send({ skip: false });
    expect(unskip.status).toBe(200);
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'releasing', botId: first });
    expect(bookings()).toHaveLength(1);
    expect((await skipping).status).toBe(200);
    await meetBotIdle();
    stubMode.cancelDelayMs = 0;
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'idle' });
    await dispatchDue(at('2026-11-10T14:47:00Z'));
    const removed = calls.findIndex((c) => c.method === 'DELETE' && c.url === `/bot/${first}/`);
    expect(bookings()).toHaveLength(2);
    expect(calls.indexOf(bookings()[1])).toBeGreaterThan(removed);
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'booked' });
    expect((await getMeeting(m.id)).bot!.botId).not.toBe(first);
  });

  it('8.7 (targeted): Recall.ai confirming one bot gone never settles a record that is now releasing another', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    const [m] = await calendarMeetings();
    const s = await steward('Steward Stale');
    stubMode.cancelDelayMs = 300;
    const skipping = s.patch(`/api/meetings/${m.id}`).send({ skip: true }).then((r) => r);
    await new Promise((r) => setTimeout(r, 100));
    // While the first bot's cancellation is in flight, the record comes to be releasing another bot.
    const { mutateMeeting } = await import('../src/services/meetings.js');
    await mutateMeeting(m.id, (x) => {
      x.bot = { ...x.bot!, botId: 'bot-other', gen: (x.bot!.gen ?? 0) + 1 };
    });
    await skipping;
    await meetBotIdle();
    stubMode.cancelDelayMs = 0;
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'releasing', botId: 'bot-other' });
  });

  /* ----- Fixes from the tenth review ----- */

  it('10.1: an old-format record that was leaving with an unanswered booking keeps leaving, and isn’t analysed first', async () => {
    // Used to read as a plain booking: found by lookup, it became booked, no removal was sent, and its lines were heard after End.
    stubMode.nullCreate = true;
    const { m, s } = await joinNow('Old leaving');
    stubMode.nullCreate = false;
    const lost = `bot-${nextBot}`;
    await line(m.id, 'Said before End.');
    const b = (await getMeeting(m.id)).bot!;
    await saveMeeting({ ...await getMeeting(m.id), bot: { provider: 'recall', status: 'scheduled', bookingId: b.bookingId, bookedUrl: b.bookedUrl, bookedAt: b.bookedAt, uncertain: true, leaving: true } });
    // Before any sweep has touched it, Analyse refuses.
    expect((await s.post(`/api/meetings/${m.id}/analyse`)).status).toBe(409);
    await dispatchDue(new Date(Date.now() + 2 * 60_000));
    await meetBotIdle();
    expect(calls.some((c) => c.method !== 'GET' && c.url.startsWith(`/bot/${lost}/`))).toBe(true);
    await line(m.id, 'Said after End.', lost);
    expect((await getMeeting(m.id)).transcript.map((l) => l.text)).not.toContain('Said after End.');
    expect(await getMeeting(m.id)).toMatchObject({ status: 'analysed', bot: { phase: 'done', botId: lost } });
  });

  it('10.2: a dismissed booking’s bot found while the next booking is backing off is cancelled straight away', async () => {
    // Used to be recorded as a stray but left alone until the other booking's retry came round.
    const { m, lost } = await lostBooking();
    stubMode.listHides = true;
    stubMode.failCreate = true;
    await dispatchDue(at('2026-11-10T15:50:00Z'));
    const s = await steward('Steward Backoff');
    expect((await s.post(`/api/meetings/${m.id}/bot/dismiss`)).status).toBe(200);
    // The call books again (Recall.ai is down), and that booking backs off for a long while.
    await dispatchDue(at('2026-11-10T15:51:00Z'));
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'booking' });
    // The dismissed booking's next lookup comes round at 15:53, with the new booking's retry not until 16:20.
    const lookAgain = at('2026-11-10T15:53:00Z').getTime();
    const { mutateMeeting } = await import('../src/services/meetings.js');
    await mutateMeeting(m.id, (x) => {
      x.bot = { ...x.bot!, dismissed: x.bot!.dismissed!.map((d) => ({ ...d, nextAt: lookAgain })), nextAt: lookAgain + 27 * 60_000 };
    });
    stubMode.listHides = false;
    calls.length = 0;
    await dispatchDue(new Date(lookAgain + 60_000));
    await meetBotIdle();
    expect(calls).toContainEqual(expect.objectContaining({ method: 'DELETE', url: `/bot/${lost}/` }));
    expect((await getMeeting(m.id)).bot!.strays).toBeUndefined();
    // The other booking's backoff is left as it was.
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/bot/')).toHaveLength(0);
  });

  it('10.3: however many bookings are dismissed, none stops being looked for before it is settled', async () => {
    // Used to keep only the last twenty, silently dropping the oldest bot that might still exist.
    const { m, lost, bookingId } = await lostBooking();
    stubMode.listHides = true;
    stubMode.failCreate = true;
    await dispatchDue(at('2026-11-10T15:50:00Z'));
    const s = await steward('Steward Many');
    expect((await s.post(`/api/meetings/${m.id}/bot/dismiss`)).status).toBe(200);
    const { mutateMeeting } = await import('../src/services/meetings.js');
    await mutateMeeting(m.id, (x) => {
      x.bot = { ...x.bot!, dismissed: [...x.bot!.dismissed!, ...Array.from({ length: 19 }, (_, i) => ({ bookingId: `bk-earlier-${i}`, url: x.meetingUrl! }))] };
    });
    // A twenty-first booking goes unconfirmed, and is dismissed too.
    await dispatchDue(at('2026-11-10T15:51:00Z'));
    await dispatchDue(at('2026-11-10T16:50:00Z'));
    expect((await getMeeting(m.id)).bot).toMatchObject({ unconfirmed: true });
    expect((await s.post(`/api/meetings/${m.id}/bot/dismiss`)).status).toBe(200);
    const dismissed = (await getMeeting(m.id)).bot!.dismissed!.map((d) => d.bookingId);
    expect(dismissed).toHaveLength(21);
    expect(dismissed[0]).toBe(bookingId);
    stubMode.listHides = false;
    await dispatchDue(new Date(Date.now() + 7 * 3600e3));
    await dispatchDue(new Date(Date.now() + 14 * 3600e3));
    await meetBotIdle();
    expect(calls).toContainEqual(expect.objectContaining({ method: 'DELETE', url: `/bot/${lost}/` }));
    expect((await getMeeting(m.id)).bot!.dismissed!.map((d) => d.bookingId)).not.toContain(bookingId);
  });

  /* ----- Fixes from the eleventh review ----- */

  it('11.1: a stray that refuses removal is retried on its own schedule, not after the booking’s six-hour wait', async () => {
    // Used to share the unanswered booking's backoff, so a refusal pushed the stray's next try six hours out.
    const { m } = await lostBooking();
    stubMode.listHides = true;
    stubMode.failCreate = true;
    const t0 = at('2026-11-10T14:46:00Z').getTime() + SLOW_LOOKUP_AFTER_MS;
    await dispatchDue(new Date(t0 + 60_000));
    await dispatchDue(new Date(t0 + 2 * 60_000));
    const bookingWait = (await getMeeting(m.id)).bot!.nextAt!;
    expect(bookingWait).toBe(t0 + 2 * 60_000 + 6 * 3600e3);
    bots.set('bot-781', { id: 'bot-781', meeting_url: m.meetingUrl!, status_changes: [{ code: 'in_call_recording' }] });
    stubMode.refuseIds = ['bot-781'];
    await line(m.id, 'An uninvited bot.', 'bot-781');
    await meetBotIdle();
    const t2 = t0 + 4 * 60_000;
    await dispatchDue(new Date(t2));
    const b = (await getMeeting(m.id)).bot!;
    expect(b.strays).toEqual(['bot-781']);
    // The booking looks again in six hours (as it was); the stray is tried again within the half hour.
    expect(b.nextAt).toBe(bookingWait);
    expect(b.strayNextAt).toBeGreaterThan(t2);
    expect(b.strayNextAt).toBeLessThanOrEqual(t2 + 30 * 60_000);
    stubMode.refuseIds = [];
    calls.length = 0;
    await dispatchDue(new Date(b.strayNextAt!));
    await meetBotIdle();
    expect(calls).toContainEqual(expect.objectContaining({ method: 'DELETE', url: '/bot/bot-781/' }));
    expect((await getMeeting(m.id)).bot!.strays).toBeUndefined();
    // The booking's own wait is untouched.
    expect((await getMeeting(m.id)).bot!.nextAt).toBe(bookingWait);
  });

  it('11.1: a stray that refused removal is tried again when it speaks, without waiting for a sweep', async () => {
    // Used to ignore lines from a bot already known as a stray, so a refusal left it in the call until the next retry.
    const m = await liveCall();
    bots.set('bot-782', { id: 'bot-782', meeting_url: m.meetingUrl!, status_changes: [{ code: 'in_call_recording' }] });
    stubMode.refuseIds = ['bot-782'];
    await line(m.id, 'First words.', 'bot-782');
    await meetBotIdle();
    expect((await getMeeting(m.id)).bot!.strays).toEqual(['bot-782']);
    stubMode.refuseIds = [];
    calls.length = 0;
    await line(m.id, 'Still here.', 'bot-782');
    await meetBotIdle();
    expect(calls).toContainEqual(expect.objectContaining({ method: 'DELETE', url: '/bot/bot-782/' }));
    expect((await getMeeting(m.id)).bot!.strays).toBeUndefined();
    expect((await getMeeting(m.id)).transcript.map((l) => l.text)).not.toContain('Still here.');
  });

  it('11.2: dismissed bookings are looked up a few links per sweep, once per link, and a bot found is cancelled before the next lookup', async () => {
    // Used to look every dismissed booking up, one by one, before recording or cancelling anything found.
    const { m, lost, bookingId } = await lostBooking();
    stubMode.listHides = true;
    stubMode.failCreate = true;
    await dispatchDue(at('2026-11-10T15:50:00Z'));
    const s = await steward('Steward Sweep');
    expect((await s.post(`/api/meetings/${m.id}/bot/dismiss`)).status).toBe(200);
    const fake = (i: number, url: string) => ({ bookingId: `bk-fake-${i}`, url });
    const other = (i: number) => `https://meet.google.com/fak-eeee-${String(i).padStart(3, '0')}`;
    const { mutateMeeting } = await import('../src/services/meetings.js');
    await mutateMeeting(m.id, (x) => {
      const real = x.bot!.dismissed!.find((d) => d.bookingId === bookingId)!;
      x.bot = {
        ...x.bot!,
        dismissed: [fake(0, other(0)), real, ...[1, 2, 3].map((i) => fake(i, other(i))), ...Array.from({ length: 30 }, (_, i) => fake(100 + i, real.url)), ...Array.from({ length: 14 }, (_, i) => fake(200 + i, other(4 + i)))],
      };
    });
    stubMode.listHides = false;
    calls.length = 0;
    await dispatchDue(at('2026-11-10T16:30:00Z'));
    await meetBotIdle();
    const isLookup = (c: { method: string; url: string }) => c.method === 'GET' && c.url.startsWith('/bot/?');
    const lookups = calls.filter(isLookup);
    expect(lookups).toHaveLength(5);
    const realUrl = `/bot/?meeting_url=${encodeURIComponent(m.meetingUrl!)}`;
    expect(lookups.filter((c) => c.url === realUrl)).toHaveLength(1);
    const found = calls.findIndex((c) => isLookup(c) && c.url === realUrl);
    const removed = calls.findIndex((c) => c.method === 'DELETE' && c.url === `/bot/${lost}/`);
    const nextLookup = calls.findIndex((c, i) => i > found && isLookup(c));
    expect(removed).toBeGreaterThan(found);
    expect(removed).toBeLessThan(nextLookup);
    // Its booking is settled; every other one (all 30 on the same link included) is still looked for, the rest next sweep.
    const left = (await getMeeting(m.id)).bot!.dismissed!;
    expect(left.map((d) => d.bookingId)).not.toContain(bookingId);
    expect(left).toHaveLength(48);
    calls.length = 0;
    await dispatchDue(at('2026-11-10T16:31:00Z'));
    expect(calls.filter(isLookup)).toHaveLength(5);
    expect(calls.filter(isLookup).some((c) => c.url === realUrl)).toBe(false);
  });

  it('11.2: a call with fifty dismissed bookings still being looked for can’t dismiss another; it stays unconfirmed and looked for', async () => {
    const { m, bookingId } = await lostBooking();
    stubMode.listHides = true;
    stubMode.failCreate = true;
    await dispatchDue(at('2026-11-10T15:50:00Z'));
    const { mutateMeeting } = await import('../src/services/meetings.js');
    await mutateMeeting(m.id, (x) => {
      x.bot = { ...x.bot!, dismissed: Array.from({ length: 50 }, (_, i) => ({ bookingId: `bk-held-${i}`, url: x.meetingUrl!, nextAt: Date.now() + 3600e3 })) };
    });
    const s = await steward('Steward Full');
    const res = await s.post(`/api/meetings/${m.id}/bot/dismiss`);
    expect(res.status).toBe(409);
    expect(res.body.error ?? res.text).toMatch(/50 dismissed bookings/);
    expect((await getMeeting(m.id)).bot).toMatchObject({ bookingId, unconfirmed: true });
    expect((await getMeeting(m.id)).bot!.dismissed).toHaveLength(50);
  });

  /* ----- Fixes from the twelfth review ----- */

  it('12.1: a duplicate bot the booking’s lookup has just found is cancelled straight away, whatever an older stray’s backoff', async () => {
    // Used to wait for the older stray's retry time before the new duplicate's first removal attempt.
    const { m, lost, bookingId } = await lostBooking();
    stubMode.failList = true;
    stubMode.failCreate = true;
    bots.set('bot-783', { id: 'bot-783', meeting_url: m.meetingUrl!, status_changes: [{ code: 'in_call_recording' }] });
    stubMode.refuseIds = ['bot-783'];
    await line(m.id, 'An older stray.', 'bot-783');
    await meetBotIdle();
    // The older stray is backing off for half an hour; the booking itself is due now.
    const { mutateMeeting } = await import('../src/services/meetings.js');
    await mutateMeeting(m.id, (x) => {
      x.bot = { ...x.bot!, strays: ['bot-783'], strayAttempts: 6, strayNextAt: at('2026-11-10T15:20:00Z').getTime(), nextAt: undefined };
    });
    // Recall.ai made two bots from the one booking.
    bots.set('bot-784', { id: 'bot-784', meeting_url: m.meetingUrl!, metadata: { ...bots.get(lost)!.metadata!, concord_booking: bookingId }, status_changes: [{ code: 'ready' }] });
    stubMode.failList = false;
    calls.length = 0;
    await dispatchDue(at('2026-11-10T14:50:00Z'));
    await meetBotIdle();
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'booked' });
    const kept = (await getMeeting(m.id)).bot!.botId!;
    const duplicate = kept === lost ? 'bot-784' : lost;
    expect(calls).toContainEqual(expect.objectContaining({ method: 'DELETE', url: `/bot/${duplicate}/` }));
    expect((await getMeeting(m.id)).bot!.strays ?? []).not.toContain(duplicate);
  });

  it('12.2: a stray that keeps speaking gets only its own removal retried, never the booking’s lookups', async () => {
    // Used to run the whole lifecycle without the clock: each stray line forced a booking lookup and cleared its backoff.
    const { m } = await lostBooking();
    stubMode.listHides = true;
    stubMode.failCreate = true;
    bots.set('bot-785', { id: 'bot-785', meeting_url: m.meetingUrl!, status_changes: [{ code: 'in_call_recording' }] });
    stubMode.refuseIds = ['bot-785'];
    await line(m.id, 'First words.', 'bot-785');
    await meetBotIdle();
    const wait = at('2026-11-10T20:46:00Z').getTime();
    const { mutateMeeting } = await import('../src/services/meetings.js');
    await mutateMeeting(m.id, (x) => {
      x.bot = { ...x.bot!, attempts: 8, nextAt: wait };
    });
    calls.length = 0;
    await line(m.id, 'Still talking.', 'bot-785');
    await meetBotIdle();
    expect(calls.some((c) => c.url.startsWith('/bot/bot-785/') && c.method !== 'GET')).toBe(true);
    expect(calls.filter((c) => c.method === 'GET' && c.url.startsWith('/bot/?'))).toHaveLength(0);
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/bot/')).toHaveLength(0);
    expect((await getMeeting(m.id)).bot).toMatchObject({ phase: 'booking', attempts: 8, nextAt: wait });
  });

  /* ----- Fixes from the thirteenth review ----- */

  it('13.1: a stray that turns up while another stray’s removal is under way is removed in that run, not after the other’s backoff', async () => {
    // Used to drop the new stray's removal because the lane was busy; the older stray's refusal then pushed both to 30 minutes.
    const m = await liveCall();
    bots.set('bot-786', { id: 'bot-786', meeting_url: m.meetingUrl!, status_changes: [{ code: 'in_call_recording' }] });
    bots.set('bot-787', { id: 'bot-787', meeting_url: m.meetingUrl!, status_changes: [{ code: 'in_call_recording' }] });
    const { mutateMeeting } = await import('../src/services/meetings.js');
    await mutateMeeting(m.id, (x) => {
      x.bot = { ...x.bot!, strays: ['bot-786'], strayAttempts: 6, strayNextAt: undefined };
    });
    // The older stray refuses removal, slowly.
    stubMode.refuseIds = ['bot-786'];
    stubMode.refuseDelayMs = 300;
    calls.length = 0;
    const t = at('2026-11-10T15:00:00Z').getTime();
    const sweep = dispatchDue(new Date(t));
    const deleting = (bot: string) => calls.some((c) => c.method === 'DELETE' && c.url === `/bot/${bot}/`);
    while (!deleting('bot-786')) await new Promise((r) => setTimeout(r, 5));
    // A new stray speaks while that removal is still waiting for an answer.
    await line(m.id, 'Another uninvited bot.', 'bot-787');
    await sweep;
    await meetBotIdle();
    expect(deleting('bot-787')).toBe(true);
    const b = (await getMeeting(m.id)).bot!;
    expect(b.strays).toEqual(['bot-786']);
    // Only the older stray, which has had its try, waits out the backoff.
    expect(b.strayNextAt).toBe(t + 30 * 60_000);
  });

  it('the calendar reader agrees with the cancellation reader', () => {
    // A cancelled week with no start time of its own.
    const bare = calendar(
      weeklySeries(),
      `BEGIN:VEVENT
RECURRENCE-ID;TZID=Europe/London:20261110T100000
DTSTAMP:20261001T120000Z
UID:series-1@google.com
STATUS:CANCELLED
END:VEVENT`,
    );
    const starts = parseOccurrences(bare, { from: at('2026-11-01T00:00:00Z'), to: at('2026-11-12T00:00:00Z') }).map((o) => o.start.toISOString());
    expect(starts).toEqual(['2026-11-03T10:00:00.000Z']);
    // METHOD:CANCEL without a STATUS on the event.
    const methodOnly = calendar(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }).replace('STATUS:CONFIRMED\n', '')).replace(
      'METHOD:PUBLISH',
      'METHOD:CANCEL',
    );
    expect(parseCancellations(methodOnly).uids).toEqual(['one-off-1@google.com']);
    expect(parseOccurrences(methodOnly, { from: at('2026-11-01T00:00:00Z'), to: at('2026-11-30T00:00:00Z') })).toEqual([]);
  });

  it('people who can’t see bot ids still see that a bot is booked', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    const [m] = await calendarMeetings();
    const contributor = request.agent(app);
    await contributor.post('/api/auth/demo').send({ name: 'Contributor Flo', role: 'reviewer' });
    const seen = (await contributor.get(`/api/meetings/${m.id}`)).body as Meeting;
    expect(seen.bot).toMatchObject({ booked: true });
    expect(seen.bot?.botId).toBeUndefined();
  });

  it('reports a feed it cannot read without dropping scheduled calls', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await syncCalendar(at('2026-11-09T09:00:00Z'));
    fs.writeFileSync(feed, '<html>Not found</html>');
    const synced = await syncCalendar(at('2026-11-09T09:01:00Z'));
    expect(synced).toMatchObject({ ok: false });
    expect(await calendarMeetings()).toHaveLength(1);
    const info = await (await steward('Steward Lou')).get('/api/meet-bot');
    expect(info.body).toMatchObject({ provider: 'recall', inviteEmail: 'concord.bot@example.org', calendarConnected: true, lastSync: { ok: false } });
  });
});

describe('scheduling from an uploaded invite', () => {
  beforeAll(() => {
    config.meetBot.recallApiKey = undefined;
    config.meetBot.calendarIcsUrl = undefined;
  });

  it('schedules a call under this ontology, and says why when the bot cannot join', async () => {
    const tester = request.agent(app);
    await tester.post('/api/auth/demo').send({ name: 'Uploader Uma', role: 'steward' });
    const start = new Date(Date.now() + 2 * 3600e3);
    const ics = calendar(oneOff({ uid: 'upload-1@google.com', start: start.toISOString(), end: new Date(start.getTime() + 3600e3).toISOString() }));
    const res = await tester.post('/api/ontologies/volunteering/meetings/calendar').send({ ics, postPromptsToChat: true });
    expect(res.status).toBe(201);
    expect(res.body.meetings).toHaveLength(1);
    expect(res.body.meetings[0]).toMatchObject({ status: 'scheduled', postPromptsToChat: true, calendar: { feed: 'upload', approval: 'approved' } });
    // Uploading the same invite again updates the call rather than adding another.
    expect((await tester.post('/api/ontologies/volunteering/meetings/calendar').send({ ics })).body.meetings[0].id).toBe(res.body.meetings[0].id);
    // Without a Recall.ai key, the bot can't join, and the meeting says so when the call comes round.
    await dispatchDue(new Date(start.getTime() - 60_000));
    expect(await getMeeting(res.body.meetings[0].id)).toMatchObject({ status: 'error', bot: { error: expect.stringMatching(/RECALL_API_KEY/) } });

    const bad = await tester.post('/api/ontologies/volunteering/meetings/calendar').send({ ics: 'hello' });
    expect(bad.status).toBe(400);
    const noMeet = await tester.post('/api/ontologies/volunteering/meetings/calendar').send({ ics: ics.replace(/https:\/\/meet\.google\.com\/[a-z-]+/g, 'https://example.org') });
    expect(noMeet.body.error ?? noMeet.text).toMatch(/Google Meet link/);
  });

  it('only facilitators can import invites, and re-importing a series without a week cancels that week', async () => {
    const contributor = request.agent(app);
    await contributor.post('/api/auth/demo').send({ name: 'Contributor Kai', role: 'contributor' });
    const first = new Date(Math.ceil((Date.now() + 26 * 3600e3) / 60_000) * 60_000);
    const series = (exdate?: Date) => {
      const ics = calendar(oneOff({ uid: 'weekly-upload', start: first.toISOString(), end: new Date(first.getTime() + 3600e3).toISOString() }));
      const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      return ics.replace('DTSTAMP:', `RRULE:FREQ=WEEKLY;COUNT=4\r\n${exdate ? `EXDATE:${stamp(exdate)}\r\n` : ''}DTSTAMP:`);
    };
    expect((await contributor.post('/api/ontologies/volunteering/meetings/calendar').send({ ics: series() })).status).toBe(403);

    const steward = request.agent(app);
    await steward.post('/api/auth/demo').send({ name: 'Steward Sal', role: 'steward' });
    const res = await steward.post('/api/ontologies/volunteering/meetings/calendar').send({ ics: series() });
    expect(res.status).toBe(201);
    expect(res.body.meetings).toHaveLength(2);
    const second = new Date(first.getTime() + 7 * 86400e3);
    await steward.post('/api/ontologies/volunteering/meetings/calendar').send({ ics: series(second) });
    const left = (await list<Meeting>('meetings')).filter((m) => m.calendar?.uid === 'weekly-upload');
    expect(left.map((m) => m.calendar!.start)).toEqual([first.toISOString()]);
  });

  it('simulated calls can post their prompts to a pretend chat', async () => {
    const tester = request.agent(app);
    await tester.post('/api/auth/demo').send({ name: 'Sim Sam', role: 'steward' });
    const m = await tester.post('/api/ontologies/volunteering/meetings/simulate?delayMs=0').send({ title: 'Sim', postPromptsToChat: true });
    expect(m.status).toBe(201);
    const got = (await tester.get(`/api/meetings/${m.body.id}`)).body as Meeting;
    expect(got.facilitatorPrompts.length).toBeGreaterThan(0);
    expect(got.facilitatorPrompts.every((p) => p.posted)).toBe(true);
  });
});
