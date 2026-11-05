import { test, expect, demoOntology, expectNoCrash, settle, signInAsPersona, uniq, type Page } from './fixtures';

/**
 * The change request lifecycle, driven through the UI by the people whose role allows each
 * step: draft (editor) → submit → review (approvers) → approved → merge (editor or steward).
 * Also: reporting a bug, asking the AI to revise, requesting changes and resubmitting,
 * withdrawing, and the role rules that stop the wrong person acting.
 */

async function newChangeRequest(page: Page, ontologyId: string, { title, ask, why = 'Coordinators plan rotas in shifts.' }: { title: string; ask: string; why?: string }) {
  await page.goto(`/o/${ontologyId}/changes`);
  await page.getByRole('button', { name: 'New change request' }).click();
  const d = page.getByRole('dialog', { name: 'New change request' });
  await expect(d.getByRole('button', { name: 'Create and draft changes' })).toBeDisabled();
  await d.getByLabel('Title').fill(title);
  await d.getByLabel('Why is this needed?').fill(why);
  await d.getByLabel('Describe the change in plain language').fill(ask);
  await d.getByRole('button', { name: 'Create and draft changes' }).click();
  await expect(page).toHaveURL(/\/changes\/cr_[^/?]+$/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { level: 2, name: new RegExp(title) })).toBeVisible();
  return page.url();
}

const actions = (page: Page) => page.getByRole('group', { name: 'Your actions' });
const status = (page: Page) => page.getByRole('button', { name: /^Status: / });

