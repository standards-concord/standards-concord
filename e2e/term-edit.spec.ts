import { demoOntology, expect, expectNoCrash, settle, signIn, test } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Inline editing on a term's page (Browse). An edit becomes an editorial change
 * request; the term itself only changes once that request is approved and merged.
 */

const VOL = 'https://w3id.org/odi/volunteering#';
const ORIGINAL_DEFINITION = 'A learned capability, such as first aid or bookkeeping, that a person can apply to a task.';

async function openTerm(page: Page, localName: string) {
  const { id } = await demoOntology(page.request);
  await page.goto(`/o/${id}/browse?term=${encodeURIComponent(VOL + localName)}`);
  await settle(page);
  return id;
}

const editor = (page: Page) => page.getByRole('form', { name: /^Edit / });

test.describe('editing a term inline', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, { name: 'E2E term editor', role: 'contributor' });
  });

  test('the Edit button sits next to Report a problem and opens a prefilled form', async ({ page }) => {
    await openTerm(page, 'Skill');
    const edit = page.getByRole('button', { name: 'Edit', exact: true });
    await expect(edit).toBeVisible();
    await expect(page.getByRole('button', { name: /Report a problem/ })).toBeVisible();
    await edit.click();

    const form = editor(page);
    await expect(form.getByRole('heading', { name: 'Edit “skill”' })).toBeVisible();
    await expect(form.getByLabel('Label')).toHaveValue('skill');
    await expect(form.getByLabel('Definition')).toHaveValue(ORIGINAL_DEFINITION);
    for (const f of ['Comment', 'Also known as', 'Examples', 'Editorial note']) await expect(form.getByLabel(f)).toHaveValue('');
    // Explains that the edit goes through governance, with this ontology's patch rule.
    await expect(form).toContainText('proposed as a change request');
    await expect(form).toContainText(/sign-off from Editor or Steward/);
    await expect(form.getByText('No changes yet')).toBeVisible();
    await expect(form.getByRole('button', { name: 'Propose change' })).toBeDisabled();
    await expect(form.getByRole('button', { name: 'Save as draft' })).toBeDisabled();

    // Cancel goes back to the term without proposing anything.
    await form.getByLabel('Comment').fill('Not saved');
    await form.getByRole('button', { name: 'Cancel' }).click();
    await expect(editor(page)).toHaveCount(0);
    await expect(page.getByText(ORIGINAL_DEFINITION)).toBeVisible();
    await expectNoCrash(page);
  });

  test('proposing an edit opens a change request and leaves the term unchanged until it merges', async ({ page }) => {
    const id = await openTerm(page, 'Skill');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const form = editor(page);
    const definition = `${ORIGINAL_DEFINITION} Volunteers can offer skills or develop them.`;
    await form.getByLabel('Definition').fill(definition);
    await form.getByLabel('Also known as').fill('competence\n\ncompetence\nability');
    await form.getByLabel('Why this change? (optional)').fill('Say how skills relate to volunteers.');
    await expect(form.getByText('Changing: definition, also known as')).toBeVisible();
    await form.getByRole('button', { name: 'Propose change' }).click();

    const notice = page.getByRole('status').filter({ hasText: 'Proposed as' });
    await expect(notice).toContainText(/change request #\d+/);
    await expect(notice).toContainText('patch');
    await expect(notice).toContainText('In review');
    // The working draft is untouched until the change request is approved and merged.
    await expect(page.getByText(ORIGINAL_DEFINITION, { exact: true })).toBeVisible();

    await notice.getByRole('link', { name: /change request #/ }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${id}/changes/`));
    await settle(page);
    await expect(page.getByRole('heading', { name: 'Edit the definition and alternative labels of “skill”' })).toBeVisible();
    await expect(page.getByText('Edited on the term page')).toBeVisible();
    await expect(page.getByText('Say how skills relate to volunteers.')).toBeVisible();
    await expectNoCrash(page);

    // "view term" goes back to the term, which now lists the open request in its editor.
    await page.getByRole('link', { name: 'view term' }).click();
    await settle(page);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(editor(page).getByText('Already proposed for this term:')).toBeVisible();
    await expect(editor(page).getByRole('link', { name: /Edit the definition and alternative labels of “skill”/ })).toBeVisible();
  });

  test('guards the label, warns before removing a definition, and saves drafts', async ({ page }) => {
    await openTerm(page, 'TimeCommitment');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const form = editor(page);

    await form.getByLabel('Label').fill('');
    await expect(form.getByText('A term needs a label.')).toBeVisible();
    await expect(form.getByRole('button', { name: 'Propose change' })).toBeDisabled();
    await form.getByLabel('Label').fill('time commitment');

    await form.getByLabel('Definition').fill('');
    await expect(form.getByText(/Removing the definition of an existing term is a/)).toBeVisible();
    await form.getByRole('button', { name: 'Save as draft' }).click();

    const notice = page.getByRole('status').filter({ hasText: 'Saved as draft' });
    await expect(notice).toContainText(/change request #\d+/);
    await expect(notice).toContainText('major');
    await expect(notice).toContainText('Submit it for review');
    await notice.getByRole('button', { name: 'Dismiss' }).click();
    await expect(notice).toHaveCount(0);
    await expectNoCrash(page);
  });
});
