import { test, expect, signIn, expectNoCrash, settle } from './fixtures';
import type { Page } from '@playwright/test';
import { SOLID } from './solid/accounts';

/**
 * Against a real Community Solid Server (see solid.config.ts): signing in with
 * a WebID (Solid-OIDC with DPoP), testers' feedback saved to their pods and
 * shared read-only with the admin WebID, and the admin reading it from the pods.
 */

type Account = (typeof SOLID)['admin'];

/**
 * Sign in at Concord's login page ("Sign in with Solid", then the suite's picker) with a
 * WebID, or with the Solid server's address as "Other provider", then at the Solid server.
 */
async function solidSignIn(page: Page, account: Account, opts: { provider?: string; next?: string } = {}) {
  await page.goto(`/login${opts.next ? `?next=${encodeURIComponent(opts.next)}` : ''}`);
  await page.getByRole('button', { name: 'Sign in with Solid' }).click();
  const picker = page.getByRole('dialog', { name: 'Sign in with Solid' });
  if (opts.provider) {
    await picker.getByRole('button', { name: 'Other provider' }).click();
    await picker.getByLabel('Provider address').fill(opts.provider);
    await picker.getByRole('form', { name: 'Sign in with another provider' }).getByRole('button', { name: 'Continue' }).click();
  } else {
    await picker.getByRole('textbox', { name: 'WebID' }).fill(account.webId);
    await picker.getByRole('form', { name: 'Sign in with your WebID' }).getByRole('button', { name: 'Continue' }).click();
  }
  // The Solid server's own pages: log in, pick the WebID, authorize Concord.
  await expect(page).toHaveURL(new RegExp(`^${SOLID.css}/`));
  const pick = page.getByText('Choose your WebID to authorize');
  const email = page.getByLabel('Email');
  await expect(email.or(pick)).toBeVisible();
  // Log in unless this browser already is (then it goes straight to the WebID picker). The
  // server's login page redirects itself a couple of times while its script loads, so a
  // submit can land on a page that is going away: try again until the picker shows.
  await expect(async () => {
    if (await email.isVisible()) {
      await email.fill(account.email);
      await page.getByLabel('Password').fill(account.password);
      await page.getByRole('button', { name: 'Log in' }).click();
    }
    await expect(pick).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 45_000 });
  await page.getByRole('button', { name: 'Authorize' }).click();
  // Back at Concord, signed in.
  await page.waitForURL((u) => u.origin !== SOLID.css && u.pathname === (opts.next ?? '/'));
}

let feedbackUrl: string;

test('a tester’s feedback goes to their pod, and they are told the admin WebID can read it', async ({ page, playwright }) => {
  await signIn(page, { name: 'Pod Tester' });

  await page.goto('/feedback');
  await settle(page);
  const notice = page.getByTestId('feedback-privacy');
  await expect(notice).toContainText('Who can read your feedback');
  await expect(notice).toContainText('the Concord alpha team (this site’s administrators) can read everything you send');
  await expect(notice).toContainText('share that folder read-only with the team’s WebID');
  await notice.getByText('The team’s WebID', { exact: true }).click();
  await expect(notice.getByTestId('feedback-readers')).toHaveText(SOLID.admin.webId);

  const r = await page.request.post('/api/feedback', { data: { pathway: 'general', answers: { general: 'Pods make sense to me' }, transcript: [] } });
  expect(r.status(), await r.text()).toBe(201);
  const sub = (await r.json()) as { id: string; savedTo?: { kind: string; url: string } };
  expect(sub.savedTo?.kind).toBe('solid');
  expect(sub.savedTo?.url.startsWith(`${SOLID.css}/`)).toBeTruthy();
  feedbackUrl = sub.savedTo!.url;

  // Sharing only added Concord's rule: the tester's own account can still write to the folder.
  const again = await page.request.post('/api/feedback', { data: { pathway: 'general', answers: { general: 'And another thing' }, transcript: [] } });
  expect(((await again.json()) as { savedTo?: { kind: string } }).savedTo?.kind).toBe('solid');

  // Nobody else gets in without a WebID the pod's access control lets read.
  const anon = await playwright.request.newContext();
  expect((await anon.get(feedbackUrl)).status()).toBe(401);
  expect((await anon.get(new URL('.', feedbackUrl).href)).status()).toBe(401);
  await anon.dispose();
});

