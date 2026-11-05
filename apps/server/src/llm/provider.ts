import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import { config } from '../config.js';
import { costOf, reserve, worstCaseCost } from './budget.js';

/**
 * One place where the platform talks to an LLM.
 *
 * Every call site passes a deterministic `fallback`. With no API key configured
 * (or if a call fails) the fallback runs instead, so the prototype is fully
 * usable offline and in tests; in production the fallback is only a safety net.
 *
 * Calls also stay within the deployment's daily and monthly spending limits (budget.ts): once one is reached,
 * the fallback answers until the limit resets.
 */
export interface JsonCall<T> {
  /** Short task id, used for logging. */
  task: string;
  system: string;
  messages: Anthropic.MessageParam[];
  schema: z.ZodType<T>;
  fallback: () => T | Promise<T>;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Called just before the request goes to the model: after the spending limit admitted it, never when the fallback answers without one. */
  onDispatch?: () => void;
}

export interface TextCall {
  task: string;
  system: string;
  messages: Anthropic.MessageParam[];
  fallback: () => string | Promise<string>;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface LlmResult<T> {
  value: T;
  simulated: boolean;
}

let client: Anthropic | undefined;
function anthropic() {
  // No automatic retries: every attempt can be billed, and the spending limit reserves for one. A failed call
  // uses its fallback instead.
  client ??= new Anthropic({ maxRetries: 0 });
  return client;
}

export const llm = {
  get provider() {
    return config.llm.provider;
  },
  get model() {
    return config.llm.provider === 'anthropic' ? config.llm.model : 'simulated';
  },

  async json<T>(call: JsonCall<T>): Promise<LlmResult<T>> {
    if (config.llm.provider !== 'anthropic') return { value: await call.fallback(), simulated: true };
    const maxTokens = call.maxTokens ?? 16000;
    const budget = await withinBudget(call, maxTokens);
    if (!budget) return { value: await call.fallback(), simulated: true };
    let cost: number | undefined;
    try {
      call.onDispatch?.();
      const response = await anthropic().messages.parse({
        model: config.llm.model,
        max_tokens: maxTokens,
        system: [{ type: 'text', text: call.system, cache_control: { type: 'ephemeral' } }],
        messages: call.messages,
        output_config: { format: zodOutputFormat(call.schema as z.ZodType<T> & z.ZodObject<z.ZodRawShape>), effort: call.effort ?? config.llm.effort },
      } as Parameters<Anthropic['messages']['parse']>[0]);
      cost = costOf(config.llm.model, response.usage);
      if (response.stop_reason === 'refusal') throw new Error('The model declined this request');
      const parsed = (response as { parsed_output?: T | null }).parsed_output;
      if (parsed == null) throw new Error('The model returned output that did not match the schema');
      return { value: parsed, simulated: false };
    } catch (err) {
      logFailure(call.task, err);
      cost ??= unbilled(err) ? 0 : budget.usd;
      return { value: await call.fallback(), simulated: true };
    } finally {
      await budget.settle(cost ?? 0);
    }
  },

  async text(call: TextCall): Promise<LlmResult<string>> {
    if (config.llm.provider !== 'anthropic') return { value: await call.fallback(), simulated: true };
    const maxTokens = call.maxTokens ?? 8000;
    const budget = await withinBudget(call, maxTokens);
    if (!budget) return { value: await call.fallback(), simulated: true };
    let cost: number | undefined;
    try {
      const response = await anthropic().messages.create({
        model: config.llm.model,
        max_tokens: maxTokens,
        system: [{ type: 'text', text: call.system, cache_control: { type: 'ephemeral' } }],
        messages: call.messages,
        output_config: { effort: call.effort ?? 'medium' },
      } as Anthropic.MessageCreateParamsNonStreaming);
      cost = costOf(config.llm.model, response.usage);
      if (response.stop_reason === 'refusal') throw new Error('The model declined this request');
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (!text) throw new Error('Empty response');
      return { value: text, simulated: false };
    } catch (err) {
      logFailure(call.task, err);
      cost ??= unbilled(err) ? 0 : budget.usd;
      return { value: await call.fallback(), simulated: true };
    } finally {
      await budget.settle(cost ?? 0);
    }
  },
};

/**
 * Reserve the call's worst-case cost, or log and return undefined when the spending limit is reached. A response
 * that arrives but is then rejected (a refusal, output that doesn't fit the schema) was still billed, so its cost
 * is recorded; a request the API answered with an error status is refunded. When it's unclear whether the model
 * ran (a timeout, a dropped connection, a failure while reading the response), the worst case stays counted.
 */
async function withinBudget(call: { task: string; system: string; messages: Anthropic.MessageParam[]; schema?: z.ZodType<unknown> }, maxTokens: number) {
  const schema = call.schema ? zodOutputFormat(call.schema as z.ZodType<unknown> & z.ZodObject<z.ZodRawShape>) : undefined;
  const r = await reserve(worstCaseCost(config.llm.model, { system: call.system, messages: call.messages, schema }, maxTokens));
  if (!r) console.warn(`[llm:${call.task}] spending limit reached, using fallback`);
  return r;
}

/** The API answered with an error status (400, 429, 500, ...), so nothing was generated or billed. */
const unbilled = (err: unknown) => err instanceof Anthropic.APIError && typeof err.status === 'number';

function logFailure(task: string, err: unknown) {
  if (err instanceof Anthropic.RateLimitError) console.warn(`[llm:${task}] rate limited, using fallback`);
  else if (err instanceof Anthropic.AuthenticationError) console.warn(`[llm:${task}] authentication failed, using fallback`);
  else if (err instanceof Anthropic.APIError) console.warn(`[llm:${task}] API error ${err.status}: ${err.message}`);
  else console.warn(`[llm:${task}] ${(err as Error).message}`);
}
