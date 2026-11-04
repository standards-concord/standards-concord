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
import { mkdir, rename, writeFile } from 'node:fs/promises';
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
}

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
    const material = JSON.stringify([o.provider, o.voice ?? d.voice, o.model ?? d.model, o.style ?? DEFAULT_STYLE, o.rate ?? 1, req.text, o.provider === 'elevenlabs' ? [req.previous, req.next] : null]);
    return createHash('sha256').update(material).digest('hex').slice(0, 24);
  }

  async synth(req: SynthRequest): Promise<Clip> {
    const ext = this.opts.provider === 'say' ? 'aiff' : this.opts.provider === 'silent' ? 'wav' : 'mp3';
    const file = path.join(this.cacheDir, this.opts.provider, `${this.key(req)}.${ext}`);
    if (existsSync(file)) return { file, duration: await probeDuration(file), cached: true };
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.part.${ext}`;
    switch (this.opts.provider) {
      case 'elevenlabs':
        await writeFile(tmp, await this.elevenlabs(req));
        break;
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
    return { file, duration: await probeDuration(file), cached: false };
  }

  private secret(name: string) {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is not set`);
    return v;
  }

  private async post(url: string, init: RequestInit, what: string): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(url, init);
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
    const res = await this.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_192`,
      {
        method: 'POST',
        headers: { 'xi-api-key': this.secret('ELEVENLABS_API_KEY'), 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({
          text: req.text,
          model_id: this.opts.model ?? DEFAULTS.elevenlabs.model,
          previous_text: req.previous,
          next_text: req.next,
          voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true, speed: this.opts.rate ?? 1 },
        }),
      },
      'ElevenLabs',
    );
    return Buffer.from(await res.arrayBuffer());
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
