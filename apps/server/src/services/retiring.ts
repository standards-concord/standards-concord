import { get, list, put, remove } from '../db.js';
import { recall } from './recall.js';

/**
 * Bots that must go: cancelled, skipped, unapproved, moved or replaced. Each is
 * recorded here before Concord forgets it on the meeting, and retried until
 * Recall.ai confirms, whatever happens to the meeting meanwhile.
 *
 * A booking whose reply was lost is recorded by its booking id (the metadata
 * Concord attaches when booking) and the Meet link it was booked for. Not seeing
 * it in one listing doesn't prove it was never made (a slow create can still
 * land), so it is watched for WATCH_MS before Concord gives up looking.
 *
 * Retries back off (one minute, doubling, up to thirty), one attempt per entry at
 * a time, each bounded by Recall.ai request deadlines. A cancelled bot leaves a
 * tombstone so a late webhook from it is still dropped.
 */
type Retiring = {
  id: string;
  meetingId: string;
  botId?: string;
  bookingId?: string;
  meetingUrl?: string;
  error?: string;
  attempts: number;
  /** Not retried before this time (ms). */
  nextAt?: number;
  /** For an unconfirmed booking: when looking for it started (ms, by the sweep's clock). */
  watchFrom?: number;
};

const PREFIX = 'meet-bot:retire:';
/** Bots already cancelled: remembered so a late webhook from one is still dropped. */
const GONE = 'meet-bot:retired:';
/** How long an unconfirmed booking that can't be found is watched for. */
export const WATCH_MS = 6 * 60 * 60 * 1000;
const TOMBSTONE_MS = 7 * 24 * 60 * 60 * 1000;
const MINUTE = 60_000;

const keyFor = (r: { botId?: string; bookingId?: string; meetingId: string }) => `${PREFIX}${r.botId ?? `booking:${r.meetingId}:${r.bookingId ?? 'untagged'}`}`;
const tombstone = (botId: string) => put('kv', { id: `${GONE}${botId}`, at: Date.now() });
const records = () => list<Retiring>('kv').filter((k) => k.id.startsWith(PREFIX));
/** Entries with an attempt in flight: never two requests for the same bot at once. */
const inFlight = new Set<string>();

/** Whether this bot was told to go: anything it sends is dropped. */
export const isRetired = (botId: string) => !!get('kv', `${PREFIX}${botId}`) || !!get('kv', `${GONE}${botId}`);

/** How many bots Concord is still trying to cancel (not counting bookings it is only watching for). */
export const retiringCount = () => records().filter((r) => r.botId || r.error).length;

type Outcome = { ok: true; watching?: boolean } | { ok: false; error: string };

/** One try. Settles the record (removes it) or leaves it for the next sweep. */
async function attempt(r: Retiring, now: number): Promise<Outcome> {
  if (r.botId) {
    const c = await recall.cancelBot(r.botId);
    if (!c.ok) return c;
    tombstone(r.botId);
    remove('kv', r.id);
    return { ok: true };
  }
  if (!r.meetingUrl) {
    remove('kv', r.id);
    return { ok: true };
  }
  let found: { id: string; booking?: string }[];
  try {
    found = await recall.findBots(r.meetingUrl, r.meetingId);
  } catch {
    return { ok: false, error: 'Couldn’t check with Recall.ai whether an unconfirmed booking went through; retrying.' };
  }
  // Only the lost booking itself, never a later one for the same meeting.
  const mine = found.filter((b) => b.booking === r.bookingId);
  if (!mine.length) {
    // Not there (yet): keep watching for a while rather than take one listing's word for it.
    if (now - (r.watchFrom ?? now) >= WATCH_MS) {
      remove('kv', r.id);
      return { ok: true };
    }
    return { ok: true, watching: true };
  }
  let failed: string | undefined;
  for (const b of mine) {
    const c = await recall.cancelBot(b.id);
    if (c.ok) tombstone(b.id);
    else {
      // Found but not cancelled: tracked by its own id from now on, and reported as still going.
      failed = c.error;
      if (!get('kv', `${PREFIX}${b.id}`)) put('kv', { id: `${PREFIX}${b.id}`, meetingId: r.meetingId, botId: b.id, attempts: 1, error: c.error } satisfies Retiring);
    }
  }
  remove('kv', r.id);
  return failed ? { ok: false, error: failed } : { ok: true };
}

