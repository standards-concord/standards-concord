/**
 * Text to speech for the narration, with a disk cache so re-recording after a UI change
 * only pays for paragraphs whose words changed.
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
import { existsSync } from 'node:fs';
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

/** ElevenLabs output format. 128 kbps MP3 works on every plan; 192 kbps needs Creator or above. */
const ELEVENLABS_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_128';
/** A fixed seed makes ElevenLabs more repeatable (it does not guarantee identical audio). */
const ELEVENLABS_SEED = 4242;

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

export interface SynthRequest {
  text: string;
  /** Neighbouring paragraphs, so the voice keeps a natural flow across clips. */
  previous?: string;
  next?: string;
}

export class Voice {
  constructor(
    readonly opts: VoiceOptions,
    readonly cacheDir: string,
  ) {}

  get label() {
    const d = DEFAULTS[this.opts.provider];
    return `${this.opts.provider}${this.opts.provider === 'silent' ? '' : ` (${this.opts.voice ?? d.voice}${this.opts.model || d.model ? `, ${this.opts.model ?? d.model}` : ''})`}`;
  }

  private key(req: SynthRequest) {
    const o = this.opts;
    const d = DEFAULTS[o.provider];
    // Everything that changes the audio is part of its identity.
    const material = JSON.stringify([o.provider, o.voice ?? d.voice, o.model ?? d.model, o.style ?? DEFAULT_STYLE, o.rate ?? 1, req.text, o.provider === 'elevenlabs' ? [req.previous, req.next, ELEVENLABS_FORMAT, ELEVENLABS_SEED] : null]);
    return createHash('sha256').update(material).digest('hex').slice(0, 24);
  }

  async synth(req: SynthRequest): Promise<Clip> {
    const ext = this.opts.provider === 'say' ? 'aiff' : this.opts.provider === 'silent' ? 'wav' : 'mp3';
    const file = path.join(this.cacheDir, this.opts.provider, `${this.key(req)}.${ext}`);
    const timing = `${file}.timing.json`;
    const readTiming = async () => (existsSync(timing) ? (JSON.parse(await readFile(timing, 'utf8')) as number[]) : undefined);
    if (existsSync(file)) return { file, duration: await probeDuration(file), cached: true, charStarts: await readTiming() };
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

  private async post(url: string, init: RequestInit, what: string): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
      } catch (err) {
        // Timeouts and dropped connections are worth another try too.
        if (attempt < 4) {
          await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
          continue;
        }
        throw new Error(`${what} failed: ${(err as Error).message}`);
      }
      if (res.ok) return res;
      const body = await res.text().catch(() => '');
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
        continue;
      }
      throw new Error(`${what} failed: ${res.status} ${body.slice(0, 300)}`);
    }
  }

  private async elevenlabs(req: SynthRequest) {
    const voice = this.opts.voice ?? DEFAULTS.elevenlabs.voice;
    // The with-timestamps endpoint also returns when each character is spoken, for captions.
    const res = await this.post(
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
          voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true, speed: this.opts.rate ?? 1 },
        }),
      },
      'ElevenLabs',
    );
    const j = (await res.json()) as { audio_base64: string; alignment?: { characters: string[]; character_start_times_seconds: number[] } };
    const starts = j.alignment?.character_start_times_seconds;
    return { audio: Buffer.from(j.audio_base64, 'base64'), charStarts: starts && starts.length === req.text.length ? starts : undefined };
  }

  private async openai(req: SynthRequest) {
    const res = await this.post(
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
    );
    return Buffer.from(await res.arrayBuffer());
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
    const res = await this.post(
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
    );
    const json = (await res.json()) as { audioContent: string };
    return Buffer.from(json.audioContent, 'base64');
  }
}
