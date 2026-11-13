import type { BrowserContext, Page } from '@playwright/test';
import type { ChangeOp, ChangeRequestDetail, GovernancePolicy } from '../packages/shared/src/index';
import { test, expect, signIn, settle, uniq } from './fixtures';

const warning = 'Saving new edits starts a new review round: earlier approvals and yes votes stop counting. Objections and votes against stand.';
const actions = (page: Page) => page.getByRole('group', { name: 'Your actions' });
const cards = (page: Page) => page.getByRole('list', { name: 'Proposed changes' });
async function setup(page: Page) {
  const owner = await signIn(page, { name: `Hand edit owner ${uniq()}`, role: 'steward' });
  const ownerCookies = await page.context().cookies();
  const response = await page.request.post('/api/ontologies', { data: { title: `Hand edits ${uniq()}`, prefix: `he${uniq()}`, description: 'A standard for the hand edit tests.', governanceTemplate: 'steward-led' } });
  expect(response.ok(), await response.text()).toBeTruthy();
  const project = await response.json();
  const policy = project.governance as GovernancePolicy;
  policy.changes.minor = { ...policy.changes.minor, approverRoles: ['reviewer'], minApprovals: 1, reviewPeriodDays: 0, autoMerge: false, lazyConsensus: false, vote: undefined };
  policy.automation.autoDraftRelease = false;
  expect((await page.request.put(`/api/ontologies/${project.id}/governance`, { data: { policy } })).ok()).toBeTruthy();
  const author = await signIn(page, { name: `Hand edit author ${uniq()}`, role: 'contributor' });
  const authorCookies = await page.context().cookies();
  return { project, owner, author, ownerCookies, authorCookies };
}
async function restore(page: Page, cookies: Awaited<ReturnType<BrowserContext['cookies']>>) {
  await page.context().clearCookies();
  await page.context().addCookies(cookies);
}
async function create(page: Page, id: string, ops: ChangeOp[]) {
  const res = await page.request.post(`/api/ontologies/${id}/change-requests`, { data: { title: `Hand edit ${uniq()}`, kind: 'feature', ops } });
  expect(res.ok(), await res.text()).toBeTruthy();
  const cr = await res.json() as ChangeRequestDetail;
  await page.goto(`/o/${id}/changes/${cr.id}`);
  return cr;
}
async function loaded(page: Page, id: string) {
  return await (await page.request.get(`/api/change-requests/${id}`)).json() as ChangeRequestDetail;
}

