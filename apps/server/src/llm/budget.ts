import type Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { get, put, transaction } from '../db.js';

/**
 * A spending limit on Claude calls, so a busy day of testing (or a loop gone wrong) can't use up the month's
 * credits. Each call first reserves its worst case (the prompt, plus every output token it may produce) against
 * today's and this month's totals, and is refused if either would pass its limit; when the response arrives, the
 * reservation is swapped for the cost of the tokens actually used. Calls that fail are refunded. Reserving up
 * front means calls running at the same time can't all slip under the limit together.
 *
 * Totals live in the document store, so every server instance shares them. Days and months are UTC and use the
 * real time, not the demo clock: fast-forwarding the demo must not hand out a fresh budget. A demo reset keeps
 * them too (services/simulation.ts).
 *
 * Costs are estimates from published per-token prices. The Console's own spend limits remain the hard stop.
 */

interface Spend {
  id: string;
  usd: number;
  calls: number;
}

/** US dollars per million tokens. */
interface Price {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
};
/** For a model not listed: the most expensive current prices, so an unknown model is never under-counted. */
const UNKNOWN: Price = { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 };

export const priceOf = (model: string): Price => PRICES[model] ?? UNKNOWN;

const PREFIX = 'llm-spend:';
const dayKey = (now: Date) => `${PREFIX}day:${now.toISOString().slice(0, 10)}`;
const monthKey = (now: Date) => `${PREFIX}month:${now.toISOString().slice(0, 7)}`;

/** Cost in dollars of a response's token usage. */
export function costOf(
  model: string,
  usage: Pick<Anthropic.Usage, 'input_tokens' | 'output_tokens' | 'cache_creation_input_tokens' | 'cache_read_input_tokens'>,
): number {
  const p = priceOf(model);
  return (
    ((usage.input_tokens ?? 0) * p.input +
      (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite +
      (usage.cache_read_input_tokens ?? 0) * p.cacheRead +
      (usage.output_tokens ?? 0) * p.output) /
    1e6
  );
}

/**
 * The most a request can cost: its prompt priced as a cache write (the dearest way to read input), counting a
 * token for every 3 characters (real text averages about 4), plus every output token allowed.
 */
export function worstCaseCost(model: string, prompt: unknown, maxTokens: number): number {
  const p = priceOf(model);
  const inputTokens = Math.ceil(JSON.stringify(prompt).length / 3);
  return (inputTokens * p.cacheWrite + maxTokens * p.output) / 1e6;
}

async function add(key: string, usd: number, calls: number) {
  const now = (await get<Spend>('kv', key)) ?? { id: key, usd: 0, calls: 0 };
  await put<Spend>('kv', { id: key, usd: Math.max(0, now.usd + usd), calls: now.calls + calls });
}

export interface Reservation {
  /** The amount reserved, in dollars. */
  usd: number;
  /** Swap the reservation for what the call actually cost (0 if it was never billed). */
  settle(actualUsd: number): Promise<void>;
}

/**
 * Reserve `usd` against today's and this month's limits, or return undefined if either would be passed (or the
 * totals can't be read, in which case the caller uses its fallback rather than spend without a check).
 */
export async function reserve(usd: number): Promise<Reservation | undefined> {
  const now = new Date();
  const day = dayKey(now);
  const month = monthKey(now);
  try {
    const ok = await transaction(async () => {
      const [d, m] = await Promise.all([get<Spend>('kv', day), get<Spend>('kv', month)]);
      if ((d?.usd ?? 0) + usd > config.llm.dailyBudgetUsd || (m?.usd ?? 0) + usd > config.llm.monthlyBudgetUsd) return false;
      await add(day, usd, 1);
      await add(month, usd, 1);
      return true;
    });
    if (!ok) return undefined;
  } catch (err) {
    console.warn(`[llm] could not check the spending limit, so not calling the model: ${(err as Error).message}`);
    return undefined;
  }
  let settled = false;
  return {
    usd,
    async settle(actualUsd: number) {
      if (settled) return;
      settled = true;
      const delta = actualUsd - usd;
      try {
        await transaction(async () => {
          await add(day, delta, 0);
          await add(month, delta, 0);
        });
      } catch (err) {
        // The reservation stays counted, which errs on the side of spending less.
        console.warn(`[llm] could not record a call's cost: ${(err as Error).message}`);
      }
    },
  };
}

/** Today's and this month's spending so far, in dollars, with the limits. */
export async function spending() {
  const now = new Date();
  const [d, m] = await Promise.all([get<Spend>('kv', dayKey(now)), get<Spend>('kv', monthKey(now))]);
  return {
    today: { usd: d?.usd ?? 0, calls: d?.calls ?? 0, limitUsd: config.llm.dailyBudgetUsd },
    month: { usd: m?.usd ?? 0, calls: m?.calls ?? 0, limitUsd: config.llm.monthlyBudgetUsd },
  };
}

/** The spending totals, to put back after a demo reset wipes the store. */
export async function snapshotSpending(): Promise<Spend[]> {
  const now = new Date();
  const docs = await Promise.all([get<Spend>('kv', dayKey(now)), get<Spend>('kv', monthKey(now))]);
  return docs.filter((d): d is Spend => !!d);
}

export async function restoreSpending(docs: Spend[]) {
  for (const d of docs) await put<Spend>('kv', d);
}
