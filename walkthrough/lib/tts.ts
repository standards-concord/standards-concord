/**
 * Text to speech for the narration, with a disk cache so re-recording after a UI change
 * only pays for paragraphs whose words changed. A clip is keyed by its own words and the
 * voice settings, not its neighbours', so editing one paragraph re-voices only that one.
 * Paid voices also have a character budget per run (VOICE_CHAR_BUDGET, or --voice-budget),
 * checked before anything is sent.
 *
 * Providers, best first:
 *   elevenlabs  ElevenLabs (eleven_multilingual_v2). The most natural long-form narration,
 *               and it stitches paragraphs together using the text either side.  ELEVENLABS_API_KEY
 *   openai      OpenAI gpt-4o-mini-tts, steerable with a plain-English style brief.  OPENAI_API_KEY
 *   google      Google Cloud Text-to-Speech Chirp 3 HD voices.  GOOGLE_TTS_API_KEY, or
 *               GOOGLE_TTS_USE_GCLOUD=1 to use `gcloud auth print-access-token`
 *   say         macOS `say`, for quick local drafts
 *   silent      No voice: silence sized to the words, for dry runs and CI
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type ProviderName = 'elevenlabs' | 'openai' | 'google' | 'say' | 'silent';

export interface VoiceOptions {
  provider: ProviderName;
  /** Provider-specific voice id or name. */
  voice?: string;
  /** Provider-specific model. */
  model?: string;
  /** Style brief for providers that take one (OpenAI). */
  style?: string;
  /** Speaking rate multiplier where supported (1 = normal). */
  rate?: number;
}

export interface Clip {
  file: string;
  /** Seconds. */
  duration: number;
  cached: boolean;
  /** Start time (seconds) of each character of the spoken text, when the provider reports it. */
  charStarts?: number[];
}

/**
 * ElevenLabs output format. Only MP3 formats are accepted, because clips are stored and
 * probed as MP3. 128 kbps works on every plan; 192 kbps needs Creator or above.
 */
export const ELEVENLABS_FORMATS = ['mp3_22050_32', 'mp3_44100_32', 'mp3_44100_64', 'mp3_44100_96', 'mp3_44100_128', 'mp3_44100_192'];
const ELEVENLABS_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_128';
/** A fixed seed makes ElevenLabs more repeatable (it does not guarantee identical audio). */
const ELEVENLABS_SEED = 4242;
/** Voice settings sent with every ElevenLabs request (speed is added from the rate). */
const ELEVENLABS_SETTINGS = { stability: 0.5, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true };

export const DEFAULTS: Record<ProviderName, { voice?: string; model?: string; key?: string }> = {
  // "George": a warm, mid-paced British narrator from ElevenLabs' default voice library.
  elevenlabs: { voice: 'JBFqnCBsd6RMkjVDRZzb', model: 'eleven_multilingual_v2', key: 'ELEVENLABS_API_KEY' },
  openai: { voice: 'sage', model: 'gpt-4o-mini-tts', key: 'OPENAI_API_KEY' },
  google: { voice: 'en-GB-Chirp3-HD-Charon', key: 'GOOGLE_TTS_API_KEY' },
  say: { voice: 'Daniel' },
  silent: {},
};

export const DEFAULT_STYLE =
  'You are narrating a calm, friendly product walkthrough video in British English. Speak naturally, like a knowledgeable colleague showing someone around: relaxed pace, warm but not salesy, short natural pauses between ideas.';

/** Picks a provider from the environment when none is given. */
export function autoProvider(): ProviderName {
  if (process.env.ELEVENLABS_API_KEY) return 'elevenlabs';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.GOOGLE_TTS_API_KEY || process.env.GOOGLE_TTS_USE_GCLOUD) return 'google';
  if (process.platform === 'darwin') return 'say';
  return 'silent';
}

export function needsKey(p: ProviderName) {
  if (p === 'google' && process.env.GOOGLE_TTS_USE_GCLOUD) return undefined;
  return DEFAULTS[p].key;
}

/** Reads a secret from the terminal without echoing it. */
export async function askHidden(prompt: string): Promise<string> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) throw new Error(`${prompt}: no terminal to ask on. Set it in the environment instead.`);
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          resolve(value.trim());
          return;
        }
        if (c === '\u0003') {
          stdin.setRawMode(false);
          reject(new Error('Cancelled'));
          return;
        }
        if (c === '\u007f') value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on('data', onData);
  });
}

