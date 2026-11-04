import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/** Public URL from the environment, or the platform's own domain variable (Railway, Render, Fly). */
const platformUrl = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : (process.env.RENDER_EXTERNAL_URL ?? (process.env.FLY_APP_NAME ? `https://${process.env.FLY_APP_NAME}.fly.dev` : undefined));

/** All configuration comes from the environment so the same build runs locally and deployed. */
export const config = {
  port: Number(process.env.PORT ?? 8787),
  publicUrl: (process.env.PUBLIC_URL ?? platformUrl ?? `http://localhost:${process.env.PORT ?? 8787}`).replace(/\/$/, ''),
  /** Where the web app is served from in development (OAuth redirects back here). */
  webUrl: (process.env.WEB_URL ?? process.env.PUBLIC_URL ?? platformUrl ?? 'http://localhost:5173').replace(/\/$/, ''),
  dataDir: path.resolve(process.env.CONCORD_DATA_DIR ?? path.join(repoRoot, '.data')),
  repoRoot,
  webDist: path.join(repoRoot, 'apps/web/dist'),
  sessionSecret: process.env.SESSION_SECRET ?? 'dev-only-secret-change-me',
  demoMode: bool(process.env.DEMO_MODE, true),
  /** Comma-separated emails of deployment administrators (reset the demo, read all feedback). */
  adminEmails: (process.env.ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),

  llm: {
    /** 'anthropic' when a key is configured, otherwise a deterministic simulator. */
    provider: (process.env.LLM_PROVIDER ?? (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'simulated')) as
      | 'anthropic'
      | 'simulated',
    model: process.env.LLM_MODEL ?? 'claude-opus-5-5',
    effort: (process.env.LLM_EFFORT ?? 'high') as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
  },

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  },
  github: {
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    /** Token used to publish released ontologies to GitHub (repo scope). */
    publishToken: process.env.GITHUB_PUBLISH_TOKEN,
    /** Default org/user to publish new ontology repos into, e.g. "theodi". */
    publishOwner: process.env.GITHUB_PUBLISH_OWNER,
  },

  solid: {
    /** Base URL of a Community Solid Server (v7+). Empty disables pods; private data then stays on local disk. */
    serverUrl: process.env.SOLID_SERVER_URL?.replace(/\/$/, ''),
    /** Spawn a bundled CSS as a child process (dev convenience). */
    spawn: bool(process.env.SOLID_SPAWN, false),
    spawnPort: Number(process.env.SOLID_SPAWN_PORT ?? 3000),
  },

  meetBot: {
    /** Recall.ai API key enables real Google Meet bots. */
    recallApiKey: process.env.RECALL_API_KEY,
    recallRegion: process.env.RECALL_REGION ?? 'us-west-2',
    /** Override the Recall.ai API base URL (tests point this at a stub). */
    recallApiBase: process.env.RECALL_API_BASE?.replace(/\/$/, ''),
    botName: process.env.MEET_BOT_NAME ?? 'Concord co-facilitator',
    /**
     * The bot's own address, e.g. concord.odi@gmail.com. Adding it to a calendar
     * invite (one call or a recurring series) brings the bot into those calls.
     */
    inviteEmail: process.env.MEET_BOT_EMAIL?.trim() || undefined,
    /**
     * The bot account's calendar as an iCal feed. For a Google account this is
     * Calendar settings > the calendar > "Secret address in iCal format".
     * file:// URLs work too, for local testing.
     */
    calendarIcsUrl: process.env.MEET_BOT_ICS_URL?.trim() || undefined,
    /** How often to re-read the calendar feed. */
    calendarPollMs: Number(process.env.MEET_BOT_POLL_SECONDS ?? 60) * 1000,
    /** Ontology (slug or id) for invites that don't say which ontology they're about. */
    defaultOntology: process.env.MEET_BOT_DEFAULT_ONTOLOGY?.trim() || undefined,
    /** Whether calls that arrive by invite post the bot's prompts into the Meet chat. */
    postToChatDefault: bool(process.env.MEET_BOT_POST_TO_CHAT, false),
  },

  stt: {
    /** Optional server-side speech-to-text for browsers without Web Speech API. */
    provider: process.env.STT_PROVIDER as 'openai' | undefined,
    openaiKey: process.env.OPENAI_API_KEY,
  },
};

export type Config = typeof config;
