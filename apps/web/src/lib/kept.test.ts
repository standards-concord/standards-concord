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
  it('a load on its way when the page changes its data is dropped', async () => {
    const k = await load();
    const key = k.keptKey('changes|vol');
    const before = k.startLoad(key);
    k.supersedeLoads('changes|vol');
    k.keepChange('changes|vol', key, 'edited');
    k.finishLoad(before, { value: 'stale' });
    expect(k.keptValue(key)).toEqual({ value: 'edited' });
  });

  // Used to go wrong: a change made by a page loaded as one account, landing after switching to
  // another, was kept under the new account's key.
  it('a late change from the last account is not kept for the next one', async () => {
    const k = await load();
    const loadedAsAlice = k.keptKey('changes|vol');
    switchTo('bob');
    k.keepChange('changes|vol', loadedAsAlice, 'alice’s edit');
    expect(k.keptValue(k.keptKey('changes|vol'))).toBeUndefined();
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

  it('keeps nothing before the account is known', async () => {
    const k = await load();
    account = undefined;
    expect(k.keptKey('changes|vol')).toBeUndefined();
    expect(k.startLoad(undefined)).toBeUndefined();
  });
});
