import { config } from '../config.js';

/**
 * Recall.ai adapter. The Google Meet Media API is in a closed developer preview,
 * so a real bot joins through Recall.ai (or a self-hosted Attendee, which has a
 * near-identical API: point RECALL_API_BASE at it). Without a key, bots are simulated.
 */

/** Google Meet rejects longer chat messages; Recall.ai passes the error through. */
export const MEET_CHAT_MAX = 500;

const base = () => config.meetBot.recallApiBase ?? `https://${config.meetBot.recallRegion}.recall.ai/api/v1`;
const headers = () => ({ Authorization: `Token ${config.meetBot.recallApiKey}`, 'Content-Type': 'application/json' });

export function chatText(message: string) {
  return message.length <= MEET_CHAT_MAX ? message : `${message.slice(0, MEET_CHAT_MAX - 1).trimEnd()}…`;
}

async function failure(res: Response) {
  return `Recall.ai returned ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`;
}

export const recall = {
  enabled: () => !!config.meetBot.recallApiKey,

  /**
   * Sends a bot to a call. With joinAt, Recall.ai schedules it to join at that
   * time (it asks for at least ten minutes' notice to guarantee a bot is free).
   */
  async createBot(opts: { meetingUrl: string; webhookUrl: string; joinAt?: string; postPromptsToChat: boolean }) {
    const intro = opts.postPromptsToChat
      ? `Hi, I'm ${config.meetBot.botName}. I'm transcribing this call to capture use cases and terms for the ontology, and I'll post the odd clarifying question here in the chat.`
      : `Hi, I'm ${config.meetBot.botName}. I'm transcribing this call to capture use cases and terms for the ontology. For now my suggestions go to the facilitator in Concord, not this chat; I'll say here if that changes.`;
    const res = await fetch(`${base()}/bot/`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        meeting_url: opts.meetingUrl,
        bot_name: config.meetBot.botName,
        ...(opts.joinAt ? { join_at: opts.joinAt } : {}),
        chat: { on_bot_join: { send_to: 'everyone', message: intro } },
        recording_config: {
          transcript: { provider: { meeting_captions: {} } },
          realtime_endpoints: [{ type: 'webhook', url: opts.webhookUrl, events: ['transcript.data'] }],
        },
      }),
    });
    if (!res.ok) throw new Error(await failure(res));
    return (await res.json()) as { id: string };
  },

  /**
   * Cancels a bot: a scheduled bot is deleted; once it is joining or in the call,
   * Recall.ai refuses deletion and the bot is told to leave instead. Returns false
   * (and the caller keeps the bot id, to retry) when neither worked.
   */
  async cancelBot(botId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const del = await fetch(`${base()}/bot/${botId}/`, { method: 'DELETE', headers: headers() });
      if (del.ok || del.status === 404) return { ok: true };
      const leave = await fetch(`${base()}/bot/${botId}/leave_call/`, { method: 'POST', headers: headers() });
      if (leave.ok) return { ok: true };
      return { ok: false, error: `Recall.ai would not cancel the bot (${del.status}, then ${leave.status}).` };
    } catch (err) {
      return { ok: false, error: `Could not reach Recall.ai to cancel the bot: ${(err as Error).message}` };
    }
  },

  async sendChat(botId: string, message: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const res = await fetch(`${base()}/bot/${botId}/send_chat_message/`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ to: 'everyone', message: chatText(message) }),
      });
      return res.ok ? { ok: true } : { ok: false, error: await failure(res) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async leave(botId: string) {
    await fetch(`${base()}/bot/${botId}/leave_call/`, { method: 'POST', headers: headers() }).catch(() => undefined);
  },
};
