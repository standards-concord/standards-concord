import AxeBuilder from '@axe-core/playwright';
import type { Page, Route } from '@playwright/test';
import { test, expect, signIn } from './fixtures';

/**
 * "Sign in with Solid" opens the Solid Suite's shared sign-in card (packages/suite-ui,
 * the same modal every suite app uses) in a dialog: pick a provider, enter a WebID, or
 * type another provider's address. Each goes to /auth/solid, which these tests stop
 * so nothing leaves the machine. The full round trip against a real Solid server is in
 * solid-signin.spec.ts.
 */

type Asked = { webId: string | null; returnTo: string | null };

/**
 * Catch the browser's trip to /auth/solid and answer "204 No Content", which leaves the
 * login page where it is with the card still signing in (as if the provider were slow).
 * Resolves with what was asked for.
 */
function catchSolidLogin(page: Page) {
  return new Promise<Asked>((resolve) => {
    void page.route('**/auth/solid?**', async (route: Route) => {
      const url = new URL(route.request().url());
      resolve({ webId: url.searchParams.get('webId'), returnTo: url.searchParams.get('returnTo') });
      await route.fulfill({ status: 204 });
    });
  });
}

/**
 * Hold the trip to /auth/solid unanswered, so it is still under way. (Playwright can't
 * look at a page while its navigation is held, so only the keyboard is used meanwhile.)
 * `answer()` then sends it on to a stand-in provider page, unless the page called it off.
 */
function holdSolidLogin(page: Page) {
  let answer!: () => void;
  const answered = new Promise<void>((r) => (answer = r));
  const asked = new Promise<void>((resolve) => {
    void page.route('**/auth/solid?**', async (route: Route) => {
      resolve();
      await answered;
      // A trip the page called off has no request left to answer.
      await route.fulfill({ contentType: 'text/html', body: '<title>Provider</title><h1>At the provider</h1>' }).catch(() => undefined);
    });
  });
  return { asked, answer };
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Sign in with Solid' });

test('“Sign in with Solid” shows the Solid logo and opens the suite’s provider picker', async ({ page }) => {
  await page.goto('/login?next=/feedback');
  const button = page.getByRole('button', { name: 'Sign in with Solid' });
  await expect(button.locator('svg[data-logo="solid"]')).toBeVisible();
  // The old inline WebID form is gone.
  await expect(page.getByRole('button', { name: /Sign in with your WebID/ })).toHaveCount(0);

  await button.click();
  const picker = dialog(page);
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('heading')).toHaveText('Sign in with Solid');
  // The suite's providers, its home provider first.
  const providers = picker.getByRole('list', { name: 'Providers' }).getByRole('button');
  const names = ['solidcommunity.net', 'Inrupt PodSpaces', 'solidweb.org', 'teamid.live'];
  await expect(providers).toHaveCount(names.length);
  for (const [i, name] of names.entries()) await expect(providers.nth(i)).toHaveAccessibleName(name);
  await expect(picker.getByRole('textbox', { name: 'WebID' })).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Other provider' })).toBeVisible();
  await expect(picker.getByRole('link', { name: 'Get a pod' })).toHaveAttribute('href', 'https://solidcommunity.net/.account/login/password/register/');
  await expect(picker).toContainText('Concord checks that your WebID names that provider');

  const r = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});

test('choosing solidcommunity.net signs in there, keeping where the visitor was going', async ({ page }) => {
  const asked = catchSolidLogin(page);
  await page.goto('/login?next=/feedback');
  await page.getByRole('button', { name: 'Sign in with Solid' }).click();
  await dialog(page).getByRole('button', { name: 'solidcommunity.net' }).click();
  expect(await asked).toEqual({ webId: 'https://solidcommunity.net/', returnTo: '/feedback' });
  // While the provider is slow to answer, the card says so and holds the other choices...
  await expect(dialog(page).getByRole('button', { name: 'Signing in with solidcommunity.net…' })).toBeDisabled();
  await expect(dialog(page).getByRole('button', { name: 'Inrupt PodSpaces' })).toBeDisabled();
  // ...until the visitor gives up waiting.
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog(page).getByRole('button', { name: 'solidcommunity.net' })).toBeEnabled();
});

