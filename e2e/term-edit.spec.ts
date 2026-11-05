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
const classItem = (page: Page, name: string) => page.getByRole('tree', { name: /Classes/ }).getByRole('treeitem', { name: new RegExp(`^${name}\\b`) }).first();

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
    await expect(form.getByLabel(/^Label( changed)?$/)).toHaveValue('skill');
    await expect(form.getByLabel('Definition')).toHaveValue(ORIGINAL_DEFINITION);
    // Focus moves into the form.
    await expect(form.getByLabel(/^Label( changed)?$/)).toBeFocused();
    for (const f of ['Comment', 'Editorial note']) await expect(form.getByLabel(f)).toHaveValue('');
    await expect(form.getByRole('group', { name: 'Also known as' }).getByRole('textbox')).toHaveCount(0);
    await expect(form.getByRole('group', { name: 'Examples' }).getByRole('textbox')).toHaveCount(0);
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
    // Focus goes back to the Edit button.
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeFocused();
    await expectNoCrash(page);
  });

  test('proposing an edit opens a change request and leaves the term unchanged until it merges', async ({ page }) => {
    const id = await openTerm(page, 'Skill');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const form = editor(page);
    const definition = `${ORIGINAL_DEFINITION} Volunteers can offer skills or develop them.`;
    await form.getByLabel('Definition').fill(definition);
    // Rewording a definition needs an explicit answer about its meaning before it can be proposed.
    await expect(form.getByText('Say whether the new definition keeps the meaning')).toBeVisible();
    await expect(form.getByRole('button', { name: 'Propose change' })).toBeDisabled();
    await form.getByRole('radio', { name: /Yes, it is clearer wording/ }).check();
    for (const [i, v] of ['competence', 'competence', 'ability'].entries()) {
      await form.getByRole('button', { name: /^Add (another )?alternative label$/ }).click();
      await expect(form.getByLabel(`alternative label ${i + 1}`, { exact: true })).toBeFocused();
      await form.getByLabel(`alternative label ${i + 1}`, { exact: true }).fill(v);
    }
    await form.getByRole('button', { name: 'Remove alternative label 2' }).click();
    await form.getByLabel('Why this change? (optional)').fill('Say how skills relate to volunteers.');
    await expect(form.getByText('Changing: definition, also known as')).toBeVisible();
    await form.getByRole('button', { name: 'Propose change' }).click();

    const notice = page.getByRole('status').filter({ hasText: 'Proposed as' });
    await expect(notice).toContainText(/change request #\d+/);
    // Keyboard focus lands on the result.
    await expect(notice.getByRole('link', { name: /change request #/ })).toBeFocused();
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

    await form.getByLabel(/^Label( changed)?$/).fill('');
    await expect(form.getByText('A term needs a label.')).toBeVisible();
    await expect(form.getByRole('button', { name: 'Propose change' })).toBeDisabled();
    await form.getByLabel(/^Label( changed)?$/).fill('time commitment');

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

  test('a definition that changes meaning is flagged as major, and multi-line examples keep their line breaks', async ({ page }) => {
    await openTerm(page, 'Location');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const form = editor(page);
    await form.getByLabel('Definition').fill('A building that a volunteering organisation owns.');
    await form.getByRole('radio', { name: /No, it changes what the term means/ }).check();
    await expect(form.getByText(/Changing what a term means is a/)).toBeVisible();
    await form.getByRole('button', { name: 'Add example' }).click();
    await form.getByLabel('example 1', { exact: true }).fill('The community hall\non Station Road');
    await form.getByRole('button', { name: 'Save as draft' }).click();

    const notice = page.getByRole('status').filter({ hasText: 'Saved as draft' });
    await expect(notice).toContainText('major');
    const res = await page.request.get(`/api/change-requests/${(await notice.getByRole('link').getAttribute('href'))!.split('/').pop()}`);
    const cr = await res.json();
    expect(cr.ops[0].set.examples).toEqual(['The community hall\non Station Road']);
    expect(cr.ops[0].expect.examples).toEqual([]);
    expect(cr.classification.reasons.map((r: { rule: string }) => r.rule)).toContain('meaning-changed');
  });

  test('switching terms closes the editor, and Edit waits for the selected term to load', async ({ page }) => {
    const id = await openTerm(page, 'Skill');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(editor(page)).toBeVisible();
    // Hold the next term's response so we can act while it loads.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route('**/api/ontologies/*/terms/**', async (route) => {
      await held;
      await route.continue();
    });
    await classItem(page, 'time commitment').click();
    await expect(editor(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeDisabled();
    release();
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(editor(page).getByRole('heading', { name: 'Edit “time commitment”' })).toBeVisible();
    await expect(editor(page).getByLabel(/^Label( changed)?$/)).toHaveValue('time commitment');
    expect(page.url()).toContain(`/o/${id}/browse`);
  });

  test('a conflicting change is refused; loading the latest keeps your edits, refreshes the rest and asks about overlaps', async ({ page, consoleGuard }) => {
    consoleGuard.allow(/status of 409/);
    // Pretend someone else changed the label and comment after this page loaded
    // the term: the first response the editor sees carries out-of-date values.
    let stale = true;
    let hold: Promise<void> | undefined;
    await page.route('**/api/ontologies/*/terms/**', async (route) => {
      if (hold) await hold;
      if (!stale) return route.continue();
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { ...body, label: 'old session label', comment: 'An older comment that has since been replaced.' } });
    });
    await openTerm(page, 'Session');
    stale = false;
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const form = editor(page);
    await expect(form.getByLabel(/^Label( changed)?$/)).toHaveValue('old session label');
    await form.getByLabel('Comment').fill('Sessions can repeat weekly.');
    await form.getByRole('button', { name: 'Propose change' }).click();
    await expect(form.getByRole('alert')).toContainText('changed since you opened the editor');
    // Hold the refresh so we can keep typing while it loads: that text must survive.
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    await form.getByRole('button', { name: 'Load the latest values (keeps your text)' }).click();
    await form.getByLabel('Editorial note').fill('Typed while loading.');
    release();

    const status = form.getByRole('status');
    await expect(status).toContainText('Someone else changed');
    // The label, which you didn't touch, now shows the latest value rather than reverting it.
    await expect(form.getByLabel(/^Label( changed)?$/)).toHaveValue('session');
    // The comment was changed by both: keep yours or take theirs before saving.
    await expect(form.getByLabel('Comment')).toHaveValue('Sessions can repeat weekly.');
    await expect(status).toContainText('You changed this too.');
    await expect(form.getByText('Choose yours or theirs for: comment')).toBeVisible();
    await expect(form.getByRole('button', { name: 'Propose change' })).toBeDisabled();
    await status.getByRole('button', { name: 'Keep mine' }).click();
    await expect(form.getByLabel('Editorial note')).toHaveValue('Typed while loading.');
    await expect(form.getByText('Changing: comment, editorial note')).toBeVisible();
    await form.getByRole('button', { name: 'Propose change' }).click();

    const notice = page.getByRole('status').filter({ hasText: 'Proposed as' });
    await expect(notice).toBeVisible();
    const crId = (await notice.getByRole('link').getAttribute('href'))!.split('/').pop();
    const cr = await (await page.request.get(`/api/change-requests/${crId}`)).json();
    expect(cr.ops[0].set).toEqual({ comment: 'Sessions can repeat weekly.', editorialNote: 'Typed while loading.' });
  });

  test('a save that finishes after you moved to another term leaves that term’s editor alone', async ({ page }) => {
    await openTerm(page, 'Skill');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await editor(page).getByLabel('Comment').fill('A slow save for skill.');
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let saved!: () => void;
    const done = new Promise<void>((r) => (saved = r));
    await page.route('**/api/ontologies/*/term-edits', async (route) => {
      await held;
      await route.continue();
      saved();
    });
    await editor(page).getByRole('button', { name: 'Save as draft' }).click();
    await classItem(page, 'time commitment').click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const form = editor(page);
    await expect(form.getByRole('heading', { name: 'Edit “time commitment”' })).toBeVisible();
    await form.getByLabel('Comment').fill('Still typing here.');
    release();
    await done;
    await page.waitForLoadState('networkidle');
    await expect(form.getByLabel('Comment')).toHaveValue('Still typing here.');
    await expect(page.getByRole('status').filter({ hasText: 'Saved as draft' })).toHaveCount(0);
  });
});
