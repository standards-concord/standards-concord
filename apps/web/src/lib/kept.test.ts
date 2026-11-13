import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * What useAsync keeps between visits to a page (lib/kept.ts), with a stand-in for the session so a
 * test can switch account.
 */
let account: string | undefined = 'alice';
let signOuts = '0';
const listeners: (() => unknown)[] = [];
vi.mock('./session', () => ({
  accountToken: () => ({ account, signOuts }),
  stillCurrent: (t: { account?: string; signOuts: string }, a: string) => t.account === a && account === a && signOuts === t.signOuts,
  onAccountChange: (fn: () => unknown) => (listeners.push(fn), () => undefined),
}));
// A stand-in for the device's copy (IndexedDB in the browser).
const saved = new Map<string, { value: unknown; at: number }>();
let clock = 0;
vi.mock('./offlineStore', () => ({
  saveOffline: async (key: string, value: unknown) => void saved.set(key, { value, at: ++clock }),
  dropOffline: async (key: string) => void saved.delete(key),
  clearOffline: async () => saved.clear(),
  loadOffline: async (account: string) => {
    const mine = [...saved].filter(([k]) => k.startsWith(`${account}|`));
    for (const [k] of saved) if (!k.startsWith(`${account}|`)) saved.delete(k);
    return mine.map(([key, v]) => ({ key, ...v })).sort((a, b) => a.at - b.at);
  },
}));
const switchTo = (next: string | undefined) => {
  account = next;
  return listeners.map((fn) => fn());
};

async function load() {
  vi.resetModules();
  listeners.length = 0;
  saved.clear();
  account = 'alice';
  return import('./kept');
}

afterEach(() => {
  account = 'alice';
});

