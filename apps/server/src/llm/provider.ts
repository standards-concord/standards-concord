import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import { config } from '../config.js';

/**
 * One place where the platform talks to an LLM.
 *
 * Every call site passes a deterministic `fallback`. With no API key configured
 * (or if a call fails) the fallback runs instead, so the prototype is fully
 * usable offline and in tests; in production the fallback is only a safety net.
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
  client ??= new Anthropic();
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
    try {
      const response = await anthropic().messages.parse({
        model: config.llm.model,
        max_tokens: call.maxTokens ?? 16000,
        system: [{ type: 'text', text: call.system, cache_control: { type: 'ephemeral' } }],
        messages: call.messages,
        output_config: { format: zodOutputFormat(call.schema as z.ZodType<T> & z.ZodObject<z.ZodRawShape>), effort: call.effort ?? config.llm.effort },
      } as Parameters<Anthropic['messages']['parse']>[0]);
      if (response.stop_reason === 'refusal') throw new Error('The model declined this request');
      const parsed = (response as { parsed_output?: T | null }).parsed_output;
      if (parsed == null) throw new Error('The model returned output that did not match the schema');
      return { value: parsed, simulated: false };
    } catch (err) {
      logFailure(call.task, err);
      return { value: await call.fallback(), simulated: true };
    }
  },

  async text(call: TextCall): Promise<LlmResult<string>> {
    if (config.llm.provider !== 'anthropic') return { value: await call.fallback(), simulated: true };
    try {
      const response = await anthropic().messages.create({
        model: config.llm.model,
        max_tokens: call.maxTokens ?? 8000,
        system: [{ type: 'text', text: call.system, cache_control: { type: 'ephemeral' } }],
        messages: call.messages,
        output_config: { effort: call.effort ?? 'medium' },
      } as Anthropic.MessageCreateParamsNonStreaming);
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
      return { value: await call.fallback(), simulated: true };
    }
  },
};

function logFailure(task: string, err: unknown) {
  if (err instanceof Anthropic.RateLimitError) console.warn(`[llm:${task}] rate limited, using fallback`);
  else if (err instanceof Anthropic.AuthenticationError) console.warn(`[llm:${task}] authentication failed, using fallback`);
  else if (err instanceof Anthropic.APIError) console.warn(`[llm:${task}] API error ${err.status}: ${err.message}`);
  else console.warn(`[llm:${task}] ${(err as Error).message}`);
}
