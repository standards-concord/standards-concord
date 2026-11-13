/** Route loaders are registered by App, shared by React.lazy and navigation prefetches. */
const pages = new Map<string, () => Promise<unknown>>();

let pendingPages = { chunks: 0, fallbacks: 0 };
/** The downloads a page on screen is waiting for now. One left behind by going elsewhere is taken out. */
const waits = new Set<object>();
const listeners = new Set<() => void>();
let notificationQueued = false;

function setPending(next: typeof pendingPages) {
  pendingPages = next;
  // React.lazy calls its loader during render. Notify after that render, and batch fast loads.
  if (notificationQueued) return;
  notificationQueued = true;
  queueMicrotask(() => {
    notificationQueued = false;
    listeners.forEach((listener) => listener());
  });
}

/** Only React.lazy's waits count; speculative downloads leave the current page alone. */
export const pagePending = {
  get: () => pendingPages,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};

/** A mounted Suspense fallback supplies its own delayed Loading status. */
export function registerPageFallback() {
  setPending({ ...pendingPages, fallbacks: pendingPages.fallbacks + 1 });
  return () => setPending({ ...pendingPages, fallbacks: pendingPages.fallbacks - 1 });
}

/** Another page has opened: a download that began before it is no longer what the person is waiting for. */
export function dismissPageWaits() {
  if (!waits.size) return;
  waits.clear();
  setPending({ ...pendingPages, chunks: 0 });
}

export class RouteChunkError extends Error {
  constructor(cause: unknown) {
    super('Could not download this page', { cause });
    this.name = 'RouteChunkError';
  }
}

export function pageChunk<T>(name: string, load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  const preload = () => pending ??= load().catch((cause: unknown) => {
    pending = undefined;
    throw new RouteChunkError(cause);
  });
  pages.set(name, preload);
  return () => {
    const result = preload();
    const wait = {};
    waits.add(wait);
    setPending({ ...pendingPages, chunks: waits.size });
    return result.finally(() => {
      if (waits.delete(wait)) setPending({ ...pendingPages, chunks: waits.size });
    });
  };
}

function saveData() {
  return (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
}

export function prefetchPage(name: string) {
  if (saveData() || !navigator.onLine) return;
  void pages.get(name)?.().catch(() => { /* Navigation reports failures; warming must stay silent. */ });
}

export function prefetchOntologyPage(href: string) {
  prefetchPage(href.split('?')[0].split('#')[0].split('/')[3] || 'overview');
}

/** Warm the hub's next step after first paint. Return the effect's cleanup. */
export function warmOntology() {
  if (saveData() || !navigator.onLine) return;
  const load = () => { prefetchPage('layout'); prefetchPage('overview'); };
  if ('requestIdleCallback' in window) {
    const id = window.requestIdleCallback(load, { timeout: 2000 });
    return () => window.cancelIdleCallback(id);
  }
  const timer = setTimeout(load, 300);
  return () => clearTimeout(timer);
}
