import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import viteConfig from '../../web/vite.config.js';
import { config as middlewareConfig } from '../../../middleware.js';

const serverPaths = ['/def', '/def/', '/def.jsonld', '/def.ttl', '/def/volunteering'];

describe('public catalogue routing', () => {
  it('proxies the catalogue, both formats and ontology pages in Vite dev and preview', () => {
    // The dev proxy used to match only /def/, leaving /def in the app shell.
    const proxy = viteConfig.server!.proxy!;
    for (const url of serverPaths) expect(Object.keys(proxy).some((key) => key.startsWith('^') && new RegExp(key).test(url)), url).toBe(true);
    expect(Object.keys(proxy).some((key) => key.startsWith('^') && new RegExp(key).test('/definitions'))).toBe(false);
    // Vite preview inherits server.proxy unless overridden.
    expect(viteConfig.preview?.proxy).toBeUndefined();
  });

  it('matches the catalogue and its files in the backend deployment middleware', () => {
    expect(middlewareConfig.matcher).toContain('/def/:path*');
    expect(middlewareConfig.matcher).toContain('/def.jsonld');
    expect(middlewareConfig.matcher).toContain('/def.ttl');
  });

  it('always leaves catalogue navigations to the network instead of the offline app shell', () => {
    const callbacks = new Map<string, (event: unknown) => void>();
    const origin = 'https://concord.example';
    const source = fs.readFileSync(new URL('../../web/sw/sw.js', import.meta.url), 'utf8');
    vm.runInNewContext(source, {
      self: { __CONCORD_VERSION__: 'test', __CONCORD_FILES__: [], location: { origin }, addEventListener: (event: string, fn: (event: unknown) => void) => callbacks.set(event, fn) },
      URL,
      fetch: () => Promise.resolve({ ok: true }),
    });
    for (const url of [...serverPaths, '/definitions']) {
      const respondWith = vi.fn();
      callbacks.get('fetch')!({ request: { method: 'GET', mode: 'navigate', url: origin + url }, respondWith });
      expect(respondWith.mock.calls.length, url).toBe(url === '/definitions' ? 1 : 0);
    }
  });
});
