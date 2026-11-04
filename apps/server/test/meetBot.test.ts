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
import { list, openDb, remove } from '../src/db.js';
import { parseCancellations, parseOccurrences } from '../src/services/calendarFeed.js';
import { findProject, setRoles } from '../src/services/ontologies.js';
import { createUser } from '../src/services/users.js';
import { dispatchDue, meetBotInfo, routeOccurrence, sanitise, syncCalendar } from '../src/services/meetBot.js';
import { canFacilitate, getMeeting, recallWebhook, recordSeriesApproval, saveMeeting } from '../src/services/meetings.js';
import { chatText } from '../src/services/recall.js';
import { seedDemo } from '../src/services/simulation.js';
import { calendar, oneOff, weeklySeries } from './fixtures/invites.js';

const app = createApp();

/* A stand-in for the Recall.ai API that records what the server asked it to do. */
type Call = { method: string; url: string; body: Record<string, unknown> };
const calls: Call[] = [];
let stub: http.Server;
let nextBot = 0;
/** How the stand-in misbehaves, per test. */
const stubMode = { failCancel: false, chatDelayMs: 0, botDelayMs: 0, failChat: false, dropCreate: false, truncateCreate: false, failList: false };
/** Bots the stand-in has created, for listing and status. */
const bots = new Map<string, { id: string; meeting_url: string; metadata?: Record<string, string>; status_changes: { code: string }[] }>();

