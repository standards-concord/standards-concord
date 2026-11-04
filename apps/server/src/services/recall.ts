import { config } from '../config.js';

/**
 * Recall.ai adapter. The Google Meet Media API is in a closed developer preview,
 * so a real bot joins through Recall.ai (or a self-hosted Attendee, which has a
 * near-identical API: point RECALL_API_BASE at it). Without a key, bots are simulated.
 */

/** Google Meet rejects longer chat messages; Recall.ai passes the error through. */
export const MEET_CHAT_MAX = 500;

const base = () => config.meetBot.recallApiBase ?? `https://${config.meetBot.recallRegion}.recall.ai/api/v1`;
/** Deadlines, so one stalled request can't hold up everything queued behind it. */
const REQUEST_MS = 10_000;
const BOOKING_MS = 30_000;
const deadline = (ms = REQUEST_MS) => AbortSignal.timeout(ms);
const headers = () => ({
  Authorization: `Token ${config.meetBot.recallApiKey}`,
  'Content-Type': 'application/json',
});

export function chatText(message: string) {
  return message.length <= MEET_CHAT_MAX ? message : `${message.slice(0, MEET_CHAT_MAX - 1).trimEnd()}…`;
}

/** Takes links and Meet codes out of what Recall.ai says, since its errors can echo the call's Meet link. */
export function scrub(text: string) {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[link]').replace(/\b[a-z]{3}-[a-z]{4}-[a-z]{3}\b/gi, '[meeting code]');
}

async function failure(res: Response) {
  return `Recall.ai returned ${res.status}: ${scrub((await res.text().catch(() => '')).slice(0, 300))}`;
}

/**
 * A booking request that failed. `uncertain` means Recall.ai may have created the
 * bot anyway (the connection dropped, or it answered with a server error), so
 * look for it before booking again: Recall.ai doesn't deduplicate bookings.
 */
export class BookingError extends Error {
  constructor(
    message: string,
    readonly uncertain: boolean,
  ) {
    // Whatever went wrong, the message never carries the Meet link.
    super(scrub(message));
  }
}

/**
 * Upper bounds on a bot's life, so a booking Concord lost track of can't linger:
 * it leaves a waiting room or an empty call after 20 minutes, and stops after six
 * hours in a call. With joining at most 15 minutes after booking, no bot outlives
 * its booking by more than about seven hours.
 */
export const BOT_LIFETIME = { waiting_room_timeout: 20 * 60, noone_joined_timeout: 20 * 60, in_call_recording_timeout: 6 * 60 * 60 };

/** How long Recall.ai honours an idempotency key; a replay is only sent well inside it. */
export const IDEMPOTENCY_KEY_MS = 50 * 60 * 1000;

type RecallBot = {
  id: string;
  metadata?: Record<string, string>;
  status_changes?: { code: string }[];
};
const ENDED = new Set(['done', 'call_ended', 'fatal', 'analysis_done', 'media_expired']);
const ended = (b: RecallBot) => ENDED.has(b.status_changes?.at(-1)?.code ?? '');

