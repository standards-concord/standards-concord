import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test as base, expect, expectNoCrash, signIn, uniq } from './fixtures';

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

async function expectInvitationNotStored(page: Page, secret: string) {
  // The old assertion only read localStorage, but kept answers actually live in IndexedDB.
  const stored = await page.evaluate(async () => {
    const kept = await new Promise<{ keys: IDBValidKey[]; values: unknown[] }>((resolve, reject) => {
      const open = indexedDB.open('concord-offline', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('kept');
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error('Offline storage is blocked'));
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('kept', 'readonly');
        const store = tx.objectStore('kept');
        const keys = store.getAllKeys();
        const values = store.getAll();
        tx.oncomplete = () => {
          db.close();
          resolve({ keys: keys.result, values: values.result });
        };
        tx.onabort = tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
    return { local: Object.entries(localStorage), session: Object.entries(sessionStorage), kept };
  });
  expect(JSON.stringify(stored)).not.toContain(secret);
  expect(JSON.stringify(stored.kept)).not.toMatch(/\/api\/invites\/|\|invite(?:s)?\|/i);
  // Lookup responses contain these fields even if saved under a key with no secret in it.
  expect(JSON.stringify(stored.kept.values)).not.toContain('"invitedBy"');
}

test('a steward copies a complete web URL, a real reviewer joins without storing the invitation, and links can be revoked', async ({ page, context, guest, baseURL }) => {
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
  const secret = new URL(link).pathname.split('/').pop()!;
  expect(secret).toMatch(/^[\w-]{43}$/);
  // The copied link used to have the API origin; navigating only to its pathname hid the broken URL.
  expect(link).toBe(new URL(`/join/${secret}`, baseURL).href);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy link', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  await accessible(page, '#roles');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await guest.goto(link);
  await expect(guest.getByRole('heading', { name: `You've been invited to join ${title}` })).toBeVisible();
  await expect(guest.getByText('as a reviewer and member', { exact: true })).toBeVisible();
  await expect(guest.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
  await accessible(guest, 'main');
  expect(await guest.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expectInvitationNotStored(guest, secret);
  await guest.getByRole('link', { name: 'Sign in to accept' }).click();
  await guest.route('**/api/auth/demo', (route) => route.continue({ postData: JSON.stringify({ name: `Invited reviewer ${uniq()}` }) }));
  await guest.getByRole('button', { name: 'Try the demo', exact: true }).click();
  await expect(guest).toHaveURL(/\/join\//);
  const session = await (await guest.request.get('/api/session')).json();
  await expect(guest.getByRole('button', { name: `Join as ${session.user.name}`, exact: true })).toBeVisible();
  await expectInvitationNotStored(guest, secret);
  await guest.getByRole('button', { name: `Join as ${session.user.name}`, exact: true }).click();
  await expect(guest).toHaveURL(new RegExp(`/o/${id}$`));
  await expectInvitationNotStored(guest, secret);
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
  await guest.goto(link);
  await expect(guest.getByText('This invitation link has been used up.', { exact: true })).toBeVisible();
  await guest.goto(revocable);
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

test('cross-site and sibling-origin forms cannot accept an invitation with the recipient session', async ({ page, baseURL, consoleGuard }) => {
  // The bodyless accept route used to allow forms, including same-site posts carrying session cookies.
  consoleGuard.allow(/^Failed to load resource: the server responded with a status of 415\b/);
  await signIn(page, { name: `Form invite owner ${uniq()}`, role: 'steward' });
  const created = await page.request.post('/api/ontologies', { data: { title: `Form invitation ${uniq()}`, description: 'Invitation consent.', prefix: `if${uniq()}` } });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  const made = await page.request.post(`/api/ontologies/${id}/invites`, { data: { roles: ['reviewer'] } });
  expect(made.status()).toBe(201);
  const { link } = await made.json();
  const secret = new URL(link).pathname.split('/').pop()!;
  const recipient = await signIn(page, { name: `Form recipient ${uniq()}`, role: 'contributor' });
  const target = new URL(`/api/invites/${secret}/accept`, baseURL).href;
  const sibling = new URL('/invitation-form', baseURL);
  sibling.port = String(Number(sibling.port) + 1);
  const crossSite = new URL('/invitation-form', baseURL);
  crossSite.hostname = crossSite.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
  for (const attacker of [sibling, crossSite]) {
    await page.route(attacker.href, (route) => route.fulfill({ contentType: 'text/html', body: `<form method="post" action="${target}"><button>Accept invitation</button></form>` }));
    await page.goto(attacker.href);
    const response = page.waitForResponse((r) => r.url() === target && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Accept invitation', exact: true }).click();
    expect((await response).status()).toBe(415);
    const lookup = await page.request.get(`/api/invites/${secret}`);
    expect(lookup.status()).toBe(200);
    expect((await lookup.json()).state).toBe('active');
  }
  // The normal client must still send JSON and let the person explicitly join.
  await page.goto(link);
  const acceptance = page.waitForRequest((r) => r.url() === target && r.method() === 'POST');
  await page.getByRole('button', { name: `Join as ${recipient.user.name}`, exact: true }).click();
  expect((await acceptance).headers()['content-type']).toMatch(/^application\/json\b/);
  await expect(page).toHaveURL(new RegExp(`/o/${id}$`));
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
  await page.goto(link);
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
