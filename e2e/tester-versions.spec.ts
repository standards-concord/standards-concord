import { test, expect, expectNoCrash, settle } from './fixtures';
import { APP_RELEASES, APP_VERSION, changesFor, changesSince, type AppChange } from '../packages/shared/src/appReleases';

/** The start of the question the feedback chat asks about a change (see changeQuestions on the server). */
const questionAbout = (c: AppChange) => (c.ask ?? `how well does this work for you: ${c.title}`).slice(0, 30);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Until we know which version a tester last tried, the version picker and the sign-in prompt are folded behind one link. */
const whatsNew = (page: import('@playwright/test').Page) => page.getByRole('button', { name: 'What’s new since you last tested?' });
async function openWhatsNew(page: import('@playwright/test').Page) {
  // Right after a sign-in or sign-out the card can still be settling on who is testing, and a fold opened in that
  // moment is replaced by a closed one. Open it until what it holds stays visible.
  await expect(async () => {
    if ((await whatsNew(page).getAttribute('aria-expanded')) !== 'true') await whatsNew(page).click();
    await expect(page.getByRole('region', { name: 'What’s changed' })).toBeVisible({ timeout: 1000 });
  }).toPass();
}

/**
 * App versions for alpha testers: the alpha page says which version you're
 * testing, encourages sign-in so the version and your feedback go to your pod,
 * and shows a returning tester what changed since the version they last tested,
 * tailoring the role picker, the suggested tasks and the feedback questions to it.
 */

test('the alpha page says which version you are testing, with release notes', async ({ page }) => {
  await page.goto('/alpha');
  await expect(page.getByTestId('app-version')).toHaveText(`Concord ${APP_VERSION}`);
  await expect(page.getByText(`Alpha testing · version ${APP_VERSION}`)).toBeVisible();
  await page.getByRole('button', { name: /Release notes for every version/ }).click();
  for (const r of APP_RELEASES) await expect(page.getByText(r.title, { exact: true }).first()).toBeVisible();
  // The number of versions used to sit beside the link; it said nothing a first-time tester needed.
  await expect(page.getByText(`${APP_RELEASES.length} versions`)).toHaveCount(0);
  // Signed out, the sign-in prompt and the question of which version you tested before are one link, folded.
  await expect(page.getByRole('group', { name: 'Your testing record' })).toHaveCount(0);
  await expect(page.getByLabel('Last version you tested')).toHaveCount(0);
  await openWhatsNew(page);
  await expect(page.getByRole('group', { name: 'Your testing record' })).toContainText('Sign in so we can remember what you tested');
  const changed = page.getByRole('region', { name: 'What’s changed' });
  await expect(changed.getByLabel('Last version you tested')).toBeVisible();
  await expectNoCrash(page);
});

test('a signed-out tester picks the version they last tested and gets questions about what changed', async ({ page }) => {
  const since = '0.6.0';
  const changes = changesSince(since);
  await page.goto('/alpha');
  await openWhatsNew(page);
  const changed = page.getByRole('region', { name: 'What’s changed' });
  await changed.getByLabel('Last version you tested').selectOption(since);
  await expect(changed.getByRole('heading', { name: `What’s changed since ${since}` })).toBeVisible();
  await expect(changed.getByText(`${changes.length} changes · you picked it`)).toBeVisible();
  if (changes.length > 5) await changed.getByRole('button', { name: `Show all ${changes.length} changes` }).click();
  for (const c of changes) await expect(changed.getByRole('listitem', { name: c.title })).toBeVisible();
  // Each change can be tried where it lives.
  await expect(changed.getByRole('link', { name: 'Try it: Connect a coding agent in one click' })).toHaveAttribute('href', '/connect');

  // The choice is remembered in this browser.
  await page.reload();
  await expect(page.getByRole('heading', { name: `What’s changed since ${since}` })).toBeVisible();

  // Roles with changes made for them are marked in the role picker.
  await page.getByRole('button', { name: 'Let’s start' }).click();
  const forAgents = changes.filter((c) => c.roles.includes('agent')).length;
  expect(forAgents).toBeGreaterThan(0);
  await expect(page.getByRole('region', { name: 'Agent developer' }).getByText(`${forAgents} new since ${since}`)).toBeVisible();

  // Feedback asks about those changes, not the whole app.
  await page.goto('/feedback');
  await page.getByRole('button', { name: new RegExp(`What’s changed since ${since}`) }).click();
  await expect(page.getByRole('heading', { name: `What’s changed since ${since}`, level: 1 })).toBeVisible();
  await expect(page.getByText(`What’s new since ${since}`).first()).toBeVisible({ timeout: 20_000 });
  const answers = page.getByRole('heading', { name: 'Your answers so far' }).locator('..');
  await expect(answers.getByText('How likely are you to use this for a real standards project?')).toBeVisible();
  await expect(answers.getByText('Which governance models should Concord offer?')).toHaveCount(0);
  await settle(page);
  await expectNoCrash(page);
});