export const recall = {
  enabled: () => !!config.meetBot.recallApiKey,

  /**
   * Sends a bot to a call. With joinAt, Recall.ai schedules it to join at that
   * time (it asks for at least ten minutes' notice to guarantee a bot is free).
   */
  /** bookingId identifies this booking attempt, so a lost one is told apart from later ones. */
  async createBot(opts: { meetingUrl: string; webhookUrl: string; joinAt?: string; postPromptsToChat: boolean; meetingId: string; bookingId?: string }) {
    const intro = opts.postPromptsToChat
      ? `Hi, I'm ${config.meetBot.botName}. I'm transcribing this call to capture use cases and terms for the ontology, and I'll post the odd clarifying question here in the chat.`
      : `Hi, I'm ${config.meetBot.botName}. I'm transcribing this call to capture use cases and terms for the ontology. For now my suggestions go to the facilitator in Concord, not this chat; I'll say here if that changes.`;
    let res: Response;
    try {
      res = await fetch(`${base()}/bot/`, {
        method: 'POST',
        // Sending the same booking again (after a lost reply or a restart) returns the bot it made, rather than a second one.
        headers: { ...headers(), ...(opts.bookingId ? { 'Idempotency-Key': opts.bookingId } : {}) },
        signal: deadline(BOOKING_MS),
        body: JSON.stringify({
          meeting_url: opts.meetingUrl,
          bot_name: config.meetBot.botName,
          // Lets a lost booking be found again (see findBots).
          metadata: { concord_meeting: opts.meetingId, ...(opts.bookingId ? { concord_booking: opts.bookingId } : {}) },
          ...(opts.joinAt ? { join_at: opts.joinAt } : {}),
          automatic_leave: BOT_LIFETIME,
          chat: { on_bot_join: { send_to: 'everyone', message: intro } },
          recording_config: {
            transcript: { provider: { meeting_captions: {} } },
            realtime_endpoints: [
              {
                type: 'webhook',
                url: opts.webhookUrl,
                events: ['transcript.data'],
              },
            ],
          },
        }),
      });
    } catch (err) {
      throw new BookingError(`Could not reach Recall.ai: ${scrub((err as Error).message)}`, true);
    }
    // 409: a request with this idempotency key is still being handled, so the bot may well exist.
    if (!res.ok) throw new BookingError(await failure(res), res.status >= 500 || res.status === 409);
    // Accepted, but the reply got lost or garbled: the bot may well exist.
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new BookingError(`Recall.ai accepted the booking but its reply was unreadable: ${(err as Error).message}`, true);
    }
    // Anything but an object with a bot id (null, a list, a number, an empty id) is as good as no reply.
    const id = body && typeof body === 'object' && !Array.isArray(body) ? (body as { id?: unknown }).id : undefined;
    if (typeof id !== 'string' || !id) throw new BookingError('Recall.ai accepted the booking but sent no bot id.', true);
    return { id };
  },

  /**
   * Bots booked for this Concord meeting (found by the metadata createBot attaches),
   * finished or not. Throws if Recall.ai can't be asked.
   */
  async findBots(meetingUrl: string, meetingId: string): Promise<{ id: string; booking?: string; ended: boolean }[]> {
    const found: { id: string; booking?: string; ended: boolean }[] = [];
    let url: string | null = `${base()}/bot/?meeting_url=${encodeURIComponent(meetingUrl)}`;
    for (let page = 0; url && page < 10; page++) {
      const res: Response = await fetch(url, { headers: headers(), signal: deadline() });
      if (!res.ok) throw new Error(await failure(res));
      const body = (await res.json()) as { next?: string | null; results?: RecallBot[] } | null;
      for (const b of body?.results ?? []) if (b?.metadata?.concord_meeting === meetingId) found.push({ id: b.id, booking: b.metadata?.concord_booking, ended: ended(b) });
      url = body?.next ?? null;
    }
    return found;
  },

  /** Whether Recall.ai says this bot has finished (left, or the call ended). */
  async hasEnded(botId: string): Promise<boolean> {
    const res = await fetch(`${base()}/bot/${botId}/`, {
      headers: headers(),
      signal: deadline(),
    }).catch(() => undefined);
    if (res?.status === 404) return true;
    if (!res?.ok) return false;
    return ended((await res.json().catch(() => ({}))) as RecallBot);
  },

  /**
   * Gets rid of a bot: a scheduled bot is deleted, and one that is joining or in
   * the call is told to leave (Recall.ai refuses to delete those). `prefer` says
   * which to try first. ok only on confirmation: Recall.ai did it, doesn't know the
   * bot, or says it has finished. Otherwise the caller keeps the bot and retries.
   */
  async release(botId: string, prefer: 'cancel' | 'leave' = 'cancel'): Promise<{ ok: true } | { ok: false; error: string }> {
    const ways = prefer === 'leave' ? (['leave', 'delete'] as const) : (['delete', 'leave'] as const);
    const statuses: number[] = [];
    try {
      for (const way of ways) {
        const res = await fetch(way === 'delete' ? `${base()}/bot/${botId}/` : `${base()}/bot/${botId}/leave_call/`, {
          method: way === 'delete' ? 'DELETE' : 'POST',
          headers: headers(),
          signal: deadline(),
        });
        if (res.ok || res.status === 404) return { ok: true };
        statuses.push(res.status);
      }
    } catch (err) {
      if (await this.hasEnded(botId)) return { ok: true };
      return { ok: false, error: `Could not reach Recall.ai to remove the bot: ${scrub((err as Error).message)}` };
    }
    // Recall.ai refuses both for a bot that has already finished: nothing left to remove.
    if (await this.hasEnded(botId)) return { ok: true };
    return { ok: false, error: `Recall.ai would not remove the bot (${statuses.join(', then ')}).` };
  },

  async sendChat(botId: string, message: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const res = await fetch(`${base()}/bot/${botId}/send_chat_message/`, {
        method: 'POST',
        headers: headers(),
        signal: deadline(),
        body: JSON.stringify({ to: 'everyone', message: chatText(message) }),
      });
      return res.ok ? { ok: true } : { ok: false, error: await failure(res) };
    } catch (err) {
      return { ok: false, error: scrub((err as Error).message) };
    }
  },
};
