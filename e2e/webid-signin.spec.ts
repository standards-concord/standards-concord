import { test, expect, signIn, settle } from './fixtures';

/**
 * Signing in with a WebID, and telling testers who reads their feedback, without
 * a Solid server (the main suite runs offline). The full Solid sign-in and the
 * pod sharing run against a real Solid server in solid-signin.spec.ts.
 */

test('the login page offers signing in with a WebID, and explains a refused address', async ({ page }) => {
  await page.goto('/login?next=/feedback');
  await page.getByRole('button', { name: /Sign in with your WebID/ }).click();
  const box = page.getByRole('textbox', { name: 'Sign in with your WebID' });
  await expect(box).toBeFocused();
  await expect(page.getByText('Your WebID, or the address of your Solid provider.')).toBeVisible();
  // A private address is never fetched for a stranger: Concord says so and keeps where they were going.
  await box.fill('https://127.0.0.1/profile/card#me');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/login\?/);
  await expect(page.getByTestId('solid-error')).toHaveText('127.0.0.1 isn’t reachable from Concord');
  expect(new URL(page.url()).searchParams.get('next')).toBe('/feedback');
  // The form stays open with the message, ready for another try.
  await expect(page.getByRole('textbox', { name: 'Sign in with your WebID' })).toBeVisible();
});

test('the feedback page tells testers the alpha team can read what they send', async ({ page }) => {
  await signIn(page, { name: 'Privacy Reader' });
  await page.goto('/feedback');
  await settle(page);
  const notice = page.getByTestId('feedback-privacy');
  await expect(notice).toContainText('Who can read your feedback: the Concord alpha team (this site’s administrators) can read everything you send, including your name and email if you give them. Other testers can’t.');
  // No Solid server here: the copy is kept in private storage.
  await expect(notice).toContainText('we also keep a copy in your private storage');

  await page.getByRole('button', { name: /Just tell us something/ }).click();
  await expect(page.getByTestId('feedback-privacy')).toBeVisible();
});
