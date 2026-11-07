import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests for Concord.
 *
 *   pnpm test:e2e              local: boots a fresh API server and the web app, runs everything
 *   E2E_MODE=preview pnpm test:e2e   same, but against the production build (what Vercel serves)
 *   pnpm test:e2e:live         read-only smoke tests against the deployed site (LIVE_URL)
 *
 * The local servers use their own ports and a throwaway data directory, so a `pnpm dev`
 * you already have running (and its data) is left alone.
 */
const mode = process.env.E2E_MODE === 'preview' ? 'preview' : 'dev';
const API_PORT = Number(process.env.E2E_API_PORT ?? 8797);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5183);
/** Stand-in for GitHub's issues API, so tester feedback can be filed as issues offline. */
export const GITHUB_STUB_PORT = Number(process.env.E2E_GITHUB_STUB_PORT ?? 8799);
const dataDir = process.env.E2E_DATA_DIR ?? path.join(os.tmpdir(), `concord-e2e-${process.pid}`);
const root = path.resolve(import.meta.dirname, '..');
// The co-lead bot's calendar feed: meetings.spec.ts writes invites here and asks the server to re-read it.
const botCalendar = (process.env.E2E_BOT_ICS ??= path.join(dataDir, 'bot-calendar.ics'));
fs.mkdirSync(path.dirname(botCalendar), { recursive: true });
fs.writeFileSync(botCalendar, 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Concord e2e//EN\r\nEND:VCALENDAR\r\n');
/**
 * The Concord GitHub App, against the stand-in: a key pair made for this run (the server signs
 * with the private key, the stand-in checks with the public one), and fixed test-only secrets.
 * app-checks-github.spec.ts signs webhook deliveries with the same secret.
 */
export const GITHUB_APP_WEBHOOK_SECRET = 'e2e-only-github-app-webhook-secret';
const githubAppKeys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const githubApp = { id: '424242', clientId: 'Iv1.e2e-concord', clientSecret: 'e2e-only-github-app-client-secret' };
const live = process.env.LIVE_URL ?? 'https://standards-concord.vercel.app';
const runningLive = process.argv.some((a) => a === '--project=live' || a === 'live');

export default defineConfig({
  testDir: '.',
  outputDir: '../test-results',
  fullyParallel: false,
  // One shared server and dataset: run files one at a time so they don't trip over each other.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: '../playwright-report' }], ['github']] : [['list']],
  use: {
    // Recording every test's trace and video and throwing them away when it passes took about a
    // third of the suite's CPU. In CI (one retry) a failing test is recorded on its retry instead;
    // a local run without retries keeps recording, so a failure there still has its trace.
    trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: process.env.CI ? 'on-first-retry' : 'retain-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1400, height: 950 },
    // Hint fonts fully, as GitHub's Linux runners do, wherever the tests run. Hinted glyph widths
    // round to whole pixels at each zoom level, which once made zoomed and saved diagrams draw
    // text wider or narrower than its box; with this, a local run catches that too.
    launchOptions: { args: ['--font-render-hinting=full'] },
    // The production build registers a service worker (apps/web/sw/sw.js). Requests it answers bypass
    // page.route, which many specs rely on, so it is off except where offline.spec.ts turns it on.
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'local',
      testIgnore: [/live\.spec\.ts/, /solid-.*\.spec\.ts/],
      use: { baseURL: `http://localhost:${WEB_PORT}` },
    },
    {
      name: 'live',
      testMatch: /live\.spec\.ts/,
      retries: 2,
      use: { baseURL: live },
    },
  ],
  webServer: runningLive
    ? undefined
    : [
        {
          command: 'node e2e/github-stub.mjs',
          cwd: root,
          url: `http://localhost:${GITHUB_STUB_PORT}/healthz`,
          reuseExistingServer: !process.env.CI,
          env: {
            PORT: String(GITHUB_STUB_PORT),
            GITHUB_APP_ID: githubApp.id,
            GITHUB_APP_PUBLIC_KEY: githubAppKeys.publicKey,
            GITHUB_APP_CLIENT_ID: githubApp.clientId,
            GITHUB_APP_CLIENT_SECRET: githubApp.clientSecret,
            CALLBACK_URL: `http://localhost:${WEB_PORT}/api/github-app/setup`,
          },
          stdout: 'ignore',
          stderr: 'pipe',
        },
        {
          command: 'pnpm --filter @concord/server start',
          cwd: root,
          url: `http://localhost:${API_PORT}/healthz`,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          env: {
            PORT: String(API_PORT),
            CONCORD_DATA_DIR: dataDir,
            WEB_URL: `http://localhost:${WEB_PORT}`,
            DEMO_MODE: 'true',
            // Public reporting needs its own secret; this one is only for the test server.
            REPORT_SECRET: 'e2e-only-public-report-secret-0123456789abcdef',
            // Keep the tests deterministic and offline: no real LLM, pods or GitHub.
            LLM_PROVIDER: 'simulated',
            ANTHROPIC_API_KEY: '',
            SOLID_SERVER_URL: '',
            GOOGLE_CLIENT_ID: '',
            GITHUB_CLIENT_ID: '',
            // Every test validates from the same address.
            VALIDATE_RATE_LIMIT: '1000',
            VALIDATE_PER_CLIENT: '100',
            VALIDATE_QUEUE: '32',
            VALIDATE_JSONLD_QUEUE: '32',
            // Invite-by-email, with the bot's calendar read from a local file and no Recall.ai key.
            MEET_BOT_EMAIL: 'concord.bot@example.org',
            MEET_BOT_ICS_URL: pathToFileURL(botCalendar).href,
            RECALL_API_KEY: '',
            // Feedback is filed as GitHub issues, to the local stand-in.
            FEEDBACK_GITHUB_TOKEN: 'e2e-feedback-token',
            FEEDBACK_GITHUB_API: `http://localhost:${GITHUB_STUB_PORT}`,
            FEEDBACK_GITHUB_REPO: 'standards-concord/standards-concord',
            // The Concord GitHub App and GitHub Actions' run tokens, both from the stand-in.
            GITHUB_APP_ID: githubApp.id,
            GITHUB_APP_SLUG: 'concord-e2e',
            GITHUB_APP_PRIVATE_KEY: githubAppKeys.privateKey,
            GITHUB_APP_WEBHOOK_SECRET,
            GITHUB_APP_CLIENT_ID: githubApp.clientId,
            GITHUB_APP_CLIENT_SECRET: githubApp.clientSecret,
            GITHUB_APP_API_URL: `http://localhost:${GITHUB_STUB_PORT}`,
            GITHUB_APP_WEB_URL: `http://localhost:${GITHUB_STUB_PORT}`,
            GITHUB_OIDC_ISSUER: `http://localhost:${GITHUB_STUB_PORT}`,
            // The welcome page's videos come from this folder, not a GitHub release.
            MEDIA_DIR: path.join(root, 'e2e', 'fixtures', 'media'),
          },
          stdout: 'ignore',
          stderr: 'pipe',
        },
        {
          command:
            mode === 'preview'
              ? `pnpm --filter @concord/web exec vite preview --port ${WEB_PORT} --strictPort`
              : `pnpm --filter @concord/web exec vite --port ${WEB_PORT} --strictPort`,
          cwd: root,
          url: `http://localhost:${WEB_PORT}`,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          env: { CONCORD_API: `http://localhost:${API_PORT}` },
          stdout: 'ignore',
          stderr: 'pipe',
        },
      ],
});
