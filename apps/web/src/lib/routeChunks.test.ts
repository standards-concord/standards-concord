import { afterEach, describe, expect, it, vi } from 'vitest';
import { pageChunk, prefetchOntologyPage, prefetchPage, RouteChunkError, warmOntology } from './routeChunks';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

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
