import { BUSY_TIMEOUT_MS, StoreBusyError } from './types.js';

interface Waiter {
  grant: () => void;
  timer: NodeJS.Timeout;
}

/**
 * A first-come, first-served lock over one connection (SQLite's, or PGlite's). Releasing hands it straight to
 * the next in line, so it stays held and nobody arriving later can overtake. A wait longer than BUSY_TIMEOUT_MS
 * fails with StoreBusyError, and with `noWait` any wait fails at once.
 */
export class FifoLock {
  private locked = false;
  private readonly waiters: Waiter[] = [];

  /** Whether taking the lock now would mean waiting. */
  get busy() {
    return this.locked;
  }

  /** Take the lock: synchronously (returning undefined) when it is free, otherwise a promise of it. */
  acquire(noWait = false): Promise<void> | undefined {
    if (!this.locked) {
      this.locked = true;
      return undefined;
    }
    if (noWait) throw new StoreBusyError();
    return new Promise((resolve, reject) => {
      const w: Waiter = {
        grant: () => {
          clearTimeout(w.timer);
          resolve();
        },
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          reject(new StoreBusyError());
        }, BUSY_TIMEOUT_MS),
      };
      this.waiters.push(w);
    });
  }

  release() {
    const next = this.waiters.shift();
    if (next) next.grant();
    else this.locked = false;
  }

  async with<T>(fn: () => Promise<T> | T, noWait = false): Promise<T> {
    const turn = this.acquire(noWait);
    if (turn) await turn;
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
