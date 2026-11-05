import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

describe('voice cache and budget', () => {
  const dir = () => mkdtempSync(path.join(os.tmpdir(), 'voice-'));
  const req = (text: string, previous?: string, next?: string) => ({ text, previous, next });
  const touch = (file: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '');
  };

  it('keys a clip by its own words, so editing a neighbour reuses it', () => {
    const v = new Voice({ provider: 'elevenlabs' }, dir());
    touch((v as any).fileFor(req('Hello.', 'Before.', 'After.')));
    expect(v.needsVoicing(req('Hello.', 'Changed before.', 'Changed after.'))).toBe(false);
    expect(v.needsVoicing(req('Hello, edited.', 'Before.', 'After.'))).toBe(true);
  });

  it('still finds clips voiced when neighbours were part of the key', () => {
    const v = new Voice({ provider: 'elevenlabs' }, dir());
    touch((v as any).fileFor(req('Hello.', 'Before.', 'After.'), true));
    expect(v.needsVoicing(req('Hello.', 'Before.', 'After.'))).toBe(false);
  });

  it('refuses a batch over the budget before sending anything', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return { ok: false, status: 500, text: async () => '' };
    });
    const v = new Voice({ provider: 'elevenlabs' }, dir());
    const reqs = [req('a'.repeat(600)), req('b'.repeat(600))];
    expect(() => v.checkBudget(reqs, 1000)).toThrow(/1,200 new characters.*budget of 1,000.*Nothing was sent/);
    expect(v.checkBudget(reqs, 1200)).toBe(1200);
    expect(v.checkBudget(reqs, undefined)).toBe(1200);
    expect(calls).toBe(0);
  });

  it('counts only paragraphs that are not cached, and nothing for free voices', () => {
    const v = new Voice({ provider: 'elevenlabs' }, dir());
    touch((v as any).fileFor(req('cached paragraph')));
    expect(v.checkBudget([req('cached paragraph'), req('new one')], 10)).toBe(7);
    expect(new Voice({ provider: 'silent' }, dir()).checkBudget([req('x'.repeat(5000))], 10)).toBe(0);
  });
});
