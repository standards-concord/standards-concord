import { AsyncLocalStorage } from 'node:async_hooks';
import { HttpError } from '../db.js';

/**
 * A per-person budget for expensive work: validating a change (reasoner, lint,
 * FAIR checks) and triaging it with the LLM. Every path that does this for a
 * person (creating, editing, submitting, revising or re-triaging a change
 * request, from the web app or MCP) runs inside `withTriageBudget`. Each person
 * gets `max` runs per `windowMs` and one at a time; nested calls within one run
 * don't count twice. Keyed by user id, so people behind the same proxy don't
 * share a quota. Simulated personas (the demo's working group) are exempt.
 * Process-local: it resets when the server restarts.
 */
export const triageBudget = { windowMs: 10 * 60 * 1000, max: 20 };

const recent = new Map<string, number[]>();
const inFlight = new Set<string>();
const current = new AsyncLocalStorage<string>();

export async function withTriageBudget<T>(user: { id: string; simulated?: boolean }, fn: () => Promise<T>): Promise<T> {
  if (user.simulated || current.getStore() === user.id) return fn();
  const now = Date.now();
  const { windowMs, max } = triageBudget;
  const times = (recent.get(user.id) ?? []).filter((t) => now - t < windowMs);
  if (inFlight.has(user.id)) throw new HttpError(429, 'Your previous change is still being checked. Try again in a moment.');
  if (times.length >= max) throw new HttpError(429, `You can have up to ${max} changes checked every ${Math.round(windowMs / 60000)} minutes. Try again shortly.`);
  times.push(now);
  recent.set(user.id, times);
  inFlight.add(user.id);
  try {
    return await current.run(user.id, fn);
  } finally {
    inFlight.delete(user.id);
  }
}