test.describe('change requests', () => {
  test('an editor drafts a change from plain language; once approved it merges automatically', async ({ page, request }) => {
    const demo = await demoOntology(request);
    const name = `Shift${uniq()}`;
    const title = `Model volunteer shifts ${name}`;

    // 1. Tom (editor) drafts it. The offline assistant turns the sentence into an "add class" edit.
    await signInAsPersona(page, 'Tom Okafor');
    const url = await newChangeRequest(page, demo.id, { title, ask: `Add a class ${name} as a subclass of Session.` });
    await expect(status(page)).toContainText('Draft');
    await expect(page.getByRole('tab', { name: /^Changes 1/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Proposed changes (1)' })).toBeVisible();
    await expect(page.getByRole('tabpanel').getByText(name.toLowerCase()).first()).toBeVisible();
    // The triples view shows the RDF being added.
    await page.getByRole('button', { name: 'Triples' }).click();
    await expect(page.getByRole('tabpanel').getByText(new RegExp(name)).first()).toBeVisible();
    await page.getByRole('button', { name: 'Readable' }).click();

    // 2. Submitted, it is classified and validated.
    await actions(page).getByRole('button', { name: 'Submit for review' }).click();
    await expect(status(page)).toContainText('In review');
    await expect(page.getByRole('button', { name: /^Level: / })).toBeVisible();
    await page.getByRole('tab', { name: /^Checks/ }).click();
    await expect(page.getByRole('tab', { name: /^Checks/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Validation' })).toBeVisible();
    await expect(page).toHaveURL(/view=checks/);

    // The author's own approval doesn't count, so Tom isn't offered a merge.
    await expect(actions(page).getByRole('button', { name: 'Merge into working draft' })).toHaveCount(0);

    // 3. Approvers approve, with a comment that appears in the discussion.
    for (const who of ['Priya Shah', 'Mei Chen']) {
      await signInAsPersona(page, who);
      await page.goto(url);
      await actions(page).getByRole('textbox').fill(`Looks right to me. (${who})`);
      await actions(page).getByRole('button', { name: 'Approve' }).click();
      await expect(actions(page).getByText('You previously chose “approve”.').or(actions(page).getByRole('button', { name: 'Merge into working draft' }))).toBeVisible();
    }

    // Two approvals are in, but the review period still has to run.
    await page.goto(url);
    await expect(status(page)).toContainText('In review');
    await expect(page.getByRole('button', { name: /^Approval details 2 of 2 approvals · review ends in/ })).toBeVisible();
    // Fast-forward the simulated clock past it: the default policy merges approved changes automatically.
    const r = await page.request.post('/api/simulation/clock', { data: { advanceDays: 8 } });
    expect(r.ok(), await r.text()).toBeTruthy();
    await page.reload();
    await expect(status(page)).toContainText('Merged');
    await expect(page.getByText(/No actions — this request is merged/)).toBeVisible();
    await page.getByRole('tab', { name: /^Discussion/ }).click();
    // Each comment shows once, with the reviewer's decision.
    await expect(page.getByText('Looks right to me. (Mei Chen)')).toHaveCount(1);
    await expect(page.getByText('Approved', { exact: true })).toHaveCount(2);

    // The list shows it under Merged, and the new class is in the working draft.
    await page.goto(`/o/${demo.id}/changes?status=merged`);
    await expect(page.getByRole('link', { name: new RegExp(title) })).toBeVisible();
    const search = await page.request.get(`/api/ontologies/${demo.id}/search?q=${name}`);
    expect(search.ok()).toBeTruthy();
    expect(JSON.stringify(await search.json()).toLowerCase()).toContain(name.toLowerCase());
  });

  test('a reviewer requests changes, the author asks the AI to revise and resubmits', async ({ page, request }) => {
    const demo = await demoOntology(request);
    const name = `Rota${uniq()}`;
    await signInAsPersona(page, 'Tom Okafor');
    const url = await newChangeRequest(page, demo.id, { title: `Add rotas ${name}`, ask: `Add a class ${name} as a subclass of Session.` });
    await actions(page).getByRole('button', { name: 'Submit for review' }).click();
    await expect(status(page)).toContainText('In review');

    await signInAsPersona(page, 'Priya Shah');
    await page.goto(url);
    // A comment needs text before it can be sent.
    await expect(actions(page).getByRole('button', { name: 'Comment' })).toBeDisabled();
    await actions(page).getByRole('textbox').fill('Please add a definition that mentions the location.');
    await actions(page).getByRole('button', { name: 'Request changes' }).click();
    await expect(status(page)).toContainText('Needs work');
    await expect(page.getByText('Sent back for more work: revise and resubmit.')).toBeVisible();

    await signInAsPersona(page, 'Tom Okafor');
    await page.goto(url);
    await actions(page).getByRole('button', { name: 'Ask AI to revise' }).click();
    const d = page.getByRole('dialog', { name: 'Ask the AI to revise the proposed changes' });
    await expect(d.getByRole('button', { name: 'Revise' })).toBeDisabled();
    // The reviewer's feedback is offered as the instruction.
    await d.getByRole('button', { name: /Please add a definition that mentions the location\..*use this/ }).click();
    await expect(d.getByRole('textbox')).toHaveValue('Please add a definition that mentions the location.');
    await d.getByRole('button', { name: 'Revise' }).click();
    await expect(d).toHaveCount(0, { timeout: 30_000 });
    // A revision is re-classified, re-validated and goes straight back to review.
    await expect(status(page)).toContainText('In review');
    await page.getByRole('tab', { name: /^Discussion/ }).click();
    await expect(page.getByText('Requested changes', { exact: true })).toBeVisible();
    await expect(page.getByText(/AI revision requested by Tom Okafor/)).toBeVisible();

    // Reviewers' earlier approvals no longer count once the edits change.
    await expect(page.getByText(/updated the proposed edits \(earlier approvals no longer count\)/)).toBeVisible();
  });

  test('the author can withdraw a request, and nobody can act on it after', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signInAsPersona(page, 'Tom Okafor');
    await newChangeRequest(page, demo.id, { title: `Withdraw me ${uniq()}`, ask: `Add a class Withdrawn${uniq()}.` });
    page.once('dialog', (d) => void d.accept());
    await actions(page).getByRole('button', { name: 'Withdraw' }).click();
    await expect(status(page)).toContainText('Withdrawn');
    await expect(page.getByText(/No actions — this request is withdrawn/)).toBeVisible();
  });

  test('a contributor can comment and object, but not merge, withdraw others’ requests or submit them', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signInAsPersona(page, 'Tom Okafor');
    const url = await newChangeRequest(page, demo.id, { title: `Contributor rules ${uniq()}`, ask: `Add a class Rules${uniq()}.` });

    await signInAsPersona(page, 'Aisha Rahman');
    await page.goto(url);
    // Aisha is not the author and not an editor: no submit, no withdraw.
    await expect(actions(page).getByRole('button', { name: 'Submit for review' })).toHaveCount(0);
    await expect(actions(page).getByRole('button', { name: 'Withdraw' })).toHaveCount(0);

    await signInAsPersona(page, 'Tom Okafor');
    await page.goto(url);
    await actions(page).getByRole('button', { name: 'Submit for review' }).click();
    await expect(status(page)).toContainText('In review');

    await signInAsPersona(page, 'Aisha Rahman');
    await page.goto(url);
    await actions(page).getByRole('button', { name: 'Approve' }).click();
    // Her approval is recorded, but she is told it doesn't count towards the threshold.
    await expect(actions(page).getByText(/Your approval is recorded but only .* approvals count/)).toBeVisible();
    await actions(page).getByRole('textbox').fill('Coordinators call these "slots".');
    await actions(page).getByRole('button', { name: 'Comment' }).click();
    await page.getByRole('tab', { name: /^Discussion/ }).click();
    // Shown once, as her comment (it used to appear a second time in the timeline).
    await expect(page.getByText('Coordinators call these "slots".')).toHaveCount(1);
    await expect(page.getByText('Commented', { exact: true })).toBeVisible();
  });

  test('anyone can report a bug, and it becomes a change request', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signInAsPersona(page, 'Gareth Lewis');
    await page.goto(`/o/${demo.id}/changes`);
    await page.getByRole('button', { name: 'Report a bug' }).click();
    const d = page.getByRole('dialog', { name: 'Report a bug' });
    await expect(d.getByRole('button', { name: 'Submit report' })).toBeDisabled();
    const title = `Missing range on start date ${uniq()}`;
    await d.getByLabel('Short title').fill(title);
    await d.getByLabel('What’s the problem?').fill('hasStartDate has no range, so our importer guesses xsd:string.');
    await d.getByRole('button', { name: 'Submit report' }).click();
    await expect(page).toHaveURL(/\/changes\/cr_[^/?]+$/, { timeout: 30_000 });
    await settle(page);
    await expectNoCrash(page);
    await expect(page.getByRole('heading', { level: 2, name: new RegExp(title) })).toBeVisible();
    await expect(page.getByText('Bug', { exact: true }).first()).toBeVisible();
  });

  test('typing in a dialog stays in the field you are typing in when the page behind it reloads', async ({ page, request }) => {
    // Used to go wrong: the dialog moved focus back to its first field whenever the page behind it re-rendered
    // (its onClose prop is a new function each render), so text typed into "Describe the change" landed in
    // Title once the change request list finished loading. Slow backends made the governance e2e flaky.
    const demo = await demoOntology(request);
    await signInAsPersona(page, 'Tom Okafor');
    let release!: () => void;
    const listHeld = new Promise<void>((r) => (release = r));
    await page.route(/\/api\/ontologies\/[^/]+\/change-requests(\?|$)/, async (route) => {
      await listHeld;
      await route.continue();
    });
    await page.goto(`/o/${demo.id}/changes`);
    await page.getByRole('button', { name: 'New change request' }).click();
    const d = page.getByRole('dialog', { name: 'New change request' });
    await expect(d.getByLabel('Title')).toBeFocused();
    const describe = d.getByLabel('Describe the change in plain language');
    await describe.click();
    await page.keyboard.type('Add a class ');
    await expect(page.getByText('Loading…')).toBeVisible(); // The list behind the dialog is still loading.
    release();
    await expect(page.getByText('Loading…')).toHaveCount(0);
    await page.keyboard.type('Shift.');
    await expect(describe).toBeFocused();
    await expect(describe).toHaveValue('Add a class Shift.');
    await expect(d.getByLabel('Title')).toHaveValue('');
  });

  test('the dialogs can be cancelled and closed with Escape', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signInAsPersona(page, 'Tom Okafor');
    await page.goto(`/o/${demo.id}/changes`);
    await page.getByRole('button', { name: 'New change request' }).click();
    await expect(page.getByRole('dialog', { name: 'New change request' })).toBeVisible();
    // Focus starts in the first field.
    await expect(page.getByRole('dialog').getByLabel('Title')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Report a bug' }).click();
    await page.getByRole('dialog', { name: 'Report a bug' }).getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});