// Authors used to have only “Ask AI to revise”, even for a typo or one unwanted edit.
test('an author edits drafted wording, renames references, removes an edit and reopens review at 390 px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { project, ownerCookies, authorCookies } = await setup(page);
  const name = `Shift${uniq()}`;
  const child = `Junior${uniq()}`;
  const unwanted = `Discard${uniq()}`;
  await page.goto(`/o/${project.id}/changes`);
  await page.getByRole('button', { name: 'New change request' }).first().click();
  const newDialog = page.getByRole('dialog', { name: 'New change request' });
  await newDialog.getByLabel('Title').fill(`Shfit ${name}`);
  await newDialog.getByLabel('Why is this needed?').fill('Plan rotas.');
  await newDialog.getByLabel('Describe the change in plain language').fill(`Add a class ${name}. Add a class ${child} as a subclass of ${name}. Add a class ${unwanted}.`);
  await newDialog.getByRole('button', { name: 'Create and draft changes' }).click();
  await expect(page).toHaveURL(/\/changes\/cr_[^/?]+$/);
  const url = page.url();
  const id = url.split('/').at(-1)!;
  const before = await loaded(page, id);
  await page.getByRole('button', { name: 'Edit title and reason' }).click();
  const heading = page.getByRole('dialog', { name: 'Edit title and reason' });
  await heading.getByLabel('Title', { exact: true }).fill('');
  await expect(heading.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await heading.getByLabel('Title', { exact: true }).fill(`Shift ${name}`);
  await heading.getByLabel('Why is this needed?').fill('Plan volunteer rotas.');
  const patch = page.waitForRequest((r) => r.method() === 'PATCH');
  await heading.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await patch).postDataJSON()).toEqual({ title: `Shift ${name}`, description: 'Plan volunteer rotas.' });
  await expect(heading).toHaveCount(0);
  expect((await loaded(page, id)).round).toBe(before.round);

  const first = cards(page).getByRole('listitem').filter({ has: page.getByText(name.toLowerCase(), { exact: true }) });
  await first.getByRole('button', { name: 'Edit', exact: true }).click();
  const edit = page.getByRole('dialog', { name: /^Edit “/ });
  await edit.getByLabel('Definition').fill('A period when a volunteer is scheduled to work.');
  await edit.getByLabel('IRI local name').fill('two words');
  await expect(edit.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await edit.getByLabel('IRI local name').fill(child);
  await expect(edit.getByText(/already used/)).toBeVisible();
  const renamed = `Volunteer${name}`;
  await edit.getByLabel('IRI local name').fill(renamed);
  await expect(edit.getByText(project.namespace + renamed, { exact: true })).toBeVisible();
  await expect(edit.getByText(warning)).toHaveCount(0);
  await expect(edit.getByText('To change the structure, ask the AI to revise or remove this edit and propose it again.')).toBeVisible();
  await edit.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(edit).toHaveCount(0);
  const saved = await loaded(page, id);
  expect(saved.ops[1]).toMatchObject({ op: 'addClass', subClassOf: [project.namespace + renamed] });
  expect(saved.validation).toBeTruthy();
  await cards(page).getByRole('listitem').filter({ has: page.getByText(unwanted.toLowerCase(), { exact: true }) }).getByRole('button', { name: 'Remove this edit' }).click();
  const remove = page.getByRole('dialog', { name: 'Remove this edit' });
  await expect(remove).toContainText(unwanted.toLowerCase());
  await remove.getByRole('button', { name: 'Remove this edit' }).click();
  await expect(remove).toHaveCount(0);
  await actions(page).getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByRole('button', { name: /^Status: / })).toContainText('In review');

  const reviewer = await signIn(page, { name: `Hand edit reviewer ${uniq()}`, role: 'reviewer' });
  const reviewerCookies = await page.context().cookies();
  await restore(page, ownerCookies);
  expect((await page.request.put(`/api/ontologies/${project.id}/members/${reviewer.user.id}`, { data: { roles: ['reviewer'] } })).ok()).toBeTruthy();
  await restore(page, reviewerCookies);
  await page.goto(url);
  await expect(page.getByRole('button', { name: 'Edit title and reason' })).toHaveCount(0);
  await expect(cards(page).getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  await expect(cards(page).getByRole('button', { name: 'Remove this edit' })).toHaveCount(0);
  await actions(page).getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Status: / })).toContainText('Approved');

  await restore(page, authorCookies);
  await page.goto(url);
  await cards(page).getByRole('listitem').first().getByRole('button', { name: 'Edit', exact: true }).click();
  await edit.getByLabel('Definition').fill('A scheduled period when a volunteer performs a role.');
  await expect(edit.getByText(warning)).toBeVisible();
  await edit.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(edit).toHaveCount(0);
  await restore(page, reviewerCookies);
  await page.goto(url);
  await expect(page.getByText(/Your “approve” was for an earlier round/)).toBeVisible();
  expect((await loaded(page, id)).governance.approvals).toBe(0);

  await signIn(page, { name: `Other contributor ${uniq()}`, role: 'contributor' });
  await page.goto(url);
  await expect(page.getByRole('button', { name: 'Edit title and reason' })).toHaveCount(0);
  await expect(cards(page).getByRole('button', { name: /Edit|Remove this edit/ })).toHaveCount(0);
  expect((await page.request.patch(`/api/change-requests/${id}`, { data: { ops: [] } })).status()).toBe(403);

  await restore(page, reviewerCookies);
  await page.goto(url);
  await actions(page).getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Status: / })).toContainText('Approved');
  await restore(page, ownerCookies);
  await page.goto(url);
  await actions(page).getByRole('button', { name: 'Merge into working draft' }).click();
  await expect(page.getByRole('button', { name: /^Status: / })).toContainText('Merged');
  await expect(page.getByRole('button', { name: 'Edit title and reason' })).toHaveCount(0);
  await expect(cards(page).getByRole('button', { name: /Edit|Remove this edit/ })).toHaveCount(0);
  await settle(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.context().clearCookies();
  await page.goto(url);
  await expect(page).toHaveURL(/\/login\?/);
  await expect(page.getByRole('button', { name: 'Edit title and reason' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Remove this edit' })).toHaveCount(0);
  expect((await page.request.patch(`/api/change-requests/${id}`, { data: { ops: [] } })).status()).toBe(401);
});

// A plain PATCH could silently overwrite edits made after the editor opened.
test('a stale hand save shows the conflict and reloads the latest edits', async ({ page, consoleGuard }) => {
  consoleGuard.allow(/Failed to load resource: the server responded with a status of 409/);
  const { project } = await setup(page);
  const cr = await create(page, project.id, [{ op: 'addClass', localName: `Shift${uniq()}`, label: 'shift', definition: 'A scheduled period.' }]);
  await cards(page).getByRole('button', { name: 'Edit', exact: true }).click();
  const edit = page.getByRole('dialog', { name: /^Edit “/ });
  await edit.getByLabel('Definition').fill('My stale wording.');
  expect((await page.request.patch(`/api/change-requests/${cr.id}`, { data: { ops: [{ ...cr.ops[0], definition: 'The latest wording.' }] } })).ok()).toBeTruthy();
  await edit.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Someone changed the edits while they were being revised. Look at the latest edits and try again.')).toBeVisible();
  await expect(edit).toHaveCount(0);
  await expect(cards(page)).toContainText('The latest wording.');
  expect(JSON.stringify((await loaded(page, cr.id)).ops)).not.toContain('My stale wording.');
});

test('removal names dependent edits and allows an empty draft, but keeps the final edit in review', async ({ page }) => {
  const { project } = await setup(page);
  const name = `Parent${uniq()}`;
  const cr = await create(page, project.id, [
    { op: 'addClass', localName: name, label: 'parent', definition: 'A parent class.' },
    { op: 'addClass', localName: `Child${uniq()}`, label: 'child', definition: 'A child class.', subClassOf: [project.namespace + name] },
  ]);
  await cards(page).getByRole('listitem').first().getByRole('button', { name: 'Remove this edit' }).click();
  const remove = page.getByRole('dialog', { name: 'Remove this edit' });
  await expect(remove).toContainText('Remove “Add class: parent”?');
  await expect(remove).toContainText('These edits depend on it and will fail validation until fixed:');
  await expect(remove).toContainText('Add class: child');
  await remove.getByRole('button', { name: 'Remove this edit' }).click();
  await expect(remove).toHaveCount(0);
  expect((await loaded(page, cr.id)).validation?.passed).toBe(false);
  await page.getByRole('tab', { name: /^Checks/ }).click();
  await expect(page.getByRole('tabpanel')).toContainText(/not a declared class|unknown|does not exist/);
  await page.getByRole('tab', { name: /^Changes/ }).click();
  await cards(page).getByRole('button', { name: 'Remove this edit' }).click();
  await remove.getByRole('button', { name: 'Remove this edit' }).click();
  await expect(page.getByRole('heading', { name: 'No changes proposed yet' })).toBeVisible();
  expect((await loaded(page, cr.id)).ops).toEqual([]);

  await create(page, project.id, [{ op: 'addClass', localName: `Retained${uniq()}`, label: 'retained', definition: 'A retained class.' }]);
  await actions(page).getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByRole('button', { name: /^Status: / })).toContainText('In review');
  await expect(cards(page).getByRole('button', { name: 'Remove this edit' })).toHaveCount(0);
  await expect(cards(page).getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
});

test('an editor is warned that their first wording edit prevents an independent approval', async ({ page }) => {
  const { project, ownerCookies } = await setup(page);
  const cr = await create(page, project.id, [{ op: 'addClass', localName: `Rota${uniq()}`, label: 'rota', definition: 'A plan for scheduled work.' }]);
  const url = page.url();
  await actions(page).getByRole('button', { name: 'Submit for review' }).click();
  const editor = await signIn(page, { name: `Hand editor ${uniq()}`, role: 'reviewer' });
  const editorCookies = await page.context().cookies();
  await restore(page, ownerCookies);
  expect((await page.request.put(`/api/ontologies/${project.id}/members/${editor.user.id}`, { data: { roles: ['editor', 'reviewer'] } })).ok()).toBeTruthy();
  await restore(page, editorCookies);
  await page.goto(url);
  await cards(page).getByRole('button', { name: 'Edit', exact: true }).click();
  const edit = page.getByRole('dialog', { name: /^Edit “/ });
  await expect(edit.getByText("After editing these, you can't also approve them.")).toBeVisible();
  await expect(edit.getByText(warning)).toBeVisible();
  await edit.getByLabel('Definition').fill('A plan assigning volunteers to scheduled periods of work.');
  await edit.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(edit).toHaveCount(0);
  expect((await loaded(page, cr.id)).revisedBy).toContain(editor.user.id);
  await actions(page).getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(actions(page).getByText('You previously chose “approve”.')).toBeVisible();
  expect((await loaded(page, cr.id)).governance.approvals).toBe(0);
  await cards(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(edit.getByText("After editing these, you can't also approve them.")).toHaveCount(0);
});

test('all supported wording forms preserve structure and annotation expectations', async ({ page }) => {
  const { project } = await setup(page);
  const suffix = uniq();
  const iri = (name: string) => project.namespace + name + suffix;
  const ops: ChangeOp[] = [
    { op: 'addClass', localName: `Class${suffix}`, label: 'class', definition: 'A scheduled activity.', comment: 'A comment.', altLabels: ['activity'], examples: ['A morning shift.'], editorialNote: 'Check wording.' },
    { op: 'addObjectProperty', localName: `related${suffix}`, label: 'related', definition: 'A related activity.', domain: [iri('Class')], range: [iri('Class')], characteristics: ['symmetric'] },
    { op: 'addDatatypeProperty', localName: `name${suffix}`, label: 'name', definition: 'The name of an activity.', domain: [iri('Class')], range: ['http://www.w3.org/2001/XMLSchema#string'], functional: true },
    { op: 'addIndividual', localName: `morning${suffix}`, label: 'morning', types: [iri('Class')] },
    { op: 'addConceptScheme', localName: `Codes${suffix}`, label: 'codes', definition: 'A list of activity codes.' },
    { op: 'addConcept', localName: `code${suffix}`, label: 'code', definition: 'A code for an activity.', scheme: iri('Codes'), notation: 'M' },
    { op: 'updateAnnotations', iri: iri('related'), set: { definition: 'An activity related to another.', comment: 'Reword this.', altLabels: ['associated'], examples: ['A related shift.'], editorialNote: 'Review this.', source: ['written source'], mappings: { 'http://www.w3.org/2004/02/skos/core#relatedMatch': [iri('Class')] } }, expect: { definition: 'A related activity.' } },
    { op: 'updateConcept', iri: iri('code'), set: { definition: 'A code representing an activity.', notation: 'AM' }, expect: { definition: 'A code for an activity.', notation: 'M' } },
    { op: 'deprecateTerm', iri: iri('name'), reason: 'Use a more specific property.' },
    { op: 'deprecateConcept', iri: iri('code'), reason: 'Use a more specific code.' },
  ];
  const cr = await create(page, project.id, ops);
  for (let index = 0; index < ops.length; index++) {
    const before = (await loaded(page, cr.id)).ops;
    await cards(page).getByRole('listitem').nth(index).getByRole('button', { name: 'Edit', exact: true }).click();
    const edit = page.getByRole('dialog', { name: /^Edit “/ });
    const original = before[index];
    const expected = structuredClone(before);
    const text = `Corrected wording ${index}.`;
    if (original.op === 'deprecateTerm' || original.op === 'deprecateConcept') {
      await edit.getByLabel('Reason').fill(text);
      expected[index] = { ...original, reason: text };
    } else if (original.op === 'updateAnnotations' || original.op === 'updateConcept') {
      await edit.getByLabel('Definition').fill(text);
      expected[index] = { ...original, set: { ...original.set, definition: text } };
      if (original.op === 'updateConcept') {
        await edit.getByLabel('Code', { exact: true }).fill('NEW');
        expected[index] = { ...original, set: { ...original.set, definition: text, notation: 'NEW' } };
      } else {
        await edit.getByLabel('source 1', { exact: true }).fill('corrected source');
        await edit.getByRole('button', { name: 'Mappings', exact: true }).click();
        await edit.getByLabel(/^Targets for /).fill(iri('Codes'));
        expected[index] = { ...original, set: { ...original.set, definition: text, source: ['corrected source'], mappings: { 'http://www.w3.org/2004/02/skos/core#relatedMatch': [iri('Codes')] } } };
      }
    } else if ('localName' in original) {
      await edit.getByLabel('Label', { exact: true }).fill(text);
      expected[index] = { ...original, label: text };
      if (original.op === 'addClass') {
        await edit.getByLabel('Definition').fill('A period of scheduled work.');
        await edit.getByLabel('Comment').fill('A corrected comment.');
        await edit.getByLabel('alternative label 1', { exact: true }).fill('working period');
        await edit.getByLabel('example 1', { exact: true }).fill('Morning work.\nEvening work.');
        await edit.getByLabel('Editorial note').fill('Corrected by hand.');
        expected[index] = { ...original, label: text, definition: 'A period of scheduled work.', comment: 'A corrected comment.', altLabels: ['working period'], examples: ['Morning work.\nEvening work.'], editorialNote: 'Corrected by hand.' };
      }
    }
    await edit.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(edit).toHaveCount(0);
    expect((await loaded(page, cr.id)).ops).toEqual(expected);
  }
});
