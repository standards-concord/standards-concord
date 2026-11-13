import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// The browser suite runs one build. A fake worker can exercise an older tab after deployment.
const source = readFileSync(new URL('../../sw/sw.js', import.meta.url), 'utf8');
const assetA = '/assets/Source-AAAA1111.js';
const assetB = '/assets/Source-BBBB2222.js';

function worker(version: string, files: string[], builds: Record<string, Record<string, string>>) {
  const stored = new Map(Object.entries(builds).map(([name, files]) => [name, {
    entries: new Map(Object.entries(files).map(([path, body]) => [path, new Response(body)])),
    match: vi.fn(async function (this: { entries: Map<string, Response> }, path: string, _options?: CacheQueryOptions) {
      return this.entries.get(path)?.clone();
    }),
    addAll: vi.fn(async (_paths: string[]) => {}),
  }]));
  const caches = {
    keys: vi.fn(async () => [...stored.keys()]),
    open: vi.fn(async (name: string) => {
      const cache = stored.get(name);
      if (!cache) throw new Error(`Unexpected cache: ${name}`);
      return cache;
    }),
    delete: vi.fn(async (name: string) => stored.delete(name)),
  };
  type WorkerEvent = { request?: { url: string; method: string; mode: string }; waitUntil?: (task: Promise<unknown>) => void; respondWith?: (task: Promise<Response>) => void };
  const listeners = new Map<string, (event: WorkerEvent) => void>();
  const fetch = vi.fn(async () => { throw new TypeError('offline'); });
  const claim = vi.fn(async () => {});
  const skipWaiting = vi.fn(async () => {});
  runInNewContext(source, {
    self: {
      __CONCORD_VERSION__: version, __CONCORD_FILES__: files,
      location: { origin: 'https://concord.test' }, clients: { claim }, skipWaiting,
      addEventListener: (name: string, listener: (event: WorkerEvent) => void) => listeners.set(name, listener),
    },
    caches, fetch, URL, Response,
  });
  return {
    caches, stored, fetch, claim, skipWaiting,
    async lifecycle(name: 'install' | 'activate') {
      let task: Promise<unknown> | undefined;
      listeners.get(name)!({ waitUntil: (value) => { task = value; } });
      expect(task).toBeDefined();
      await task;
    },
    async request(path: string, mode = 'cors', method = 'GET') {
      let response: Promise<Response> | undefined;
      listeners.get('fetch')!({
        request: { url: new URL(path, 'https://concord.test').href, method, mode },
        respondWith: (value) => { response = value; },
      });
      return response;
    },
  };
}

describe('service worker across deployments', () => {
  it('keeps the two newest earlier builds on activation and leaves unrelated caches alone', async () => {
    // Activation used to discard every earlier build, including code needed by open tabs.
    const sw = worker('C', [], {
      'concord-app-oldest': {}, 'unrelated-cache': {}, 'concord-app-A': {}, 'concord-app-B': {}, 'concord-app-C': {},
    });
    await sw.lifecycle('activate');
    expect([...sw.stored.keys()]).toEqual(['unrelated-cache', 'concord-app-A', 'concord-app-B', 'concord-app-C']);
    expect(sw.claim).toHaveBeenCalledOnce();
  });

  it('serves an older tab its hashed asset offline after the next build activates', async () => {
    // Build B used to delete A's code and ignore requests for A's hashed URLs.
    const sw = worker('B', [assetB], {
      'concord-app-A': { [assetA]: 'build A code' }, 'concord-app-B': { [assetB]: 'build B code' },
    });
    await sw.lifecycle('activate');
    const response = await sw.request(`${assetA}?from=older-tab`);
    expect(response).toBeDefined();
    expect(await response?.text()).toBe('build A code');
    expect(sw.stored.get('concord-app-A')!.match).toHaveBeenCalledWith(assetA, { ignoreVary: true });
    expect(sw.fetch).not.toHaveBeenCalled();
  });

  it('serves current-build files only from the current cache', async () => {
    // Keeping old caches must not let an earlier copy of a current file win.
    const sw = worker('B', [assetB, '/favicon.svg'], {
      'concord-app-A': { [assetB]: 'old copy', '/favicon.svg': 'old icon' },
      'concord-app-B': { [assetB]: 'current code', '/favicon.svg': 'current icon' },
    });
    expect(await (await sw.request(assetB))?.text()).toBe('current code');
    expect(await (await sw.request('/favicon.svg'))?.text()).toBe('current icon');
    expect(sw.fetch).not.toHaveBeenCalled();
  });

  it('uses only the current index for offline navigations, including /index.html', async () => {
    // An older tab's asset lookup must never supply an older document after deployment.
    const sw = worker('B', [assetB], {
      'concord-app-A': { '/index.html': 'old document' }, 'concord-app-B': { '/index.html': 'current document' },
    });
    for (const path of ['/o/example/source', '/index.html']) {
      expect(await (await sw.request(path, 'navigate'))?.text()).toBe('current document');
    }
    expect(sw.stored.get('concord-app-A')!.match).not.toHaveBeenCalled();
  });

  it('falls back to the network when no retained cache has the old hashed asset', async () => {
    // Tabs beyond the two-build retention limit must reach the existing offline error path.
    const sw = worker('C', [assetB], { 'concord-app-C': {} });
    await expect(sw.request(assetA)).rejects.toThrow('offline');
    expect(sw.fetch).toHaveBeenCalledOnce();
  });

  it('does not handle API, sign-in, public server paths or unrelated requests', async () => {
    // Serving earlier assets must not broaden the worker to server-owned routes.
    const sw = worker('B', [assetB], { 'concord-app-B': {} });
    for (const path of ['/api/ontologies', '/auth/login', '/mcp', '/people/example', '/def/example', '/def.ttl', '/def.jsonld', '/healthz', '/.well-known/oauth', '/authorize', '/token', '/register', '/revoke', 'https://elsewhere.test' + assetA]) {
      expect(await sw.request(path, 'navigate')).toBeUndefined();
    }
    expect(await sw.request('/unknown.txt')).toBeUndefined();
    expect(await sw.request(assetB, 'cors', 'POST')).toBeUndefined();
    expect(sw.fetch).not.toHaveBeenCalled();
  });

  it('installs the current index and full build file list before skipping waiting', async () => {
    const sw = worker('B', [assetB, '/assets/worker-BBBB2222.js'], { 'concord-app-B': {} });
    await sw.lifecycle('install');
    expect(sw.stored.get('concord-app-B')!.addAll).toHaveBeenCalledWith(['/index.html', assetB, '/assets/worker-BBBB2222.js']);
    expect(sw.skipWaiting).toHaveBeenCalledOnce();
  });
});