export async function probeDuration(file: string): Promise<number> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  const d = Number(stdout.trim());
  if (!Number.isFinite(d)) throw new Error(`Could not read the duration of ${file}`);
  return d;
}

/** Estimated speaking time, used for silent drafts: about 155 words a minute. */
export function estimateSeconds(text: string) {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(0.6, words / 2.6);
}

/** A send that would pass the run's character budget; nothing was sent. */
export class BudgetExceeded extends Error {}

export interface SynthRequest {
  text: string;
  /** Neighbouring paragraphs, so the voice keeps a natural flow across clips. */
  previous?: string;
  next?: string;
}

export class Voice {
  /** First retry delay; doubles each time. */
  static retryBaseMs = 1500;

  constructor(
    readonly opts: VoiceOptions,
    readonly cacheDir: string,
  ) {
    if (opts.provider === 'elevenlabs' && !ELEVENLABS_FORMATS.includes(ELEVENLABS_FORMAT))
      throw new Error(`ELEVENLABS_OUTPUT_FORMAT must be one of ${ELEVENLABS_FORMATS.join(', ')} (got "${ELEVENLABS_FORMAT}")`);
  }

  get label() {
    const d = DEFAULTS[this.opts.provider];
    return `${this.opts.provider}${this.opts.provider === 'silent' ? '' : ` (${this.opts.voice ?? d.voice}${this.opts.model || d.model ? `, ${this.opts.model ?? d.model}` : ''})`}`;
  }

  private key(req: SynthRequest, legacy = false) {
    const o = this.opts;
    const d = DEFAULTS[o.provider];
    // Everything that changes the audio is part of its identity, except the neighbouring
    // paragraphs: they only smooth the joins, and keying on them would re-voice a
    // paragraph whenever the one before or after it changed. Clips voiced before that
    // change (legacy) are still found.
    const eleven = o.provider === 'elevenlabs' ? [ELEVENLABS_FORMAT, ELEVENLABS_SEED, ELEVENLABS_SETTINGS] : null;
    const material = JSON.stringify([o.provider, o.voice ?? d.voice, o.model ?? d.model, o.style ?? DEFAULT_STYLE, o.rate ?? 1, req.text, legacy && eleven ? [req.previous, req.next, ...eleven] : eleven]);
    return createHash('sha256').update(material).digest('hex').slice(0, 24);
  }

  private ext() {
    return this.opts.provider === 'say' ? 'aiff' : this.opts.provider === 'silent' ? 'wav' : 'mp3';
  }

  private fileFor(req: SynthRequest, legacy = false) {
    return path.join(this.cacheDir, this.opts.provider, `${this.key(req, legacy)}.${this.ext()}`);
  }

  /** Whether voicing this paragraph would cost anything: a paid voice with no cached clip. */
  needsVoicing(req: SynthRequest) {
    if (!this.paid) return false;
    return !existsSync(this.fileFor(req)) && !(this.opts.provider === 'elevenlabs' && existsSync(this.fileFor(req, true)));
  }

  /** Whether this voice is a paid service (the cloud voices, not say or silent). */
  get paid() {
    return ['elevenlabs', 'openai', 'google'].includes(this.opts.provider);
  }

  /** Characters sent to a paid voice so far in this run (across videos, with a ledger). */
  spent = 0;
  /** Most characters this run may send to a paid voice; undefined means no limit. */
  budget?: number;
  private ledger?: string;

  /**
   * Shares the budget with other processes of the same run (one per video): what they
   * sent is read from `file`, and every send is added to it.
   */
  useLedger(file: string) {
    this.ledger = file;
    this.spent = existsSync(file) ? Number(JSON.parse(readFileSync(file, 'utf8')).spent) || 0 : 0;
  }

  private overBudget(cost: number, before = false) {
    return new BudgetExceeded(
      `Voicing this would send ${cost.toLocaleString('en')} new characters to ${this.opts.provider}` +
        (this.spent ? ` on top of the ${this.spent.toLocaleString('en')} already sent` : '') +
        `, over this run's budget of ${this.budget!.toLocaleString('en')}.${before ? ' Nothing was sent.' : ''} Raise VOICE_CHAR_BUDGET (or --voice-budget; 0 means no limit) if that is intended.`,
    );
  }

