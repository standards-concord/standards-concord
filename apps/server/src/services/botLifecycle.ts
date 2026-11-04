import type { Meeting } from '@concord/shared';
import { config } from '../config.js';
import { get, list, put } from '../db.js';
import { newId, newToken } from '../ids.js';
import { dropMeeting, emit, finishCall, meetingLock, saveMeeting } from './meetings.js';
import { BookingError, IDEMPOTENCY_KEY_MS, recall } from './recall.js';

/**
 * Each meeting's Recall.ai bot is one record (`meeting.bot`) with one state machine:
 *
 *   idle ─book─▶ booking ─Recall.ai names the bot─▶ booked
 *    ▲  ◀─refused─┘   │                               │
 *    │                └──────────── release ──────────┤
 *    └───(after: idle)── releasing ◀──────────────────┘
 *                         └─confirmed─▶ done (after: done)
 *
 * - Every change is one compare-and-set on the latest stored copy, under the
 *   meeting's lock (`transition`). A change decided from an earlier copy checks
 *   the record's generation; an answer from Recall.ai checks the bot's identity
 *   (its booking id or bot id). Nothing waits on Recall.ai under the lock.
 * - A booking is recorded before it is sent, and its id is also its idempotency
 *   key. A meeting books only from idle: never while a booking is out, unanswered,
 *   or being released, so there is never a second bot for one meeting.
 * - An unanswered booking is sent again under the same key while Recall.ai still
 *   honours it (IDEMPOTENCY_KEY_MS), which returns the bot it made, or a definite
 *   refusal (no bot). After that it is only looked up (and adopted from its first
 *   transcript line), however long that takes.
 * - Releasing ends only on terminal confirmation: Recall.ai removed the bot, says
 *   it has finished or doesn't exist, or definitively refused the booking; or a
 *   facilitator dismissed a booking that can no longer be checked.
 * - A withdrawn meeting is only deleted once its record has settled.
 * - Requests for one meeting go one at a time, in its lane; lanes run side by side.
 */

type Bot = NonNullable<Meeting['bot']>;
type Phase = NonNullable<Bot['phase']>;
export type Tracked = Meeting & { bot: Bot & { phase: Phase; gen: number } };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** An unconfirmed booking looked for this long (since it was made) is looked for every six hours from then on. */
export const SLOW_LOOKUP_AFTER_MS = 6 * HOUR;
const RELEASED_KEEP = 20;

export const tracked = (m: Meeting | undefined): m is Tracked => !!m?.bot && m.bot.provider === 'recall' && !!m.bot.phase;
/** Nothing booked, nothing being released, no stray bots. */
export const settled = (b: Bot) => (b.phase === 'idle' || b.phase === 'done' || !b.phase) && !b.strays?.length;
/** Whether the booking can still be sent again under its idempotency key. */
export const withinKey = (b: Pick<Bot, 'bookedAt'>, t: number) => !!b.bookedAt && t - Date.parse(b.bookedAt) < IDEMPOTENCY_KEY_MS;

export const idleBot = (): Bot => ({ provider: 'recall', phase: 'idle', gen: 0, status: 'scheduled' });

/** Records from before the state machine. */
function normalise(m: Meeting) {
  const b = m.bot;
  if (!b || b.provider !== 'recall' || b.phase) return;
  b.gen = 0;
  if (b.status === 'done') b.phase = 'done';
  else if (b.botId && b.leaving) Object.assign(b, { phase: 'releasing', release: 'leave', after: 'done' });
  else if (b.botId) b.phase = 'booked';
  else if (b.bookingId && b.uncertain) b.phase = 'booking';
  else b.phase = 'idle';
}

/** The fields the page reads, from the phase. */
function derive(m: Meeting) {
  const b = m.bot;
  if (!tracked(m) || !b) return;
  const releasingOld = b.phase === 'releasing' && b.after !== 'done';
  const unknown = (b.phase === 'booking' || b.phase === 'releasing') && !b.botId && !!b.bookingId;
  b.uncertain = unknown || undefined;
  // Set by a failed step, by the sweep's clock (see `failed`); cleared once the booking is known.
  if (!unknown) b.unconfirmed = undefined;
  b.leaving = (b.phase === 'releasing' && b.after === 'done') || undefined;
  b.cancelError = releasingOld && b.attempts ? (b.fault ?? 'Cancelling the bot is being retried.') : undefined;
  b.error = releasingOld ? undefined : (b.fault ?? (m.status === 'error' ? 'The call ended before the bot could join.' : undefined));
  b.status =
    m.status === 'error'
      ? 'error'
      : b.phase === 'done'
        ? 'done'
        : b.phase === 'idle'
          ? b.fault && m.source === 'google-meet-bot'
            ? 'error'
            : 'scheduled'
          : releasingOld
            ? 'scheduled'
            : b.inCall
              ? 'in-call'
              : m.status === 'live' && b.phase !== 'booking'
                ? 'joining'
                : 'scheduled';
}

