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

test('the privacy policy covers sign-in data, storage, public posts and deletion', async ({ page }) => {
  await page.goto('/privacy');
  for (const name of ['When you sign in', 'What you add', 'Where it is kept', 'Services that process it for us', 'Public reports and GitHub issues', 'Getting your data deleted', 'Contact']) {
    await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
  }
  const signInSection = page.getByRole('region', { name: 'When you sign in' });
  await expect(signInSection).toContainText('Google:');
  await expect(signInSection).toContainText('GitHub:');
  await expect(signInSection).toContainText('profile picture');
  await expect(page.getByRole('region', { name: 'Where it is kept' })).toContainText('Solid pod');
  await expect(page.getByRole('region', { name: 'Public reports and GitHub issues' })).toContainText('GitHub issue');
  // Deletion requests go to a real address, as a mail link.
  const contact = page.getByRole('region', { name: 'Getting your data deleted' }).getByRole('link');
  await expect(contact).toHaveAttribute('href', /^mailto:[^@\s]+@[^@\s]+\.[a-z]+$/);
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
