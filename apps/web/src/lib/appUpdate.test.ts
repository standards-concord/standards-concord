import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadApp, reloadForChunkFailure } from './appUpdate';
import { APP_VERSION } from '@concord/shared';

const reload = vi.fn();
let flags: Map<string, string>;
beforeEach(() => {
  flags = new Map(); reload.mockClear();
  vi.stubGlobal('window', { location: { reload } });
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('sessionStorage', { getItem: (k: string) => flags.get(k), setItem: (k: string, v: string) => flags.set(k, v) });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('recovering a failed route import', () => {
  it('reloads at most once per build and keeps the flag across further failures', async () => {
    reloadForChunkFailure(); reloadForChunkFailure();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect([...flags.keys()]).toEqual([`concord.chunkReload.${APP_VERSION}.${import.meta.env.VITE_APP_COMMIT || 'local'}`]);
    reloadForChunkFailure();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('stays on the page offline and does not spend its online recovery attempt', () => {
    vi.stubGlobal('navigator', { onLine: false });
    reloadForChunkFailure();
    expect(reload).not.toHaveBeenCalled();
    expect(flags.size).toBe(0);
  });

  it('does not risk a reload loop when session storage is unavailable', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('storage blocked'); } });
    reloadForChunkFailure();
    expect(reload).not.toHaveBeenCalled();
  });

  it('checks for a new worker and lets it activate before reloading', async () => {
    const worker = new EventTarget() as EventTarget & { state: string };
    worker.state = 'installing';
    const update = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => ({ update, installing: worker }) } });
    const done = reloadApp();
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(reload).not.toHaveBeenCalled();
    worker.state = 'activated'; worker.dispatchEvent(new Event('statechange'));
    await done;
    expect(reload).toHaveBeenCalledOnce();
  });

  it('still retries if the worker update fails', async () => {
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => ({ update: async () => { throw new Error('offline'); } }) } });
    await reloadApp();
    expect(reload).toHaveBeenCalledOnce();
  });
});
