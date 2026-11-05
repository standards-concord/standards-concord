import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyRunBudget, DEFAULT_VOICE_BUDGET, parseBudget, recordVideos, videoEnv } from '../lib/budget.ts';
import { Voice } from '../lib/tts.ts';

describe('the run budget', () => {
  beforeEach(() => {
    process.env.ELEVENLABS_API_KEY = 'test-key';
  });
  afterEach(() => {
    delete process.env.ELEVENLABS_API_KEY;
  });

  // Local runs used to have no limit unless one was set.
  it('defaults to 2,500 characters, with 0 for no limit', () => {
    expect(DEFAULT_VOICE_BUDGET).toBe(2500);
    expect(parseBudget(undefined)).toBe(2500);
    expect(parseBudget('')).toBe(2500);
    expect(parseBudget('4000')).toBe(4000);
    expect(parseBudget('0')).toBeUndefined();
    expect(() => parseBudget('lots')).toThrow(/whole number/);
    expect(() => parseBudget('-1')).toThrow(/whole number/);
  });

  // Each video used to start with a fresh budget, and the second video's refusal came
  // after the first had already sent its narration.
  it('plans every video and refuses before recording any if the total is over', async () => {
    const recorded: string[] = [];
    const costs: Record<string, number> = { tour: 2000, feedback: 1000 };
    await expect(
      recordVideos({
        videos: ['tour', 'feedback'],
        paid: true,
        budget: 2500,
        plan: async (v, file) => writeFileSync(file, JSON.stringify({ cost: costs[v] })),
        record: async (v) => void recorded.push(v),
      }),
    ).rejects.toThrow(/need 3,000 new characters.*budget of 2,500\. Nothing was sent/);
    expect(recorded).toEqual([]);
  });

  it('records every video against one shared ledger', async () => {
    const cache = mkdtempSync(path.join(os.tmpdir(), 'voice-'));
    const seen: { video: string; spentBefore: number }[] = [];
    await recordVideos({
      videos: ['tour', 'feedback'],
      paid: true,
      budget: 2500,
      plan: async (_v, file) => writeFileSync(file, JSON.stringify({ cost: 1000 })),
      // What a video's process does: its voice, under the run's budget, then a send.
      record: async (video, ledger) => {
        const voice = applyRunBudget(new Voice({ provider: 'elevenlabs' }, cache), videoEnv({}, ledger), 2500);
        seen.push({ video, spentBefore: voice.spent });
        (voice as any).charge(1000);
      },
    });
    expect(seen).toEqual([
      { video: 'tour', spentBefore: 0 },
      { video: 'feedback', spentBefore: 1000 },
    ]);
  });

  it('does not plan for free voices or an unlimited budget', async () => {
    const planned: string[] = [];
    const recorded: string[] = [];
    for (const o of [{ paid: false, budget: 2500 }, { paid: true, budget: undefined }])
      await recordVideos({ videos: ['tour'], ...o, plan: async (v) => void planned.push(v), record: async (v) => void recorded.push(v) });
    expect(planned).toEqual([]);
    expect(recorded).toEqual(['tour', 'tour']);
  });
});
