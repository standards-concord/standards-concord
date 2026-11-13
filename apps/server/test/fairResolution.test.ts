import { afterEach, expect, it, vi } from 'vitest';
import type { Release } from '@concord/shared';
import { list } from '../src/db.js';
import { fairContext } from '../src/services/fairResolution.js';

vi.mock('../src/db.js', () => ({ list: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('does not look up an address until a release is published, then uses the normal resolver', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('FAIR_RESOLVE', '1');
  const fetch = vi.fn(async (_iri: string, options: RequestInit) => new Response('', { headers: { 'content-type': options.headers && (options.headers as { accept: string }).accept === 'text/html' ? 'text/html' : 'text/turtle' } }));
  vi.stubGlobal('fetch', fetch);
  const iri = 'https://example.org/first-release';
  vi.mocked(list).mockResolvedValue([]);
  expect(await fairContext(iri, 'new')).toEqual({ unreleased: true });
  vi.mocked(list).mockResolvedValue([{ status: 'draft' } as Release]);
  expect(await fairContext(iri, 'new')).toEqual({ unreleased: true });
  expect(fetch).not.toHaveBeenCalled();
  vi.mocked(list).mockResolvedValue([{ status: 'published' } as Release]);
  expect(await fairContext(iri, 'new')).toEqual({ resolution: { rdf: true, html: true } });
  expect(fetch).toHaveBeenCalledTimes(2);
});