describe('kept answers', () => {
  it('forgets a changed ontology’s aliases and offline copies without forgetting other ontologies', async () => {
    const k = await load();
    const aliases = ['ontology|ont_1', 'ontology|old-slug'];
    for (const alias of [...aliases, 'ontology|ont_2']) k.finishLoad(k.startLoad(k.keptKey(alias)), { value: { title: 'Before' } });
    const older = k.startLoad(k.keptKey(aliases[1]));
    for (const alias of aliases) {
      k.forgetKept(alias);
      expect(k.keptValue(k.keptKey(alias))).toBeUndefined();
      expect(saved.has(k.keptKey(alias)!)).toBe(false);
    }
    k.finishLoad(older, { value: { title: 'Stale' } });
    expect(k.keptValue(k.keptKey(aliases[1]))).toBeUndefined();
    expect(k.keptValue(k.keptKey('ontology|ont_2'))).toEqual({ value: { title: 'Before' } });
  });

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

  /** One page as useAsync drives it: each load is recorded by the page's owner before it starts. */
  function page(k: Awaited<ReturnType<typeof load>>) {
    const owner = k.keptOwner();
    return {
      owner,
      start(keep: string) {
        const key = k.keptKey(keep);
        owner.loading(key);
        return k.startLoad(key);
      },
    };
  }

  // Used to go wrong: a load that started before the page changed its data (after an edit) answered
  // afterwards and put the older list back in what was kept.
  it('after the page changes its data, nothing kept stands for it, and loads on their way are not kept', async () => {
    const k = await load();
    const p = page(k);
    const key = k.keptKey('changes|vol');
    k.finishLoad(p.start('changes|vol'), { value: 'before the edit' });
    const onItsWay = p.start('changes|vol');
    p.owner.changed('changes|vol');
    expect(k.keptValue(key)).toBeUndefined();
    k.finishLoad(onItsWay, { value: 'stale' });
    expect(k.keptValue(key)).toBeUndefined();
    // The next load keeps afresh.
    k.finishLoad(p.start('changes|vol'), { value: 'after the edit' });
    expect(k.keptValue(key)).toEqual({ value: 'after the edit' });
  });

  // Used to go wrong (twice): an edit made on one list that finished after the page had started loading
  // another was put down to the new list only. The first list's kept copy, and a load still on its way
  // for it, survived the edit, so going back showed the list from before it.
  it('an edit that finishes after the page moved to other data forgets the data it was made on', async () => {
    const k = await load();
    const p = page(k);
    const a = k.keptKey('changes|vol|open');
    const b = k.keptKey('changes|vol|merged');
    k.finishLoad(p.start('changes|vol|open'), { value: 'open list' });
    const loadingA = p.start('changes|vol|open'); // the edit starts on A while A reloads
    const loadingB = p.start('changes|vol|merged'); // the page moves to B
    p.owner.changed('changes|vol|merged'); // ...and then the edit on A finishes
    expect(k.keptValue(a)).toBeUndefined();
    k.finishLoad(loadingA, { value: 'open list, from before the edit' });
    expect(k.keptValue(a)).toBeUndefined();
    k.finishLoad(loadingB, { value: 'merged list' });
    expect(k.keptValue(b)).toBeUndefined();
    // Another page's copies are its own business... unless this page loaded them too.
    const other = page(k);
    k.finishLoad(other.start('releases|vol'), { value: 'releases' });
    p.owner.changed('changes|vol|merged');
    expect(k.keptValue(k.keptKey('releases|vol'))).toEqual({ value: 'releases' });
  });

  it('a change after the account changed writes nothing for the new account', async () => {
    const k = await load();
    const p = page(k);
    k.finishLoad(p.start('changes|vol|open'), { value: 'alice’s list' });
    switchTo('bob');
    const bobs = k.keptKey('changes|vol|open');
    k.finishLoad(p.start('changes|vol|open'), { value: 'bob’s list' });
    p.owner.changed('changes|vol|open');
    expect(k.keptValue(bobs)).toBeUndefined();
    expect(k.keptSizesForTests()).toEqual({ kept: 0, loads: 0 });
  });

  it('a page that has loaded very many keys forgets the oldest rather than losing track of it', async () => {
    const k = await load();
    const p = page(k);
    const first = k.keptKey('page|first');
    k.finishLoad(p.start('page|first'), { value: 'first' });
    // Still kept (nothing pushed it out), but this page has since loaded too many keys to track it.
    for (let i = 0; i < k.KEEP_MAX; i++) p.start(`hangs|${i}`);
    expect(k.keptValue(first)).toBeUndefined();
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
    const first = k.startLoad(k.keptKey('hangs|first'));
    for (let i = 0; i < k.KEEP_MAX * 3; i++) k.startLoad(k.keptKey(`hangs|${i}`));
    expect(k.keptSizesForTests().loads).toBe(k.KEEP_MAX);
    // A load dropped from the record that does answer in the end is not kept.
    k.finishLoad(first, { value: 'late' });
    expect(k.keptValue(k.keptKey('hangs|first'))).toBeUndefined();
  });

  it('keeps nothing before the account is known', async () => {
    const k = await load();
    account = undefined;
    expect(k.keptKey('changes|vol')).toBeUndefined();
    expect(k.startLoad(undefined)).toBeUndefined();
  });

  it('loads ahead only what is neither kept nor loading, and a page’s own load wins over it', async () => {
    const k = await load();
    const key = k.keptKey('forks|vol');
    let answer: (v: string) => void = () => {};
    let calls = 0;
    const slow = () => (calls++, new Promise<string>((r) => (answer = r)));
    k.prefetchKept('forks|vol', slow);
    k.prefetchKept('forks|vol', slow); // already loading
    expect(calls).toBe(1);
    // The page opens before the early load answers: its own newer load is the one kept.
    const own = k.startLoad(key);
    answer('ahead');
    await new Promise((r) => setTimeout(r));
    expect(k.keptValue(key)).toBeUndefined();
    k.finishLoad(own, { value: 'own' });
    expect(k.keptValue(key)).toEqual({ value: 'own' });
    k.prefetchKept('forks|vol', slow); // already kept
    expect(calls).toBe(1);
  });

  it('a load ahead is kept when it answers, but not when it fails or the page was edited meanwhile', async () => {
    const k = await load();
    k.prefetchKept('releases|vol', async () => ['1.0.0']);
    await vi.waitFor(() => expect(k.keptValue(k.keptKey('releases|vol'))).toEqual({ value: ['1.0.0'] }));
    k.prefetchKept('meetings|vol', () => Promise.reject(new Error('offline')));
    await new Promise((r) => setTimeout(r));
    expect(k.keptValue(k.keptKey('meetings|vol'))).toBeUndefined();
    expect(k.keptSizesForTests().loads).toBe(0);
    const p = page(k);
    let answer: (v: string) => void = () => {};
    k.prefetchKept('changes|vol', () => new Promise<string>((r) => (answer = r)));
    p.owner.changed('changes|vol');
    answer('from before the edit');
    await new Promise((r) => setTimeout(r));
    expect(k.keptValue(k.keptKey('changes|vol'))).toBeUndefined();
  });

  describe('on this device', () => {
    it('saves what is kept, and drops what is forgotten or evicted', async () => {
      const k = await load();
      const p = page(k);
      k.finishLoad(p.start('releases|vol'), { value: ['1.0.0'] });
      expect(saved.get('alice|releases|vol')?.value).toEqual(['1.0.0']);
      p.owner.changed('releases|vol');
      await Promise.resolve();
      expect(saved.has('alice|releases|vol')).toBe(false);
      for (let i = 0; i <= k.KEEP_MAX; i++) k.finishLoad(k.startLoad(k.keptKey(`page|${i}`)), { value: i });
      await Promise.resolve();
      expect(saved.has('alice|page|0')).toBe(false);
      expect(saved.size).toBe(k.KEEP_MAX);
    });

    // Opening Concord again (a reload, or the next day with no connection) shows what was saved.
    it('reads back the account’s own copy when it is opened again, oldest first', async () => {
      const k = await load();
      saved.set('alice|releases|vol', { value: ['1.0.0'], at: 1 });
      saved.set('alice|forks|vol', { value: ['fork'], at: 2 });
      saved.set('bob|releases|vol', { value: ['bob’s'], at: 3 });
      account = undefined;
      // The session waits on what the account change returns before showing pages: it must be the
      // reading back, or pages open before it is done (that used to happen, so nothing showed offline).
      const [waitFor] = switchTo('alice');
      expect(waitFor).toBeInstanceOf(Promise);
      await waitFor;
      expect(k.keptValue('alice|releases|vol')).toEqual({ value: ['1.0.0'] });
      expect(k.keptValue('alice|forks|vol')).toEqual({ value: ['fork'] });
      // Another account’s copy is never read, and is deleted from the device.
      expect(k.keptValue('bob|releases|vol')).toBeUndefined();
      expect(saved.has('bob|releases|vol')).toBe(false);
    });

    it('a newer answer that arrived while reading back is not replaced by the saved one', async () => {
      const k = await load();
      saved.set('alice|releases|vol', { value: ['old'], at: 1 });
      account = undefined;
      switchTo('alice');
      k.finishLoad(k.startLoad(k.keptKey('releases|vol')), { value: ['new'] });
      await k.keptReady();
      expect(k.keptValue('alice|releases|vol')).toEqual({ value: ['new'] });
    });

    // Used to go wrong: a read-back that started before a sign-out (and a sign-in again as the same
    // account) finished afterwards and put the wiped copy back in memory.
    it('a read-back that a sign-out overtook brings nothing back, even as the same account', async () => {
      const k = await load();
      saved.set('alice|releases|vol', { value: ['1.0.0'], at: 1 });
      account = undefined;
      const [first] = switchTo('alice');
      switchTo(undefined);
      const [second] = switchTo('alice');
      await Promise.all([first, second]);
      expect(k.keptValue('alice|releases|vol')).toBeUndefined();
      expect(saved.size).toBe(0);
    });

    it('signing out wipes the device’s copy', async () => {
      const k = await load();
      k.finishLoad(k.startLoad(k.keptKey('releases|vol')), { value: ['1.0.0'] });
      expect(saved.size).toBe(1);
      switchTo(undefined);
      await k.keptReady();
      expect(saved.size).toBe(0);
    });
  });
});
