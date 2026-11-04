import { clock } from '../clock.js';
import { get, list, put, remove } from '../db.js';
import { recall } from './recall.js';

/**
 * Bots that must go: cancelled, skipped, unapproved, moved or replaced. Each is
 * recorded here before Concord forgets it on the meeting, and retried every
 * minute until Recall.ai confirms, whatever happens to the meeting meanwhile.
 * A booking whose reply was lost is recorded by its booking id (the metadata
 * Concord attaches when booking) and the Meet link it was booked for, so it is
 * found again even if the invite has changed since.
 */
type Retiring = { id: string; meetingId: string; botId?: string; bookingId?: string; meetingUrl?: string; since: string; error?: string };

const PREFIX = 'meet-bot:retire:';
/** Bots already cancelled: remembered so a late webhook from one is still dropped. */
const GONE = 'meet-bot:retired:';
const tombstone = (botId: string) => put('kv', { id: `${GONE}${botId}`, at: clock.iso() });
const keyFor = (r: { botId?: string; bookingId?: string; meetingId: string }) => `${PREFIX}${r.botId ?? `booking:${r.meetingId}:${r.bookingId ?? 'unknown'}`}`;

/** Whether this bot was told to go: anything it sends is dropped. */
export const isRetired = (botId: string) => !!get('kv', `${PREFIX}${botId}`) || !!get('kv', `${GONE}${botId}`);

/** How many bots Concord is still trying to cancel. */
export const retiringCount = () => list<{ id: string }>('kv').filter((k) => k.id.startsWith(PREFIX)).length;

async function attempt(r: Retiring): Promise<{ ok: true } | { ok: false; error: string }> {
  if (r.botId) {
    const c = await recall.cancelBot(r.botId);
    if (c.ok) tombstone(r.botId);
    return c;
  }
  if (!r.meetingUrl) return { ok: true };
  let found: { id: string; booking?: string }[];
  try {
    found = await recall.findBots(r.meetingUrl, r.meetingId);
  } catch {
    return { ok: false, error: 'Couldn’t check with Recall.ai whether an unconfirmed booking went through; retrying.' };
  }
  for (const b of found) {
    // Only the lost booking itself, never a later one for the same meeting.
    if (b.booking !== r.bookingId) continue;
    const c = await recall.cancelBot(b.id);
    // Track that bot by its own id from now on.
    if (c.ok) tombstone(b.id);
    else put('kv', { id: `${PREFIX}${b.id}`, meetingId: r.meetingId, botId: b.id, since: r.since, error: c.error });
  }
  return { ok: true };
}

/**
 * Records a meeting's bot (or unconfirmed booking) as one to cancel, and tries
 * straight away. The caller can forget the bot on the meeting either way.
 */
export async function retireBot(
  meetingId: string,
  bot: { provider?: string; botId?: string; bookingId?: string; uncertain?: boolean; bookedUrl?: string } | undefined,
  meetingUrl?: string,
) {
  if (!bot || bot.provider !== 'recall' || (!bot.botId && !bot.uncertain && !bot.bookingId) || !recall.enabled()) return { ok: true as const };
  const r: Retiring = {
    id: '',
    meetingId,
    botId: bot.botId,
    bookingId: bot.botId ? undefined : bot.bookingId,
    meetingUrl: bot.botId ? undefined : (bot.bookedUrl ?? meetingUrl),
    since: clock.iso(),
  };
  r.id = keyFor(r);
  put('kv', r);
  const out = await attempt(r);
  if (out.ok) remove('kv', r.id);
  else put('kv', { ...r, error: out.error });
  return out;
}

/** Retries every bot still waiting to be cancelled. */
export async function retireDue() {
  for (const r of list<Retiring>('kv').filter((k) => k.id.startsWith(PREFIX))) {
    const out = await attempt(r);
    if (out.ok) remove('kv', r.id);
  }
}
