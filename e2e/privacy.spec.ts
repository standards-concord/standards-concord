import { test, expect, expectNoCrash, settle, signIn } from './fixtures';

/**
 * The privacy policy at /privacy. Google's OAuth consent screen links to it, so
 * it has to open for someone who isn't signed in (before this page, /privacy
 * was only the app shell's "Page not found").
 */

test('a signed-out visitor reaches the privacy policy from the sign-in card', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('main').getByRole('link', { name: 'privacy policy' }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy policy' })).toBeVisible();
  await expectNoCrash(page);
});

test('the privacy policy opens directly without signing in', async ({ page }) => {
  await page.goto('/privacy');
  await settle(page);
  // Not sent to /login: it is public.
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy policy' })).toBeVisible();
});

test('the privacy policy covers each section and every sign-in method the server offers', async ({ page, request }) => {
  await page.goto('/privacy');
  for (const name of ['When you sign in', 'What you add', 'Where it is kept', 'Services that process it for us', 'Public reports and GitHub issues', 'Getting your data deleted', 'Contact']) {
    await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
  }
  // Every sign-in method this server offers must say what it shares (a new provider without a line here fails).
  const session = (await (await request.get('/api/session')).json()) as { providers: Record<string, boolean> };
  const lines: Record<string, string> = { google: 'Google:', github: 'GitHub:', solid: 'Your WebID (Solid):', demo: 'Try the demo:' };
  const signInSection = page.getByRole('region', { name: 'When you sign in' });
  for (const [provider, on] of Object.entries(session.providers)) {
    if (!on) continue;
    expect(lines[provider], `the policy has no line for the "${provider}" sign-in`).toBeTruthy();
    await expect(signInSection).toContainText(lines[provider]);
  }
  // Google and GitHub are what the Google review checks, even where they aren't configured.
  await expect(signInSection).toContainText(lines.google);
  await expect(signInSection).toContainText(lines.github);
  // Interviews and feedback are kept on Concord's servers as well as in a pod (an early draft said otherwise).
  await expect(page.getByRole('region', { name: 'Where it is kept' })).toContainText('Your account, your interviews, your feedback and testing history');
  // A public summary can only be withdrawn from the thank-you screen (the withdraw button lives there only).
  await expect(page.getByRole('region', { name: 'Public reports and GitHub issues' })).toContainText('from the thank-you screen straight after sending it');
  // Deletion requests go to the ODI address Jesse chose, as a mail link.
  await expect(page.getByRole('region', { name: 'Getting your data deleted' }).getByRole('link')).toHaveAttribute('href', 'mailto:solid-eng@theodi.org');
});

test('a signed-in tester reaches the privacy policy from the footer', async ({ page }) => {
  await signIn(page, { name: 'Privacy reader', role: 'contributor' });
  await page.goto('/');
  await settle(page);
  await page.getByRole('contentinfo').getByRole('link', { name: 'Privacy policy' }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy policy' })).toBeVisible();
  await expectNoCrash(page);
});
