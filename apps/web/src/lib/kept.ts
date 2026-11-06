import { accountToken, onAccountChange, stillCurrent } from './session';

/**
 * The last answer for each `keep` key of useAsync, so a page opened again shows it at once while it
 * loads the current one (stale while revalidate). Kept per account: keys include the account, all of
 * it is dropped whenever the account changes, and an answer that arrives after the change is not kept.
 * The oldest go once there are too many.
 */
const kept = new Map<string, unknown>();
// The newest load still on its way for each key, so a slower, older answer never replaces a newer one
// (or a change made since it started). Numbers are never reused; an entry goes once its load settles.
const loads = new Map<string, number>();
let lastLoad = 0;
export const KEEP_MAX = 100;

onAccountChange(() => {
  kept.clear();
  loads.clear();
});

/** The key for `keep` under the current account, or nothing to keep (no key, or no account yet). */
export function keptKey(keep: string | undefined): string | undefined {
  const account = accountToken().account;
  return keep && account ? `${account}|${keep}` : undefined;
}

export function keptValue<T>(key: string | undefined): { value: T } | undefined {
  return key && kept.has(key) ? { value: kept.get(key) as T } : undefined;
}

function store(key: string, value: unknown) {
  kept.delete(key);
  kept.set(key, value);
  if (kept.size > KEEP_MAX) {
    const oldest = kept.keys().next().value!;
    kept.delete(oldest);
    loads.delete(oldest);
  }
}

/** A load for `key` starts. Returns what `finishLoad` needs to keep its answer only if it is still the newest. */
export function startLoad(key: string | undefined): { key: string; load: number; token: ReturnType<typeof accountToken> } | undefined {
  if (!key) return undefined;
  const load = ++lastLoad;
  loads.set(key, load);
  return { key, load, token: accountToken() };
}

/** A load settled: its answer (if it has one) is kept when no newer load or change came since, under the same account. */
export function finishLoad(started: ReturnType<typeof startLoad>, answer?: { value: unknown }) {
  if (!started) return;
  const { key, load, token } = started;
  if (loads.get(key) !== load) return;
  loads.delete(key);
  if (answer && token.account && stillCurrent(token, token.account)) store(key, answer.value);
}

/**
 * The page changed its data itself (after an edit): kept as the newest, and loads on their way are
 * dropped. `loadedKey` is the key the page's data was loaded under; if the account has changed since,
 * nothing is kept, so a late change from one account never lands in the next one's copy.
 */
export function keepChange(keep: string | undefined, loadedKey: string | undefined, value: unknown) {
  const key = keptKey(keep);
  if (!key) return;
  loads.delete(key);
  if (key === loadedKey) store(key, value);
}

/** Drops the loads on their way for `keep` (called as soon as the page changes its data, before React applies it). */
export function supersedeLoads(keep: string | undefined) {
  const key = keptKey(keep);
  if (key) loads.delete(key);
}

/** For tests: how many keys are kept and how many loads are tracked. */
export function keptSizesForTests() {
  return { kept: kept.size, loads: loads.size };
}