/** `now` is the sweep's clock; an immediate attempt (no clock) leaves the timing to the next sweep. */
async function run(r: Retiring, now?: number): Promise<Outcome> {
  if (inFlight.has(r.id)) return { ok: false, error: r.error ?? 'Cancelling the bot is already in progress.' };
  inFlight.add(r.id);
  try {
    const out = await attempt({ ...r, watchFrom: r.watchFrom ?? now }, now ?? 0);
    const still = get<Retiring>('kv', r.id);
    if (still) {
      const attempts = (still.attempts ?? 0) + 1;
      // The first retry is due at the next sweep, then waits double each time (capped at 30 minutes).
      const wait = Math.min(30, 2 ** Math.max(0, attempts - 2)) * MINUTE;
      put('kv', { ...still, attempts, watchFrom: still.watchFrom ?? now, nextAt: now !== undefined && attempts > 1 ? now + wait : undefined, error: out.ok ? undefined : out.error } satisfies Retiring);
    }
    return out;
  } finally {
    inFlight.delete(r.id);
  }
}

type BotRef = { provider?: string; botId?: string; bookingId?: string; uncertain?: boolean; bookedUrl?: string } | undefined;

/**
 * Records a meeting's bot (or unconfirmed booking) as one to cancel, and tries
 * straight away. The caller can forget the bot on the meeting either way. A bot
 * already cancelled isn't asked about again, and one already on record only
 * with retryNow (otherwise the sweep carries on with it, backing off).
 */
export async function retireBot(meetingId: string, bot: BotRef, meetingUrl?: string, opts: { retryNow?: boolean } = {}): Promise<Outcome> {
  if (!bot || bot.provider !== 'recall' || (!bot.botId && !bot.uncertain && !bot.bookingId) || !recall.enabled()) return { ok: true };
  if (bot.botId && get('kv', `${GONE}${bot.botId}`)) return { ok: true };
  const r: Retiring = { id: '', meetingId, botId: bot.botId, bookingId: bot.botId ? undefined : bot.bookingId, meetingUrl: bot.botId ? undefined : (bot.bookedUrl ?? meetingUrl), attempts: 0 };
  r.id = keyFor(r);
  const existing = get<Retiring>('kv', r.id);
  // Already on record: a stale webhook just leaves it to the sweep; someone acting on the call (retryNow) tries again now.
  if (existing && !opts.retryNow) return existing.error ? { ok: false, error: existing.error } : { ok: true, watching: !existing.botId };
  if (existing) return run(existing);
  put('kv', r);
  return run(r);
}

/** Records an unconfirmed booking to watch for, without asking Recall.ai now (it was just asked). */
export function watchBooking(meetingId: string, bookingId: string | undefined, meetingUrl: string | undefined) {
  if (!meetingUrl || !recall.enabled()) return;
  const r: Retiring = { id: '', meetingId, bookingId, meetingUrl, attempts: 1 };
  r.id = keyFor(r);
  if (!get('kv', r.id)) put('kv', r);
}

/** Retries every bot still waiting to be cancelled whose turn has come, and forgets old tombstones. */
export async function retireDue(now = new Date()) {
  const t = now.getTime();
  for (const r of records()) if (!r.nextAt || r.nextAt <= t) await run(r, t);
  for (const g of list<{ id: string; at?: number }>('kv')) if (g.id.startsWith(GONE) && (g.at ?? 0) < Date.now() - TOMBSTONE_MS) remove('kv', g.id);
}