/** Marks an in-place change of the record (new generation, page fields recomputed). */
export function bump(m: Meeting) {
  m.bot!.gen = (m.bot!.gen ?? 0) + 1;
  derive(m);
}

/* ------------------------------------------------------------------------ */
/* Transitions (each applied to the latest copy, under the meeting's lock)   */
/* ------------------------------------------------------------------------ */

function commit(m: Meeting) {
  if (m.withdrawn && (!m.bot || settled(m.bot))) {
    dropMeeting(m.id);
    return m;
  }
  const saved = saveMeeting(m);
  emit(saved, { type: 'meeting', meeting: saved });
  return saved;
}

/**
 * One compare-and-set on a meeting's bot record: `when` is checked on the latest
 * stored copy under the meeting's lock, and `change` applied (bumping the
 * generation) only if it holds. Undefined when it didn't apply.
 */
export function transition(id: string, when: (m: Tracked) => boolean, change: (m: Tracked) => void): Promise<Meeting | undefined> {
  return meetingLock(id, () => {
    const m = get<Meeting>('meetings', id);
    if (!m) return undefined;
    normalise(m);
    if (!tracked(m) || !when(m)) return undefined;
    change(m);
    bump(m);
    return commit(m);
  });
}

/* In-place changes, for code already holding the meeting's lock on its latest copy. Each bumps the generation. */

/** Records a booking (sent afterwards, from the meeting's lane). Only from idle. */
export function beginBooking(m: Meeting, joinAt: string | undefined, at: Date) {
  normalise(m);
  const b = m.bot;
  if (!m.meetingUrl || (tracked(m) && m.bot.phase !== 'idle')) return false;
  m.bot = {
    provider: 'recall',
    phase: 'booking',
    gen: b?.gen ?? 0,
    status: 'scheduled',
    bookingId: newId('bk'),
    bookedUrl: m.meetingUrl,
    bookedAt: at.toISOString(),
    joinAt,
    chat: !!m.postPromptsToChat,
    attempts: 0,
    fault: b?.fault,
    strays: b?.strays,
    released: b?.released,
  };
  bump(m);
  return true;
}

/**
 * Starts getting rid of the meeting's bot (or its unanswered booking). `after`:
 * what the record becomes once Recall.ai confirms. Returns whether anything is
 * still outstanding (false: nothing was booked).
 */
export function beginRelease(m: Meeting, mode: 'cancel' | 'leave', after: 'idle' | 'done') {
  normalise(m);
  if (!tracked(m)) return false;
  const b = m.bot;
  if (b.phase === 'done') return !settled(b);
  if (b.phase === 'idle') {
    if (after === 'done') {
      b.phase = 'done';
      bump(m);
    }
    return !settled(b);
  }
  if (b.phase === 'releasing') {
    // Asked again (End call after a skip, say): the stronger outcome wins.
    if (after === 'done' && b.after !== 'done') {
      b.after = 'done';
      bump(m);
    }
    return true;
  }
  Object.assign(b, { phase: 'releasing', release: mode, after, attempts: 0, nextAt: undefined, fault: undefined });
  bump(m);
  return true;
}

/** Once release is confirmed: the record settles as `after` says. */
function finishRelease(m: Tracked) {
  const b = m.bot;
  const released = [...(b.released ?? []), ...(b.botId ? [b.botId] : [])].slice(-RELEASED_KEEP);
  m.bot =
    b.after === 'done'
      ? { provider: 'recall', phase: 'done', gen: b.gen, status: 'done', botId: b.botId, inCall: b.inCall, strays: b.strays, released }
      : { provider: 'recall', phase: 'idle', gen: b.gen, status: 'scheduled', strays: b.strays, released };
}

function addStrays(m: Tracked, ids: string[]) {
  const b = m.bot;
  const fresh = ids.filter((id) => id !== b.botId && !b.released?.includes(id) && !b.strays?.includes(id));
  if (fresh.length) b.strays = [...(b.strays ?? []), ...fresh];
  return fresh.length > 0;
}

