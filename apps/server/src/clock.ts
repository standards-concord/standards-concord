/**
 * The governance clock. Review periods and vote windows are measured against
 * this, so alpha testers can fast-forward time in demo mode instead of waiting days.
 */
let offsetMs = 0;

export const clock = {
  now(): Date {
    return new Date(Date.now() + offsetMs);
  },
  iso(): string {
    return clock.now().toISOString();
  },
  advance(ms: number) {
    offsetMs += ms;
  },
  reset() {
    offsetMs = 0;
  },
  get offsetMs() {
    return offsetMs;
  },
  set offsetMs(v: number) {
    offsetMs = v;
  },
};

export const DAY_MS = 24 * 60 * 60 * 1000;
export const addDays = (iso: string, days: number) => new Date(new Date(iso).getTime() + days * DAY_MS).toISOString();
