import { test, expect, signIn, signInAsPersona, demoOntology, type Page } from './fixtures';

/**
 * Turtle on Validate data (this used to be Query's "Check data" workspace): the data is
 * checked as you type, problems read as sentences written with the data's own prefixes, are
 * underlined in the editor with a hover popup, and clicking one selects the place it's about.
 * A syntax error is underlined as you type, and Format tidies the layout without losing comments.
 *
 * CodeMirror draws underlines and popups as plain elements with no ARIA role,
 * so those few assertions use its class names (.cm-lintRange-*, .cm-tooltip-lint).
 * Everything a person clicks is found by role.
 */

const VOL = 'https://w3id.org/odi/volunteering#';

async function openValidate(page: Page, id: string, query = '') {
  await page.goto(`/o/${id}/validate${query}`);
  // The sample data is there to start with, and is checked straight away.
  await expect(page.getByTestId('validate-status')).toHaveText(/^Checked in/, { timeout: 30_000 });
}

async function setData(page: Page, text: string) {
  await page.getByTestId('validate-editor').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
}

/** Waits for the check of the data as it is now. */
const checked = (page: Page) => expect(page.getByTestId('validate-status')).toHaveText(/^Checked in/);
const selection = (page: Page) => page.evaluate(() => document.getSelection()?.toString() ?? '');
const problems = (page: Page) => page.getByRole('list', { name: /^Problems found/ });
const editor = (page: Page) => page.getByTestId('validate-editor');

