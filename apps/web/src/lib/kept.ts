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
 * Loads what `keep` names ahead of the page that shows it, so that page is instant the first time it
 * is opened too. Nothing happens when it is already kept or already loading; a failed load is simply
 * not kept. Its answer goes through finishLoad like any other, so a page's newer load, an edit or an
 * account change since it started all win over it.
 */
export function prefetchKept(keep: string, fn: () => Promise<unknown>) {
  const key = keptKey(keep);
  if (!key || kept.has(key) || loads.has(key)) return;
  const started = startLoad(key);
  fn().then(
    (value) => finishLoad(started, { value }),
    () => finishLoad(started),
  );
}

function forget(key: string) {
  kept.delete(key);
  loads.delete(key);
}

/**
 * What one page (one useAsync) has loaded, so that a change it makes itself (after an edit) can forget
 * everything that change may have made untrue. An edit can finish after the page has moved on to other
 * data, so it isn't known which key it was made against: every key the page loaded is forgotten, along
 * with the current one, and loads on their way for them won't be kept. Forgetting too much only costs a
 * wait next time. Nothing is written, so a late change can never end up kept under the wrong key.
 */
export function keptOwner() {
  const loaded = new Set<string>();
  return {
    /** The page starts loading `key` (account included). */
    loading(key: string | undefined) {
      if (!key) return;
      loaded.delete(key);
      loaded.add(key);
      // A page that has loaded very many keys stops tracking the oldest, and forgets it now instead.
      if (loaded.size > KEEP_MAX) {
        const oldest = loaded.keys().next().value!;
        loaded.delete(oldest);
        forget(oldest);
      }
    },
    /** The page changed its data itself; `keep` is its current key. */
    changed(keep: string | undefined) {
      const current = keptKey(keep);
      if (current) forget(current);
      for (const key of loaded) forget(key);
    },
  };
}

/** For tests: how many keys are kept and how many loads are tracked. */
export function keptSizesForTests() {
  return { kept: kept.size, loads: loads.size };
}