test('closing the dialog while waiting for the provider calls the sign-in off', async ({ page }) => {
  // This used to hide the dialog but carry on to the provider, and the reopened card
  // was stuck on "Signing in…".
  const login = holdSolidLogin(page);
  await page.goto('/login');
  const open = page.getByRole('button', { name: 'Sign in with Solid' });
  await open.click();
  // Playwright can't drive a page whose navigation is held, so the page presses Escape
  // itself, a moment after the trip starts.
  await page.evaluate(() => {
    window.addEventListener('beforeunload', () => {
      setTimeout(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), 200);
    }, { once: true });
  });
  const calledOff = page.waitForEvent('requestfailed', (r) => r.url().includes('/auth/solid'));
  await dialog(page).getByRole('button', { name: 'solidcommunity.net' }).click();
  await login.asked;
  await calledOff;
  // The provider answers late; the trip was already called off, so the page stays put.
  login.answer();
  await expect(dialog(page)).toBeHidden();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'At the provider' })).toHaveCount(0);
  await open.click();
  await expect(dialog(page).getByRole('button', { name: 'solidcommunity.net' })).toBeEnabled();
  await expect(dialog(page).getByRole('button', { name: 'Cancel' })).toHaveCount(0);
});

test('closing the dialog after a slow start leaves a fresh card next time', async ({ page }) => {
  const asked = catchSolidLogin(page);
  await page.goto('/login');
  const open = page.getByRole('button', { name: 'Sign in with Solid' });
  await open.click();
  await dialog(page).getByRole('button', { name: 'teamid.live' }).click();
  await asked;
  await expect(dialog(page).getByRole('button', { name: 'Signing in with teamid.live…' })).toBeDisabled();
  await dialog(page).getByRole('button', { name: 'Close' }).click();
  await expect(dialog(page)).toBeHidden();
  await open.click();
  await expect(dialog(page).getByRole('button', { name: 'teamid.live' })).toBeEnabled();
});

test('another provider’s address goes to that provider', async ({ page }) => {
  const asked = catchSolidLogin(page);
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in with Solid' }).click();
  await dialog(page).getByRole('button', { name: 'Other provider' }).click();
  const address = dialog(page).getByLabel('Provider address');
  await expect(address).toBeFocused();
  await address.fill('https://pods.example.org/');
  await dialog(page).getByRole('form', { name: 'Sign in with another provider' }).getByRole('button', { name: 'Continue' }).click();
  expect(await asked).toEqual({ webId: 'https://pods.example.org/', returnTo: '/' });
});

test('a refused provider or address is explained without blaming the WebID field', async ({ page }) => {
  // This used to mark the (empty) WebID field as the one in error whatever was chosen.
  // A provider that refuses: the stand-in sends the browser back as Concord does.
  await page.route('**/auth/solid?**', (route) =>
    route.fulfill({ status: 302, headers: { location: `/login?next=%2Ffeedback&solidError=${encodeURIComponent('solidweb.org didn’t answer')}` } }),
  );
  await page.goto('/login?next=/feedback');
  await page.getByRole('button', { name: 'Sign in with Solid' }).click();
  await dialog(page).getByRole('button', { name: 'solidweb.org' }).click();
  await expect(dialog(page).getByRole('alert')).toHaveText('solidweb.org didn’t answer');
  await expect(dialog(page).getByRole('textbox', { name: 'WebID' })).not.toHaveAttribute('aria-invalid');
  await expect(dialog(page).getByRole('button', { name: 'solidweb.org' })).toBeEnabled();
  await page.unroute('**/auth/solid?**');

  // Another provider's address that Concord refuses (a private address is never fetched).
  await dialog(page).getByRole('button', { name: 'Other provider' }).click();
  await dialog(page).getByLabel('Provider address').fill('https://127.0.0.1/');
  await dialog(page).getByLabel('Provider address').press('Enter');
  await expect(page).toHaveURL(/solidError=/);
  await expect(dialog(page).getByRole('alert')).toHaveText('127.0.0.1 isn’t reachable from Concord');
  await expect(dialog(page).getByRole('textbox', { name: 'WebID' })).not.toHaveAttribute('aria-invalid');
});