/** A bot from this meeting's webhook that isn't its bot: recorded, to be cancelled. */
export function noteStray(m: Meeting, botId: string) {
  normalise(m);
  if (!tracked(m) || !addStrays(m, [botId])) return false;
  bump(m);
  return true;
}

/** Whether this bot was confirmed gone (or is being cancelled as a stray): its lines are dropped quietly. */
export const knownGone = (b: Bot, botId: string) => !!b.released?.includes(botId) || !!b.strays?.includes(botId);

/** Recall.ai named the bot (in its reply, a listing, or the bot's first line) for this booking. Identity-checked. */
export function adoptInPlace(m: Tracked, bookingId: string | undefined, found: { id: string; ended?: boolean }[]) {
  const b = m.bot;
  if (!bookingId || b.bookingId !== bookingId || (b.phase !== 'booking' && b.phase !== 'releasing')) return false;
  const mine = b.botId ?? (found.find((f) => !f.ended) ?? found[0])?.id;
  if (!mine) return false;
  const others = found.filter((f) => f.id !== mine);
  addStrays(
    m,
    others.filter((f) => !f.ended).map((f) => f.id),
  );
  const finished = found.find((f) => f.id === mine)?.ended;
  Object.assign(b, {
    botId: mine,
    attempts: 0,
    nextAt: undefined,
    fault: undefined,
    released: [...(b.released ?? []), ...others.filter((f) => f.ended).map((f) => f.id)].slice(-RELEASED_KEEP),
  });
  if (finished) {
    // Already over: nothing left to release. A booking whose bot has finished books afresh if there's still time.
    if (b.phase === 'releasing') finishRelease(m);
    else m.bot = { provider: 'recall', phase: 'idle', gen: b.gen, status: 'scheduled', strays: b.strays, released: [...(b.released ?? []), mine].slice(-RELEASED_KEEP) };
  } else if (b.phase === 'booking') b.phase = 'booked';
  return true;
}

/* ------------------------------------------------------------------------ */
/* Lanes: the requests for one meeting, one at a time                         */
/* ------------------------------------------------------------------------ */

const lanes = new Map<string, Promise<void>>();
const queued = new Map<string, Promise<void>>();
const extra = new Set<Promise<unknown>>();

/** Work started but not waited for (analysis after a bot left, say). */
export function background<T>(p: Promise<T>) {
  extra.add(p);
  void p.finally(() => extra.delete(p)).catch(() => undefined);
  return p;
}

