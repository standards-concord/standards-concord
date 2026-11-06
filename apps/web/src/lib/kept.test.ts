import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * What useAsync keeps between visits to a page (lib/kept.ts), with a stand-in for the session so a
 * test can switch account.
 */
let account: string | undefined = 'alice';
let signOuts = '0';
const listeners: (() => void)[] = [];
vi.mock('./session', () => ({
  accountToken: () => ({ account, signOuts }),
  stillCurrent: (t: { account?: string; signOuts: string }, a: string) => t.account === a && account === a && signOuts === t.signOuts,
  onAccountChange: (fn: () => void) => (listeners.push(fn), () => undefined),
}));
const switchTo = (next: string | undefined) => {
  account = next;
  for (const fn of listeners) fn();
};

async function load() {
  vi.resetModules();
  listeners.length = 0;
  account = 'alice';
  return import('./kept');
}

afterEach(() => {
  account = 'alice';
});

describe('kept answers', () => {
  it('keeps the newest answer per account, and drops everything when the account changes', async () => {
    const k = await load();
    const key = k.keptKey('releases|vol');
    k.finishLoad(k.startLoad(key), { value: ['1.0.0'] });
    expect(k.keptValue(key)).toEqual({ value: ['1.0.0'] });
    switchTo('bob');
    expect(k.keptValue(k.keptKey('releases|vol'))).toBeUndefined();
    expect(k.keptValue(key)).toBeUndefined();
  });

  it('an older load that answers last never replaces a newer one', async () => {
    const k = await load();
    const key = k.keptKey('changes|vol');
    const older = k.startLoad(key);
    const newer = k.startLoad(key);
    k.finishLoad(newer, { value: 'new' });
    k.finishLoad(older, { value: 'old' });
    expect(k.keptValue(key)).toEqual({ value: 'new' });
  });

  // Used to go wrong: a load that started before the page changed its data (after an edit) answered
  // afterwards and put the older list back in what was kept.
  it('after the page changes its data, nothing kept stands for it, and loads on their way are not kept', async () => {
    const k = await load();
    const key = k.keptKey('changes|vol');
    k.finishLoad(k.startLoad(key), { value: 'before the edit' });
    const onItsWay = k.startLoad(key);
    k.forgetKept('changes|vol', key);
    expect(k.keptValue(key)).toBeUndefined();
    k.finishLoad(onItsWay, { value: 'stale' });
    expect(k.keptValue(key)).toBeUndefined();
    // The next load keeps afresh.
    k.finishLoad(k.startLoad(key), { value: 'after the edit' });
    expect(k.keptValue(key)).toEqual({ value: 'after the edit' });
  });

  // Used to go wrong: a change that finished after the page had moved on (to other data, or after the
  // account changed) was kept under the new key. A change now writes nothing, and both the key the page
  // last loaded and the current one are forgotten.
  it('a change that lands after the page moved on writes nothing under either key', async () => {
    const k = await load();
    const a = k.keptKey('changes|vol|open');
    const b = k.keptKey('changes|vol|merged');
    k.finishLoad(k.startLoad(a), { value: 'open list' });
    k.finishLoad(k.startLoad(b), { value: 'merged list' });
    const loadingB = k.startLoad(b);
    k.forgetKept('changes|vol|merged', a);
    expect(k.keptValue(a)).toBeUndefined();
    expect(k.keptValue(b)).toBeUndefined();
    k.finishLoad(loadingB, { value: 'merged list again' });
    expect(k.keptValue(b)).toBeUndefined();
    // After an account change: the old account's key is gone already, and the new one's isn't written.
    const asAlice = k.keptKey('changes|vol|open');
    switchTo('bob');
    const bobs = k.keptKey('changes|vol|open');
    k.finishLoad(k.startLoad(bobs), { value: 'bob’s list' });
    k.forgetKept('changes|vol|open', asAlice);
    expect(k.keptValue(bobs)).toBeUndefined();
    expect(k.keptValue(asAlice)).toBeUndefined();
  });

  it('an answer that arrives after the account changed is not kept', async () => {
    const k = await load();
    const started = k.startLoad(k.keptKey('changes|vol'));
    switchTo('bob');
    switchTo('alice');
    signOuts = '1';
    k.finishLoad(started, { value: 'from before' });
    signOuts = '0';
    expect(k.keptValue(k.keptKey('changes|vol'))).toBeUndefined();
  });

  // Used to go wrong: the record of loads grew for every key ever loaded, even after the answers were dropped.
  it('tracks only loads on their way, and keeps at most KEEP_MAX answers', async () => {
    const k = await load();
    for (let i = 0; i < k.KEEP_MAX + 20; i++) k.finishLoad(k.startLoad(k.keptKey(`page|${i}`)), { value: i });
    k.finishLoad(k.startLoad(k.keptKey('failed')));
    expect(k.keptSizesForTests()).toEqual({ kept: k.KEEP_MAX, loads: 0 });
    expect(k.keptValue(k.keptKey('page|0'))).toBeUndefined();
    expect(k.keptValue(k.keptKey(`page|${k.KEEP_MAX + 19}`))).toEqual({ value: k.KEEP_MAX + 19 });
    k.startLoad(k.keptKey('pending'));
    switchTo('bob');
    expect(k.keptSizesForTests()).toEqual({ kept: 0, loads: 0 });
  });

  it('a key evicted while its load is on its way is not brought back by that load', async () => {
    const k = await load();
    const first = k.keptKey('page|first');
    k.finishLoad(k.startLoad(first), { value: 'first' });
    const reloading = k.startLoad(first);
    // Enough other pages to push the first one out.
    for (let i = 0; i < k.KEEP_MAX; i++) k.finishLoad(k.startLoad(k.keptKey(`page|${i}`)), { value: i });
    expect(k.keptValue(first)).toBeUndefined();
    k.finishLoad(reloading, { value: 'first, reloaded' });
    expect(k.keptValue(first)).toBeUndefined();
  });

  it('load numbers are never reused, even after everything is dropped', async () => {
    const k = await load();
    const key = k.keptKey('changes|vol');
    const before = k.startLoad(key);
    switchTo('bob');
    switchTo('alice');
    const after = k.startLoad(k.keptKey('changes|vol'));
    expect(after!.load).not.toBe(before!.load);
    k.finishLoad(before, { value: 'from before' });
    expect(k.keptValue(key)).toBeUndefined();
    k.finishLoad(after, { value: 'current' });
    expect(k.keptValue(key)).toEqual({ value: 'current' });
  });

  // Loads that never settle (a request that hangs) used to stay recorded for ever.
  it('loads that never settle are capped too', async () => {
    const k = await load();
    for (let i = 0; i < k.KEEP_MAX * 3; i++) k.startLoad(k.keptKey(`hangs|${i}`));
    expect(k.keptSizesForTests().loads).toBe(k.KEEP_MAX);
  });

  it('keeps nothing before the account is known', async () => {
    const k = await load();
    account = undefined;
    expect(k.keptKey('changes|vol')).toBeUndefined();
    expect(k.startLoad(undefined)).toBeUndefined();
  });
});
