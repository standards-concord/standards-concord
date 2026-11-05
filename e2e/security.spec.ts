import { expect, signIn, test } from './fixtures';

/**
 * Hotfix for Astra's PR #39 review: demo sign-in must never grant access to
 * testers' feedback, and the OAuth callbacks must reject a missing state.
 */
test.describe('Sign-in and feedback access', () => {
  test('a demo tester who picks the owner role cannot read feedback, and the menu hides it', async ({ page }) => {
    await signIn(page, { name: 'Mallory', role: 'owner' });
    for (const path of ['/api/feedback', '/api/feedback/summary']) {
      const r = await page.request.get(path);
      expect(r.status(), path).toBe(403);
    }
    await page.goto('/');
    await page.locator('.app-user-button').click();
    await expect(page.getByRole('navigation', { name: 'Account' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Account' }).getByText('Alpha walkthrough')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Account' }).getByText('Feedback admin')).toHaveCount(0);
  });

  test('a playable persona with owner or ODI roles cannot read feedback either', async ({ page, request }) => {
    const ps = (await (await request.get('/api/personas')).json()) as { id: string; roles: string[]; playable?: boolean }[];
    const privileged = ps.filter((p) => p.playable !== false && (p.roles.includes('owner') || p.roles.includes('odi')));
    expect(privileged.length).toBeGreaterThan(0);
    for (const p of privileged) {
      await signIn(page, { userId: p.id });
      expect((await page.request.get('/api/feedback')).status(), p.id).toBe(403);
    }
  });

  test('OAuth callbacks without a state are refused', async ({ request }) => {
    for (const provider of ['google', 'github']) {
      const r = await request.get(`/auth/${provider}/callback?code=x`, { maxRedirects: 0 });
      // 404 when the provider isn't configured on the test server, 400 when it is: never a sign-in.
      expect([400, 404], provider).toContain(r.status());
      expect(r.headers()['set-cookie'] ?? '').not.toContain('concord_session');
    }
  });
});
