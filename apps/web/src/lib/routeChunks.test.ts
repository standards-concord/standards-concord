import { afterEach, describe, expect, it, vi } from 'vitest';
import { dismissPageWaits, pageChunk, pagePending, prefetchOntologyPage, prefetchPage, registerPageFallback, RouteChunkError, warmOntology } from './routeChunks';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('page chunk pending feedback', () => {
  it('does not count a prefetch as a page waiting for code', async () => {
    // Speculative downloads used to be indistinguishable from a page waiting for its code.
    vi.stubGlobal('navigator', { onLine: true });
    let release!: () => void;
    const download = new Promise<void>((resolve) => { release = resolve; });
    pageChunk('prefetch-only', () => download);
    prefetchPage('prefetch-only');
    expect(pagePending.get()).toEqual({ chunks: 0, fallbacks: 0 });
    release();
    await download;
    expect(pagePending.get().chunks).toBe(0);
  });

  it.each(['success', 'failure'])('counts lazy loads until they settle: %s', async (outcome) => {
    // Transition navigation used to have no separate indication that a page was waiting.
    let resolve!: (value: string) => void;
    let reject!: (cause: Error) => void;
    const download = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
    const load = pageChunk(`pending-${outcome}`, () => download);
    const result = load();
    expect(pagePending.get().chunks).toBe(1);
    if (outcome === 'success') {
      resolve('ready');
      await expect(result).resolves.toBe('ready');
    } else {
      reject(new Error('offline'));
      await expect(result).rejects.toBeInstanceOf(RouteChunkError);
    }
    expect(pagePending.get().chunks).toBe(0);
  });

  it('counts overlapping lazy calls separately and notifies subscribers outside render', async () => {
    // Several suspended pages must not clear pending feedback when just one finishes.
    const releases: Array<() => void> = [];
    const loads = ['first', 'second'].map((name) => pageChunk(name, () => new Promise<void>((resolve) => { releases.push(resolve); })));
    const changed = vi.fn();
    const unsubscribe = pagePending.subscribe(changed);
    const first = loads[0]();
    const second = loads[1]();
    expect(pagePending.get().chunks).toBe(2);
    expect(changed).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(changed).toHaveBeenCalledOnce();
    releases[0]();
    await first;
    expect(pagePending.get().chunks).toBe(1);
    unsubscribe();
    changed.mockClear();
    releases[1]();
    await second;
    expect(pagePending.get().chunks).toBe(0);
    expect(changed).not.toHaveBeenCalled();
  });

  it('counts an already prefetched chunk for no longer than a microtask', async () => {
    // A fully downloaded first navigation used to blank and flash Loading anyway.
    vi.stubGlobal('navigator', { onLine: true });
    const load = pageChunk('already-downloaded', () => Promise.resolve('ready'));
    prefetchPage('already-downloaded');
    await Promise.resolve();
    const result = load();
    expect(pagePending.get().chunks).toBe(1);
    await Promise.resolve();
    expect(pagePending.get().chunks).toBe(0);
    await expect(result).resolves.toBe('ready');
  });

  it('stops counting a wait once another page has opened, and never counts it again', async () => {
    // Going elsewhere while a page was still downloading used to leave Loading showing until that download ended.
    let release!: () => void;
    const load = pageChunk('abandoned', () => new Promise<void>((resolve) => { release = resolve; }));
    const abandoned = load();
    expect(pagePending.get().chunks).toBe(1);
    dismissPageWaits();
    expect(pagePending.get().chunks).toBe(0);
    const next = pageChunk('wanted-next', () => Promise.resolve())();
    expect(pagePending.get().chunks).toBe(1);
    release();
    await abandoned;
    await next;
    expect(pagePending.get().chunks).toBe(0);
  });

  it('tracks mounted Suspense fallbacks so first loads have only one Loading status', () => {
    // Separate pending feedback must not duplicate the first-load Suspense status.
    const unmountOuter = registerPageFallback();
    const unmountInner = registerPageFallback();
    expect(pagePending.get().fallbacks).toBe(2);
    unmountInner();
    expect(pagePending.get().fallbacks).toBe(1);
    unmountOuter();
    expect(pagePending.get()).toEqual({ chunks: 0, fallbacks: 0 });
  });
});

describe('route chunk warming', () => {
  it('shares a successful prefetch with navigation, including a tab URL with filters', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    const load = vi.fn().mockResolvedValue({ default: 'page' });
    const navigate = pageChunk('source', load);
    prefetchOntologyPage('/o/demo/source?format=turtle#code');
    expect(await navigate()).toEqual({ default: 'page' });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('leaves a failed prefetch retryable and preserves the import failure as its cause', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    const cause = new TypeError('Failed to fetch dynamically imported module');
    const load = vi.fn().mockRejectedValueOnce(cause).mockResolvedValue({ default: 'page' });
    const navigate = pageChunk('failed-tab', load);
    await expect(navigate()).rejects.toMatchObject({ name: 'RouteChunkError', cause });
    expect(await navigate()).toEqual({ default: 'page' });
    expect(load).toHaveBeenCalledTimes(2);
    expect(new RouteChunkError(cause)).toBeInstanceOf(Error);
  });

  it('silences a speculative failure without poisoning the next navigation', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    const load = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValue('ready');
    const navigate = pageChunk('speculation', load);
    prefetchPage('speculation');
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    await expect(navigate()).resolves.toBe('ready');
  });

  it.each([{ onLine: false }, { onLine: true, connection: { saveData: true } }])('skips all speculation on a constrained connection: %j', (connection) => {
    vi.stubGlobal('navigator', connection);
    const load = vi.fn();
    pageChunk('source', load);
    prefetchPage('source');
    expect(warmOntology()).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });

  it('warms layout and Overview on idle, with a bounded timeout and cancellation', () => {
    vi.stubGlobal('navigator', { onLine: true });
    const layout = vi.fn().mockResolvedValue({});
    const overview = vi.fn().mockResolvedValue({});
    pageChunk('layout', layout); pageChunk('overview', overview);
    const idle = vi.fn().mockReturnValue(7);
    const cancel = vi.fn();
    vi.stubGlobal('window', { requestIdleCallback: idle, cancelIdleCallback: cancel });
    const cleanup = warmOntology();
    expect(layout).not.toHaveBeenCalled();
    expect(idle).toHaveBeenCalledWith(expect.any(Function), { timeout: 2000 });
    idle.mock.calls[0][0]();
    expect(layout).toHaveBeenCalledOnce();
    expect(overview).toHaveBeenCalledOnce();
    cleanup?.();
    expect(cancel).toHaveBeenCalledWith(7);
  });

  it('uses a cancellable timer when requestIdleCallback is unavailable', () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('window', {});
    const load = vi.fn().mockResolvedValue({});
    pageChunk('layout', load); pageChunk('overview', load);
    warmOntology()?.();
    vi.advanceTimersByTime(300);
    expect(load).not.toHaveBeenCalled();
    warmOntology();
    vi.advanceTimersByTime(300);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
