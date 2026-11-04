import { HttpError } from '../db.js';

/**
 * A per-person budget for expensive work: validating a change (reasoner, lint,
 * FAIR checks) and triaging it with the LLM. Each person gets `max` runs per
 * `windowMs` and one at a time. Keyed by user id, so people behind the same
 * proxy don't share a quota. Process-local: it resets when the server restarts.
 */
export const triageBudget = { windowMs: 10 * 60 * 1000, max: 20 };

const recent = new Map<string, number[]>();
const inFlight = new Set<string>();

export async function withTriageBudget<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const { windowMs, max } = triageBudget;
  const times = (recent.get(userId) ?? []).filter((t) => now - t < windowMs);
  if (inFlight.has(userId)) throw new HttpError(429, 'Your previous change is still being checked. Try again in a moment.');
  if (times.length >= max) throw new HttpError(429, `You can have up to ${max} changes checked every ${Math.round(windowMs / 60000)} minutes. Try again shortly.`);
  times.push(now);
  recent.set(userId, times);
  inFlight.add(userId);
  try {
    return await fn();
  } finally {
    inFlight.delete(userId);
  }
}
