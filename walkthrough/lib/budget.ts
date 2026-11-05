/**
 * The narration character budget for a whole recording run (walkthrough/README.md).
 * Paid voices are limited, so a run may send at most this many characters, across every
 * video it records, retries included.
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Voice } from './tts.ts';

export const DEFAULT_VOICE_BUDGET = 2500;

/** The budget from --voice-budget or VOICE_CHAR_BUDGET: 2,500 when unset, undefined (no limit) for 0. */
export function parseBudget(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return DEFAULT_VOICE_BUDGET;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`The voice budget must be a whole number of characters (got "${raw}")`);
  return n || undefined;
}

export interface RunVideos {
  videos: string[];
  /** Whether the voice is a paid one (the budget only applies to those). */
  paid: boolean;
  budget: number | undefined;
  /** Works out, without sending anything, how many characters a video would send; writes { cost } to `file`. */
  plan: (video: string, file: string) => Promise<void>;
  /** Records a video; every send it makes is added to the shared `ledger`. */
  record: (video: string, ledger: string) => Promise<void>;
  log?: (s: string) => void;
}

/**
 * Records several videos under one budget. With a paid voice, every video is planned
 * first and the run refuses before recording (and so before sending) anything if their
 * total is over; the videos then share one ledger, so each send counts against the same
 * budget.
 */
export async function recordVideos(o: RunVideos) {
  const log = o.log ?? (() => {});
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'walkthrough-voice-'));
  const ledger = path.join(tmp, 'ledger.json');
  if (o.paid && o.budget) {
    let total = 0;
    for (const v of o.videos) {
      log(`\n━━ ${v}: what needs voicing ━━`);
      const file = path.join(tmp, `${v}.plan.json`);
      await o.plan(v, file);
      total += (JSON.parse(await readFile(file, 'utf8')) as { cost: number }).cost;
    }
    if (total > o.budget)
      throw new Error(
        `These videos need ${total.toLocaleString('en')} new characters of narration, over this run's budget of ${o.budget.toLocaleString('en')}. Nothing was sent. Raise VOICE_CHAR_BUDGET (or --voice-budget; 0 means no limit) if that is intended.`,
      );
    log(`\nNarration to voice: ${total.toLocaleString('en')} new characters of a ${o.budget.toLocaleString('en')} budget`);
  }
  for (const v of o.videos) {
    log(`\n━━ ${v} ━━`);
    await o.record(v, ledger);
  }
}

/** The environment a video's recording runs with: the run's shared ledger. */
export const videoEnv = (env: NodeJS.ProcessEnv, ledger: string): NodeJS.ProcessEnv => ({ ...env, VOICE_LEDGER: ledger });

/** Puts a video's voice under the run's budget, counting what earlier videos sent. */
export function applyRunBudget(voice: Voice, env: NodeJS.ProcessEnv, budget: number | undefined) {
  voice.budget = budget;
  if (env.VOICE_LEDGER) voice.useLedger(env.VOICE_LEDGER);
  return voice;
}
