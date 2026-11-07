import { test, expect, demoOntology, settle, signIn, signInAsPersona, uniq } from './fixtures';

/**
 * Signing in and out, the account menu, the hub's activity feed and the shared simulation
 * controls. (Looks are in looks.spec.ts, agents in agents.spec.ts and oauth.spec.ts, and who
 * may read feedback in security.spec.ts.)
 */

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
    await expect(page.getByRole('button', { name: 'Try the demo' })).toBeVisible();
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