/** Resolves once every lane and background task has finished. For tests and shutdown. */
export async function lanesIdle() {
  while (lanes.size || queued.size || extra.size) {
    await Promise.allSettled([...lanes.values(), ...queued.values(), ...extra]);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const laneBusy = (id: string) => lanes.has(id) || queued.has(id);

/**
 * Moves the meeting's record along as far as Recall.ai allows right now. If its
 * lane is busy, one more run is queued after the current one (and shared by
 * everyone asking meanwhile). `now`: the bot clock's time, which sets backoff;
 * without it (someone acting on the call) failures leave timing to the next sweep.
 */
export function drive(id: string, now?: number): Promise<void> {
  const q = queued.get(id);
  if (q) return q;
  const cur = lanes.get(id);
  if (cur) {
    const next = cur.then(() => {
      queued.delete(id);
      return drive(id, now);
    });
    queued.set(id, next);
    return next;
  }
  const run = work(id, now)
    .catch((err) => console.warn(`[meet-bot] ${id}: ${(err as Error).message}`))
    .finally(() => lanes.delete(id));
  lanes.set(id, run);
  return run;
}

async function work(id: string, now?: number) {
  for (let pass = 0; pass < 6; pass++) {
    const m = get<Meeting>('meetings', id);
    if (!m) return;
    normalise(m);
    if (!tracked(m)) return;
    const b = m.bot;
    let progressed = false;
    if (b.phase === 'booking' || (b.phase === 'releasing' && !b.botId)) progressed = await settleBooking(m, now);
    else if (b.phase === 'releasing') progressed = await releaseBot(m, now);
    if (!progressed) break;
  }
  await cancelStrays(id, now);
  // A withdrawn meeting goes once nothing is outstanding.
  await transition(
    id,
    (m) => !!m.withdrawn && settled(m.bot),
    () => undefined,
  );
}

function backoff(b: Bot, now: number) {
  const lookingOnly = !b.botId && !withinKey(b, now);
  if (lookingOnly && b.bookedAt && now - Date.parse(b.bookedAt) >= SLOW_LOOKUP_AFTER_MS) return 6 * HOUR;
  // The first retry is at the next sweep, then each waits twice as long, up to 30 minutes.
  return Math.min(30, 2 ** Math.max(0, (b.attempts ?? 0) - 2)) * MINUTE;
}

/** A step that didn't get an answer: counted, with the next try backed off. Only if nothing changed meanwhile. */
function failed(id: string, gen: number, fault: string, now?: number) {
  return transition(
    id,
    (m) => m.bot.gen === gen,
    (m) => {
      const b = m.bot;
      b.attempts = (b.attempts ?? 0) + 1;
      b.fault = fault;
      b.nextAt = now !== undefined && b.attempts > 1 ? now + backoff(b, now) : undefined;
      // A booking that can no longer be sent again and hasn't turned up: a facilitator may dismiss it.
      b.unconfirmed = (!b.botId && !!b.bookingId && !withinKey(b, now ?? Date.now())) || undefined;
    },
  );
}

const NOT_LISTED = 'Recall.ai hasn’t confirmed the bot’s booking and doesn’t list it yet; Concord keeps looking for it.';
const CANT_ASK = 'Couldn’t check with Recall.ai whether the bot’s booking went through; retrying.';

async function lookup(m: Tracked) {
  try {
    return (await recall.findBots(m.bot.bookedUrl ?? m.meetingUrl!, m.id)).filter((f) => f.booking === m.bot.bookingId);
  } catch {
    return undefined;
  }
}

function webhookSecret(meetingId: string) {
  let secret = get<{ id: string; secret: string }>('kv', `meeting-secret:${meetingId}`)?.secret;
  if (!secret) {
    secret = newToken();
    put('kv', { id: `meeting-secret:${meetingId}`, secret });
  }
  return secret;
}

/** Sends the record's booking (again), exactly as first recorded, under its idempotency key. */
async function send(m: Tracked): Promise<{ id: string } | { refused: boolean; error: string }> {
  const b = m.bot;
  try {
    const bot = await recall.createBot({
      meetingId: m.id,
      bookingId: b.bookingId,
      meetingUrl: b.bookedUrl ?? m.meetingUrl!,
      joinAt: b.joinAt,
      postPromptsToChat: !!b.chat,
      webhookUrl: `${config.publicUrl}/api/webhooks/recall?meeting=${m.id}&secret=${webhookSecret(m.id)}`,
    });
    return { id: bot.id };
  } catch (err) {
    const uncertain = !(err instanceof BookingError) || err.uncertain;
    return { refused: !uncertain, error: (err as Error).message };
  }
}

/**
 * Finds out what an unanswered booking made: looks it up (except before its first
 * send), and while its key is honoured sends it again, which returns its bot or a
 * definite refusal. Past that, only lookups. Returns whether the record moved on.
 */
async function settleBooking(m: Tracked, now?: number): Promise<boolean> {
  const b = m.bot;
  const gen = b.gen;
  const bookingId = b.bookingId;
  if (!bookingId) {
    // Releasing with nothing booked: nothing to wait for.
    return !!(await transition(m.id, (x) => x.bot.gen === gen, finishRelease));
  }
  const replayable = withinKey(b, now ?? Date.now());
  if (b.attempts || b.phase === 'releasing' || !replayable) {
    const found = await lookup(m);
    if (found?.length) return adopt(m.id, bookingId, found);
    if (!replayable) {
      await failed(m.id, gen, found ? NOT_LISTED : CANT_ASK, now);
      return false;
    }
  }
  const r = await send(m);
  if ('id' in r) return adopt(m.id, bookingId, [{ id: r.id }]);
  if (r.refused) {
    // A definite answer to this key: no bot was made from it.
    return !!(await transition(
      m.id,
      (x) => x.bot.bookingId === bookingId && !x.bot.botId && (x.bot.phase === 'booking' || x.bot.phase === 'releasing'),
      (x) => {
        if (x.bot.phase === 'releasing') finishRelease(x);
        else x.bot = { provider: 'recall', phase: 'idle', gen: x.bot.gen, status: 'scheduled', fault: r.error, strays: x.bot.strays, released: x.bot.released };
      },
    ));
  }
  await failed(m.id, gen, r.error, now);
  return false;
}

/** Applies Recall.ai's answer by identity: only to the booking it is about. Bots that aren't this booking's become strays. */
async function adopt(id: string, bookingId: string, found: { id: string; ended?: boolean }[]) {
  const done = await transition(
    id,
    (m) => m.bot.bookingId === bookingId && (m.bot.phase === 'booking' || m.bot.phase === 'releasing'),
    (m) => void adoptInPlace(m, bookingId, found),
  );
  if (done) {
    if (tracked(done) && done.bot.phase === 'done') background(finishCall(id));
    return true;
  }
  // The record has moved on (the bot was named meanwhile, say): anything else found is cancelled.
  await transition(
    id,
    (m) => found.some((f) => !f.ended && f.id !== m.bot.botId && !knownGone(m.bot, f.id)),
    (m) =>
      void addStrays(
        m,
        found.filter((f) => !f.ended).map((f) => f.id),
      ),
  );
  return false;
}

async function releaseBot(m: Tracked, now?: number): Promise<boolean> {
  const b = m.bot;
  const gen = b.gen;
  const botId = b.botId!;
  const r = await recall.release(botId, b.release ?? 'cancel');
  if (!r.ok) {
    await failed(m.id, gen, r.error, now);
    return false;
  }
  // Confirmed for this bot: settles the record only if it is still releasing this same bot.
  const done = await transition(
    m.id,
    (x) => x.bot.phase === 'releasing' && x.bot.botId === botId,
    (x) => finishRelease(x),
  );
  if (done && tracked(done) && done.bot.phase === 'done') background(finishCall(m.id));
  return !!done;
}

async function cancelStrays(id: string, now?: number) {
  const m = get<Meeting>('meetings', id);
  if (!tracked(m) || !m.bot.strays?.length) return;
  for (const stray of m.bot.strays) {
    const gen = get<Meeting>('meetings', id)?.bot?.gen ?? 0;
    const r = await recall.release(stray, 'cancel');
    if (r.ok)
      await transition(
        id,
        (x) => !!x.bot.strays?.includes(stray),
        (x) => {
          x.bot.strays = x.bot.strays!.filter((s) => s !== stray);
          if (!x.bot.strays.length) x.bot.strays = undefined;
          x.bot.released = [...(x.bot.released ?? []), stray].slice(-RELEASED_KEEP);
        },
      );
    else await failed(id, gen, r.error, now);
  }
}

/* ------------------------------------------------------------------------ */
/* The sweep, and a facilitator's say-so                                     */
/* ------------------------------------------------------------------------ */

/** Whether the record has something to do with Recall.ai, and its turn has come. */
export function due(m: Meeting, t: number) {
  if (!tracked(m)) return false;
  const b = m.bot;
  const work = b.phase === 'booking' || b.phase === 'releasing' || !!b.strays?.length || (!!m.withdrawn && settled(b));
  return work && (b.nextAt === undefined || b.nextAt <= t);
}

/** Starts the lanes of every record whose turn has come (lanes already running are left to finish). */
export function driveDue(t: number) {
  const runs: Promise<void>[] = [];
  for (const m of list<Meeting>('meetings')) if (due(m, t) && !laneBusy(m.id)) runs.push(drive(m.id, t));
  return runs;
}

/** How many meetings are still getting rid of a bot (or of bots that turned up uninvited). */
export const releasingCount = () => list<Meeting>('meetings').filter((m) => tracked(m) && (m.bot.phase === 'releasing' || !!m.bot.strays?.length)).length;

/**
 * A facilitator's confirmation that an unconfirmed booking can be let go: only one
 * that can no longer be sent again safely (its key has expired) and that Recall.ai
 * hasn't listed. Booking: the call may book again. Releasing: release is done.
 */
export async function dismissUnconfirmed(id: string) {
  const m = await transition(
    id,
    (x) => (x.bot.phase === 'booking' || x.bot.phase === 'releasing') && !x.bot.botId && !!x.bot.bookingId && !!x.bot.unconfirmed,
    (x) => {
      if (x.bot.phase === 'releasing') finishRelease(x);
      else x.bot = { provider: 'recall', phase: 'idle', gen: x.bot.gen, status: 'scheduled', strays: x.bot.strays, released: x.bot.released };
    },
  );
  if (m && tracked(m) && m.bot.phase === 'done') background(finishCall(id));
  return m;
}
