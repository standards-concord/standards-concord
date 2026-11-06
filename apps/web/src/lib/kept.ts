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
  loads.delete(key);
  loads.set(key, load);
  // A load that never settles mustn't stay for ever: past the cap the oldest is dropped (its answer just isn't kept).
  if (loads.size > KEEP_MAX) loads.delete(loads.keys().next().value!);
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
 * The page changed its data itself (after an edit). What was kept for it may no longer be true, so it is
 * forgotten, and loads on their way for it won't be kept: the next load keeps afresh. Nothing is written
 * here, so a change that lands late (after the page moved to other data, or the account changed) can
 * never end up kept under the wrong key. `loadedKey` is the key the page last loaded; both it and the
 * current key are forgotten.
 */
export function forgetKept(keep: string | undefined, loadedKey: string | undefined) {
  for (const key of new Set([keptKey(keep), loadedKey])) {
    if (!key) continue;
    kept.delete(key);
    loads.delete(key);
  }
}

/** For tests: how many keys are kept and how many loads are tracked. */
export function keptSizesForTests() {
  return { kept: kept.size, loads: loads.size };
}
