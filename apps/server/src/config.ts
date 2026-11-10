import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/** A non-negative dollar amount from the environment; anything else (unset, blank, "abc", -1) gives the default. */
function usd(v: string | undefined, dflt: number): number {
  if (v === undefined || v.trim() === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** Public URL from the environment, or the platform's own domain variable (Railway, Render, Fly, Vercel). */
const vercelHost = process.env.VERCEL_ENV === 'production' ? process.env.VERCEL_PROJECT_PRODUCTION_URL : (process.env.VERCEL_BRANCH_URL ?? process.env.VERCEL_URL);
const platformUrl = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : (process.env.RENDER_EXTERNAL_URL ?? (process.env.FLY_APP_NAME ? `https://${process.env.FLY_APP_NAME}.fly.dev` : vercelHost ? `https://${vercelHost}` : undefined));

/** On Vercel, Concord runs as a function: no lasting disk, many instances, a 4.5 MB request limit. */
const onVercel = !!process.env.VERCEL;

function ontologyStoreKind(value: string | undefined, postgres: boolean): 'git' | 'db' {
  if (value === 'git' || value === 'db') return value;
  if (value) throw new Error(`ONTOLOGY_STORE must be git or db, not ${value}`);
  return postgres ? 'db' : 'git';
}

/** All configuration comes from the environment so the same build runs locally and deployed. */
export const config = {
  port: Number(process.env.PORT ?? 8787),
  publicUrl: (process.env.PUBLIC_URL ?? platformUrl ?? `http://localhost:${process.env.PORT ?? 8787}`).replace(/\/$/, ''),
  /** Where the web app is served from in development (OAuth redirects back here). */
  webUrl: (process.env.WEB_URL ?? process.env.PUBLIC_URL ?? platformUrl ?? 'http://localhost:5173').replace(/\/$/, ''),
  /** On Vercel only /tmp is writable, and nothing there lasts: caches only (the database holds everything else). */
  dataDir: path.resolve(process.env.CONCORD_DATA_DIR ?? (onVercel ? path.join(os.tmpdir(), 'concord') : path.join(repoRoot, '.data'))),
  /**
   * The largest request bodies accepted: JSON (and MCP) and voice clips. Vercel refuses anything over 4.5 MB before
   * Concord sees it, so there both are 4 MB, which Concord refuses with a clear message.
   */
  bodyLimits: onVercel ? { json: '4mb', audio: '4mb' } : { json: '5mb', audio: '25mb' },
  /**
   * Where ontologies' files and history live. `git`: a git repository per ontology under dataDir (the VM). `db`:
   * git's objects stored in the database (services/gitdb.ts), for hosts with no disk (Vercel). Default: `db`
   * when the store is Postgres (DATABASE_URL), otherwise `git`.
   */
  ontologyStore: ontologyStoreKind(process.env.ONTOLOGY_STORE, !!(process.env.DATABASE_URL ?? process.env.POSTGRES_URL)),
  repoRoot,
  webDist: path.join(repoRoot, 'apps/web/dist'),
  sessionSecret: process.env.SESSION_SECRET ?? 'dev-only-secret-change-me',
  demoMode: bool(process.env.DEMO_MODE, true),
  /**
   * CONCORD_READ_ONLY: serve reads only, for the minutes of a move to another database (docs/cutover.md). Requests
   * that change something get 503, every write to the database is refused, and no scheduled work runs.
   */
  readOnly: bool(process.env.CONCORD_READ_ONLY, false),
  /**
   * How scheduled work is started (services/scheduler.ts): 'timer', a long-running server's own minute timer, or
   * 'requests', after requests plus a daily cron call (Vercel, which has no long-running process).
   */
  schedule: (process.env.CONCORD_SCHEDULE ?? (process.env.VERCEL ? 'requests' : 'timer')) as 'timer' | 'requests',
  /**
   * Rate limits counted in the database, shared by every instance (OAuth endpoints, public validation), instead of
   * each process's memory. On by default on Vercel, where several instances serve at once.
   */
  sharedLimits: bool(process.env.CONCORD_SHARED_LIMITS, !!process.env.VERCEL),
  /**
   * Where private data goes when it isn't in a pod (no Solid server, or an account with no pod): `files` under the
   * data directory (the VM), or `db`, rows in the database (Vercel, which has no lasting disk).
   */
  privateStore: (process.env.CONCORD_PRIVATE_STORE ?? (process.env.VERCEL ? 'db' : 'files')) === 'db' ? ('db' as const) : ('files' as const),
  /**
   * Without CONCORD_ENCRYPTION_KEY, keep an administrator's Solid login (for reading testers' pods) in this process's
   * memory. Fine for one long-running server (the VM); off by default on Vercel, where the next request can reach
   * another instance, so there the feature needs the key and is turned off without it.
   */
  adminLoginsInMemory: bool(process.env.CONCORD_ADMIN_LOGINS_IN_MEMORY, !process.env.VERCEL),
  /**
   * People who sign in with Solid keep their private data in their own pod (step 5e, the 4 November decision), written
   * with their own Solid login, sealed in the database (CONCORD_ENCRYPTION_KEY). On by default on Vercel; the VM keeps
   * giving every account a pod on its own Solid server until the cutover.
   */
  solidOwnPods: bool(process.env.CONCORD_SOLID_OWN_PODS, !!process.env.VERCEL),
  /** Vercel Cron's bearer secret, for GET /api/cron/daily. Unset: the endpoint refuses every call. */
  cronSecret: process.env.CRON_SECRET || undefined,
  /**
   * Refuse to publish fork edits when the full OWL reasoner (sparq) gives no verdict (it timed
   * out, crashed, or can't decide the ontology), instead of falling back to the structural check.
   * On in production; off by default elsewhere.
   */
  requireFullReasoner: bool(process.env.CONCORD_REQUIRE_REASONER, process.env.NODE_ENV === 'production'),
  /**
   * WebIDs of deployment administrators (reset the demo, read all feedback), comma- or space-separated.
   * An account's WebID is shown under Settings. Google and GitHub sign-ins are separate accounts with their own WebIDs, so list the WebID of the account you actually sign in with.
   * Someone who signs in with their own WebID (Solid) has that WebID. Listed WebIDs are also given
   * read access to each tester's feedback folder in their pod, and are shown to testers.
   */
  adminWebIds: (process.env.ADMIN_WEBIDS ?? '').split(/[\s,]+/).map((w) => w.trim()).filter(Boolean),
  /** Older alternative to ADMIN_WEBIDS: the verified email of a Google or GitHub account. */
  adminEmails: (process.env.ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),

  llm: {
    /** 'anthropic' when a key is configured, otherwise a deterministic simulator. */
    provider: (process.env.LLM_PROVIDER ?? (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'simulated')) as
      | 'anthropic'
      | 'simulated',
    model: process.env.LLM_MODEL ?? 'claude-opus-5-5',
    effort: (process.env.LLM_EFFORT ?? 'high') as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
    /** Questions the query assistant may send to Claude each day; beyond these the offline helper answers. */
    queryAssistant: {
      perDay: Number(process.env.QUERY_ASSISTANT_DAILY_LIMIT ?? 300),
      perUserPerDay: Number(process.env.QUERY_ASSISTANT_PER_USER_DAILY_LIMIT ?? 40),
      perOntologyPerDay: Number(process.env.QUERY_ASSISTANT_PER_ONTOLOGY_DAILY_LIMIT ?? 150),
    },
    /**
     * Most this deployment may spend on Claude per UTC day and per UTC month, in US dollars, estimated from each
     * response's token usage (llm/budget.ts). Once a limit is reached, AI features use their offline fallbacks
     * until the next day or month. 0 turns real AI calls off.
     */
    dailyBudgetUsd: usd(process.env.LLM_DAILY_BUDGET_USD, 5),
    monthlyBudgetUsd: usd(process.env.LLM_MONTHLY_BUDGET_USD, 40),
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
    /** GitHub's API root, for publishing from the database store (tests point it elsewhere). */
    publishApi: (process.env.GITHUB_PUBLISH_API || 'https://api.github.com').replace(/\/$/, ''),
  },

  solid: {
    /** Base URL of a Community Solid Server (v7+). Empty disables pods; private data then stays on local disk. */
    serverUrl: process.env.SOLID_SERVER_URL?.replace(/\/$/, ''),
    /** Spawn a bundled CSS as a child process (dev convenience). */
    spawn: bool(process.env.SOLID_SPAWN, false),
    spawnPort: Number(process.env.SOLID_SPAWN_PORT ?? 3000),
  },

  solidOidc: {
    /** Let people sign in with their own WebID (Solid-OIDC). On unless SOLID_OIDC=off. */
    enabled: bool(process.env.SOLID_OIDC, true),
    /**
     * Solid providers the operator trusts enough to reach on a private address or over plain http
     * (a local Community Solid Server in development and tests). Everything else must be public https.
     */
    trustedIssuers: (process.env.SOLID_TRUSTED_ISSUERS ?? '').split(/[\s,]+/).map((w) => w.trim()).filter(Boolean),
  },
  feedbackIssues: {
    /**
     * Fine-grained GitHub token with Issues: read and write on `repo`. When set, testers
     * can choose to post a short summary of their feedback as an issue labelled "feedback".
     */
    token: process.env.FEEDBACK_GITHUB_TOKEN || undefined,
    repo: process.env.FEEDBACK_GITHUB_REPO || 'standards-concord/standards-concord',
    /** Overridable for tests. */
    apiUrl: (process.env.FEEDBACK_GITHUB_API || 'https://api.github.com').replace(/\/$/, ''),
    /** Cap on new issues in any rolling hour, across all server processes (the triage routine handles 10 an hour); the rest are posted later. */
    perHour: Number(process.env.FEEDBACK_ISSUES_PER_HOUR || 10),
    /**
     * Bearer token for the triage routine's endpoints (/api/feedback/triage/...). The routine
     * comments and labels only through them, so each comment's id is recorded for withdrawal.
     */
    triageToken: process.env.FEEDBACK_TRIAGE_TOKEN || undefined,
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