  /**
   * Counts characters about to be sent, refusing (before the send) if that would pass the
   * budget. Called for every attempt, retries included: each one may be billed.
   */
  private charge(chars: number) {
    if (!this.paid) return;
    if (this.budget && this.spent + chars > this.budget) throw this.overBudget(chars);
    this.spent += chars;
    if (this.ledger) writeFileSync(this.ledger, JSON.stringify({ spent: this.spent }));
  }

  /**
   * Refuses, before anything is sent, a batch of paragraphs that would take this run past
   * its budget. Returns how many characters the batch will cost.
   */
  checkBudget(reqs: SynthRequest[]) {
    const cost = this.cost(reqs);
    if (this.budget && this.spent + cost > this.budget) throw this.overBudget(cost, true);
    return cost;
  }

  /** Characters a batch of paragraphs would send: the ones not cached, for a paid voice. */
  cost(reqs: SynthRequest[]) {
    return reqs.filter((r) => this.needsVoicing(r)).reduce((a, r) => a + r.text.length, 0);
  }

  /**
   * The ElevenLabs account's characters used and allowed this billing period, or
   * undefined when the key can't read them (a key restricted to text to speech).
   * Reading it costs nothing.
   */
  async quota(): Promise<{ used: number; limit: number; resetsAt?: string } | undefined> {
    if (this.opts.provider !== 'elevenlabs') return undefined;
    try {
      const res = await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': this.secret('ELEVENLABS_API_KEY') }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return undefined;
      const j = (await res.json()) as { character_count?: number; character_limit?: number; next_character_count_reset_unix?: number };
      if (typeof j.character_count !== 'number' || typeof j.character_limit !== 'number') return undefined;
      return { used: j.character_count, limit: j.character_limit, resetsAt: j.next_character_count_reset_unix ? new Date(j.next_character_count_reset_unix * 1000).toISOString() : undefined };
    } catch {
      return undefined;
    }
  }

  /**
   * Refuses, before anything is sent, if the account hasn't `cost` characters left (with a
   * margin for retries). Returns what it saw, for the log.
   */
  async checkQuota(cost: number, margin = 0.1) {
    const q = cost > 0 ? await this.quota() : undefined;
    if (q && q.limit - q.used < Math.ceil(cost * (1 + margin)))
      throw new BudgetExceeded(
        `ElevenLabs has ${(q.limit - q.used).toLocaleString('en')} characters left this period (${q.used.toLocaleString('en')} of ${q.limit.toLocaleString('en')} used), not enough for ${cost.toLocaleString('en')} plus a margin for retries. Nothing was sent.`,
      );
    return q;
  }

