import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The governance clock. Review periods and vote windows are measured against
 * this, so alpha testers can fast-forward time in demo mode instead of waiting days.
 *
 * The offset is kept in the database too (`kv governance-clock`), so every server or function instance runs on
 * the same clock: `advanceClock` and a demo reset save it, and `syncClock` loads it before each request and each
 * scheduled run. Seeding the demo runs on a clock of its own (`withShift`), which nothing else sees.
 */
let offsetMs = 0;
const shifts = new AsyncLocalStorage<{ ms: number }>();
const shift = () => shifts.getStore()?.ms ?? 0;

export const clock = {
  now(): Date {
    return new Date(Date.now() + offsetMs + shift());
  },
  iso(): string {
    return clock.now().toISOString();
  },
  /** Moves the clock forward: the shared one, or inside `withShift` only that shift. */
  advance(ms: number) {
    const s = shifts.getStore();
    if (s) s.ms += ms;
    else offsetMs += ms;
  },
  reset() {
    offsetMs = 0;
  },
  /** Runs `fn` on this clock moved by `ms` (and by whatever `fn` advances it), without moving it for anyone else. */
  withShift<T>(ms: number, fn: () => Promise<T>): Promise<T> {
    return shifts.run({ ms: shift() + ms }, fn);
  },
  get offsetMs() {
    return offsetMs;
  },
  set offsetMs(v: number) {
    offsetMs = v;
  },
};

const CLOCK_ROW = 'governance-clock';
/** Saves the shared offset, for every other instance. */
export async function saveClock(): Promise<void> {
  const { put } = await import('./db.js');
  await put('kv', { id: CLOCK_ROW, offsetMs });
}
/** Loads the shared offset another instance may have moved. */
export async function syncClock(): Promise<void> {
  const { get } = await import('./db.js');
  const row = await get<{ offsetMs?: number }>('kv', CLOCK_ROW);
  if (row && Number.isFinite(row.offsetMs)) offsetMs = row.offsetMs!;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
export const addDays = (iso: string, days: number) => new Date(new Date(iso).getTime() + days * DAY_MS).toISOString();
