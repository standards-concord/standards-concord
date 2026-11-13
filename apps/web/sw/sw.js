/*
 * Concord's service worker: keeps the app itself on this device, so it opens with no connection
 * (pages then show what lib/offlineStore.ts saved). The build (vite.config.ts) fills in VERSION and
 * the list of files to keep. Only the app's own files are handled here: the API, sign-in, MCP and
 * public ontology pages always go to the network.
 * Keep this simple: retain the two newest earlier builds (cache keys are in creation order).
 * Older open tabs can still load their hashed assets offline across two updates. A tab more
 * than two builds behind may show the existing "isn't available offline yet" message when
 * opening a page it has never opened. Documents always use the current build's cache.
 */
const VERSION = self.__CONCORD_VERSION__;
const FILES = self.__CONCORD_FILES__;
const CACHE = `concord-app-${VERSION}`;
const SERVER = /^\/(api|auth|mcp|people|def|healthz|\.well-known|authorize|token|register|revoke)(\/|$)|^\/def\.(jsonld|ttl)$/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(['/index.html', ...FILES]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('concord-app-') && k !== CACHE).slice(0, -2).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || SERVER.test(url.pathname)) return;
  if (req.mode === 'navigate') {
    // The network first, so a new release shows as soon as it is out; the kept app with no connection.
    event.respondWith(fetch(req).catch(() => caches.open(CACHE).then((c) => c.match('/index.html', { ignoreVary: true })).then((r) => r || Response.error())));
    return;
  }
  if (FILES.includes(url.pathname)) {
    // Built files have a hash in their name, so a kept copy is always the right one. Matched by path
    // alone: scripts and styles are asked for with an Origin header the kept copy's request lacked.
    event.respondWith(caches.open(CACHE).then((c) => c.match(url.pathname, { ignoreVary: true }).then((r) => r || fetch(req))));
    return;
  }
  if (/^\/assets\/[^/]+-[\w-]+\.\w+$/.test(url.pathname)) {
    // An older tab still imports its build's hashed URLs after this worker claims it.
    event.respondWith((async () => {
      const keys = (await caches.keys()).filter((key) => key.startsWith('concord-app-')).reverse();
      for (const key of keys) {
        const cached = await (await caches.open(key)).match(url.pathname, { ignoreVary: true });
        if (cached) return cached;
      }
      return fetch(req);
    })());
  }
});
