import { afterEach, describe, expect, it, vi } from 'vitest';
import { Voice } from '../lib/tts.ts';

describe('voice requests', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ELEVENLABS_OUTPUT_FORMAT;
  });

  it('retries when the connection drops while the body is read', async () => {
    Voice.retryBaseMs = 1;
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      if (calls === 1) return { ok: true, status: 200, json: async () => Promise.reject(new TypeError('terminated')) };
      return { ok: true, status: 200, json: async () => ({ audio_base64: 'AA==' }) };
    });
    const v = new Voice({ provider: 'openai' }, '/tmp/unused');
    const out = await (v as any).post('https://example.invalid', {}, 'test', (r: Response) => r.json());
    expect(out).toEqual({ audio_base64: 'AA==' });
    expect(calls).toBe(2);
  });

  it('gives up on client errors without retrying', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return { ok: false, status: 401, text: async () => 'bad key' };
    });
    const v = new Voice({ provider: 'openai' }, '/tmp/unused');
    await expect((v as any).post('https://example.invalid', {}, 'test', (r: Response) => r.json())).rejects.toThrow(/401 bad key/);
    expect(calls).toBe(1);
  });
});
