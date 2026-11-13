import { createElement, lazy, type ComponentType } from 'react';

/** Route loaders are registered by App, shared by React.lazy and navigation prefetches. */
const pages = new Map<string, () => Promise<unknown>>();
/** Pages whose download has ended. React.lazy keeps either outcome, so neither is waited for again. */
const settled = new Set<string>();

let pendingPages = { chunks: 0, fallbacks: 0 };
/** The pages the person is waiting for now, by name. One left behind by going elsewhere is taken out. */
const waits = new Set<string>();
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

/** Only pages being opened count (see pageWanted); speculative downloads leave the current page alone. */
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

/**
 * A page is being opened. Until its code has downloaded it counts as waited for, unless another page
 * opens first. Called each time the page is rendered, not from React.lazy's loader: React asks for a
 * page's code once, so someone coming back to a page still downloading would get no Loading.
 */
export function pageWanted(name: string) {
  if (settled.has(name) || waits.has(name)) return;
  waits.add(name);
  setPending({ ...pendingPages, chunks: waits.size });
}

export function pageChunk<T>(name: string, load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  const done = () => {
    settled.add(name);
    if (waits.delete(name)) setPending({ ...pendingPages, chunks: waits.size });
  };
  const preload = () => pending ??= load().then(
    (page) => { done(); return page; },
    (cause: unknown) => {
      pending = undefined;
      done();
      throw new RouteChunkError(cause);
    },
  );
  pages.set(name, preload);
  return preload;
}

/** A page that downloads when it is first opened, and says it is wanted every time it is rendered. */
export function lazyPage(name: string, load: () => Promise<{ default: ComponentType }>) {
  const Page = lazy(pageChunk(name, load));
  return function LazyPage() {
    pageWanted(name);
    return createElement(Page);
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
