import { test, expect, demoOntology, expectNoCrash, fakeSpeech, settle, signInAsPersona, type Page } from './fixtures';

/**
 * Requirements: a contributor describes a use case in the AI interview (typing or speaking),
 * finishes it, and the use case is turned into a change request. Also the interview's layouts,
 * and drafting changes from several use cases at once.
 */

const answer = (page: Page) => page.getByRole('textbox', { name: /Type your answer/ });

async function startInterview(page: Page, ontologyId: string) {
  await page.goto(`/o/${ontologyId}/use-cases`);
  await page.getByRole('button', { name: 'Describe a use case' }).click();
  await expect(page).toHaveURL(/\/interview\/[^/]+$/, { timeout: 30_000 });
  await expect(page.getByRole('region', { name: 'Use case progress' })).toContainText('0 of 21 sections filled');
}

test.describe('requirements', () => {
  test('a contributor describes a use case in the interview, finishes it and drafts changes from it', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signInAsPersona(page, 'Aisha Rahman');
    await startInterview(page, demo.id);
    const progress = page.getByRole('region', { name: 'Use case progress' });

    // Send is disabled until there is something to send; Enter sends.
    await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
    const goal = 'Coordinators want to fill weekly shifts at food banks with regular volunteers.';
    await answer(page).fill(goal);
    await answer(page).press('Enter');
    await expect(page.getByRole('main').getByText(goal).first()).toBeVisible();
    await expect(answer(page)).toHaveValue('');
    await expect(progress).not.toContainText('0 of 21 sections filled', { timeout: 20_000 });

    // Shift+Enter makes a new line instead of sending.
    await answer(page).fill('Volunteer coordinators at councils,');
    await answer(page).press('Shift+Enter');
    await answer(page).pressSequentially('and residents who volunteer.');
    await expect(answer(page)).toHaveValue('Volunteer coordinators at councils,\nand residents who volunteer.');
    await page.getByRole('button', { name: 'Send' }).click();
    await answer(page).fill('Which shifts next week still need volunteers?');
    await answer(page).press('Enter');
    await expect(progress).toContainText(/Just captured:/, { timeout: 20_000 });

    // The document view and side-by-side layout show the use case as it fills in.
    const layout = page.getByRole('group', { name: 'Interview layout' });
    await layout.getByRole('button', { name: 'View document' }).click();
    await expect(layout.getByRole('button', { name: 'View document' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('main').getByText(goal).filter({ visible: true }).first()).toBeVisible();
    await layout.getByRole('button', { name: 'Side by side' }).click();
    await expect(answer(page)).toBeVisible();
    await layout.getByRole('button', { name: 'Conversation' }).click();

    // Finishing opens the use case, marked Ready, with what was captured.
    await page.getByRole('button', { name: 'Finish' }).click();
    await expect(page).toHaveURL(/\/use-cases\/[^/]+$/, { timeout: 30_000 });
    await settle(page);
    await expectNoCrash(page);
    await expect(page.getByRole('heading', { level: 2, name: goal.replace(/\.$/, '') })).toBeVisible();
    await expect(page.getByText('Ready', { exact: true }).first()).toBeVisible();
    const ucUrl = page.url();

    // It is listed with the other use cases.
    await page.getByRole('link', { name: 'All use cases' }).click();
    await expect(page.locator(`a[href="${new URL(ucUrl).pathname}"]`)).toBeVisible();

    // Draft changes from it: a change request that links back to the use case.
    await page.goto(ucUrl);
    await page.getByRole('button', { name: 'Draft changes' }).click();
    await expect(page).toHaveURL(/\/changes\/cr_[^/]+$/, { timeout: 30_000 });
    await settle(page);
    await expectNoCrash(page);
    await page.getByRole('link', { name: /use case 1|view use case/ }).first().click();
    await expect(page).toHaveURL(ucUrl);
  });

  test('answers can be spoken instead of typed', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await fakeSpeech(page, 'We publish shifts on our council website every Friday');
    await signInAsPersona(page, 'Aisha Rahman');
    await startInterview(page, demo.id);
    const mic = page.getByRole('button', { name: 'Start voice input' });
    await mic.click();
    // While listening, the mic button stops dictation and the box says it is listening.
    const stop = page.getByRole('button', { name: 'Stop dictation' });
    await expect(stop).toHaveAttribute('aria-pressed', 'true');
    await expect(answer(page)).toHaveAttribute('placeholder', 'Listening… speak naturally');
    await expect(answer(page)).toHaveValue(/We publish shifts on our council website every Friday/);
    await stop.click();
    await expect(page.getByRole('button', { name: 'Start voice input' })).toBeVisible();
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('main').getByText('We publish shifts on our council website every Friday').first()).toBeVisible();
  });

  test('a use case can be archived and is no longer offered for drafting', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signInAsPersona(page, 'Aisha Rahman');
    await startInterview(page, demo.id);
    await answer(page).fill('Track DBS checks for volunteers who work with children.');
    await answer(page).press('Enter');
    await expect(page.getByRole('main').getByText('Track DBS checks').first()).toBeVisible();
    await page.getByRole('button', { name: 'Finish' }).click();
    await expect(page).toHaveURL(/\/use-cases\/[^/]+$/, { timeout: 30_000 });
    await page.getByRole('button', { name: 'Archive' }).click();
    await expect(page.getByText('Archived', { exact: true }).first()).toBeVisible();
  });

  test('changes can be drafted from a selection of use cases', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signInAsPersona(page, 'Tom Okafor');
    await page.goto(`/o/${demo.id}/use-cases`);
    await settle(page);
    await page.getByRole('button', { name: 'Draft changes' }).click();
    await expect(page.getByRole('button', { name: 'Draft changes from all' })).toBeVisible();
    const boxes = page.getByRole('main').getByRole('checkbox');
    await boxes.first().check();
    await expect(page.getByRole('button', { name: 'Draft changes from 1 selected' })).toBeVisible();
    // Cancel leaves the selection mode without drafting anything.
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('main').getByRole('checkbox')).toHaveCount(0);
    await page.getByRole('button', { name: 'Draft changes' }).click();
    await boxes.first().check();
    await page.getByRole('button', { name: 'Draft changes from 1 selected' }).click();
    await expect(page).toHaveURL(/\/changes\/cr_[^/]+$/, { timeout: 30_000 });
    await settle(page);
    await expectNoCrash(page);
    await expect(page.getByRole('button', { name: /^Status: / })).toBeVisible();
  });
});