test('a refused WebID reopens the picker with the reason', async ({ page }) => {
  await page.goto('/login?next=/feedback');
  await page.getByRole('button', { name: 'Sign in with Solid' }).click();
  const webId = dialog(page).getByRole('textbox', { name: 'WebID' });
  // Continue waits for something to be typed.
  await expect(dialog(page).getByRole('form', { name: 'Sign in with your WebID' }).getByRole('button', { name: 'Continue' })).toBeDisabled();
  // A private address is never fetched for a stranger: Concord says so and keeps where they were going.
  await webId.fill('https://127.0.0.1/profile/card#me');
  await webId.press('Enter');
  await expect(page).toHaveURL(/\/login\?/);
  expect(new URL(page.url()).searchParams.get('next')).toBe('/feedback');
  await expect(dialog(page).getByRole('alert')).toHaveText('127.0.0.1 isn’t reachable from Concord');
  await expect(dialog(page).getByRole('textbox', { name: 'WebID' })).toHaveAttribute('aria-invalid', 'true');
});

test('the picker works from the keyboard and Escape closes it', async ({ page }) => {
  await page.goto('/login');
  const button = page.getByRole('button', { name: 'Sign in with Solid' });
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeVisible();
  // Focus stays inside the dialog.
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expect(button).toBeFocused();
});

test('the picker follows Concord’s look, and its styles leave the rest of Concord alone', async ({ page }) => {
  await page.goto('/login');
  // The suite calls a fill colour "muted"; Concord's muted is a text colour. The login
  // page's muted text must keep Concord's colour with the suite's styles loaded.
  const resolve = (value: string) =>
    page.evaluate((v) => {
      const el = document.createElement('span');
      el.style.color = v;
      document.body.append(el);
      const c = getComputedStyle(el).color;
      el.remove();
      return c;
    }, value);
  // (The restyle removed the login page's all-caps eyebrow, so this checks its muted paragraph instead.)
  const muted = page.getByText(/^Requirements come in from interviews/);
  expect(await muted.evaluate((el) => getComputedStyle(el).color)).toBe(await resolve('var(--muted)'));

  await page.getByRole('button', { name: 'Sign in with Solid' }).click();
  // The dialog is drawn with the look's surface.
  const surface = await resolve('var(--surface)');
  await expect.poll(() => dialog(page).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(surface);
  await dialog(page).getByRole('textbox', { name: 'WebID' }).fill('https://alice.example/profile/card#me');
  const go = dialog(page).getByRole('form', { name: 'Sign in with your WebID' }).getByRole('button', { name: 'Continue' });
  // The card's Continue is drawn in the look's text colour (the suite's design), once enabled.
  const fg = await resolve('var(--fg)');
  await expect.poll(() => go.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(fg);
});

test('signed-in people aren’t offered it, nor is it shown when the server has Solid sign-in off', async ({ page }) => {
  // Solid sign-in switched off on this server: no button.
  await page.route('**/api/session', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, providers: { ...body.providers, solid: false } } });
  });
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Try the demo' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with Solid' })).toHaveCount(0);
  await page.unroute('**/api/session');

  // Someone already signed in goes straight past the login page.
  await signIn(page, { name: 'Already In' });
  await page.goto('/login?next=/feedback');
  await expect(page).toHaveURL(/\/feedback$/);
  await expect(page.getByRole('button', { name: 'Sign in with Solid' })).toHaveCount(0);
});