test('a returning tester’s versions and feedback are saved to their pod and steer the walkthrough', async ({ page }) => {
  await page.goto('/alpha');
  await openWhatsNew(page);
  const record = page.getByRole('group', { name: 'Your testing record' });
  await record.getByRole('button', { name: /Keep a tester account in this browser/ }).click();
  await expect(record).toContainText('You’re using a tester account kept in this browser');

  // This version is saved to the tester's record without them doing anything.
  await expect
    .poll(async () => ((await (await page.request.get('/api/alpha/me')).json()) as { versions: { version: string }[] }).versions.map((v) => v.version))
    .toContain(APP_VERSION);

  // Pretend they tested 0.7.0 last time.
  const prev = await page.request.post('/api/alpha/visit', { data: { version: '0.7.0' } });
  expect(prev.ok()).toBeTruthy();
  await page.reload();
  const changed = page.getByRole('region', { name: 'What’s changed' });
  await expect(changed.getByRole('heading', { name: 'What’s changed since 0.7.0' })).toBeVisible();
  await expect(changed.getByText(/from your pod/)).toBeVisible();

  // Join as an agent developer: what changed for agents since 0.7.0 comes first.
  await page.getByRole('button', { name: 'Let’s start' }).click();
  const agents = page.getByRole('region', { name: 'Agent developer' });
  await expect(agents.getByText(/new since 0\.7\.0/)).toBeVisible();
  await agents.getByRole('button').first().click();
  await agents.getByRole('button', { name: 'Join as a new agent developer' }).click();
  await expect(page.getByRole('heading', { name: '3. Explore the demo' })).toBeVisible();
  const forAgents = changesFor(changesSince('0.7.0'), 'agent').filter((c) => c.type !== 'fix' || c.ask);
  expect(forAgents[0].roles).toContain('agent');
  const whatsNew = page.getByRole('region', { name: 'New since 0.7.0' });
  await expect(whatsNew.getByRole('listitem', { name: forAgents[0].title })).toBeVisible();
  await expect(whatsNew.getByText('For your role').first()).toBeVisible();
  await expect(page.getByRole('group', { name: 'Suggested next task' }).getByText('Changed since 0.7.0')).toBeVisible();
  // Still the same tester, so the record stays theirs.
  await expect(record).toContainText('You’re using a tester account kept in this browser');

  // Feedback on what changed goes to the tester's pod with the version they tested.
  await page.goto('/feedback');
  await page.getByRole('button', { name: /What’s changed since 0\.7\.0/ }).click();
  // Agents' changes first, newest first; one can be skipped.
  const chat = page.getByRole('main');
  await expect(chat.getByText(new RegExp(esc(questionAbout(forAgents[0])))).first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(chat.getByText(new RegExp(`New in ${esc(forAgents[1].version)}: ${esc(questionAbout(forAgents[1]))}`)).first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: '4', exact: true }).click();
  await expect(chat.getByText(new RegExp(`New in ${esc(forAgents[2].version)}: ${esc(questionAbout(forAgents[2]))}`)).first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Submit what I’ve said so far' }).click();
  await expect(page.getByRole('heading', { name: 'Thank you!' })).toBeVisible();
  await expect(page.getByTestId('feedback-saved')).toContainText(`A copy is saved to your private storage, with the version you tested (${APP_VERSION})`);

  const me = (await (await page.request.get('/api/alpha/me')).json()) as { versions: { version: string; feedbackIds: string[]; roles?: string[] }[] };
  const current = me.versions.find((v) => v.version === APP_VERSION)!;
  expect(current.feedbackIds).toHaveLength(1);
  expect(current.roles).toContain('agent');
  expect(me.versions.map((v) => v.version)).toContain('0.7.0');
  await expectNoCrash(page);
});

// Picking a version used to swap the folded card for the expanded one, so the picker vanished from under the
// keyboard before Done, and picking "This is my first time" afterwards folded everything away again.
test('a first-time tester picks a version in the fold by keyboard, and it stays open while they change their mind', async ({ page }) => {
  await page.goto('/alpha');
  await openWhatsNew(page);
  const changed = page.getByRole('region', { name: 'What’s changed' });
  const picker = changed.getByLabel('Last version you tested');
  await picker.focus();
  await picker.selectOption('0.6.0');
  await expect(changed.getByRole('heading', { name: 'What’s changed since 0.6.0' })).toBeVisible();
  // The picker stays put, with focus, until Done.
  await expect(picker).toBeFocused();
  await expect(changed.getByRole('status')).toHaveText(`Showing ${changesSince('0.6.0').length} changes since 0.6.0.`);
  await changed.getByRole('button', { name: 'Done' }).click();
  await expect(picker).toHaveCount(0);
  await expect(changed.getByRole('button', { name: 'Change', exact: true })).toBeFocused();

  // Changing their mind to "first time" keeps the fold open, with the welcome and the sign-in prompt.
  await changed.getByRole('button', { name: 'Change', exact: true }).click();
  await changed.getByLabel('Last version you tested').focus();
  await changed.getByLabel('Last version you tested').selectOption('first');
  await expect(whatsNew(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(changed.getByText('Welcome! Everything is new to you, so the walkthrough covers it all.')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Your testing record' })).toContainText('Sign in so we can remember what you tested');
  await expect(changed.getByLabel('Last version you tested')).toBeFocused();
  await expectNoCrash(page);
});

test('a tester with history can compare with another version and come back, by keyboard', async ({ page }) => {
  await page.goto('/alpha');
  await openWhatsNew(page);
  await page.getByRole('group', { name: 'Your testing record' }).getByRole('button', { name: /Keep a tester account in this browser/ }).click();
  await expect(page.getByRole('group', { name: 'Your testing record' })).toContainText('tester account kept in this browser');
  expect((await page.request.post('/api/alpha/visit', { data: { version: '0.7.0' } })).ok()).toBeTruthy();
  await page.reload();
  const changed = page.getByRole('region', { name: 'What’s changed' });
  await expect(changed.getByRole('heading', { name: 'What’s changed since 0.7.0' })).toBeVisible();
  // No buttons nested inside links in the status card.
  for (const part of [changed, page.getByRole('group', { name: 'Your testing record' })]) await expect(part.locator('a button, button a')).toHaveCount(0);

  const toggle = changed.getByRole('button', { name: 'Compare with another version' });
  await toggle.focus();
  await page.keyboard.press('Enter');
  const picker = changed.getByLabel('Compare with');
  await expect(picker).toBeVisible();
  // There's history, so "first time" isn't offered, and the pod's version is marked.
  await expect(picker.locator('option[value="first"]')).toHaveCount(0);
  await expect(picker.locator('option[value="0.7.0"]')).toHaveText(/\(last tested\)/);
  await picker.focus();
  await picker.selectOption('0.5.0');
  // The picker stays put (and keeps focus) while the result is announced.
  await expect(changed.getByRole('heading', { name: 'What’s changed since 0.5.0' })).toBeVisible();
  await expect(picker).toBeFocused();
  await expect(changed.getByRole('status')).toHaveText(`Showing ${changesSince('0.5.0').length} changes since 0.5.0.`);
  await expect(changed.getByText(/comparing/)).toBeVisible();
  await changed.getByRole('button', { name: 'Done' }).click();
  await expect(picker).toHaveCount(0);
  await expect(changed.getByRole('button', { name: 'Compare with another version' })).toBeFocused();

  // The comparison is temporary: back to the tested version, and gone after a reload.
  await changed.getByRole('button', { name: /Back to your last tested version \(0\.7\.0\)/ }).click();
  await expect(changed.getByRole('heading', { name: 'What’s changed since 0.7.0' })).toBeVisible();
  await changed.getByRole('button', { name: 'Compare with another version' }).click();
  await changed.getByLabel('Compare with').selectOption('0.5.0');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'What’s changed since 0.7.0' })).toBeVisible();
  await expectNoCrash(page);
});

test('a comparison one tester picked doesn’t carry over to the next tester in the same browser', async ({ page }) => {
  await page.goto('/alpha');
  await openWhatsNew(page);
  const record = page.getByRole('group', { name: 'Your testing record' });
  await record.getByRole('button', { name: /Keep a tester account in this browser/ }).click();
  await expect(record).toContainText('tester account kept in this browser');
  expect((await page.request.post('/api/alpha/visit', { data: { version: '0.7.0' } })).ok()).toBeTruthy();
  await page.reload();
  const changed = page.getByRole('region', { name: 'What’s changed' });
  await changed.getByRole('button', { name: 'Compare with another version' }).click();
  await changed.getByLabel('Compare with').selectOption('0.5.0');
  await expect(changed.getByRole('heading', { name: 'What’s changed since 0.5.0' })).toBeVisible();

  // Sign out and start again as someone else, without reloading the page.
  await signOutInPlace(page);
  await openWhatsNew(page);
  await page.getByRole('group', { name: 'Your testing record' }).getByRole('button', { name: /Keep a tester account in this browser/ }).click();
  await expect(page.getByRole('group', { name: 'Your testing record' })).toContainText('tester account kept in this browser');
  // The new tester has no history of their own, so they're asked, not shown the last tester's comparison.
  await expect(whatsNew(page)).toBeVisible();
  await expect(changed.getByLabel('Last version you tested')).toBeVisible();
  await expect(changed.getByRole('heading', { name: 'What’s changed since 0.5.0' })).toHaveCount(0);
  await expectNoCrash(page);
});

/** Sign out from the account menu and open /alpha again without reloading the page. */
async function signOutInPlace(page: import('@playwright/test').Page) {
  await page.locator('.app-user-button').click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.evaluate(() => {
    history.pushState({}, '', '/alpha');
    dispatchEvent(new PopStateEvent('popstate'));
  });
}

test('a slow save for the previous tester doesn’t replace the next tester’s record', async ({ page }) => {
  let fetched!: () => void;
  const aFetched = new Promise<void>((r) => (fetched = r));
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const held: Promise<void>[] = [];
  let aSession: string | undefined;
  await page.route('**/api/alpha/visit', async (route) => {
    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === 'concord_session')?.value;
    aSession ??= session;
    if (session !== aSession) return route.continue();
    // Every save made as tester A (who has tested 0.7.0 before) is slow to come back.
    let done!: () => void;
    held.push(new Promise<void>((r) => (done = r)));
    await page.request.post('/api/alpha/visit', { data: { version: '0.7.0' } });
    // Sent with A's cookies (the browser adds them below the level route.fetch sees).
    const response = await route.fetch({ headers: { ...route.request().headers(), cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') } });
    fetched();
    await released;
    await route.fulfill({ response });
    done();
  });
  await page.goto('/alpha');
  await openWhatsNew(page);
  await page.getByRole('group', { name: 'Your testing record' }).getByRole('button', { name: /Keep a tester account in this browser/ }).click();
  await aFetched;

  // Tester B takes over the browser before A's save comes back.
  await signOutInPlace(page);
  await openWhatsNew(page);
  const record = page.getByRole('group', { name: 'Your testing record' });
  await record.getByRole('button', { name: /Keep a tester account in this browser/ }).click();
  await expect(record).toContainText('tester account kept in this browser');
  const changed = page.getByRole('region', { name: 'What’s changed' });
  await expect(changed.getByLabel('Last version you tested')).toBeVisible();
  release();
  await Promise.all(held);
  await page.waitForTimeout(500);
  // A's history (0.7.0) never shows up as B's.
  await expect(whatsNew(page)).toBeVisible();
  await expect(changed.getByLabel('Last version you tested')).toBeVisible();
  await expect(changed.getByRole('heading', { name: 'What’s changed since 0.7.0' })).toHaveCount(0);
  await expectNoCrash(page);
});

test('versions this browser has seen are never written over when they couldn’t be read', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('concord.alpha.seen', JSON.stringify(['0.7.0']));
    // The first read of the saved versions fails.
    const get = Storage.prototype.getItem;
    let failed = false;
    Storage.prototype.getItem = function (key: string) {
      if (key === 'concord.alpha.seen' && !failed) {
        failed = true;
        throw new Error('storage unavailable');
      }
      return get.call(this, key);
    };
  });
  await page.goto('/alpha');
  await expect(page.getByTestId('app-version')).toBeVisible();
  await settle(page);
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem('concord.alpha.seen'))) ?? '[]')).toEqual(['0.7.0']);
  // Read properly next time, it's still there, so this browser knows what changed.
  await page.reload();
  await expect(page.getByRole('region', { name: 'What’s changed' }).getByRole('heading', { name: 'What’s changed since 0.7.0' })).toBeVisible();
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem('concord.alpha.seen'))) ?? '[]')).toEqual(['0.7.0', APP_VERSION]);
});
