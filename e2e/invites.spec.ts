import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, expectNoCrash, signIn, uniq, type Page } from './fixtures';

const test = base.extend<{ guest: Page }>({
  guest: async ({ browser, baseURL }, use) => {
    const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && !/^Failed to load resource: the server responded with a status of (401|410)\b/.test(message.text())) errors.push(message.text());
    });
    await use(page);
    await expectNoCrash(page);
    expect(errors, 'unexpected errors in the invitation recipient context').toEqual([]);
    await context.close();
  },
});

async function accessible(page: Page, selector: string) {
  const result = await new AxeBuilder({ page }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(result.violations).toEqual([]);
}

test('a steward invites a real reviewer, the link is used once, and another link can be revoked', async ({ page, context, guest }) => {
  // Previously Add a person only offered simulated personas, so real reviewers could not join.
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, { name: `Invite steward ${uniq()}`, role: 'steward' });
  const title = `Invitation group ${uniq()}`;
  const created = await page.request.post('/api/ontologies', { data: { title, description: 'Inviting our working group.', prefix: `iv${uniq()}` } });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  await page.goto(`/o/${id}/governance#roles`);
  await page.getByRole('button', { name: /^Invite people/ }).click();
  await page.getByRole('checkbox', { name: 'Reviewer', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Voting member', exact: true }).check();
  await page.getByRole('textbox', { name: 'Note (optional)' }).fill('Pilot reviewers');
  await page.getByRole('button', { name: 'Create invitation link' }).click();
  const link = await page.getByRole('textbox', { name: 'Invitation link', exact: true }).inputValue();
  expect(new URL(link).pathname).toMatch(/^\/join\/[\w-]{43}$/);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy link', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  await accessible(page, '#roles');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await guest.goto(new URL(link).pathname);
  await expect(guest.getByRole('heading', { name: `You've been invited to join ${title}` })).toBeVisible();
  await expect(guest.getByText('as a reviewer and member', { exact: true })).toBeVisible();
  await expect(guest.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
  await accessible(guest, 'main');
  expect(await guest.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await guest.getByRole('link', { name: 'Sign in to accept' }).click();
  await guest.route('**/api/auth/demo', (route) => route.continue({ postData: JSON.stringify({ name: `Invited reviewer ${uniq()}` }) }));
  await guest.getByRole('button', { name: 'Try the demo', exact: true }).click();
  await expect(guest).toHaveURL(/\/join\//);
  const session = await (await guest.request.get('/api/session')).json();
  await guest.getByRole('button', { name: `Join as ${session.user.name}`, exact: true }).click();
  await expect(guest).toHaveURL(new RegExp(`/o/${id}$`));
  expect(await guest.evaluate((secret) => Object.values(localStorage).some((value) => value.includes(secret)), new URL(link).pathname.split('/').pop()!)).toBe(false);
  await expect(guest.getByRole('status').filter({ hasText: `You've joined ${title} as a reviewer and member.` })).toBeVisible();
  // The steward is already on this address, so going to it again would not load the page afresh.
  await page.reload();
  await expect(page.locator('#roles').getByText(session.user.name, { exact: true })).toBeVisible();
  const row = page.locator('#roles div.flex-wrap.items-start').filter({ hasText: session.user.name });
  await expect(row.getByText('Reviewer', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Invite people/ }).click();
  await expect(page.getByRole('list', { name: 'Invitation links' })).toContainText('used 1 of 1');

  await page.getByRole('checkbox', { name: 'Reviewer', exact: true }).check();
  await page.getByRole('button', { name: 'Create invitation link' }).click();
  const revocable = await page.getByRole('textbox', { name: 'Invitation link', exact: true }).inputValue();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('list', { name: 'Invitation links' }).getByRole('listitem').filter({ has: page.getByText('Active', { exact: true }) }).getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Invitation links' })).toContainText('Revoked');
  await guest.context().clearCookies();
  await guest.unroute('**/api/auth/demo');
  await signIn(guest, { name: `Third invitee ${uniq()}`, role: 'contributor' });
  await guest.goto(new URL(link).pathname);
  await expect(guest.getByText('This invitation link has been used up.', { exact: true })).toBeVisible();
  await guest.goto(new URL(revocable).pathname);
  await expect(guest.getByText('This invitation link has been revoked.', { exact: true })).toBeVisible();
  await expect(guest.getByRole('link', { name: `View ${title}` })).toHaveAttribute('href', /\/def\//);
});

test('a contributor can view the group but cannot create invitation links', async ({ page }) => {
  await signIn(page, { name: `Invite owner ${uniq()}`, role: 'steward' });
  const created = await page.request.post('/api/ontologies', { data: { title: `Private invites ${uniq()}`, description: 'Role boundaries.', prefix: `ir${uniq()}` } });
  const { id } = await created.json();
  const ownerCookies = await page.context().cookies();
  const contributor = await signIn(page, { name: `Invite contributor ${uniq()}`, role: 'contributor' });
  const contributorCookies = await page.context().cookies();
  await page.context().clearCookies();
  await page.context().addCookies(ownerCookies);
  expect((await page.request.put(`/api/ontologies/${id}/members/${contributor.user.id}`, { data: { roles: ['contributor'] } })).ok()).toBe(true);
  await page.context().clearCookies();
  await page.context().addCookies(contributorCookies);
  await page.goto(`/o/${id}/governance#roles`);
  await expect(page.getByRole('heading', { name: 'Members and roles' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Invite people/ })).toHaveCount(0);
  expect((await page.request.post(`/api/ontologies/${id}/invites`, { data: { roles: ['reviewer'] } })).status()).toBe(403);
});

test('expired and invalid links explain how to get another invitation', async ({ page, consoleGuard }) => {
  consoleGuard.allow(/^Failed to load resource: the server responded with a status of (404|410)\b/);
  await signIn(page, { name: `Expiry owner ${uniq()}`, role: 'steward' });
  const created = await page.request.post('/api/ontologies', { data: { title: `Expired invitation ${uniq()}`, description: 'Expiry messages.', prefix: `ie${uniq()}` } });
  const ontology = await created.json();
  const made = await page.request.post(`/api/ontologies/${ontology.id}/invites`, { data: { roles: ['reviewer'], expiresInDays: 1 } });
  expect(made.status()).toBe(201);
  const { link } = await made.json();
  const secret = new URL(link).pathname.split('/').pop();
  const lookup = await (await page.request.get(`/api/invites/${secret}`)).json();
  // Stub only the display: real expiry is tested against clock in invites.test.ts, without moving the shared e2e clock.
  await page.route(`**/api/invites/${secret}`, (route) => route.fulfill({ status: 410, json: { ...lookup, state: 'expired', error: 'This invitation link has expired.' } }));
  await page.goto(new URL(link).pathname);
  await expect(page.getByText('This invitation link has expired.', { exact: true })).toBeVisible();
  await expect(page.getByText('Ask whoever sent it for a new link.', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: `View ${ontology.title}` })).toBeVisible();
  await page.goto('/join/invalid');
  await expect(page.getByText('This invitation link is not valid.', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Browse standards' })).toBeVisible();
});

test('demo sign-in rejects an external next destination', async ({ page }) => {
  // Login previously used next without checking that it stayed on this site.
  await page.goto('/login?next=%2F%2Fexample.org');
  await page.getByRole('button', { name: 'Try the demo', exact: true }).click();
  await expect(page).toHaveURL(/\/alpha$/);
});
