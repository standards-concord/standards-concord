import os from 'node:os';
import path from 'node:path';
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
const dataDir = process.env.E2E_DATA_DIR ?? path.join(os.tmpdir(), `concord-e2e-${process.pid}`);
const root = path.resolve(import.meta.dirname, '..');
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
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1400, height: 950 },
  },
  projects: [
    {
      name: 'local',
      testIgnore: /live\.spec\.ts/,
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
