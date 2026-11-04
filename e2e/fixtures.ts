import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Shared test fixture. Every test fails if the page throws an uncaught error, logs a
 * console error, or shows the app's crash screen, so "the page rendered" really means
 * it worked. A test that expects a particular error can allow it with `allowConsole`.
 */
export interface ConsoleGuard {
  /** Patterns of console errors this test expects (matched against the message text). */
  allow: (...patterns: RegExp[]) => void;
  errors: string[];
}

// Network failures the app handles itself, e.g. GET /api/session before sign-in.
const ALWAYS_ALLOWED = [/Failed to load resource: the server responded with a status of 401/];

export const test = base.extend<{ consoleGuard: ConsoleGuard }>({
  consoleGuard: [
    async ({ page }, use) => {
      const allowed = [...ALWAYS_ALLOWED];
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(`Uncaught: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      await use({ allow: (...p) => allowed.push(...p), errors });
      const unexpected = errors.filter((e) => !allowed.some((p) => p.test(e)));
      expect(unexpected, 'unexpected console errors or uncaught exceptions').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export interface Persona {
  id: string;
  name: string;
  roles: string[];
  playable?: boolean;
  key?: string;
}

export async function personas(request: APIRequestContext): Promise<Persona[]> {
  const r = await request.get('/api/personas');
  expect(r.ok(), `GET /api/personas: ${r.status()}`).toBeTruthy();
  return r.json();
}

/** Sign the page's browser context in through the demo login, as a persona or a fresh tester. */
export async function signIn(page: Page, as: { userId?: string; name?: string; role?: string } = {}) {
  // Drop any earlier session first, so switching people mid-test can't leave two session cookies.
  await page.context().clearCookies({ name: 'concord_session' });
  const r = await page.request.post('/api/auth/demo', { data: as });
  expect(r.ok(), `POST /api/auth/demo: ${r.status()} ${await r.text()}`).toBeTruthy();
  return (await r.json()) as { user: { id: string; name: string } };
}

export async function demoOntology(request: APIRequestContext): Promise<{ id: string; title: string }> {
  // GET /api/personas seeds the demo ontology if this is a fresh server.
  await personas(request);
  const r = await request.get('/api/ontologies');
  expect(r.ok()).toBeTruthy();
  const all = (await r.json()) as { id: string; title: string; demo?: boolean }[];
  const demo = all.find((o) => o.demo) ?? all[0];
  expect(demo, 'a demo ontology exists').toBeTruthy();
  return demo;
}

/** Fails if the app's error boundary or an error card is showing. */
export async function expectNoCrash(page: Page) {
  for (const title of ['This page crashed', 'Something went wrong', 'Server unavailable'])
    await expect(page.getByRole('alert').filter({ hasText: title }), `error card "${title}"`).toHaveCount(0);
}

/** Waits until no "Loading…" spinners remain in the main content. */
export async function settle(page: Page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 20_000 });
}

/** Signs the page in as one of the simulated working-group members, by name (e.g. "Tom Okafor"). */
export async function signInAsPersona(page: Page, name: string) {
  const p = (await personas(page.request)).find((x) => x.name === name);
  expect(p, `persona ${name}`).toBeTruthy();
  return signIn(page, { userId: p!.id });
}

/** A short random suffix, so a test can make uniquely named things on the shared server (and on a retry). */
export const uniq = () => Math.random().toString(36).slice(2, 7);

/** A stand-in for the browser's speech recognition that "hears" one sentence when started. */
export async function fakeSpeech(page: Page, heard: string) {
  await page.addInitScript((text) => {
    class FakeRecognition {
      lang = 'en-GB';
      continuous = false;
      interimResults = false;
      onresult: ((e: unknown) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        setTimeout(() => {
          this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text } }] });
        }, 50);
      }
      stop() {
        setTimeout(() => this.onend?.(), 10);
      }
      abort() {
        this.onend?.();
      }
    }
    const w = window as unknown as { SpeechRecognition: unknown; webkitSpeechRecognition: unknown };
    w.SpeechRecognition = w.webkitSpeechRecognition = FakeRecognition;
  }, heard);
}
