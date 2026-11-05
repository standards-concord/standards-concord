import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { clock, DAY_MS } from '../src/clock.js';
import { config } from '../src/config.js';
import { openDb, put, remove } from '../src/db.js';
import { costOf, spending, worstCaseCost } from '../src/llm/budget.js';
import { llm } from '../src/llm/provider.js';
import { resetAll } from '../src/services/simulation.js';

/**
 * The spending limit on Claude calls (llm/budget.ts), against a stand-in for the Messages API that counts the
 * requests it gets. These are server tests rather than Playwright ones because the browser suite runs with the
 * offline LLM only: a real or stand-in model can't be switched on per spec.
 */

const USAGE = { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 2000, cache_read_input_tokens: 4000 };
let requests = 0;
let reply: { status: number; body: unknown } = { status: 200, body: {} };
let gate: Promise<void> | undefined;

const message = (text: string) => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: USAGE,
});

const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', async () => {
    requests++;
    await gate;
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
});

const saved = { ...config.llm };
const env = { key: process.env.ANTHROPIC_API_KEY, url: process.env.ANTHROPIC_BASE_URL };

beforeAll(async () => {
  await openDb();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  Object.assign(config.llm, saved);
  process.env.ANTHROPIC_API_KEY = env.key;
  process.env.ANTHROPIC_BASE_URL = env.url;
  if (env.key === undefined) delete process.env.ANTHROPIC_API_KEY;
  if (env.url === undefined) delete process.env.ANTHROPIC_BASE_URL;
  await new Promise((r) => server.close(r));
});

const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => new Date().toISOString().slice(0, 7);

beforeEach(async () => {
  Object.assign(config.llm, { ...saved, provider: 'anthropic', model: 'claude-opus-5-5', dailyBudgetUsd: 5, monthlyBudgetUsd: 40 });
  await remove('kv', `llm-spend:day:${today()}`);
  await remove('kv', `llm-spend:month:${thisMonth()}`);
  requests = 0;
  reply = { status: 200, body: message('From the model') };
  gate = undefined;
});

const ask = (maxTokens = 1000) =>
  llm.text({ task: 'test', system: 'Be brief.', messages: [{ role: 'user', content: 'Hello' }], maxTokens, fallback: () => 'From the fallback' });

