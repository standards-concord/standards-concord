import { test, expect, fakeSpeech, settle, signIn, uniq, type Page } from './fixtures';

/**
 * The alpha feedback chat at /feedback: the open pathway, the guided pathway with its
 * captured answers, voice input, and starting again. Anyone can give feedback, signed in
 * or not; only platform admins can read it (security.spec.ts).
 */

const box = (page: Page) => page.getByRole('main').getByRole('textbox', { name: /Type or tap the mic|Anything else/ });

test.describe('feedback', () => {
  test('a signed-out visitor tells us something and submits it', async ({ page }) => {
    await page.goto('/feedback');
    await expect(page.getByRole('heading', { level: 1, name: 'Tell us what you think' })).toBeVisible();
    await page.getByRole('button', { name: /Just tell us something/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Tell us something' })).toBeVisible();
    const submit = page.getByRole('button', { name: 'Submit what I’ve said so far' });
    await expect(submit).toBeDisabled();
    const said = `The change request page took me a while to find. ${uniq()}`;
    await box(page).fill(said);
    await box(page).press('Enter');
    await expect(page.getByRole('main').getByText(said).first()).toBeVisible();
    // The assistant replies (offline, a scripted follow-up).
    await expect(submit).toBeEnabled({ timeout: 20_000 });
    await page.getByLabel('Name (optional)').fill('Alex');
    await page.getByLabel('Email (optional)').fill('alex@example.org');
    await submit.click();
    await expect(page.getByRole('heading', { name: 'Thank you!' })).toBeVisible();

    // Starting again returns to the choice of pathway.
    await page.getByRole('button', { name: 'Tell us something else' }).click();
    await expect(page.getByRole('button', { name: /Guided feedback/ })).toBeVisible();
  });

  // The choices used to enable for a moment while the signed-in account's data was still loading, then disable
  // again until it arrived. A click in that moment did nothing, so testers (and these tests, now and then) stayed
  // on the choice of pathway. Now they enable once, when everything they need has loaded.
  test('the ways to give feedback enable once, and stay enabled', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __flips: string[] };
      w.__flips = [];
      new MutationObserver((records) => {
        for (const r of records) {
          if (r.attributeName !== 'disabled' || !(r.target as Element).textContent?.includes('Guided feedback')) continue;
          w.__flips.push(r.oldValue === null ? 'disabled' : 'enabled');
        }
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ['disabled'], attributeOldValue: true });
    });
    await signIn(page, { name: `Feedback tester ${uniq()}`, role: 'contributor' });
    await page.goto('/feedback');
    const guided = page.getByRole('button', { name: /Guided feedback/ });
    await expect(guided).toBeEnabled();
    await settle(page);
    expect(await page.evaluate(() => (window as unknown as { __flips: string[] }).__flips)).toEqual(['enabled']);
    await guided.click();
    await expect(page.getByRole('heading', { level: 1, name: 'Guided feedback' })).toBeVisible();
  });

  test('guided feedback captures answers as you go, and they can be edited before submitting', async ({ page }) => {
    await signIn(page, { name: `Feedback tester ${uniq()}`, role: 'contributor' });
    await page.goto('/feedback');
    await page.getByRole('button', { name: /Guided feedback/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Guided feedback' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your answers so far' })).toBeVisible();
    await settle(page);
    // The question being asked is shown with an answer field named after it, so it can be edited directly.
    const role = page.getByRole('combobox', { name: 'Which best describes your work with data standards?' });
    await expect(role).toBeVisible();
    await role.selectOption('Domain expert (e.g. local government, charity)');
    await expect(role).toHaveValue('Domain expert (e.g. local government, charity)');

    for (const reply of ['I tried it as a volunteer coordinator.', 'The interview was the most useful part.']) {
      await box(page).fill(reply);
      await box(page).press('Enter');
      await expect(page.getByRole('main').getByText(reply).first()).toBeVisible();
      await expect(box(page)).toBeEnabled({ timeout: 20_000 });
    }
    // The edited answer is kept while the conversation moves on.
    await expect(role).toHaveValue('Domain expert (e.g. local government, charity)');

    await page.getByRole('button', { name: /^Submit (what I’ve said so far|feedback)$/ }).last().click();
    await expect(page.getByRole('heading', { name: 'Thank you!' })).toBeVisible();
    await page.getByRole('link', { name: 'Back to the hub' }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('an answer edited in the panel while a reply is on its way is kept', async ({ page }) => {
    // The reply used to be merged into the answers as they were when the message was sent, undoing the edit.
    await signIn(page, { name: `Feedback editor ${uniq()}`, role: 'contributor' });
    await page.goto('/feedback');
    await page.getByRole('button', { name: /Guided feedback/ }).click();
    await expect(page.getByRole('heading', { name: 'Your answers so far' })).toBeVisible();
    await settle(page);
    await expect(box(page)).toBeEnabled({ timeout: 20_000 });
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let sent!: () => void;
    const replySent = new Promise<void>((r) => (sent = r));
    await page.route('**/api/feedback/chat', async (route) => {
      const response = await route.fetch();
      sent();
      await released;
      await route.fulfill({ response });
    });
    // Answer the first question by typing, then change it in the panel before the reply comes back.
    await box(page).fill('Developer');
    await box(page).press('Enter');
    await replySent;
    const role = page.getByRole('combobox', { name: 'Which best describes your work with data standards?' });
    await role.selectOption('Policy or research');
    release();
    await expect(box(page)).toBeEnabled({ timeout: 20_000 });
    await expect(role).toHaveValue('Policy or research');
  });

  test('feedback can be spoken', async ({ page }) => {
    await fakeSpeech(page, 'I would like to see who else is reviewing');
    await page.goto('/feedback');
    await expect(page.getByText('Voice input works in this browser.')).toBeVisible();
    await page.getByRole('button', { name: /Just tell us something/ }).click();
    await page.getByRole('main').getByRole('button', { name: 'Start voice input' }).first().click();
    await expect(box(page)).toHaveValue(/I would like to see who else is reviewing/);
    await page.getByRole('main').getByRole('button', { name: 'Stop dictation' }).first().click();
    await box(page).press('Enter');
    await expect(page.getByText('Thanks for using voice — it helps us test it.')).toBeVisible();
    await page.getByRole('button', { name: 'Submit what I’ve said so far' }).click();
    await expect(page.getByRole('heading', { name: 'Thank you!' })).toBeVisible();
  });

  test('the back link leaves a pathway', async ({ page }) => {
    await page.goto('/feedback');
    await page.getByRole('button', { name: /Guided feedback/ }).click();
    await page.getByRole('main').getByRole('button', { name: 'Choose a different way' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Tell us what you think' })).toBeVisible();
  });
});