beforeAll(async () => {
  openDb();
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
      if (req.method === 'POST' && req.url === '/bot/') {
        const body = JSON.parse(raw) as { meeting_url: string; metadata?: Record<string, string> };
        const bot = { id: `bot-${++nextBot}`, meeting_url: body.meeting_url, metadata: body.metadata, status_changes: [{ code: 'ready' }] };
        bots.set(bot.id, bot);
        // Recall.ai took the booking, but the answer never arrives.
        if (stubMode.dropCreate) return void res.destroy();
        // Or the headers arrive and the body is cut off.
        if (stubMode.truncateCreate) {
          res.writeHead(201, { 'Content-Type': 'application/json', 'Content-Length': '200' });
          res.write('{"id":"bo');
          return void setTimeout(() => res.destroy(), 20);
        }
        return reply(201, JSON.stringify({ id: bot.id }), stubMode.botDelayMs);
      }
      if (req.method === 'GET' && req.url?.startsWith('/bot/?')) {
        if (stubMode.failList) return reply(503, '{"detail":"try later"}');
        const url = new URL(req.url, 'http://x').searchParams.get('meeting_url');
        return reply(200, JSON.stringify({ next: null, results: [...bots.values()].filter((b) => b.meeting_url === url) }));
      }
      const own = req.url?.match(/^\/bot\/(bot-\d+)\/$/);
      if (req.method === 'GET' && own) return reply(bots.has(own[1]) ? 200 : 404, JSON.stringify(bots.get(own[1]) ?? {}));
      if (stubMode.failCancel && (req.method === 'DELETE' || req.url?.includes('leave_call'))) return reply(405, '{"detail":"Method not allowed"}');
      if (req.url?.includes('send_chat_message')) return stubMode.failChat ? reply(500, '{"detail":"chat unavailable"}') : reply(200, '{}', stubMode.chatDelayMs);
      const done = req.url?.match(/^\/bot\/(bot-\d+)\/(?:leave_call\/)?$/);
      if (done && (req.method === 'DELETE' || req.method === 'POST')) bots.get(done[1])?.status_changes.push({ code: 'done' });
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

beforeEach(() => {
  calls.length = 0;
  Object.assign(stubMode, { failCancel: false, chatDelayMs: 0, botDelayMs: 0, failChat: false, dropCreate: false, truncateCreate: false, failList: false });
  for (const m of list<Meeting>('meetings')) if (m.source === 'calendar-invite') remove('meetings', m.id);
  for (const k of list<{ id: string }>('kv')) if (k.id.startsWith('meet-bot:approval:')) remove('kv', k.id);
});

const at = (iso: string) => new Date(iso);

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

  it('files an invite under the ontology its address, tag or title names, else the default', () => {
    const base = { title: 'Call', description: '', attendees: ['someone@example.org'] };
    expect(routeOccurrence({ ...base, attendees: ['concord.bot+volunteering@example.org'] })?.slug).toBe('volunteering');
    expect(routeOccurrence({ ...base, description: 'Agenda for #volunteering' })?.slug).toBe('volunteering');
    expect(routeOccurrence({ ...base, title: 'Volunteering Data Standard: use cases' })?.slug).toBe('volunteering');
    expect(routeOccurrence(base)?.slug).toBe('volunteering'); // the demo ontology is the default
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
      setRoles(findProject('volunteering')!.id, u.id, ['steward']);
    }
  });
  beforeEach(() => {
    config.meetBot.calendarIcsUrl = pathToFileURL(feed).href;
  });
  /** Reads the calendar, then approves every call waiting for it as a steward would (for tests about what happens next). */
  const sync = async (t: Date) => {
    const r = await syncCalendar(t);
    for (const m of list<Meeting>('meetings')) {
      if (m.calendar?.approval !== 'pending') continue;
      recordSeriesApproval(m.ontologyId, m.calendar.uid, m.calendar.organizer, m.meetingUrl, 'test-steward');
      saveMeeting({ ...m, calendar: { ...m.calendar, approval: 'approved', approvedBy: 'test-steward' } });
    }
    return r;
  };
  const steward = async (name: string) => {
    const agent = request.agent(app);
    const r = await agent.post('/api/auth/demo').send({ name, role: 'steward' });
    return Object.assign(agent, { userId: r.body.user.id as string });
  };

  const calendarMeetings = () => list<Meeting>('meetings').filter((m) => m.source === 'calendar-invite');

  it('schedules a call when the bot is invited, books a bot before it starts, and follows moves and cancellations', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z', bot: 'concord.bot+volunteering@example.org' }));
    const synced = await sync(at('2026-11-09T09:00:00Z'));
    expect(synced).toMatchObject({ ok: true, events: 1 });
    let [m] = calendarMeetings();
    expect(m).toMatchObject({ status: 'scheduled', title: 'Use case workshop', meetingUrl: 'https://meet.google.com/xyz-abcd-efg', bot: { provider: 'recall', status: 'scheduled' } });
    expect(m.calendar).toMatchObject({ feed: 'calendar', start: '2026-11-10T15:00:00.000Z', organizer: 'tom@example.org', recurring: false });

    // A day ahead: nothing is booked yet.
    await dispatchDue(at('2026-11-09T15:00:00Z'));
    expect(calls).toEqual([]);

    // Fifteen minutes ahead: a bot is booked to join at the start time.
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/bot/', body: { meeting_url: 'https://meet.google.com/xyz-abcd-efg', join_at: '2026-11-10T15:00:00.000Z' } });
    m = getMeeting(m.id);
    expect(m.status).toBe('scheduled');
    expect(m.bot?.botId).toBe(`bot-${nextBot}`);

    // The organiser moves the call: the booked bot is cancelled and booked again for the new time.
    calls.length = 0;
    writeFeed(oneOff({ start: '2026-11-10T16:00:00Z', end: '2026-11-10T17:00:00Z', bot: 'concord.bot+volunteering@example.org' }));
    await sync(at('2026-11-10T14:50:00Z'));
    expect(calls).toEqual([expect.objectContaining({ method: 'DELETE', url: `/bot/bot-${nextBot}/` })]);
    m = getMeeting(m.id);
    expect(m.calendar?.start).toBe('2026-11-10T16:00:00.000Z');
    expect(m.bot?.botId).toBeUndefined();

    // Then cancels it: the meeting goes.
    writeFeed();
    await sync(at('2026-11-10T14:55:00Z'));
    expect(calendarMeetings()).toEqual([]);
  });

  it('goes live when the call starts, keeps prompts out of the chat unless asked, and ends after the call', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    await dispatchDue(at('2026-11-10T14:50:00Z'));
    await dispatchDue(at('2026-11-10T15:00:30Z'));
    let [m] = calendarMeetings();
    expect(m).toMatchObject({ status: 'live', postPromptsToChat: false, bot: { status: 'joining' } });
    const intro = (calls.find((c) => c.url === '/bot/')!.body.chat as { on_bot_join: { message: string } }).on_bot_join.message;
    expect(intro).toMatch(/not this chat/);

    const secret = list<{ id: string; secret: string }>('kv').find((k) => k.id === `meeting-secret:${m.id}`)!.secret;
    const say = (name: string, text: string) => recallWebhook(m.id, secret, { event: 'transcript.data', data: { data: { participant: { name }, words: [{ text, start_timestamp: { relative: 5 } }] } } });
    calls.length = 0;
    for (let i = 0; i < 4; i++) await say('Aisha Rahman', `A "shift" is a fixed slot on a rota, part ${i}.`);
    m = getMeeting(m.id);
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
    m = getMeeting(m.id);
    expect(m.facilitatorPrompts.length).toBe(2);
    expect(m.facilitatorPrompts[1].posted).toBe(true);
    expect(calls.filter((c) => c.url.includes('send_chat_message'))).toHaveLength(1);

    // Well after the slot, with the transcript quiet, the call is closed and analysed.
    await dispatchDue(at('2026-11-10T16:05:00Z'));
    expect(getMeeting(m.id).status).toBe('live');
    await dispatchDue(at('2026-11-10T16:20:00Z'));
    m = getMeeting(m.id);
    expect(m.status).toBe('analysed');
    expect(m.bot?.status).toBe('done');
    expect(calls.some((c) => c.url === `/bot/${m.bot!.botId}/leave_call/`)).toBe(true);
  });

  it('books each week of a recurring series separately, and skips a week on request', async () => {
    writeFeed(weeklySeries({ description: 'Notes: #volunteering' }));
    await sync(at('2026-11-09T09:00:00Z'));
    const weeks = calendarMeetings().sort((a, b) => a.calendar!.start.localeCompare(b.calendar!.start));
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
    expect(calendarMeetings().find((w) => w.id === weeks[0].id)).toBeUndefined();

    // Next sync, a week on: the 24th (moved to 14:00) appears.
    await sync(at('2026-11-16T09:00:00Z'));
    expect(calendarMeetings().map((w) => w.calendar!.start)).toContain('2026-11-24T14:00:00.000Z');
  });

  it('holds invites from people who aren’t facilitators until one approves, and ignores invites the bot isn’t on or declined', async () => {
    writeFeed(
      oneOff({ uid: 'stranger', organizer: 'stranger@elsewhere.test', start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }),
      oneOff({ uid: 'declined', partstat: 'DECLINED', start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }),
      oneOff({ uid: 'not-invited', bot: 'someone.else@example.org', start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }),
    );
    await syncCalendar(at('2026-11-09T09:00:00Z'));
    const [m, ...rest] = calendarMeetings();
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
    const [m] = calendarMeetings();
    stubMode.botDelayMs = 150;
    const steward = request.agent(app);
    await steward.post('/api/auth/demo').send({ name: 'Steward Sol', role: 'steward' });
    const [, , skip] = await Promise.all([dispatchDue(at('2026-11-10T14:46:00Z')), dispatchDue(at('2026-11-10T14:46:00Z')), steward.patch(`/api/meetings/${m.id}`).send({ skip: true })]);
    expect(calls.filter((c) => c.url === '/bot/')).toHaveLength(1);
    expect(skip.status).toBe(200);
    const after = getMeeting(m.id);
    expect(after.calendar?.skip).toBe(true);
    expect(after.bot?.botId).toBeUndefined();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('keeps a booked bot (and says so) when Recall.ai won’t cancel it', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-09T09:00:00Z'));
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    const [m] = calendarMeetings();
    const botId = getMeeting(m.id).bot!.botId!;
    stubMode.failCancel = true;
    const steward = request.agent(app);
    await steward.post('/api/auth/demo').send({ name: 'Steward Sue', role: 'steward' });
    const skip = await steward.patch(`/api/meetings/${m.id}`).send({ skip: true });
    expect(skip.status).toBe(502);
    expect(getMeeting(m.id).calendar?.skip).toBeFalsy();
    expect(getMeeting(m.id).bot?.botId).toBe(botId);
    // The invite is cancelled: the meeting stays, marked for retry, until Recall.ai cancels the bot.
    writeFeed();
    await sync(at('2026-11-10T14:48:00Z'));
    expect(getMeeting(m.id)).toMatchObject({ calendar: { cancelPending: true }, bot: { botId } });
    stubMode.failCancel = false;
    await dispatchDue(at('2026-11-10T14:49:00Z'));
    expect(calendarMeetings()).toEqual([]);
  });

  it('posting a prompt doesn’t lose transcript lines that arrive meanwhile, and tells the call when posting is switched on', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    await dispatchDue(at('2026-11-10T14:50:00Z'));
    const [m] = calendarMeetings();
    const secret = list<{ id: string; secret: string }>('kv').find((k) => k.id === `meeting-secret:${m.id}`)!.secret;
    const say = (text: string) => recallWebhook(m.id, secret, { event: 'transcript.data', data: { data: { participant: { name: 'Aisha Rahman' }, words: [{ text }] } } });
    for (let i = 0; i < 4; i++) await say(`A "rota" is a weekly pattern, part ${i}.`);
    expect(getMeeting(m.id).facilitatorPrompts).toHaveLength(1);

    const steward = request.agent(app);
    await steward.post('/api/auth/demo').send({ name: 'Steward Sid', role: 'steward' });
    stubMode.chatDelayMs = 150;
    const [posted] = await Promise.all([steward.post(`/api/meetings/${m.id}/prompts/0/post`), (async () => {
      await new Promise((r) => setTimeout(r, 30));
      await say('This line arrives while the prompt is being posted.');
    })()]);
    expect(posted.status).toBe(200);
    const after = getMeeting(m.id);
    expect(after.transcript.at(-1)?.text).toBe('This line arrives while the prompt is being posted.');
    expect(after.facilitatorPrompts[0].posted).toBe(true);

    calls.length = 0;
    stubMode.chatDelayMs = 0;
    await steward.patch(`/api/meetings/${m.id}`).send({ postPromptsToChat: true });
    const notices = calls.filter((c) => c.url.includes('send_chat_message')).map((c) => c.body.message as string);
    expect(notices).toEqual([expect.stringMatching(/from now on I'll post follow-up questions here/)]);
    expect(getMeeting(m.id).chatModeAnnounced).toBe(true);
  });

  it('an imported .ics of a call already on the bot’s calendar doesn’t book a second bot', async () => {
    writeFeed(oneOff({ uid: 'shared-1', start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-09T09:00:00Z'));
    const steward = request.agent(app);
    await steward.post('/api/auth/demo').send({ name: 'Steward Sam', role: 'steward' });
    const { scheduleFromInvite } = await import('../src/services/meetBot.js');
    const { getProject } = await import('../src/services/ontologies.js');
    const [m] = calendarMeetings();
    const got = await scheduleFromInvite(getProject(m.ontologyId), { id: 'u', name: 'x' } as never, calendar(oneOff({ uid: 'shared-1', start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' })), {
      now: at('2026-11-09T10:00:00Z'),
    });
    expect(got.meetings.map((x) => x.id)).toEqual([m.id]);
    expect(calendarMeetings()).toHaveLength(1);
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
    expect(JSON.stringify(meetBotInfo())).not.toMatch(/s3cr3t/);
    expect(info.lastSync.error).toMatch(/not a valid address/);
  });

  /* ----- Fixes from the second review ----- */

  const secretOf = (id: string) => list<{ id: string; secret: string }>('kv').find((k) => k.id === `meeting-secret:${id}`)!.secret;
  const line = (id: string, text: string, botId?: string) =>
    recallWebhook(id, secretOf(id), { event: 'transcript.data', data: { ...(botId ? { bot: { id: botId } } : {}), data: { participant: { name: 'Aisha Rahman' }, words: [{ text }] } } });
  /** A one-off call at 15:00 on 10 November, with its bot booked and in the call. */
  const liveCall = async () => {
    writeFeed(oneOff({ uid: 'live-1', start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    await dispatchDue(at('2026-11-10T14:50:00Z'));
    const [m] = calendarMeetings();
    await line(m.id, 'Hello everyone.', getMeeting(m.id).bot!.botId);
    return getMeeting(m.id);
  };

  it('by default every invite waits for approval; one approval covers the series, until its Meet link changes', async () => {
    writeFeed(weeklySeries({ description: '#volunteering' }));
    await syncCalendar(at('2026-11-02T09:00:00Z'));
    let weeks = calendarMeetings();
    expect(weeks.map((w) => w.calendar!.approval)).toEqual(['pending', 'pending']);
    // Organised by a steward, but the invite can't prove that, so nothing is booked.
    await dispatchDue(at('2026-11-03T09:50:00Z'));
    expect(calls.filter((c) => c.url === '/bot/')).toEqual([]);

    const s = await steward('Steward Ava');
    expect((await s.patch(`/api/meetings/${weeks[0].id}`).send({ approve: true })).status).toBe(200);
    weeks = calendarMeetings();
    expect(weeks.map((w) => w.calendar!.approval)).toEqual(['approved', 'approved']);
    // Weeks that turn up later are covered too.
    await syncCalendar(at('2026-11-16T09:00:00Z'));
    const moved = calendarMeetings().find((w) => w.calendar!.start === '2026-11-24T14:00:00.000Z')!;
    expect(moved.calendar!.approval).toBe('approved');
    await dispatchDue(at('2026-11-24T13:46:00Z'));
    const botId = getMeeting(moved.id).bot!.botId!;
    expect(botId).toBeTruthy();

    // The Meet link changes: the booking is cancelled and the call needs approving again.
    calls.length = 0;
    writeFeed(weeklySeries({ description: '#volunteering', meet: 'https://meet.google.com/new-linx-abc' }));
    await syncCalendar(at('2026-11-24T13:50:00Z'));
    const after = getMeeting(moved.id);
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
    const byUid = (uid: string) => calendarMeetings().find((m) => m.calendar!.uid === uid)!;
    // Even an invite whose organiser is a steward can't prove it: everything waits.
    expect(['fwd', 'olive', 'tom'].map((u) => byUid(u).calendar!.approval)).toEqual(['pending', 'pending', 'pending']);
    expect(byUid('fwd').calendar!.sentBy).toBe('tom@example.org');
    // Organising the call gives Olive no say over it.
    expect(byUid('olive').createdBy).toBe('calendar');
    expect(canFacilitate(byUid('olive'), olive)).toBe(false);

    // Tom's call is approved and booked, then taken over by someone else while Recall.ai is refusing cancellations.
    const s = await steward('Steward Quinn');
    await s.patch(`/api/meetings/${byUid('tom').id}`).send({ approve: true });
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    const botId = getMeeting(byUid('tom').id).bot!.botId!;
    stubMode.failCancel = true;
    writeFeed(oneOff({ uid: 'tom', organizer: 'mallory@elsewhere.test', meet: 'https://meet.google.com/mal-lory-abc', start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await syncCalendar(at('2026-11-10T14:50:00Z'));
    const tom = getMeeting(byUid('tom').id);
    expect(tom.calendar).toMatchObject({ approval: 'pending', organizer: 'mallory@elsewhere.test', approvalNote: expect.stringMatching(/changed/) });
    expect(tom.bot).toMatchObject({ botId, error: expect.any(String) });
    // The old bot joins anyway: what it hears is dropped, and the call doesn't go live.
    await line(tom.id, 'Should not be kept.', botId);
    expect(getMeeting(tom.id)).toMatchObject({ status: 'scheduled', transcript: [] });
    // Once Recall.ai recovers, the cancellation is retried.
    stubMode.failCancel = false;
    calls.length = 0;
    await dispatchDue(at('2026-11-10T14:52:00Z'));
    expect(calls).toContainEqual(expect.objectContaining({ method: 'DELETE', url: `/bot/${botId}/` }));
    expect(getMeeting(tom.id).bot?.botId).toBeUndefined();
    expect(calls.filter((c) => c.url === '/bot/')).toEqual([]);
  });

  it('analysing needs a facilitator and an ended call; ending reports a bot it couldn’t remove and keeps trying', async () => {
    const m = await liveCall();
    expect(m.bot?.status).toBe('in-call');
    const contributor = request.agent(app);
    await contributor.post('/api/auth/demo').send({ name: 'Contributor Cy', role: 'contributor' });
    expect((await contributor.post(`/api/meetings/${m.id}/analyse`)).status).toBe(403);
    expect((await contributor.post(`/api/meetings/${m.id}/propose`)).status).toBe(403);
    const s = await steward('Steward Eve');
    expect((await s.post(`/api/meetings/${m.id}/analyse`)).status).toBe(409);

    stubMode.failCancel = true;
    const end = await s.post(`/api/meetings/${m.id}/end`);
    expect(end.status).toBe(502);
    expect(getMeeting(m.id)).toMatchObject({ status: 'live', bot: { status: 'in-call', leaving: true } });
    // Retried every minute; once the bot is out, the call is analysed.
    stubMode.failCancel = false;
    await dispatchDue(at('2026-11-10T15:30:00Z'));
    expect(getMeeting(m.id)).toMatchObject({ status: 'analysed', bot: { status: 'done' } });
  });

  it('retries a failed cancellation even once the bot is in the call, and drops what that bot hears', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    const [m] = calendarMeetings();
    const botId = getMeeting(m.id).bot!.botId!;
    stubMode.failCancel = true;
    writeFeed();
    await sync(at('2026-11-10T14:50:00Z'));
    expect(getMeeting(m.id).calendar?.cancelPending).toBe(true);
    // The bot joins anyway: nothing it transcribes is kept, and the call doesn't go live.
    await line(m.id, 'Is this thing on?', botId);
    expect(getMeeting(m.id)).toMatchObject({ status: 'scheduled', transcript: [] });
    stubMode.failCancel = false;
    await dispatchDue(at('2026-11-10T15:02:00Z'));
    expect(calendarMeetings()).toEqual([]);
  });

  it('finds a booking whose answer was lost instead of booking a second bot', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    stubMode.dropCreate = true;
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    const booked = `bot-${nextBot}`;
    const [m] = calendarMeetings();
    expect(getMeeting(m.id).bot).toMatchObject({ uncertain: true });
    stubMode.dropCreate = false;
    await dispatchDue(at('2026-11-10T14:47:00Z'));
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/bot/')).toHaveLength(1);
    expect(calls.some((c) => c.method === 'GET' && c.url.startsWith('/bot/?'))).toBe(true);
    expect(getMeeting(m.id).bot).toMatchObject({ botId: booked });
    expect(getMeeting(m.id).bot?.uncertain).toBeUndefined();
  });

  it('importing only a cancellation cancels the booked call', async () => {
    const start = new Date(Date.now() + 10 * 60_000);
    const one = (status?: string) => calendar(oneOff({ uid: 'import-cancel', start: start.toISOString(), end: new Date(start.getTime() + 3600e3).toISOString(), status }));
    expect(parseCancellations(one('CANCELLED'))).toEqual({ uids: ['import-cancel'], keys: [] });
    const s = await steward('Steward Ivy');
    const made = await s.post('/api/ontologies/volunteering/meetings/calendar').send({ ics: one() });
    const id = made.body.meetings[0].id as string;
    const botId = getMeeting(id).bot!.botId!;
    expect(botId).toBeTruthy();
    const res = await s.post('/api/ontologies/volunteering/meetings/calendar').send({ ics: one('CANCELLED') });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ meetings: [], cancelled: 1, cancelRetrying: 0 });
    expect(calls).toContainEqual(expect.objectContaining({ method: 'DELETE', url: `/bot/${botId}/` }));
    expect(list<Meeting>('meetings').some((x) => x.id === id)).toBe(false);
  });

  it('retries a chat notice that failed, and holds back automatic posts until the call has been told', async () => {
    const m = await liveCall();
    const s = await steward('Steward Noor');
    stubMode.failChat = true;
    expect((await s.patch(`/api/meetings/${m.id}`).send({ postPromptsToChat: true })).status).toBe(200);
    expect(getMeeting(m.id)).toMatchObject({ postPromptsToChat: true, chatModeAnnounced: false, chatNoticeError: expect.stringMatching(/Couldn’t tell the call/) });
    for (let i = 0; i < 4; i++) await line(m.id, `A "rota" is a weekly pattern, part ${i}.`);
    expect(getMeeting(m.id).facilitatorPrompts.at(-1)?.posted).toBe(false);

    stubMode.failChat = false;
    calls.length = 0;
    for (let i = 0; i < 4; i++) await line(m.id, `The "activity record" holds hours, note ${i}.`);
    const after = getMeeting(m.id);
    expect(after.chatModeAnnounced).toBe(true);
    expect(after.chatNoticeError).toBeUndefined();
    const sent = calls.filter((c) => c.url.includes('send_chat_message')).map((c) => c.body.message as string);
    expect(sent[0]).toMatch(/from now on I'll post follow-up questions here/);
    expect(after.facilitatorPrompts.at(-1)?.posted).toBe(true);
  });

  it('shows meetings to signed-in people only, and invites awaiting approval, Meet links and organisers to facilitators only', async () => {
    writeFeed(oneOff({ uid: 'private-call', start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await syncCalendar(at('2026-11-09T09:00:00Z'));
    const [m] = calendarMeetings();
    expect((await request(app).get('/api/ontologies/volunteering/meetings')).status).toBe(401);
    expect((await request(app).get(`/api/meetings/${m.id}`)).status).toBe(401);
    const contributor = request.agent(app);
    await contributor.post('/api/auth/demo').send({ name: 'Contributor Dee', role: 'contributor' });
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
  });

  it('“Join a call now” keeps transcript lines that arrive before Recall.ai answers', async () => {
    const s = await steward('Steward Raj');
    stubMode.botDelayMs = 200;
    const sending = s.post('/api/ontologies/volunteering/meetings/bot').send({ title: 'Join now race', meetingUrl: 'https://meet.google.com/abc-defg-hij' });
    const req = sending.then((r) => r);
    await new Promise((r) => setTimeout(r, 80));
    const m = list<Meeting>('meetings').find((x) => x.title === 'Join now race')!;
    await line(m.id, 'Said before the booking came back.');
    const res = await req;
    expect(res.status).toBe(201);
    const after = getMeeting(m.id);
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
    expect(getMeeting(m.id)).toMatchObject({ status: 'analysed', bot: { status: 'done' } });
  });

  it('cancelling a call whose booking reply was lost finds that bot and cancels it', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    stubMode.dropCreate = true;
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    const booked = `bot-${nextBot}`;
    const [m] = calendarMeetings();
    stubMode.dropCreate = false;
    // Recall.ai can't be asked at first: the call is kept and retried, not forgotten.
    stubMode.failList = true;
    writeFeed();
    await sync(at('2026-11-10T14:47:00Z'));
    expect(getMeeting(m.id).calendar?.cancelPending).toBe(true);
    stubMode.failList = false;
    calls.length = 0;
    await dispatchDue(at('2026-11-10T14:48:00Z'));
    expect(calls).toContainEqual(expect.objectContaining({ method: 'DELETE', url: `/bot/${booked}/` }));
    expect(calendarMeetings()).toEqual([]);
  });

  it('a booking reply cut off after its headers counts as unconfirmed, not failed', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    stubMode.truncateCreate = true;
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    const booked = `bot-${nextBot}`;
    const [m] = calendarMeetings();
    expect(getMeeting(m.id).bot).toMatchObject({ uncertain: true });
    stubMode.truncateCreate = false;
    await dispatchDue(at('2026-11-10T14:47:00Z'));
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/bot/')).toHaveLength(1);
    expect(getMeeting(m.id).bot?.botId).toBe(booked);
  });

  it('after a lost booking reply, the bot’s first words identify it, and End call removes it', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    stubMode.dropCreate = true;
    await dispatchDue(at('2026-11-10T14:58:00Z'));
    const booked = `bot-${nextBot}`;
    stubMode.dropCreate = false;
    const [m] = calendarMeetings();
    await line(m.id, 'We can start.', booked);
    expect(getMeeting(m.id)).toMatchObject({ status: 'live', bot: { botId: booked, status: 'in-call' } });
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
    const [m] = calendarMeetings();
    // Live (it's past the start) with no bot id yet, and Recall.ai can't be asked.
    const { mutateMeeting } = await import('../src/services/meetings.js');
    await mutateMeeting(m.id, (x) => {
      x.status = 'live';
      x.bot = { provider: 'recall', status: 'joining', uncertain: true };
    });
    const s = await steward('Steward Wes');
    stubMode.failList = true;
    expect((await s.post(`/api/meetings/${m.id}/end`)).status).toBe(502);
    expect(getMeeting(m.id).bot).toMatchObject({ leaving: true });
    stubMode.failList = false;
    calls.length = 0;
    await dispatchDue(at('2026-11-10T15:05:00Z'));
    expect(calls).toContainEqual(expect.objectContaining({ method: 'DELETE', url: `/bot/${booked}/` }));
    expect(getMeeting(m.id).bot?.status).toBe('done');
  });

  it('a skip that lands just before a transcript line wins: the line is dropped', async () => {
    const m = await liveCall();
    const { meetingLock } = await import('../src/services/meetings.js');
    // Hold the meeting's lock, queue the webhook behind it, then mark the call skipped before releasing.
    let release!: () => void;
    const held = meetingLock(m.id, () => new Promise<void>((r) => (release = r)));
    const hook = line(m.id, 'Arrives during the skip.', m.bot!.botId);
    await new Promise((r) => setTimeout(r, 20));
    const fresh = getMeeting(m.id);
    saveMeeting({ ...fresh, calendar: { ...fresh.calendar!, skip: true } });
    release();
    await held;
    await hook;
    expect(getMeeting(m.id).transcript.map((l) => l.text)).toEqual(['Hello everyone.']);
  });

  it('retries a failed chat notice on every line, even when the bot has nothing new to suggest', async () => {
    const m = await liveCall();
    const s = await steward('Steward Xan');
    stubMode.failChat = true;
    await s.patch(`/api/meetings/${m.id}`).send({ postPromptsToChat: true });
    expect(getMeeting(m.id).chatNoticeError).toBeTruthy();
    stubMode.failChat = false;
    calls.length = 0;
    // One plain line, too few for a new suggestion.
    await line(m.id, 'Okay.');
    expect(calls.filter((c) => c.url.includes('send_chat_message')).map((c) => c.body.message)).toEqual([expect.stringMatching(/from now on/)]);
    expect(getMeeting(m.id).chatModeAnnounced).toBe(true);
  });

  it('importing an invite that is waiting for approval approves it', async () => {
    const start = new Date(Date.now() + 10 * 60_000);
    const ics = calendar(oneOff({ uid: 'pending-then-import', start: start.toISOString(), end: new Date(start.getTime() + 3600e3).toISOString() }));
    writeFeed(oneOff({ uid: 'pending-then-import', start: start.toISOString(), end: new Date(start.getTime() + 3600e3).toISOString() }));
    await syncCalendar(new Date());
    const [m] = calendarMeetings();
    expect(m.calendar?.approval).toBe('pending');
    const s = await steward('Steward Yan');
    const res = await s.post('/api/ontologies/volunteering/meetings/calendar').send({ ics });
    expect(res.body.meetings[0]).toMatchObject({ id: m.id, calendar: { approval: 'approved', approvedBy: s.userId } });
    expect(getMeeting(m.id).bot?.botId).toBeTruthy();
  });

  it('a cancellation without a start time still cancels, and says when cancelling the bot is still being retried', async () => {
    const start = new Date(Date.now() + 10 * 60_000);
    const s = await steward('Steward Zed');
    await s.post('/api/ontologies/volunteering/meetings/calendar').send({ ics: calendar(oneOff({ uid: 'bare-cancel', start: start.toISOString(), end: new Date(start.getTime() + 3600e3).toISOString() })) });
    const [m] = calendarMeetings();
    expect(getMeeting(m.id).bot?.botId).toBeTruthy();
    const bare = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:CANCEL\r\nBEGIN:VEVENT\r\nUID:bare-cancel\r\nDTSTAMP:20261104T120000Z\r\nSEQUENCE:2\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    expect(parseCancellations(bare)).toEqual({ uids: ['bare-cancel'], keys: [] });
    stubMode.failCancel = true;
    const res = await s.post('/api/ontologies/volunteering/meetings/calendar').send({ ics: bare });
    expect(res.body).toEqual({ meetings: [], cancelled: 0, cancelRetrying: 1 });
    expect(getMeeting(m.id).calendar?.cancelPending).toBe(true);
  });

  it('people who can’t see bot ids still see that a bot is booked', async () => {
    writeFeed(oneOff({ start: '2026-11-10T15:00:00Z', end: '2026-11-10T16:00:00Z' }));
    await sync(at('2026-11-10T14:00:00Z'));
    await dispatchDue(at('2026-11-10T14:46:00Z'));
    const [m] = calendarMeetings();
    const contributor = request.agent(app);
    await contributor.post('/api/auth/demo').send({ name: 'Contributor Flo', role: 'contributor' });
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
    expect(calendarMeetings()).toHaveLength(1);
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
    expect(getMeeting(res.body.meetings[0].id)).toMatchObject({ status: 'error', bot: { error: expect.stringMatching(/RECALL_API_KEY/) } });

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
    const left = list<Meeting>('meetings').filter((m) => m.calendar?.uid === 'weekly-upload');
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