describe('AI spending limit', () => {
  it('calls the model within the limit and records what the response cost', async () => {
    expect(await ask()).toEqual({ value: 'From the model', simulated: false });
    expect(requests).toBe(1);
    const s = await spending();
    // 1000 × $4 + 2000 × $5 + 4000 × $0.20 + 500 × $20 per million tokens.
    expect(s.today.usd).toBeCloseTo(0.0248, 6);
    expect(s.today.usd).toBeCloseTo(costOf('claude-opus-5-5', USAGE), 9);
    expect(s.month.usd).toBeCloseTo(s.today.usd, 9);
    expect(s.today.calls).toBe(1);
  });

  it('uses the fallback without calling the model once the day’s limit is reached', async () => {
    await put('kv', { id: `llm-spend:day:${today()}`, usd: 4.99, calls: 300 });
    expect(await ask()).toEqual({ value: 'From the fallback', simulated: true });
    expect(requests).toBe(0);
    expect((await spending()).today.usd).toBeCloseTo(4.99, 9);
  });

  it('uses the fallback once the month’s limit is reached, even with room left today', async () => {
    await put('kv', { id: `llm-spend:month:${thisMonth()}`, usd: 39.99, calls: 9000 });
    expect((await ask()).simulated).toBe(true);
    expect(requests).toBe(0);
  });

  it('a limit of 0 turns real calls off', async () => {
    config.llm.dailyBudgetUsd = 0;
    expect((await ask()).simulated).toBe(true);
    expect(requests).toBe(0);
  });

  // Each call reserves its worst case before it starts, so calls running together can't all pass a check made
  // while none of them had been counted yet.
  it('calls made at the same time can’t together go past the limit', async () => {
    const worst = worstCaseCost('claude-opus-5-5', { system: 'Be brief.', messages: [{ role: 'user', content: 'Hello' }] }, 1000);
    config.llm.dailyBudgetUsd = worst * 2.5;
    let open!: () => void;
    gate = new Promise((r) => (open = r));
    const calls = Array.from({ length: 6 }, () => ask());
    await new Promise((r) => setTimeout(r, 300));
    open();
    const results = await Promise.all(calls);
    expect(results.filter((r) => !r.simulated)).toHaveLength(2);
    expect(requests).toBe(2);
    expect((await spending()).today.usd).toBeCloseTo(2 * costOf('claude-opus-5-5', USAGE), 9);
  });

  it('refunds a request the API turned down', async () => {
    reply = { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } } };
    expect((await ask()).simulated).toBe(true);
    expect(requests).toBe(1);
    const s = await spending();
    expect(s.today.usd).toBe(0);
  });

  it('counts a response it then rejects, because it was still billed', async () => {
    reply = { status: 200, body: message('not json') };
    const schema = z.object({ answer: z.string() });
    const r = await llm.json({
      task: 'test',
      system: 'Answer in JSON.',
      messages: [{ role: 'user', content: 'Hello' }],
      schema,
      maxTokens: 1000,
      fallback: () => ({ answer: 'fallback' }),
    });
    expect(r).toEqual({ value: { answer: 'fallback' }, simulated: true });
    expect(requests).toBe(1);
    // Either the usage was read (the tokens' cost) or the SDK threw before we saw it (the worst case reserved for
    // the call stays counted). Never a refund.
    const worst = worstCaseCost('claude-opus-5-5', { system: 'Answer in JSON.', messages: [{ role: 'user', content: 'Hello' }], schema: zodOutputFormat(schema) }, 1000);
    const usd = (await spending()).today.usd;
    expect([worst, costOf('claude-opus-5-5', USAGE)].some((v) => Math.abs(usd - v) < 1e-9)).toBe(true);
  });

  // The SDK used to retry an overloaded or failed request twice on its own. Each attempt can be billed, but the
  // limit had reserved for one, so retries could spend past it unseen.
  it('a failed request is not retried behind the limit’s back', async () => {
    reply = { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } };
    expect(await ask()).toEqual({ value: 'From the fallback', simulated: true });
    expect(requests).toBe(1);
  });

  // The reservation used to count a token per 3 characters, which dense scripts (CJK, emoji) can exceed, so a big
  // prompt could be reserved for far less than it costs and pass a limit it should not.
  it('a prompt in a dense script is reserved for what it can really cost', async () => {
    const content = '漢'.repeat(30_000); // 30,000 characters, 90,000 bytes
    const prompt = { system: 'Be brief.', messages: [{ role: 'user' as const, content }] };
    const worst = worstCaseCost('claude-opus-5-5', prompt, 1000);
    // A cache write of 90,000 tokens alone costs 0.45 USD.
    expect(worst).toBeGreaterThan(0.45);
    config.llm.dailyBudgetUsd = 0.3;
    const r = await llm.text({ task: 'test', ...prompt, maxTokens: 1000, fallback: () => 'From the fallback' });
    expect(r.simulated).toBe(true);
    expect(requests).toBe(0);
  });

  it('counts the output schema in what a structured request may cost', async () => {
    const schema = z.object({ answer: z.string().describe('x'.repeat(50_000)) });
    const bare = worstCaseCost('claude-opus-5-5', { system: 'S', messages: [] }, 1000);
    const withSchema = worstCaseCost('claude-opus-5-5', { system: 'S', messages: [], schema: zodOutputFormat(schema) }, 1000);
    expect(withSchema - bare).toBeGreaterThan((50_000 * 5) / 1e6);
    config.llm.dailyBudgetUsd = (bare + withSchema) / 2;
    const r = await llm.json({ task: 'test', system: 'S', messages: [], schema, maxTokens: 1000, fallback: () => ({ answer: 'f' }) });
    expect(r.simulated).toBe(true);
    expect(requests).toBe(0);
  });

  // The demo clock only moves governance dates; the budget runs on real time.
  it('fast-forwarding the demo clock doesn’t start a new day’s budget', async () => {
    await put('kv', { id: `llm-spend:day:${today()}`, usd: 5, calls: 300 });
    const before = clock.offsetMs;
    clock.advance(3 * DAY_MS);
    try {
      expect((await ask()).simulated).toBe(true);
      expect(requests).toBe(0);
    } finally {
      clock.offsetMs = before;
    }
  });

  // A demo reset wipes the store; without carrying the totals over, anyone allowed to reset would refill the budget.
  it('a demo reset keeps the spending totals', async () => {
    await put('kv', { id: `llm-spend:day:${today()}`, usd: 4.5, calls: 200 });
    await put('kv', { id: `llm-spend:month:${thisMonth()}`, usd: 40, calls: 2000 });
    config.llm.provider = 'simulated';
    await resetAll();
    const s = await spending();
    expect(s.today).toMatchObject({ usd: 4.5, calls: 200 });
    expect(s.month).toMatchObject({ usd: 40, calls: 2000 });
  });
});
