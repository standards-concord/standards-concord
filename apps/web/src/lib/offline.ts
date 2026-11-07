import { useSyncExternalStore } from 'react';

/**
 * Whether Concord can reach its server right now. It goes offline when the browser says so or a
 * request can't get through, and back online when the browser says so or any answer comes back.
 */
let offline = typeof navigator !== 'undefined' && navigator.onLine === false;
const listeners = new Set<() => void>();

export function setOffline(next: boolean) {
  if (next === offline) return;
  offline = next;
  for (const fn of listeners) fn();
}

export function isOffline() {
  return offline;
}

if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => setOffline(true));
  window.addEventListener('online', () => setOffline(false));
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function useOffline(): boolean {
  return useSyncExternalStore(subscribe, isOffline, () => false);
}