test.describe('Validate data: Turtle', () => {
  let id: string;
  test.beforeEach(async ({ request }) => {
    ({ id } = await demoOntology(request));
  });

  test('problems read as sentences, are underlined, and clicking one jumps to it', async ({ page }) => {
    await signIn(page, { name: 'E2E check', role: 'editor' });
    // Against the working draft, so the test can hold a re-check (each one downloads the draft again).
    await openValidate(page, id, '?version=draft');
    await setData(
      page,
      `@prefix vol: <${VOL}> .
@prefix ex: <https://example.org/data/> .

ex:foodbank a vol:VolunteerInvolvingOrganisation .

ex:saturday-shift a vol:VolunteeringOpportunity ;
  vol:title "Saturday food bank shift" ;
  vol:offeredBy ex:foodbank ;
  vol:hasRole ex:helper ;
  vol:minimumAge "sixteen" .

ex:helper a vol:Role .
`,
    );
    await checked(page);
    const list = problems(page);
    await expect(list.getByRole('button', { name: /ex:foodbank requires at least 1 vol:offersOpportunity, 0 found/ })).toBeVisible();
    // The numbers stand out: required and found are bold.
    await expect(list.getByRole('button', { name: /ex:foodbank requires/ }).locator('strong')).toHaveText(['1', '0']);
    const age = list.getByRole('button', { name: /Value "sixteen" is of type xsd:string but must be of type xsd:nonNegativeInteger/ });
    await expect(age).toContainText('Line 10');
    await expect(age).toContainText('Write it as "16"^^xsd:nonNegativeInteger');

    // Each problem is underlined where it is; hovering shows the same sentence.
    const squiggle = editor(page).locator('.cm-lintRange-error', { hasText: '"sixteen"' });
    await expect(squiggle).toHaveCount(1);
    await expect(editor(page).locator('.cm-lintRange-error', { hasText: 'ex:foodbank' })).toHaveCount(1);
    await squiggle.hover();
    await expect(page.locator('.cm-tooltip-lint')).toContainText('Value "sixteen" is of type xsd:string but must be of type xsd:nonNegativeInteger');

    // Clicking a problem selects the value in the editor.
    await age.click();
    await expect.poll(() => selection(page)).toBe('"sixteen"');
    await list.getByRole('button', { name: /ex:foodbank requires/ }).click();
    await expect.poll(() => selection(page)).toBe('ex:foodbank');

    // Used to go wrong: after an edit, the old report's underline moved onto the record's name.
    // Now an out-of-date report underlines nothing and its items can't be jumped to until the new check is in.
    // Hold the re-check by holding its download of the draft.
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const draftSource = /\/api\/ontologies\/[^/]+\/source\?.*ref=working/;
    // Used to fail now and then on a busy machine with "Route is already handled!": unroute ran
    // before the released handler had continued its request, and so let the request through
    // itself. Now the test waits for every held request to be continued before unrouting.
    const continued: Promise<void>[] = [];
    await page.route(draftSource, (route) => {
      const done = held.then(() => route.continue());
      continued.push(done);
      return done;
    });
    await setData(page, (await editor(page).innerText()).replace('"sixteen"', '16'));
    await expect(page.getByTestId('validation-report')).toHaveAttribute('aria-busy', 'true');
    await expect(editor(page).locator('.cm-lintRange-error')).toHaveCount(0);
    await expect(list.getByRole('button')).toHaveCount(0);
    release();
    await Promise.all(continued);
    await page.unroute(draftSource);
    await setData(page, (await editor(page).innerText()).replace(/vol:minimumAge 16/, 'vol:minimumAge "16"^^<http://www.w3.org/2001/XMLSchema#nonNegativeInteger>'));
    await checked(page);
    await expect(list.getByRole('button', { name: /ex:foodbank requires/ })).toBeVisible();
    await expect(list.getByRole('button', { name: /sixteen/ })).toHaveCount(0);
  });

  // Used to go wrong: fixing a value in place left its old underline on the new text
  // until typing paused for the re-check, so "16" still read as "must be of type …".
  test('an edit clears the underline it touches at once, and leaves the others', async ({ page }) => {
    await signIn(page, { name: 'E2E check edit', role: 'editor' });
    await openValidate(page, id);
    await setData(page, `@prefix vol: <${VOL}> .\n@prefix ex: <https://example.org/data/> .\n\nex:foodbank a vol:VolunteerInvolvingOrganisation .\n\nex:shift a vol:VolunteeringOpportunity ;\n  vol:title "Shift" ;\n  vol:offeredBy ex:foodbank ;\n  vol:minimumAge "sixteen" .\n`);
    await checked(page);
    await expect(editor(page).locator('.cm-lintRange-error', { hasText: '"sixteen"' })).toHaveCount(1);
    await problems(page).getByRole('button', { name: /Value "sixteen"/ }).click();
    await expect.poll(() => selection(page)).toBe('"sixteen"');
    // Type over the value and look straight away, before the new check is in.
    const underlined = await page.evaluate(async () => {
      document.execCommand('insertText', false, '16');
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return [...document.querySelectorAll('[data-testid="validate-editor"] .cm-lintRange-error')].map((e) => e.textContent);
    });
    expect(underlined).not.toContain('16');
    expect(underlined).toContain('ex:foodbank');
  });

  // Used to go wrong: a problem about an anonymous [ … ] record said "Not in your data", as if it wasn't real.
  test('a problem with no place in the text says why', async ({ page }) => {
    await signIn(page, { name: 'E2E check anon', role: 'editor' });
    await openValidate(page, id);
    await setData(page, `@prefix vol: <${VOL}> .\n\n[] a vol:VolunteerInvolvingOrganisation .\n`);
    await checked(page);
    const item = problems(page).getByRole('listitem').filter({ hasText: /requires at least 1 vol:offersOpportunity/ });
    await expect(item).toContainText('Location unavailable');
    await expect(item).toContainText('anonymous record');
    await expect(item.getByRole('button')).toHaveCount(0);
  });

  // Used to go wrong: "Show all" rendered every problem at once (10,000 rows froze the page for over a second)
  // and stayed expanded. Now long lists are paged, 50 at a time.
  test('a long list of problems is shown a page at a time', async ({ page }) => {
    await signIn(page, { name: 'E2E check pages', role: 'editor' });
    await openValidate(page, id);
    const records = Array.from({ length: 60 }, (_, i) => `ex:org${i} a vol:VolunteerInvolvingOrganisation .`).join('\n');
    await setData(page, `@prefix vol: <${VOL}> .\n@prefix ex: <https://example.org/data/> .\n\n${records}\n`);
    await checked(page);
    const list = problems(page);
    await expect(list.getByRole('listitem')).toHaveCount(50);
    const pages = page.getByRole('navigation', { name: 'Pages of problems found' });
    await expect(pages).toContainText('1–50 of 60');
    await expect(pages.getByRole('button', { name: 'Previous' })).toBeDisabled();
    // Used to go wrong: focus stayed on Next and nothing said what changed, so Tab skipped the new results.
    await pages.getByRole('button', { name: 'Next' }).press('Enter');
    await expect(list.getByRole('listitem')).toHaveCount(10);
    await expect(list).toBeFocused();
    await expect(list).toHaveAccessibleName('Problems found, 51–60 of 60');
    await page.keyboard.press('Tab');
    await expect(list.getByRole('button').first()).toBeFocused();
    await expect(pages).toContainText('51–60 of 60');
    await expect(pages.getByRole('button', { name: 'Next' })).toBeDisabled();
    // The items on later pages still jump to their place.
    await list.getByRole('button', { name: /ex:org\d+ requires/ }).first().click();
    await expect.poll(() => selection(page)).toMatch(/^ex:org\d+$/);

    // Used to go wrong: after paging and editing, an old page came back (60 problems opened at 51–60 instead of 1–50).
    await setData(page, `@prefix vol: <${VOL}> .\n@prefix ex: <https://example.org/data/> .\n\n${records.split('\n').slice(0, 12).join('\n')}\n`);
    await checked(page);
    await expect(list.getByRole('listitem')).toHaveCount(12);
    await expect(pages).toHaveCount(0);
    await setData(page, `@prefix vol: <${VOL}> .\n@prefix ex: <https://example.org/data/> .\n\n${records}\n`);
    await checked(page);
    await expect(pages).toContainText('1–50 of 60');
  });

  // Used to go wrong: problems showed full <https://…> IRIs because sparq wraps IRIs in
  // angle brackets, which the prefix lookup never matched, and it only knew the ontology's prefixes.
  test('problems use the prefixes the data declares', async ({ page }) => {
    await signIn(page, { name: 'E2E check prefixes', role: 'editor' });
    await openValidate(page, id);
    await setData(page, `@prefix v: <${VOL}> .\n@prefix org: <https://example.org/orgs/> .\n\norg:northvale a v:VolunteerInvolvingOrganisation .\n`);
    await checked(page);
    await expect(problems(page).getByRole('button', { name: /org:northvale requires at least 1 v:offersOpportunity, 0 found/ })).toBeVisible();
    await expect(page.getByTestId('validation-results')).not.toContainText('https://');
  });

  test('a misspelt term is underlined and listed with its line, and a syntax error as you type', async ({ page }) => {
    await signIn(page, { name: 'E2E check lint', role: 'editor' });
    await openValidate(page, id);
    await setData(page, `@prefix vol: <${VOL}> .\n@prefix ex: <https://example.org/data/> .\n\nex:shift a vol:VolunteeringOpportunity ;\n  vol:titel "Park clean-up" .\n`);
    await checked(page);
    const typo = page.getByTestId('validation-terms').getByRole('button', { name: /vol:titel is used as a property but is not defined in the ontology\. Did you mean vol:title\?/ });
    await expect(typo).toContainText('Line 5');
    await expect(editor(page).locator('.cm-lintRange-error', { hasText: 'vol:titel' })).toHaveCount(1);
    await typo.click();
    await expect.poll(() => selection(page)).toBe('vol:titel');

    // A missing full stop: sparq's error, placed where it happened, and not repeated as the check's error.
    await setData(page, `@prefix vol: <${VOL}> .\n@prefix ex: <https://example.org/data/> .\n\nex:a a vol:Role\nex:b a vol:Role .\n`);
    const lint = page.getByRole('list', { name: 'Problems in the Turtle' });
    const syntax = lint.getByRole('button', { name: /Syntax error: Expected '\.'/ });
    await expect(syntax).toContainText('Line 5');
    await expect(editor(page).locator('.cm-lintRange-error', { hasText: 'ex:b' })).toHaveCount(1);
    await expect(page.getByRole('alert').filter({ hasText: 'Could not parse' })).toHaveCount(0);
    // Format won't rearrange a document it can't read.
    await expect(page.getByRole('button', { name: 'Format', exact: true })).toBeDisabled();
    // Screen readers hear a short summary once typing settles.
    await expect(page.getByTestId('lint-announcement')).toHaveText('A syntax error in the Turtle, shown below the editor.');
  });

  // Used to go wrong: an out-of-range escape threw while rendering and took the page down.
  test('an invalid character escape is a syntax error, not a crash', async ({ page }) => {
    await signIn(page, { name: 'E2E check escape', role: 'editor' });
    await openValidate(page, id);
    await setData(page, `@prefix vol: <${VOL}> .\n@prefix ex: <https://example.org/data/> .\n\nex:a a vol:Role ; vol:title "\\UFFFFFFFF" .\n`);
    const lint = page.getByRole('list', { name: 'Problems in the Turtle' });
    await expect(lint.getByRole('button', { name: /Syntax error/ })).toContainText('Line 4');
    await expect(editor(page)).toBeVisible();
  });

  test('Format tidies the layout and keeps prefixes and comments', async ({ page }) => {
    await signIn(page, { name: 'E2E check format', role: 'editor' });
    await openValidate(page, id);
    await setData(page, `@prefix vol: <${VOL}> . @prefix ex: <https://example.org/data/> .\n# The food bank\nex:foodbank a vol:VolunteerInvolvingOrganisation;vol:offersOpportunity ex:shift,ex:other .`);
    await page.getByRole('button', { name: 'Format', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Tidied the layout' })).toBeVisible();
    await expect(editor(page)).toHaveText(
      [
        `@prefix vol: <${VOL}> .`,
        '@prefix ex: <https://example.org/data/> .',
        '',
        '# The food bank',
        'ex:foodbank a vol:VolunteerInvolvingOrganisation ;',
        '  vol:offersOpportunity ex:shift, ex:other .',
      ].join(''),
    );
    // Undo puts the original back.
    await editor(page).click();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(editor(page)).toContainText('VolunteerInvolvingOrganisation;vol:offersOpportunity');
  });

  test('the ontology’s terms autocomplete in the editor', async ({ page }) => {
    await signIn(page, { name: 'E2E check complete', role: 'editor' });
    await openValidate(page, id);
    await setData(page, `@prefix vol: <${VOL}> .\n@prefix ex: <https://example.org/data/> .\n\nex:shift a vol:VolunteeringOpp`);
    await page.keyboard.press('Control+Space');
    await page.getByRole('option', { name: /vol:VolunteeringOpportunity/ }).first().click();
    await expect(editor(page)).toContainText('ex:shift a vol:VolunteeringOpportunity');
  });

  test('a contributor can check data too', async ({ page }) => {
    await signInAsPersona(page, 'Aisha Rahman');
    await openValidate(page, id);
    await setData(page, `@prefix vol: <${VOL}> .\n@prefix ex: <https://example.org/data/> .\n\nex:r a vol:Role .\n`);
    await checked(page);
    await expect(page.getByTestId('validation-verdict')).toContainText('Conforms to the shapes');
  });

  test('signed out, Validate data sends you to sign in', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto(`/o/${id}/validate`);
    await expect(page).toHaveURL(/\/login/);
    await expect(editor(page)).toHaveCount(0);
  });
});
