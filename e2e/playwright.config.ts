import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the real server, which also serves the built web
 * app. Build the web app first (`pnpm --filter @concord/web build`); the
 * server runs on a fresh data directory with the demo seeded and the LLM
 * simulated, like the alpha.
 */
const PORT = Number(process.env.E2E_PORT ?? 8799);
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
const dataDir = path.join(os.tmpdir(), `concord-e2e-${process.pid}`);

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'pnpm --filter @concord/server start',
        cwd: '..',
        url: `${baseURL}/healthz`,
        timeout: 180_000,
        reuseExistingServer: !process.env.CI,
        stdout: 'pipe',
        env: {
          PORT: String(PORT),
          PUBLIC_URL: baseURL,
          WEB_URL: baseURL,
          CONCORD_DATA_DIR: dataDir,
          DEMO_MODE: 'true',
          LLM_PROVIDER: 'simulated',
          SOLID_SERVER_URL: '',
        },
      },
});
