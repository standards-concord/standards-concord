import { get, list, put, remove } from '../db.js';
import { recall } from './recall.js';

/**
 * Bots that must go: cancelled, skipped, unapproved, moved, replaced or ended.
 * Each is recorded here before Concord forgets it on the meeting, and retried
 * until Recall.ai confirms (or says the bot has already finished), whatever
 * happens to the meeting meanwhile. Every request to cancel a bot goes through
 * here, so retries back off (next sweep, then 1, 2, 4… minutes up to 30), and
 * there is only ever one request per bot at a time, each with a deadline.
 *
 * A booking whose reply was lost is recorded by its booking id (the metadata
 * and idempotency key Concord sends when booking) and the Meet link it was
 * booked for. Not seeing it in a listing doesn't prove it was never made, so it
 * is looked for again and again (backing off to every six hours after the first
 * six) for WATCH_MAX_MS. By then any bot from that booking has long finished:
 * Recall.ai bots join within minutes of their start time and leave when the
 * call ends. A bot found this way is tracked by its own id from then on.
 *
 * A cancelled bot leaves a tombstone so a late webhook from it is still dropped.
 */
type Retiring = {
  id: string;
  meetingId: string;
  botId?: string;
  /** Taking a bot out of a call (End call), rather than cancelling its booking. */
  leave?: boolean;
  bookingId?: string;
  meetingUrl?: string;
  error?: string;
  attempts: number;
  /** Not retried before this time (ms, by the sweep's clock). */
  nextAt?: number;
  /** For an unconfirmed booking: when looking for it started (ms, by the sweep's clock). */
  watchFrom?: number;
};

const PREFIX = 'meet-bot:retire:';
/** Bots already cancelled: remembered so a late webhook from one is still dropped. */
const GONE = 'meet-bot:retired:';
const HOUR = 60 * 60 * 1000;
const MINUTE = 60_000;
/** After this long without a sighting, an unconfirmed booking is looked for only every six hours. */
export const WATCH_MS = 6 * HOUR;
/** And after this long, it is let go. */
export const WATCH_MAX_MS = 7 * 24 * HOUR;
const TOMBSTONE_MS = 30 * 24 * HOUR;

const botKey = (botId: string) => `${PREFIX}${botId}`;
const keyFor = (r: { botId?: string; bookingId?: string; meetingId: string }) => (r.botId ? botKey(r.botId) : `${PREFIX}booking:${r.meetingId}:${r.bookingId ?? 'untagged'}`);
const tombstone = (botId: string) => put('kv', { id: `${GONE}${botId}`, at: Date.now() });
const records = () => list<Retiring>('kv').filter((k) => k.id.startsWith(PREFIX));
/** Entries with an attempt in flight: never two requests for the same bot at once. */
const inFlight = new Set<string>();

/** Whether any cancellation attempt is running. */
export const ledgerBusy = () => inFlight.size > 0;

/** Whether this bot was told to go: anything it sends is dropped. */
export const isRetired = (botId: string) => !!get('kv', botKey(botId)) || !!get('kv', `${GONE}${botId}`);

/** Where cancelling this bot stands: gone (confirmed), pending (still being retried), or never asked. */
export function retireState(botId: string): 'gone' | 'pending' | 'none' {
  if (get('kv', `${GONE}${botId}`)) return 'gone';
  return get('kv', botKey(botId)) ? 'pending' : 'none';
}

/** How many bots (or unconfirmed bookings) Concord is still trying to cancel. */
export const retiringCount = () => records().length;

export type Outcome = { ok: true } | { ok: false; error: string; watching?: boolean };

/** Recorded (if not already) and tried, under the one-at-a-time rule. */
async function cancelById(meetingId: string, botId: string, now?: number) {
  const id = botKey(botId);
  if (get('kv', `${GONE}${botId}`)) return { ok: true } as Outcome;
  const r = get<Retiring>('kv', id) ?? put('kv', { id, meetingId, botId, attempts: 0 } satisfies Retiring);
  return run(r as Retiring, now);
}

/** One try. Settles the record (removes it) or leaves it for the next sweep. */
async function attempt(r: Retiring, now: number): Promise<Outcome> {
  if (r.botId) {
    const c = r.leave ? await recall.leave(r.botId) : await recall.cancelBot(r.botId);
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
    // Not there (yet): keep looking rather than take one listing's word for it.
    if (now - (r.watchFrom ?? now) >= WATCH_MAX_MS) {
      remove('kv', r.id);
      return { ok: true };
    }
    return { ok: false, watching: true, error: 'A booking Recall.ai never confirmed isn’t listed yet; Concord keeps looking for it, to cancel it.' };
  }
  // Found: from now on each bot is its own entry (so it is never asked about twice at once), and this one is done.
  remove('kv', r.id);
  let failed: string | undefined;
  for (const b of mine) {
    const c = await cancelById(r.meetingId, b.id);
    if (!c.ok) failed = c.error;
  }
  return failed ? { ok: false, error: failed } : { ok: true };
}

function backoff(attempts: number, watchedFor: number) {
  if (watchedFor >= WATCH_MS) return 6 * HOUR;
  return Math.min(30, 2 ** Math.max(0, attempts - 2)) * MINUTE;
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
      const watchFrom = still.watchFrom ?? now;
      // The first retry is due at the next sweep, then waits double each time.
      const nextAt = now !== undefined && attempts > 1 ? now + backoff(attempts, now - (watchFrom ?? now)) : undefined;
      put('kv', { ...still, attempts, watchFrom, nextAt, error: out.ok ? undefined : out.error } satisfies Retiring);
    }
    return out;
  } finally {
    inFlight.delete(r.id);
  }
}

type BotRef = { provider?: string; botId?: string; bookingId?: string; uncertain?: boolean; bookedUrl?: string; leave?: boolean } | undefined;

/**
 * Records a meeting's bot (or unconfirmed booking) as one to cancel. The caller
 * can forget the bot on the meeting either way.
 *  - Tried straight away unless `background` (then the attempt runs without
 *    holding up the caller, as during a calendar sync).
 *  - A bot already on record is tried again only with `retryNow` (someone acting
 *    on the call); otherwise the sweep carries on with it, backing off.
 *  - A bot already cancelled isn't asked about again.
 */
export async function retireBot(meetingId: string, bot: BotRef, meetingUrl?: string, opts: { retryNow?: boolean; background?: boolean } = {}): Promise<Outcome & { queued?: boolean }> {
  if (!bot || bot.provider !== 'recall' || (!bot.botId && !bot.uncertain && !bot.bookingId) || !recall.enabled()) return { ok: true };
  if (bot.botId && get('kv', `${GONE}${bot.botId}`)) return { ok: true };
  const r: Retiring = { id: '', meetingId, botId: bot.botId, leave: bot.botId && bot.leave ? true : undefined, bookingId: bot.botId ? undefined : bot.bookingId, meetingUrl: bot.botId ? undefined : (bot.bookedUrl ?? meetingUrl), attempts: 0 };
  r.id = keyFor(r);
  const existing = get<Retiring>('kv', r.id);
  if (existing && !opts.retryNow) return existing.error ? { ok: false, error: existing.error } : { ok: true };
  const entry = existing ?? (put('kv', r) as Retiring);
  if (opts.background) {
    void run(entry).catch(() => undefined);
    return { ok: true, queued: true };
  }
  return run(entry);
}

/** Records an unconfirmed booking to look for, without asking Recall.ai now (it was just asked). */
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