  async synth(req: SynthRequest): Promise<Clip> {
    const ext = this.ext();
    const file = this.fileFor(req);
    const timing = `${file}.timing.json`;
    const readTiming = async () => (existsSync(timing) ? (JSON.parse(await readFile(timing, 'utf8')) as number[]) : undefined);
    if (existsSync(file)) return { file, duration: await probeDuration(file), cached: true, charStarts: await readTiming() };
    const legacy = this.opts.provider === 'elevenlabs' ? this.fileFor(req, true) : undefined;
    if (legacy && existsSync(legacy)) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, await readFile(legacy));
      if (existsSync(`${legacy}.timing.json`)) await writeFile(timing, await readFile(`${legacy}.timing.json`));
      return { file, duration: await probeDuration(file), cached: true, charStarts: await readTiming() };
    }
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.part.${ext}`;
    switch (this.opts.provider) {
      case 'elevenlabs': {
        const r = await this.elevenlabs(req);
        await writeFile(tmp, r.audio);
        if (r.charStarts) await writeFile(timing, JSON.stringify(r.charStarts));
        break;
      }
      case 'openai':
        await writeFile(tmp, await this.openai(req));
        break;
      case 'google':
        await writeFile(tmp, await this.google(req));
        break;
      case 'say':
        await run('say', ['-v', this.opts.voice ?? DEFAULTS.say.voice!, '-r', String(Math.round(175 * (this.opts.rate ?? 1))), '-o', tmp, req.text]);
        break;
      case 'silent':
        await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', estimateSeconds(req.text).toFixed(2), tmp]);
        break;
    }
    await rename(tmp, file);
    return { file, duration: await probeDuration(file), cached: false, charStarts: await readTiming() };
  }

  private secret(name: string) {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is not set`);
    return v;
  }

  /**
   * POSTs and reads the whole response with `read`, retrying timeouts, dropped
   * connections (including mid-body), rate limits and server errors.
   */
  private async post<T>(url: string, init: RequestInit, what: string, read: (res: Response) => Promise<T>, chars = 0): Promise<T> {
    const wait = (attempt: number) => new Promise((r) => setTimeout(r, Voice.retryBaseMs * 2 ** attempt));
    for (let attempt = 1; ; attempt++) {
      // Outside the try: going over the budget is never retried.
      this.charge(chars);
      let res: Response;
      try {
        // The timeout covers the body too: the signal stays live until read() finishes.
        res = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
        if (res.ok) return await read(res);
      } catch (err) {
        if (attempt < 4) {
          await wait(attempt);
          continue;
        }
        throw new Error(`${what} failed: ${(err as Error).message}`);
      }
      const body = await res.text().catch(() => '');
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await wait(attempt);
        continue;
      }
      throw new Error(`${what} failed: ${res.status} ${body.slice(0, 300)}`);
    }
  }

  private async elevenlabs(req: SynthRequest) {
    const voice = this.opts.voice ?? DEFAULTS.elevenlabs.voice;
    // The with-timestamps endpoint also returns when each character is spoken, for captions.
    const j = await this.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice}/with-timestamps?output_format=${ELEVENLABS_FORMAT}`,
      {
        method: 'POST',
        headers: { 'xi-api-key': this.secret('ELEVENLABS_API_KEY'), 'content-type': 'application/json' },
        body: JSON.stringify({
          text: req.text,
          seed: ELEVENLABS_SEED,
          model_id: this.opts.model ?? DEFAULTS.elevenlabs.model,
          previous_text: req.previous,
          next_text: req.next,
          voice_settings: { ...ELEVENLABS_SETTINGS, speed: this.opts.rate ?? 1 },
        }),
      },
      'ElevenLabs',
      async (res) => (await res.json()) as { audio_base64: string; alignment?: { characters: string[]; character_start_times_seconds: number[] } },
      req.text.length,
    );
    const starts = j.alignment?.character_start_times_seconds;
    return { audio: Buffer.from(j.audio_base64, 'base64'), charStarts: starts && starts.length === req.text.length ? starts : undefined };
  }

  private async openai(req: SynthRequest) {
    return this.post(
      'https://api.openai.com/v1/audio/speech',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${this.secret('OPENAI_API_KEY')}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.opts.model ?? DEFAULTS.openai.model,
          voice: this.opts.voice ?? DEFAULTS.openai.voice,
          input: req.text,
          instructions: this.opts.style ?? DEFAULT_STYLE,
          response_format: 'mp3',
          speed: this.opts.rate ?? 1,
        }),
      },
      'OpenAI speech',
      async (res) => Buffer.from(await res.arrayBuffer()),
      req.text.length,
    );
  }

  private async google(req: SynthRequest) {
    const voice = this.opts.voice ?? DEFAULTS.google.voice!;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    let url = 'https://texttospeech.googleapis.com/v1/text:synthesize';
    if (process.env.GOOGLE_TTS_USE_GCLOUD) {
      const { stdout } = await run('gcloud', ['auth', 'print-access-token']);
      headers.authorization = `Bearer ${stdout.trim()}`;
      if (process.env.GOOGLE_CLOUD_PROJECT) headers['x-goog-user-project'] = process.env.GOOGLE_CLOUD_PROJECT;
    } else {
      url += `?key=${encodeURIComponent(this.secret('GOOGLE_TTS_API_KEY'))}`;
    }
    return this.post(
      url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          input: { text: req.text },
          voice: { languageCode: voice.split('-').slice(0, 2).join('-'), name: voice },
          audioConfig: { audioEncoding: 'MP3', sampleRateHertz: 44100, speakingRate: this.opts.rate ?? 1 },
        }),
      },
      'Google Text-to-Speech',
      async (res) => Buffer.from(((await res.json()) as { audioContent: string }).audioContent, 'base64'),
      req.text.length,
    );
  }
}
