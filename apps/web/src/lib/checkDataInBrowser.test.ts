import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The checker's worker can't be interrupted part way through a job, so stopping one check means
 * replacing the worker. These tests use a stand-in Worker that only answers when told to.
 */
class FakeWorker {
  static all: FakeWorker[] = [];
  received: { id: number; text: string }[] = [];
  terminated = false;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: { message: string }) => void) | null = null;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(m: { id: number; text: string }) {
    this.received.push(m);
  }
  terminate() {
    this.terminated = true;
  }
  answer(text: string) {
    const job = this.received.find((j) => j.text === text)!;
    this.onmessage?.({ data: { id: job.id, outcome: { conforms: true }, ms: 1 } });
  }
}

const job = (text: string) => ({ key: 'k', ontology: '', shapes: '', text, format: 'turtle' as const, baseIRI: 'https://data.example/', maxTriples: 10 });

async function load() {
  vi.resetModules();
  FakeWorker.all = [];
  vi.stubGlobal('Worker', FakeWorker);
  return import('./checkDataInBrowser');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('checkDataInBrowser', () => {
  // Used to go wrong: one check running past its time limit (or cancelled) stopped the worker and
  // failed every other check waiting on it, including the newest one, which the page then showed as an error.
  it('a check that times out fails alone; the others move to a new worker and still answer', async () => {
    vi.useFakeTimers();
    const { checkDataInBrowser } = await load();
    const slow = checkDataInBrowser(job('slow'), { timeoutMs: 1000 });
    const newer = checkDataInBrowser(job('newer'), { timeoutMs: 60_000 });
    vi.advanceTimersByTime(1001);
    await expect(slow).rejects.toMatchObject({ status: 422 });
    const [first, second] = FakeWorker.all;
    expect(first.terminated).toBe(true);
    expect(second.received.map((j) => j.text)).toEqual(['newer']);
    second.answer('newer');
    await expect(newer).resolves.toMatchObject({ conforms: true });
  });

  it('cancelling one check leaves the others to answer', async () => {
    const { checkDataInBrowser } = await load();
    const controller = new AbortController();
    const old = checkDataInBrowser(job('old'), { signal: controller.signal });
    const latest = checkDataInBrowser(job('latest'));
    controller.abort();
    await expect(old).rejects.toMatchObject({ name: 'AbortError' });
    FakeWorker.all.at(-1)!.answer('latest');
    await expect(latest).resolves.toMatchObject({ conforms: true });
  });

  // Used to go wrong: a check moved to a new worker kept its old timer, so it could be stopped
  // as "too slow" moments after the new worker started it.
  it('a check moved to a new worker gets its full time limit again', async () => {
    vi.useFakeTimers();
    const { checkDataInBrowser } = await load();
    const slow = checkDataInBrowser(job('slow'), { timeoutMs: 1000 });
    const newer = checkDataInBrowser(job('newer'), { timeoutMs: 1500 });
    vi.advanceTimersByTime(1001);
    await expect(slow).rejects.toMatchObject({ status: 422 });
    let settled = false;
    newer.then(() => (settled = true), () => (settled = true));
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(settled).toBe(false);
    FakeWorker.all.at(-1)!.answer('newer');
    await expect(newer).resolves.toMatchObject({ conforms: true });
  });

  // Used to go wrong: only an explicit sign-out reset the checker, so signing in as someone else
  // (or out in another tab) left the last account's parsed ontologies in the worker.
  it('any change of account forgets everything the worker parsed', async () => {
    const listeners: (() => void)[] = [];
    vi.doMock('./session', () => ({ onAccountChange: (fn: () => void) => (listeners.push(fn), () => undefined) }));
    const { checkDataInBrowser } = await load();
    const pending = checkDataInBrowser(job('x'));
    for (const fn of listeners) fn();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.all[0].terminated).toBe(true);
    vi.doUnmock('./session');
  });

  it('signing out forgets everything the worker parsed', async () => {
    const { checkDataInBrowser, resetDataCheck } = await load();
    const pending = checkDataInBrowser(job('x'));
    resetDataCheck();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.all[0].terminated).toBe(true);
  });
});
