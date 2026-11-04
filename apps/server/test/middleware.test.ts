import { afterEach, describe, expect, it } from 'vitest';
import middleware from '../../../middleware.js';

/**
 * The Vercel routing middleware is the only thing that may set x-concord-*
 * headers. @vercel/functions' rewrite() passes the request headers it should
 * forward as x-middleware-request-<name> headers on its response.
 */
const forwarded = (res: Response) => {
  const out: Record<string, string> = {};
  for (const [k, v] of res.headers) if (k.startsWith('x-middleware-request-')) out[k.slice('x-middleware-request-'.length)] = v;
  return out;
};

describe('Vercel middleware', () => {
  afterEach(() => {
    delete process.env.BACKEND_URL;
    delete process.env.CONCORD_PROXY_SECRET;
  });

  it('drops visitors’ own x-concord-* headers and vouches for the real ones with the secret', () => {
    process.env.BACKEND_URL = 'https://backend.example';
    process.env.CONCORD_PROXY_SECRET = 'shh';
    const res = middleware(
      new Request('https://standards-concord.vercel.app/mcp', {
        headers: { 'x-concord-origin': 'https://attacker.example', 'x-concord-proxy-secret': 'guess', 'x-concord-client-ip': '1.2.3.4', 'x-real-ip': '203.0.113.9' },
      }),
    );
    expect(res.headers.get('x-middleware-rewrite')).toBe('https://backend.example/mcp');
    const h = forwarded(res);
    expect(h['x-concord-origin']).toBe('https://standards-concord.vercel.app');
    expect(h['x-concord-proxy-secret']).toBe('shh');
    expect(h['x-concord-client-ip']).toBe('203.0.113.9');
  });

  it('sends no x-concord-* headers at all without the secret', () => {
    process.env.BACKEND_URL = 'https://backend.example';
    const res = middleware(new Request('https://preview.vercel.app/token', { headers: { 'x-concord-origin': 'https://attacker.example', 'x-concord-proxy-secret': 'guess' } }));
    const h = forwarded(res);
    expect(Object.keys(h).filter((k) => k.startsWith('x-concord-'))).toEqual([]);
  });
});