test('the admin signs in with their WebID and reads testers’ feedback from their pods as that WebID', async ({ page, browser }) => {
  expect(feedbackUrl, 'the tester test ran first').toBeTruthy();
  await solidSignIn(page, SOLID.admin, { next: '/admin/feedback' });

  const session = await (await page.request.get('/api/session')).json();
  expect(session.user.webId).toBe(SOLID.admin.webId);
  expect(session.user.providers).toEqual([{ provider: 'solid', subject: SOLID.admin.webId }]);
  expect(session.user.isPlatformAdmin).toBe(true);

  await expect(page.getByRole('heading', { name: 'Alpha feedback' })).toBeVisible();
  await expectNoCrash(page);
  const card = page.getByTestId('pod-feedback');
  await expect(card).toContainText('shared read-only with the admin WebID');
  await card.getByRole('button', { name: 'Read as my WebID' }).click();
  await expect(card).toContainText(`Read as ${SOLID.admin.webId}`);
  const folder = card.getByTestId('pod-folder').filter({ hasText: 'Pod Tester' });
  await expect(folder).toContainText('Readable');
  await expect(folder).toContainText('2 submissions');
  await expect(folder.getByRole('link')).toHaveAttribute('href', new URL('.', feedbackUrl).href);

  // The Solid login belongs to the browser session that signed in: another session of the
  // same account has its own, and signing that one out leaves this one working.
  const other = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const otherPage = await other.newPage();
  await solidSignIn(otherPage, SOLID.admin);
  expect((await otherPage.request.get('/api/feedback/pods')).status()).toBe(200);
  await otherPage.request.post('/api/auth/logout', { data: {} });
  await other.close();
  expect((await page.request.get('/api/feedback/pods')).status()).toBe(200);

  // Signing out ends the admin's Solid login: reading the pods needs a new one.
  const out = await page.request.post('/api/auth/logout', { data: {} });
  expect(await out.json()).toEqual({ ended: true });
  expect((await page.request.get('/api/feedback/pods')).status()).toBe(401);
});

test('someone else signs in with Solid (from their provider’s address) and can’t read feedback', async ({ page }) => {
  await solidSignIn(page, SOLID.visitor, { provider: `${SOLID.css}/` });
  const session = await (await page.request.get('/api/session')).json();
  expect(session.user.webId).toBe(SOLID.visitor.webId);
  expect(session.user.isPlatformAdmin).toBeFalsy();
  expect((await page.request.get('/api/feedback')).status()).toBe(403);
  expect((await page.request.get('/api/feedback/pods')).status()).toBe(403);

  // Signing in again finds the same account.
  const id = session.user.id;
  const out = await page.request.post('/api/auth/logout', { data: {} });
  expect(await out.json()).toEqual({ ended: true });
  await page.context().clearCookies();
  await solidSignIn(page, SOLID.visitor);
  expect((await (await page.request.get('/api/session')).json()).user.id).toBe(id);

  await page.goto('/settings');
  await expect(page.getByText('Solid (your WebID)')).toBeVisible();
  await expect(page.getByText('You signed in with your own WebID')).toBeVisible();
});

// Step 5e: someone who signs in with Solid keeps their private data in their own pod, written as them, in a folder
// private to them, with their feedback shared read-only with the team. Before, it went to a pod Concord made for them
// on its own Solid server (and on Vercel, which has none, to Concord's database).
test('someone who signs in with Solid keeps their feedback in their own pod, private to them and shared with the team', async ({ page, browser, playwright }) => {
  await solidSignIn(page, SOLID.visitor);
  const pod = `${SOLID.css}/visitor/`;
  const r = await page.request.post('/api/feedback', { data: { pathway: 'general', answers: { general: 'Saved in my own pod' }, transcript: [] } });
  expect(r.status(), await r.text()).toBe(201);
  const sub = (await r.json()) as { savedTo?: { kind: string; url: string } };
  expect(sub.savedTo?.kind).toBe('solid');
  expect(sub.savedTo?.url.startsWith(`${pod}concord/feedback/`)).toBeTruthy();

  // Nobody else can read it, nor anything else Concord keeps in their pod.
  const anon = await playwright.request.newContext();
  expect((await anon.get(sub.savedTo!.url)).status()).toBe(401);
  expect((await anon.get(`${pod}concord/`)).status()).toBe(401);
  expect((await anon.get(`${pod}concord/alpha/testing.jsonld`)).status()).toBe(401);
  await anon.dispose();

  // The team reads it from the pod, as the admin's WebID.
  const admin = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const adminPage = await admin.newPage();
  await solidSignIn(adminPage, SOLID.admin, { next: '/admin/feedback' });
  const card = adminPage.getByTestId('pod-feedback');
  await card.getByRole('button', { name: 'Read as my WebID' }).click();
  const folder = card.getByTestId('pod-folder').filter({ has: adminPage.getByRole('link', { name: new RegExp(`${pod}concord/feedback/`) }) });
  await expect(folder).toContainText('Readable');
  await expect(folder).toContainText('1 submission');
  await admin.close();
});
