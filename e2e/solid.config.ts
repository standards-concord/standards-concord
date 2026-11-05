import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { CSS_PORT, SOLID } from './solid/accounts';

/**
 * Signing in with Solid, and administrators reading testers' feedback in their
 * pods, against a real Community Solid Server (the same major version the
 * deployment runs, with its default WAC access control).
 *
 *   pnpm test:e2e:solid
 *
 * The Solid server seeds two accounts with their own pods and WebIDs
 * (e2e/solid/seed.json): "admin", whose WebID is in ADMIN_WEBIDS, and "visitor".
 * Concord provisions testers' pods on the same server, as it does when deployed.
 */
const API_PORT = Number(process.env.E2E_SOLID_API_PORT ?? 8897);
const WEB_PORT = Number(process.env.E2E_SOLID_WEB_PORT ?? 5283);
const tmp = path.join(os.tmpdir(), `concord-e2e-solid-${process.pid}`);
const root = path.resolve(import.meta.dirname, '..');
const css = SOLID.css;
/** E2E_CSS_COMMAND points at an installed community-solid-server, to skip the download. */
const cssCommand = process.env.E2E_CSS_COMMAND ?? 'npx -y @solid/community-server@7.3.0';

export default defineConfig({
  testDir: '.',
  testMatch: /solid-.*\.spec\.ts/,
  outputDir: '../test-results/solid',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: '../playwright-report-solid' }], ['github']] : [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1400, height: 950 },
    baseURL: `http://localhost:${WEB_PORT}`,
  },
  webServer: [
    {
      command: `${cssCommand} -c @css:config/file.json -f ${path.join(tmp, 'pods')} -p ${CSS_PORT} -b ${css}/ --seedConfig ${path.join(root, 'e2e/solid/seed.json')} -l warn`,
      url: `${css}/.well-known/openid-configuration`,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'pnpm --filter @concord/server start',
      cwd: root,
      url: `http://localhost:${API_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        PORT: String(API_PORT),
        CONCORD_DATA_DIR: path.join(tmp, 'concord'),
        WEB_URL: `http://localhost:${WEB_PORT}`,
        DEMO_MODE: 'true',
        LLM_PROVIDER: 'simulated',
        ANTHROPIC_API_KEY: '',
        SOLID_SERVER_URL: css,
        // A local, plain-http Solid server: only providers listed here may be private or http.
        SOLID_TRUSTED_ISSUERS: `${css}/`,
        ADMIN_WEBIDS: SOLID.admin.webId,
        GOOGLE_CLIENT_ID: '',
        GITHUB_CLIENT_ID: '',
      },
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: `pnpm --filter @concord/web exec vite --port ${WEB_PORT} --strictPort`,
      cwd: root,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { CONCORD_API: `http://localhost:${API_PORT}` },
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
