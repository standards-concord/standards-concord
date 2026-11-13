import type { Page } from '@playwright/test';
import { test, expect, demoOntology, settle, signIn, signInAsPersona, uniq } from './fixtures';

/**
 * Signing in and out, the account menu, the hub's activity feed and the shared simulation
 * controls. (Looks are in looks.spec.ts, agents in agents.spec.ts and oauth.spec.ts, and who
 * may read feedback in security.spec.ts.)
 */

/** Record ordering only, without keeping cookies or request bodies. */
function authTraffic(page: Page) {
  const traffic: string[] = [];
  const paths: Record<string, string> = {
    '/api/auth/logout': 'logout',
    '/api/auth/demo': 'demo',
    '/api/session': 'session',
  };
  const label = (url: string) => paths[new URL(url).pathname];
  page.on('request', (request) => {
    const name = label(request.url());
    if (name) traffic.push(`request ${name}`);
  });
  page.on('response', (response) => {
    const name = label(response.url());
    if (name) traffic.push(`response ${name}`);
  });
  return traffic;
}

async function expectSignedIn(page: Page, previousName: string) {
  await expect(page).toHaveURL(/\/alpha$/);
  await settle(page);
  await expect(page.getByRole('button', { name: 'Try the demo' })).toHaveCount(0);
  const session = (await (await page.request.get('/api/session')).json()) as { user?: { name: string } };
  expect(session.user && session.user.name !== previousName).toBe(true);
  await expect(page.getByRole('button', { name: new RegExp(session.user!.name) })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/alpha$/);
  await expect(page.getByRole('button', { name: new RegExp(session.user!.name) })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try the demo' })).toHaveCount(0);
}

test.describe('account and hub', () => {
  test('signing in from a deep link returns to that page', async ({ page }) => {
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings/);
    // Only the demo sign-in is configured here: no Google or GitHub buttons.
    await expect(page.getByRole('link', { name: /Google/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /GitHub/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Try the demo' }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
  });

  test('the login page sends a signed-in person on, and the walkthrough link works', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Alpha tester? Start here' }).click();
    await expect(page).toHaveURL(/\/welcome$/);
    await page.getByRole('link', { name: 'Start the guided walkthrough' }).first().click();
    await expect(page).toHaveURL(/\/alpha$/);
    await signIn(page, { name: `Returning ${uniq()}` });
    await page.goto('/login?next=%2Fsettings');
    await expect(page).toHaveURL(/\/settings$/);
  });

  test('the account menu shows who you are, links to your pages, and signs you out', async ({ page }) => {
    const name = `Menu tester ${uniq()}`;
    await signIn(page, { name, role: 'contributor' });
    await page.goto('/');
    await settle(page);
    const button = page.getByRole('button', { name: new RegExp(name) });
    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    const menu = page.getByRole('navigation', { name: 'Account' });
    await expect(menu.getByText(name)).toBeVisible();
    for (const [label, url] of [
      ['Profile', /\/settings$/],
      ['Connect an agent', /\/connect$/],
      ['Appearance', /\/appearance$/],
      ['Alpha walkthrough', /\/alpha$/],
    ] as const) {
      await page.goto('/');
      await page.getByRole('button', { name: new RegExp(name) }).click();
      await page.getByRole('navigation', { name: 'Account' }).getByRole('link', { name: label, exact: true }).click();
      await expect(page).toHaveURL(url);
    }
    // Profile keeps the WebID and pod made for this person behind the scenes, folded away.
    await page.goto('/settings');
    await page.getByRole('button', { name: /Your WebID and Solid pod/ }).click();
    await expect(page.getByRole('main').locator('code').first()).toContainText(/\/people\/usr_[^#]+#me$/);
    const webId = await page.getByRole('main').locator('code').first().innerText();
    const profile = await page.request.get(webId.replace(/#me$/, ''), { headers: { accept: 'text/turtle' } });
    expect(profile.ok(), `GET ${webId}`).toBeTruthy();

    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('navigation', { name: 'Account' }).getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login\?next=%2F$/);
    expect((await page.request.get('/api/agent-tokens')).status()).toBe(401);
  });

  // Used to go wrong (#100): going back to a page that needs sign-in straight after signing out could leave it
  // blank (main empty, address still the page). The redirect to /login was made, but when the move back landed
  // before the router had shown /login, the router saw no change at all, so nothing redirected again.
  test('going back to a page that needs sign-in, straight after signing out, sends you to sign in', async ({ page }) => {
    const name = `Back tester ${uniq()}`;
    await signIn(page, { name, role: 'contributor' });
    const { id } = await demoOntology(page.request);
    const target = `/o/${id}/validate`;
    await page.goto(target);
    await settle(page);
    // Also went wrong: sign-in is shown the moment you sign out, but the move to /login waited for the server to
    // end the session, so going back in that time was undone a moment later (and lost where you were going). The
    // server's answer is held back here so that window is always open.
    let answer!: () => void;
    const answered = new Promise<void>((r) => (answer = r));
    await page.route('**/api/auth/logout', async (route) => {
      await answered;
      await route.continue();
    });
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('navigation', { name: 'Account' }).getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('button', { name: 'Try the demo' })).toBeVisible();
    // Going back (without reloading) the moment the redirect to sign in is made: the timing a quick Back can hit.
    await page.evaluate((to) => {
      const replace = history.replaceState.bind(history);
      let once = false;
      history.replaceState = (data, unused, url) => {
        replace(data, unused, url);
        if (!once && String(url ?? '').startsWith('/login')) {
          once = true;
          queueMicrotask(() => {
            history.pushState({}, '', to);
            dispatchEvent(new PopStateEvent('popstate'));
          });
        }
      };
      history.pushState({}, '', to);
      dispatchEvent(new PopStateEvent('popstate'));
    }, target);
    await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(target)}$`));
    // The server ends the session now; you stay where you went.
    const ended = page.waitForResponse('**/api/session');
    answer();
    await ended;
    await settle(page);
    await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(target)}$`));
    await expect(page.getByRole('button', { name: 'Try the demo' })).toBeVisible();
    expect((await page.request.get('/api/agent-tokens')).status()).toBe(401);
  });

  // Used to go wrong: the page being left also redirected to sign-in, naming itself as the place to come back
  // to, so the next person to sign in on this browser was sent to the page the last one had open.
  test('signing out opens plain sign-in, with no return to the page that was open', async ({ page }) => {
    const name = `Leaver ${uniq()}`;
    await signIn(page, { name, role: 'contributor' });
    await page.goto('/settings');
    await settle(page);
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('navigation', { name: 'Account' }).getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('button', { name: 'Try the demo' })).toBeVisible();
    await settle(page);
    await expect(page).toHaveURL(/\/login$/);
  });

  // Used to go wrong: sign-in is shown while the server is still ending the old session. Signing in again in
  // that time worked for a moment, then the sign-out's late answer took the new session's cookie away and
  // closed the account on screen, so you were back at sign-in without having signed out.
  test('signing in again while a sign-out is still being confirmed keeps you signed in', async ({ page }) => {
    const name = `Quick return ${uniq()}`;
    await signIn(page, { name, role: 'contributor' });
    await page.goto('/settings');
    await settle(page);
    const traffic = authTraffic(page);
    let answer!: () => void;
    const answered = new Promise<void>((r) => (answer = r));
    await page.route('**/api/auth/logout', async (route) => {
      await answered;
      await route.continue();
    });
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('navigation', { name: 'Account' }).getByRole('button', { name: 'Sign out' }).click();
    const again = page.getByRole('button', { name: 'Try the demo' });
    await again.click();
    // The new sign-in waits its turn: nothing is sent as the next person until the old session has ended.
    await expect(again).toBeDisabled();
    // A disabled button alone also passed without the barrier, whenever demo login happened to answer last.
    await page.waitForTimeout(250);
    expect(traffic).toContain('request logout');
    expect(traffic).not.toContain('request demo');
    answer();
    await expect.poll(() => traffic.includes('request demo')).toBe(true);
    expect(traffic.indexOf('response logout')).toBeGreaterThanOrEqual(0);
    expect(traffic.indexOf('request demo')).toBeGreaterThan(traffic.indexOf('response logout'));
    await expectSignedIn(page, name);
  });

  // Used to go wrong: a stalled session refresh blocked login after logout had succeeded; once allowed
  // through, its old signed-out answer could also replace the new account on screen.
  test('a slow session check after signing out neither blocks nor undoes the next sign-in', async ({ page }) => {
    const name = `Slow check ${uniq()}`;
    await signIn(page, { name, role: 'contributor' });
    await page.goto('/settings');
    await settle(page);
    const traffic = authTraffic(page);
    let logoutStarted = false;
    await page.route('**/api/auth/logout', async (route) => {
      logoutStarted = true;
      await route.continue();
    });
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    let ready!: () => void;
    const held = new Promise<void>((resolve) => (ready = resolve));
    let holding = false;
    await page.route('**/api/session', async (route) => {
      if (!logoutStarted || holding) return route.continue();
      holding = true;
      // Fetch now, while signed out, rather than letting a later fetch see the next login's cookie.
      const response = await route.fetch();
      expect((await response.json()).user).toBeUndefined();
      ready();
      await answered;
      await route.fulfill({ response });
    });
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('navigation', { name: 'Account' }).getByRole('button', { name: 'Sign out' }).click();
    await held;
    const signedIn = page.waitForResponse('**/api/auth/demo');
    await page.getByRole('button', { name: 'Try the demo' }).click();
    const response = await signedIn;
    expect(response.ok()).toBe(true);
    const next = (await response.json()).user.name as string;
    await expect(page).toHaveURL(/\/alpha$/);
    await expect(page.getByRole('button', { name: new RegExp(next) })).toBeVisible();
    expect(traffic.indexOf('response logout')).toBeGreaterThanOrEqual(0);
    expect(traffic.indexOf('request demo')).toBeGreaterThan(traffic.indexOf('response logout'));
    expect(traffic).not.toContain('response session');
    const checked = page.waitForResponse('**/api/session');
    answer();
    await checked;
    await expectSignedIn(page, name);
  });

  // Used to go wrong: replaying an offline sign-out bypassed the wait, so its late response could
  // clear the cookie belonging to a demo login made while the replay was still on its way.
  test('signing in while an offline sign-out is being finished waits for it', async ({ page, consoleGuard }) => {
    consoleGuard.allow(/Failed to load resource|ERR_INTERNET_DISCONNECTED/);
    const name = `Offline return ${uniq()}`;
    await signIn(page, { name, role: 'contributor' });
    await page.goto('/settings');
    await settle(page);
    await page.route('**/api/**', (route) => route.abort('internetdisconnected'));
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('navigation', { name: 'Account' }).getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith('concord.signOutPending.')))).toBe(true);
    await settle(page);
    await page.unroute('**/api/**');
    const traffic = authTraffic(page);
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    let ready!: () => void;
    const held = new Promise<void>((resolve) => (ready = resolve));
    await page.route('**/api/auth/logout', async (route) => {
      // The reconnect replay identifies the session it meant, rather than ending an arbitrary session.
      expect(typeof route.request().postDataJSON().session).toBe('string');
      ready();
      await answered;
      await route.continue();
    });
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await held;
    const again = page.getByRole('button', { name: 'Try the demo' });
    await again.click();
    await expect(again).toBeDisabled();
    await page.waitForTimeout(250);
    expect(traffic).toContain('request logout');
    expect(traffic).not.toContain('request demo');
    answer();
    await expect.poll(() => traffic.includes('request demo')).toBe(true);
    expect(traffic.indexOf('response logout')).toBeGreaterThanOrEqual(0);
    expect(traffic.indexOf('request demo')).toBeGreaterThan(traffic.indexOf('response logout'));
    await expectSignedIn(page, name);
  });

  test('the hub lists ontologies and its activity feed links to what happened', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signInAsPersona(page, 'Tom Okafor');
    await page.goto('/');
    await settle(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Ontologies' })).toBeVisible();
    const card = page.getByRole('link', { name: new RegExp(`^${demo.title}`) });
    await expect(card).toBeVisible();
    // The card's counts read as one sentence, e.g. "16 classes, 24 properties, 2 use cases and 9 members."
    await expect(card).toContainText(/\d+ class(es)?, \d+ propert(y|ies), \d+ use cases? and \d+ members?\./);
    const feed = page.getByRole('complementary').filter({ has: page.getByRole('heading', { name: 'Recent activity' }) });
    const first = feed.getByRole('link').first();
    await expect(first).toBeVisible();
    const href = await first.getAttribute('href');
    await first.click();
    await expect(page).toHaveURL(new RegExp(`${href!.replace(/[?]/g, '\\?')}$`));
    await settle(page);
    // The ontology card opens the ontology.
    await page.goto('/');
    await card.click();
    await expect(page).toHaveURL(new RegExp(`/o/${demo.id}$`));
  });

  test('the shared simulated clock fast-forwards within limits', async ({ page }) => {
    await signInAsPersona(page, 'Mei Chen');
    const before = (await (await page.request.get('/api/session')).json()).now as string;
    const r = await page.request.post('/api/simulation/clock', { data: { advanceDays: 1 } });
    expect(r.ok()).toBeTruthy();
    const after = (await r.json()).now as string;
    expect(Date.parse(after) - Date.parse(before)).toBeGreaterThanOrEqual(24 * 3600 * 1000 - 60_000);
    // Out-of-range fast-forwards are refused.
    expect((await page.request.post('/api/simulation/clock', { data: { advanceDays: 0 } })).status()).toBe(400);
    expect((await page.request.post('/api/simulation/clock', { data: { advanceDays: 61 } })).status()).toBe(400);
  });
});
