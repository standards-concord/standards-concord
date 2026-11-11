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
    delete process.env.CONCORD_API;
  });

  // The first preview of the API as a function (2026-11-11) never reached it: this middleware runs before the
  // function's routes and forwarded every API path to the VM at BACKEND_URL, and without BACKEND_URL (the cutover)
  // it answered 503 instead of letting the request through.
  it('lets API requests through to the function when no BACKEND_URL is set, as at the cutover', () => {
    const res = middleware(new Request('https://standards-concord.vercel.app/api/ontologies', { headers: { 'x-concord-origin': 'https://attacker.example' } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    expect(Object.keys(forwarded(res)).filter((k) => k.startsWith('x-concord-'))).toEqual([]);
  });

  it('lets them through with CONCORD_API=function even while BACKEND_URL is set, for a preview of the function', () => {
    process.env.BACKEND_URL = 'https://backend.example';
    process.env.CONCORD_API = 'function';
    const res = middleware(new Request('https://preview.vercel.app/healthz'));
    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
  });

  it('says what is missing when CONCORD_API=backend has no BACKEND_URL to forward to', async () => {
    process.env.CONCORD_API = 'backend';
    const res = middleware(new Request('https://preview.vercel.app/api/session'));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/BACKEND_URL/);
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
