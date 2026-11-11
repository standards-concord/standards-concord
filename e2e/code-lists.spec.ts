import { test, expect, settle, signIn, uniq } from './fixtures';
import type { APIResponse, Cookie, Locator, Page } from '@playwright/test';

/** Testers can't sign in again by id, so each person's session cookie is kept and put back. */
const sessions = new Map<string, Cookie>();
async function signInAs(page: Page, as: { name: string; role: string }) {
  const who = await signIn(page, as);
  const cookie = (await page.context().cookies()).find((c) => c.name === 'concord_session');
  expect(cookie, 'session cookie').toBeTruthy();
  sessions.set(who.user.id, cookie!);
  return who;
}
async function become(page: Page, userId: string) {
  await page.context().clearCookies({ name: 'concord_session' });
  await page.context().addCookies([sessions.get(userId)!]);
}

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()}: ${await response.text()}`).toBeTruthy();
  return response.json();
}
const notice = (page: Page) => page.getByRole('status').filter({ hasText: /Proposed as|Saved as draft/ });
const editForm = (page: Page) => page.getByRole('form', { name: /^Edit / });
async function proposedId(page: Page) {
  await expect(notice(page)).toBeVisible();
  return (await notice(page).getByRole('link', { name: /change request #/ }).getAttribute('href'))!.split('/').pop()!;
}
async function fillCode(form: Locator, number: number, label: string, code = '') {
  const row = form.getByRole('group', { name: `New code ${number}`, exact: true });
  await row.getByLabel('Label', { exact: true }).fill(label);
  await row.getByLabel('Definition', { exact: true }).fill(`An activity involving ${label}.`);
  if (code) await row.getByLabel(/^Code/).fill(code);
  return row;
}
async function approveAndMerge(page: Page, id: string) {
  const cr = await json(await page.request.get(`/api/change-requests/${id}`));
  const approved = await json(await page.request.post(`/api/change-requests/${id}/reviews`, { data: { decision: 'approve', round: cr.round ?? 1 } }));
  expect(approved.status).toBe('approved');
  const merged = await json(await page.request.post(`/api/change-requests/${id}/merge`));
  expect(merged.status).toBe('merged');
}

/** Fresh ontology: changing the policy here must never change the shared demo. */
async function setup(page: Page) {
  const owner = await signInAs(page, { name: `Code list steward ${uniq()}`, role: 'steward' });
  await page.goto('/');
  await page.getByRole('button', { name: 'New ontology' }).click();
  const dialog = page.getByRole('dialog', { name: 'New ontology' });
  const u = uniq();
  await dialog.getByLabel('Title').fill(`Activities ${u}`);
  await dialog.getByLabel('Prefix').fill(`cl${u}`.replace(/[^a-z0-9]/g, '').slice(0, 12));
  await dialog.getByLabel('Description').fill('Activity codes for community events.');
  await dialog.getByLabel('Domain').fill('community events');
  await dialog.getByLabel('Governance policy').selectOption({ label: 'Steward-led' });
  await dialog.getByRole('button', { name: 'Create ontology' }).click();
  await expect(page).toHaveURL(/\/o\/[^/]+$/);
  const id = page.url().split('/o/')[1];
  const project = await json(await page.request.get(`/api/ontologies/${id}`));
  const policy = structuredClone(project.governance);
  for (const level of ['patch', 'minor', 'major']) {
    Object.assign(policy.changes[level], { approverRoles: ['steward', 'owner'], minApprovals: 1, reviewPeriodDays: 0, autoMerge: false });
    delete policy.changes[level].vote;
  }
  Object.assign(policy.automation, { autoDraftRelease: false, appAutopilot: false });
  await json(await page.request.put(`/api/ontologies/${id}/governance`, { data: { policy } }));
  const contributor = await signInAs(page, { name: `Code list contributor ${uniq()}`, role: 'contributor' });
  const ns: string = project.namespace;
  const seed = await json(await page.request.post(`/api/ontologies/${id}/change-requests`, { data: {
    title: 'Add event terms', description: 'The classes and property used by these activities.', submit: true,
    ops: [
      { op: 'addClass', localName: 'Event', label: 'event', definition: 'An occurrence involving people.' },
      { op: 'addClass', localName: 'Activity', label: 'activity', definition: 'Something people do at an event.' },
      { op: 'addObjectProperty', localName: 'hasActivityType', label: 'has activity type', definition: 'The activity type of an event.', domain: [ns + 'Event'], range: [ns + 'Activity'] },
    ],
  } }));
  await become(page, owner.user.id);
  await approveAndMerge(page, seed.id);
  await become(page, contributor.user.id);
  return { id, ns, slug: project.slug, owner: owner.user.id, contributor: contributor.user.id };
}

test('codes are proposed, reviewed and merged, then used in Browse, data checks and the public page', async ({ page }) => {
  test.setTimeout(150_000);
  const { id, ns, slug, owner, contributor } = await setup(page);
  const listName = `Activity types ${uniq()}`;
  await page.goto(`/o/${id}/browse`);
  await page.getByRole('button', { name: 'New code list', exact: true }).click();
  await expect(page).toHaveURL(/new=code-list/);
  const form = page.getByRole('form', { name: 'New code list', exact: true });
  await expect(form.getByRole('button', { name: 'Propose change' })).toBeDisabled();
  await form.getByLabel('Name', { exact: true }).fill(listName);
  await form.getByLabel('Definition', { exact: true }).first().fill('Permitted activities for community events.');
  await form.getByLabel(/^Use\ for\ property/).selectOption({ label: 'has activity type' });
  await fillCode(form, 1, 'outdoor', 'OUT');
  await form.getByRole('button', { name: 'Add another code' }).click();
  await fillCode(form, 2, 'indoor', 'IN');
  await form.getByRole('button', { name: 'Add another code' }).click();
  const nested = await fillCode(form, 3, 'gardening', 'GARD');
  await nested.getByLabel(/^Parent/).selectOption({ label: 'outdoor' });
  await form.getByLabel('Why this change? (optional)').fill('Keep event data consistent.');
  await form.getByRole('button', { name: 'Propose change' }).click();
  const firstId = await proposedId(page);
  await expect(notice(page)).toContainText('Major');
  await expect(page.getByRole('button', { name: /^Code lists \(/ })).toHaveCount(0);
  await notice(page).getByRole('link', { name: /change request #/ }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`Create the code list “${listName}”$`) })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Level: major/ })).toBeVisible();
  await expect(page.getByText(/Your approval is recorded but only/)).toBeVisible();
  await page.getByRole('group', { name: 'Your actions' }).getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Status: In review/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Merge into working draft' })).toHaveCount(0);
  await expect(page.getByText(`In “${listName}”, under “outdoor”`, { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Diff', exact: true }).click();
  await expect(page.getByText('skos:ConceptScheme', { exact: false }).first()).toBeVisible();

  // First approval and merge are driven through the UI.
  await become(page, owner);
  await page.goto(`/o/${id}/changes/${firstId}`);
  const actions = page.getByRole('group', { name: 'Your actions' });
  await actions.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Status: Approved/ })).toBeVisible();
  await actions.getByRole('button', { name: 'Merge into working draft' }).click();
  await expect(page.getByRole('button', { name: /^Status: Merged/ })).toBeVisible();
  const mergedView = await json(await page.request.get(`/api/ontologies/${id}/view`));
  const scheme = mergedView.conceptSchemes.find((s: { label: string }) => s.label === listName);
  const listUrl = `/o/${id}/browse?term=${encodeURIComponent(scheme.iri)}`;
  await page.goto(listUrl);
  await expect(page.getByRole('button', { name: new RegExp(`${listName}.*\\(3\\)`) })).toBeVisible();
  const codes = page.getByRole('list', { name: `Codes in ${listName}` });
  await expect(codes).toBeVisible();
  await expect(codes.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'outdoor', exact: true }) }).getByRole('list').getByRole('button', { name: 'gardening', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'has activity type', exact: true }).first().click();
  await expect(page.getByRole('definition').filter({ hasText: 'Codes from' })).toContainText(listName);

  await become(page, contributor);
  await page.goto(listUrl);
  await page.getByRole('button', { name: 'Propose codes', exact: true }).click();
  const add = page.getByRole('form', { name: 'Propose codes', exact: true });
  await fillCode(add, 1, 'cooking', 'COOK');
  await add.getByRole('button', { name: 'Propose change' }).click();
  const extraId = await proposedId(page);
  await page.reload();
  await expect(page.getByText('Proposed changes waiting:', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: new RegExp(`Add 1 code to “${listName}”`) })).toBeVisible();
  await become(page, owner);
  await approveAndMerge(page, extraId);

  await become(page, contributor);
  await page.goto(`/o/${id}/browse?term=${encodeURIComponent(ns + 'gardening')}`);
  await expect(page.getByRole('definition').filter({ hasText: 'GARD' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const edit = editForm(page);
  // Changing a stored notation is major, even if the definition hasn't changed.
  await edit.getByLabel(/^Code( changed)?$/).fill('GARDEN');
  await expect(edit.getByText(/Data that stored the old code will no longer match/)).toContainText('Major');
  const parentOptions = edit.getByLabel(/^Parent/).getByRole('option');
  await expect(parentOptions.filter({ hasText: /^gardening$/ })).toHaveCount(0);
  await edit.getByRole('button', { name: 'Save as draft' }).click();
  await expect(notice(page)).toContainText('Major');
  await expect(page.getByRole('definition').filter({ hasText: 'GARD' })).toBeVisible();

  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await edit.getByRole('button', { name: 'Deprecate this code', exact: true }).click();
  await edit.getByRole('checkbox', { name: 'Deprecate this code with this change' }).check();
  await expect(edit.getByRole('button', { name: 'Propose change' })).toBeDisabled();
  await edit.getByLabel('Reason for deprecation', { exact: true }).fill('Use the broader outdoor code.');
  await edit.getByLabel(/^Replacement\ code\ \(optional\)/).selectOption({ label: 'outdoor' });
  await edit.getByRole('button', { name: 'Propose change' }).click();
  const deprecatedId = await proposedId(page);
  await become(page, owner);
  await approveAndMerge(page, deprecatedId);
  await page.goto(listUrl);
  await expect(codes.getByRole('button', { name: 'gardening', exact: true })).toHaveCSS('text-decoration-line', 'line-through');
  await expect(codes.getByText('Deprecated', { exact: true })).toBeVisible();
  await codes.getByRole('button', { name: 'gardening', exact: true }).click();
  await expect(page.getByText(/Deprecated — use/)).toContainText('outdoor');

  await page.goto(`/o/${id}/validate`);
  await page.getByLabel('Version to validate against').selectOption('draft');
  const data = (value: string) => `@prefix c: <${ns}> .\n<https://example.org/event> a c:Event ; c:hasActivityType <${value}> .`;
  const dataEditor = page.getByRole('textbox', { name: 'Data to validate' });
  await dataEditor.fill(data(ns + 'outdoor'));
  await expect(page.getByText('Conforms to the shapes', { exact: false })).toBeVisible();
  await dataEditor.fill(data('https://example.org/unlisted-code'));
  await expect(page.getByRole('list', { name: /^Problems found/ })).toContainText(/hasActivityType|has activity type/);

  // Public anchors and controls are checked without a signed-in session.
  await page.context().clearCookies();
  await page.goto(`/def/${slug}/draft#sec-code-lists`);
  await expect(page.getByRole('heading', { name: /^Code lists/ })).toBeVisible();
  for (const code of ['outdoor', 'indoor', 'gardening', 'cooking']) {
    await expect(page.getByRole('link', { name: code, exact: true }).first()).toHaveAttribute('href', `#${code}`);
    await page.goto(`/def/${slug}/draft#${code}`);
    await expect(page.getByRole('heading', { name: new RegExp(`${listName}$`), level: 3 })).toBeVisible();
  }
  for (const name of ['New code list', 'Propose codes', 'Use for a property']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  for (const url of [listUrl, `/o/${id}/browse?term=${encodeURIComponent(ns + 'gardening')}`]) {
    await page.goto(url);
    await expect(page).toHaveURL(/\/login\?next=/);
    await settle(page);
    for (const name of ['New code list', 'Propose codes', 'Use for a property']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
});

test('code list forms validate IRIs, keep filtered ancestors, and recover conflicting edits', async ({ page, consoleGuard }) => {
  test.setTimeout(150_000);
  consoleGuard.allow(/status of 409/);
  const { id, ns, owner, contributor } = await setup(page);
  await page.goto(`/o/${id}/browse?new=code-list`);
  const create = page.getByRole('form', { name: 'New code list', exact: true });
  await create.getByLabel('Name', { exact: true }).fill('Status codes');
  await create.getByLabel('Definition', { exact: true }).first().fill('Permitted status values.');
  await create.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await create.getByLabel('IRI local name', { exact: true }).fill('bad_name');
  await expect(create.getByText(/Use UpperCamelCase/)).toBeVisible();
  await expect(create.getByRole('button', { name: 'Save as draft' })).toBeDisabled();
  await create.getByLabel('IRI local name', { exact: true }).fill('Event');
  await expect(create.getByText(/This IRI is already used/)).toBeVisible();
  await create.getByLabel('IRI local name', { exact: true }).fill('Statuses');
  const root = await fillCode(create, 1, 'category', 'CAT');
  await root.getByRole('button', { name: 'Edit', exact: true }).click();
  await root.getByLabel('IRI local name', { exact: true }).fill('bad_name');
  await expect(root.getByText(/Use letters, digits and hyphens/)).toBeVisible();
  await root.getByLabel('IRI local name', { exact: true }).fill('category');
  await create.getByRole('button', { name: 'Add another code' }).click();
  await fillCode(create, 2, 'temporary', 'CAT');
  await expect(create.getByText('This code is already used in the list.').first()).toBeVisible();
  await expect(create.getByRole('button', { name: 'Propose change' })).toBeDisabled();
  await create.getByRole('button', { name: 'Remove new code 2' }).click();
  await create.getByRole('button', { name: 'Propose change' }).click();
  const listRequest = await proposedId(page);
  await become(page, owner);
  await approveAndMerge(page, listRequest);

  await become(page, contributor);
  const codes = await json(await page.request.post(`/api/ontologies/${id}/code-list-edits`, { data: { submit: true, ops: Array.from({ length: 16 }, (_, i) => ({
    op: 'addConcept', scheme: ns + 'Statuses', localName: `status-${i + 1}`, label: `status ${i + 1}`, definition: `Status value ${i + 1}.`, notation: `S${String(i + 1).padStart(2, '0')}`,
    broader: ns + (i === 1 ? 'status-1' : 'category'),
  })) } }));
  await become(page, owner);
  await approveAndMerge(page, codes.id);
  await become(page, contributor);
  const listUrl = `/o/${id}/browse?term=${encodeURIComponent(ns + 'Statuses')}`;
  await page.goto(listUrl);
  await expect(page.getByText('No property uses this list yet.', { exact: false })).toBeVisible();
  const hierarchy = page.getByRole('list', { name: 'Codes in Status codes' });
  await page.getByLabel('Filter codes', { exact: true }).fill('S02');
  for (const name of ['category', 'status 1', 'status 2']) await expect(hierarchy.getByRole('button', { name, exact: true })).toBeVisible();
  await expect(hierarchy.getByRole('button', { name: 'status 3', exact: true })).toHaveCount(0);
  await page.getByLabel('Filter codes', { exact: true }).fill('');
  await expect(hierarchy.getByRole('button', { name: 'status 3', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Use for a property', exact: true }).click();
  const use = page.getByRole('form', { name: 'Use for a property' });
  await use.getByLabel(/^Property/).selectOption({ label: 'has activity type' });
  await use.getByRole('button', { name: 'Propose change' }).click();
  await expect(notice(page)).toContainText('Major');
  await expect(page.getByRole('form', { name: 'Use for a property' })).toHaveCount(0);

  // Code-list annotation updates use the same stale-value recovery as term edits.
  let stale = true;
  await page.route(/\/api\/ontologies\/[^/]+\/view/, async (route) => {
    const response = await route.fetch();
    const view = await response.json();
    if (stale) for (const list of view.conceptSchemes) if (list.iri === ns + 'Statuses') list.label = 'Old status codes';
    await route.fulfill({ response, json: view });
  });
  await page.goto(listUrl);
  await expect(page.getByRole('heading', { name: 'Old status codes', exact: true })).toBeVisible();
  stale = false;
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const edit = editForm(page);
  await expect(edit.getByLabel(/^Label/)).toHaveValue('Old status codes');
  await edit.getByLabel(/^Label/).fill('Activity status codes');
  await edit.getByRole('button', { name: 'Add alternative label' }).click();
  await edit.getByLabel('alternative label 1', { exact: true }).fill('event statuses');
  await edit.getByLabel('Editorial note', { exact: true }).fill('Keep the list small.');
  await edit.getByRole('button', { name: 'Propose change' }).click();
  await expect(edit.getByRole('alert')).toContainText('changed since you opened the editor');
  await edit.getByRole('button', { name: 'Load the latest values (keeps your text)' }).click();
  await expect(edit.getByRole('status')).toContainText('You changed this too.');
  await expect(edit.getByRole('button', { name: 'Propose change' })).toBeDisabled();
  await edit.getByRole('button', { name: 'Keep mine' }).click();
  await expect(edit.getByLabel(/^Editorial note/)).toHaveValue('Keep the list small.');
  await edit.getByRole('button', { name: 'Propose change' }).click();
  const editId = await proposedId(page);
  const changed = await json(await page.request.get(`/api/change-requests/${editId}`));
  expect(changed.ops[0]).toMatchObject({ op: 'updateConcept', set: { label: 'Activity status codes', altLabels: ['event statuses'], editorialNote: 'Keep the list small.' }, expect: { label: 'Status codes' } });

  // A fresh copy of the ontology, without the stale label.
  await page.unrouteAll();
  await page.goto(listUrl);
  await page.getByLabel('Search terms', { exact: true }).fill('Status codes');
  await page.getByRole('button', { name: /^Status codes\s*Code list/ }).click();
  await expect(page.getByRole('heading', { name: 'Status codes', exact: true })).toBeVisible();
  await page.getByLabel('Search terms', { exact: true }).fill('S02');
  await page.getByRole('button', { name: /^status 2\s*Code/ }).click();
  await expect(page.getByRole('heading', { name: 'status 2', exact: true })).toBeVisible();
  await page.getByLabel('Search terms', { exact: true }).fill('');
  await page.goto(`/o/${id}/browse?term=${encodeURIComponent(ns + 'status-1')}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const codeEdit = editForm(page);
  await expect(codeEdit.getByLabel(/^Parent/).getByRole('option', { name: 'status 1', exact: true })).toHaveCount(0);
  await expect(codeEdit.getByLabel(/^Parent/).getByRole('option', { name: 'status 2', exact: true })).toHaveCount(0);
  await codeEdit.getByLabel(/^Parent/).selectOption({ label: 'Top level' });
  await expect(codeEdit.getByText(/Moving this code changes its place/)).toContainText('Major');
  await codeEdit.getByLabel(/^Definition/).fill('A status that means the activity is cancelled.');
  await expect(codeEdit.getByRole('button', { name: 'Save as draft' })).toBeDisabled();
  await codeEdit.getByRole('radio', { name: /No, it changes what the code means/ }).check();
  await expect(codeEdit.getByText(/Changing what a code means/)).toContainText('Major');
  await codeEdit.getByRole('button', { name: 'Save as draft' }).click();
  const major = await json(await page.request.get(`/api/change-requests/${await proposedId(page)}`));
  expect(major.classification.level).toBe('major');
  expect(major.ops).toContainEqual({ op: 'moveConcept', iri: ns + 'status-1', broader: null, expect: { broader: ns + 'category' } });
});
