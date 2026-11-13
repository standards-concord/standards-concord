import type { Page } from '@playwright/test';
import { demoOntology, expect, settle, signIn, test, uniq } from './fixtures';

const NS = 'https://w3id.org/odi/volunteering#';
const panel = (page: Page) => page.getByRole('region', { name: 'Proposed changes', exact: true });
const list = (page: Page) => panel(page).getByRole('list', { name: 'Your proposed changes', exact: true });
const diagram = (page: Page) => page.getByRole('group', { name: 'Class diagram', exact: true });
const form = (page: Page, action: string) => page.getByRole('form', { name: action, exact: true });

/**
 * Serves the page an edited copy of the ontology view. A view request still in flight when the page
 * navigates (a reload) or the test ends is cancelled, and its response disposed: nothing waits for it,
 * so it is let go. (A background refresh caught by the end of a test used to fail that test now and then.)
 */
async function editView(page: Page, edit: (view: { classes: { iri: string; superClasses: string[] }[] } & Record<string, unknown>) => void) {
  await page.route(/\/api\/ontologies\/[^/]+\/view(\?|$)/, async (route) => {
    try {
      const res = await route.fetch();
      const view = await res.json();
      edit(view);
      await route.fulfill({ response: res, json: view });
    } catch (error) {
      if (/disposed|closed|already handled|test ended/i.test(String(error))) return;
      throw error;
    }
  });
}

async function openDiagram(page: Page) {
  const { id } = await demoOntology(page.request);
  await page.goto(`/o/${id}/browse?view=diagram&hops=0`);
  await settle(page);
  await page.getByRole('button', { name: 'Propose changes', exact: true }).click();
  return id;
}
async function addClass(page: Page, name: string) {
  await panel(page).getByRole('button', { name: 'Add class', exact: true }).click();
  const f = form(page, 'Add class');
  await expect(f.getByLabel('Label', { exact: true })).toBeFocused();
  await f.getByLabel('Label', { exact: true }).fill(name);
  await f.getByLabel('Definition', { exact: true }).fill('A person who coordinates volunteering shifts.');
  await f.getByRole('combobox', { name: 'Subclass of', exact: true }).selectOption(NS + 'Person');
  await f.getByRole('button', { name: 'Add to proposal', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: 'Add class', exact: true })).toBeFocused();
}
async function addRelationship(page: Page, from: string, name: string) {
  await panel(page).getByRole('button', { name: 'Add relationship', exact: true }).click();
  const f = form(page, 'Add relationship');
  await f.getByRole('combobox', { name: 'From', exact: true }).selectOption({ label: `${from} (proposed)` });
  await f.getByRole('combobox', { name: 'To', exact: true }).selectOption(NS + 'Session');
  await f.getByLabel('Label', { exact: true }).fill(name);
  await f.getByLabel('Definition', { exact: true }).fill('Connects a coordinator to a session they coordinate.');
  await f.getByRole('combobox', { name: 'How many', exact: true }).selectOption({ label: 'At least one' });
  await f.getByRole('button', { name: 'Add to proposal', exact: true }).click();
}

test.describe('proposing from the Diagram', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, { name: `Diagram contributor ${uniq()}`, role: 'contributor' });
  });

  test('a contributor proposes a new class and relationship in one request while Browse stays unchanged', async ({ page }) => {
    const id = await openDiagram(page);
    const name = `volunteer coordinator ${uniq()}`, rel = `coordinates ${uniq()}`;
    await expect(panel(page)).toContainText('Nothing changes until the change request is approved and merged.');
    await addClass(page, name);
    await addRelationship(page, name, rel);
    await expect(list(page).getByRole('listitem')).toHaveCount(2);
    await expect(list(page)).toContainText(`Add class “${name}”, subclass of “person”`);
    await expect(list(page)).toContainText(`Add relationship “${rel}” from “${name}” to “session”, at least one`);
    await expect(diagram(page).getByRole('button', { name: new RegExp(`^${name} \\(proposed\\)`) })).toBeVisible();
    await expect(diagram(page).getByText(`${rel} (proposed)  1..*`, { exact: true })).toBeVisible();
    await page.getByText(/^Relationships as text/).click();
    await expect(page.getByRole('list', { name: 'Proposed terms' })).toContainText(`${name} (proposed)`);
    await expect(page.getByRole('list', { name: 'Proposed terms' })).toContainText(`${rel} (proposed)`);
    await expect(panel(page).getByLabel('Title', { exact: true })).toHaveValue(`Add ${name} and 1 more change`);
    await panel(page).getByRole('button', { name: 'Open change request', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${id}/changes/[^/]+$`));
    await page.getByRole('tab', { name: /^Changes/ }).click();
    const changes = page.getByRole('tabpanel');
    await expect(changes.getByRole('listitem').filter({ hasText: /^Add class/ }).getByText(name, { exact: true })).toBeVisible();
    await expect(changes.getByRole('listitem').filter({ hasText: /^Add object property/ }).getByText(rel, { exact: true })).toBeVisible();
    const cr = await (await page.request.get(`/api/change-requests/${page.url().split('/').pop()}`)).json();
    expect(cr.ops.map((op: { op: string }) => op.op)).toEqual(['addClass', 'addObjectProperty', 'addRestriction']);
    expect(cr.status).not.toBe('draft');
    await page.goto(`/o/${id}/browse?view=diagram&hops=0`);
    await expect(diagram(page).getByRole('button', { name: new RegExp(`^${name}`) })).toHaveCount(0);
    await page.getByRole('button', { name: 'Propose changes', exact: true }).click();
    await expect(list(page).getByRole('listitem')).toHaveCount(0);
    const view = await (await page.request.get(`/api/ontologies/${id}/view`)).json();
    expect(view.classes.some((c: { label: string }) => c.label === name)).toBe(false);
  });

  test('undo removes dependent proposals, reload restores drafts, and review and discard clear them', async ({ page }) => {
    await openDiagram(page);
    const name = `pending coordinator ${uniq()}`, rel = `pending coordinates ${uniq()}`;
    await addClass(page, name);
    await addRelationship(page, name, rel);
    await list(page).getByRole('button', { name: /^Undo: Add relationship/ }).click();
    await expect(list(page).getByRole('listitem')).toHaveCount(1);
    await expect(list(page).getByRole('button', { name: /^Undo: Add class/ })).toBeFocused();
    await addRelationship(page, name, rel);
    await list(page).getByRole('button', { name: /^Undo: Add class/ }).click();
    await expect(list(page).getByRole('listitem')).toHaveCount(0);
    await expect(panel(page).getByRole('button', { name: 'Add class', exact: true })).toBeFocused();
    await expect(panel(page).getByRole('status')).toHaveText('Also removed 1 change that used it');
    await addClass(page, name);
    await addRelationship(page, name, rel);
    await panel(page).getByLabel('Description (optional)').fill('Remember my explanation.');
    await page.reload();
    await expect(page.getByText('You have 2 proposed changes not sent yet.')).toBeVisible();
    await expect(diagram(page).getByRole('button', { name: new RegExp(`^${name}`) })).toHaveCount(0);
    await page.getByRole('button', { name: 'Review them', exact: true }).click();
    await expect(list(page).getByRole('listitem')).toHaveCount(2);
    await expect(panel(page).getByLabel('Description (optional)')).toHaveValue('Remember my explanation.');
    await page.getByRole('button', { name: 'Propose changes', exact: true }).click();
    await expect(page.getByText('You have 2 proposed changes not sent yet.')).toBeVisible();
    await page.getByRole('button', { name: 'Review them', exact: true }).click();
    await panel(page).getByRole('button', { name: 'Discard all', exact: true }).click();
    await expect(panel(page).getByText('Discard 2 proposed changes?', { exact: true })).toBeVisible();
    await panel(page).getByRole('button', { name: 'Keep', exact: true }).click();
    await expect(list(page).getByRole('listitem')).toHaveCount(2);
    await panel(page).getByRole('button', { name: 'Discard all', exact: true }).click();
    await panel(page).getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(list(page).getByRole('listitem')).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Review them', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Propose changes', exact: true }).click();
    await expect(list(page).getByRole('listitem')).toHaveCount(0);
  });

  test('Undo keeps focus on the next Undo, the previous Undo, then Add class', async ({ page }) => {
    // Removing the focused row used to leave keyboard focus on the document body.
    await openDiagram(page);
    const first = `first coordinator ${uniq()}`, middle = `middle coordinator ${uniq()}`, last = `last coordinator ${uniq()}`;
    for (const name of [first, middle, last]) await addClass(page, name);
    const undo = (name: string) => list(page).getByRole('button', { name: `Undo: Add class “${name}”, subclass of “person”`, exact: true });
    await undo(middle).click();
    await expect(undo(last)).toBeFocused();
    await undo(last).click();
    await expect(undo(first)).toBeFocused();
    await undo(first).click();
    await expect(panel(page).getByRole('button', { name: 'Add class', exact: true })).toBeFocused();
  });

  test('Undo retains an invalid superclass proposal and blocks sending until the cycle is fixed', async ({ page }) => {
    // Undo used to restore Volunteer -> Person while leaving Person -> Volunteer sendable.
    await openDiagram(page);
    const changeSuperclass = async (cls: string, parent: string) => {
      await panel(page).getByRole('button', { name: 'Change superclass', exact: true }).click();
      const f = form(page, 'Change superclass');
      await f.getByRole('combobox', { name: 'Class', exact: true }).selectOption(NS + cls);
      await f.getByRole('combobox', { name: 'New superclass', exact: true }).selectOption(NS + parent);
      await f.getByRole('button', { name: 'Add to proposal', exact: true }).click();
    };
    await changeSuperclass('Volunteer', 'Session');
    await changeSuperclass('Person', 'Volunteer');
    await expect(panel(page).getByRole('button', { name: 'Open change request', exact: true })).toBeEnabled();
    await list(page).getByRole('button', { name: /^Undo: Make “volunteer”/ }).click();
    await expect(list(page).getByRole('listitem')).toHaveCount(1);
    await expect(list(page).getByRole('button', { name: /^Undo: Make “person”/ })).toBeFocused();
    await expect(panel(page).getByRole('alert')).toContainText('one of its subclasses');
    await expect(panel(page).getByRole('button', { name: 'Open change request', exact: true })).toBeDisabled();
    await page.reload();
    await page.getByRole('button', { name: 'Review them', exact: true }).click();
    await expect(list(page).getByRole('listitem')).toHaveCount(1);
    await expect(panel(page).getByRole('alert')).toContainText('one of its subclasses');
    await expect(panel(page).getByRole('button', { name: 'Open change request', exact: true })).toBeDisabled();
    await changeSuperclass('Volunteer', 'Session');
    await expect(panel(page).getByRole('alert')).toHaveCount(0);
    await expect(panel(page).getByRole('button', { name: 'Open change request', exact: true })).toBeEnabled();
  });

  test('Undo and reload block sending a cycle through a superclass intersection', async ({ page }) => {
    // Revalidation used to omit B's preserved (C and D) intersection and allow A -> B -> C -> A.
    await editView(page, (view) => {
      view.classes = ['A', 'B', 'C', 'D', 'E'].map((name) => ({
        iri: NS + name, kind: 'class', label: name.toLowerCase(), superClasses: name === 'A' ? [NS + 'B'] : [],
        equivalentClasses: [], disjointWith: [], restrictions: [],
        ...(name === 'B' ? { superClassConjuncts: [{ expression: '_:intersection', classes: [NS + 'C', NS + 'D'], restrictions: [] }] } : {}),
      }));
    });
    await openDiagram(page);
    const changeSuperclass = async (cls: string, parent: string) => {
      await panel(page).getByRole('button', { name: 'Change superclass', exact: true }).click();
      const f = form(page, 'Change superclass');
      await f.getByRole('combobox', { name: 'Class', exact: true }).selectOption(NS + cls);
      await f.getByRole('combobox', { name: 'New superclass', exact: true }).selectOption(NS + parent);
      await f.getByRole('button', { name: 'Add to proposal', exact: true }).click();
    };
    await changeSuperclass('C', 'A');
    await expect(form(page, 'Change superclass').getByRole('alert')).toContainText('one of its subclasses');
    await form(page, 'Change superclass').getByRole('button', { name: 'Cancel', exact: true }).click();
    await changeSuperclass('A', 'E');
    await changeSuperclass('C', 'A');
    await expect(panel(page).getByRole('button', { name: 'Open change request', exact: true })).toBeEnabled();
    await list(page).getByRole('button', { name: /^Undo: Make “a”/ }).click();
    await expect(list(page).getByRole('listitem')).toHaveCount(1);
    await expect(panel(page).getByRole('alert')).toContainText('one of its subclasses');
    await expect(panel(page).getByRole('button', { name: 'Open change request', exact: true })).toBeDisabled();
    await page.reload();
    await page.getByRole('button', { name: 'Review them', exact: true }).click();
    await expect(list(page).getByRole('listitem')).toHaveCount(1);
    await expect(panel(page).getByRole('alert')).toContainText('one of its subclasses');
    await expect(panel(page).getByRole('button', { name: 'Open change request', exact: true })).toBeDisabled();
  });

  test('adding a superclass keeps a parent from another vocabulary', async ({ page }) => {
    // The form built the new superclass list from the diagram's parents, which leave out classes from
    // other vocabularies, so "As well as" used to propose dropping them. The demo has no such parent,
    // so the page is given one: volunteer is also a schema.org Person.
    const EXTERNAL = 'https://schema.org/Person';
    await editView(page, (view) => {
      for (const c of view.classes) if (c.iri === NS + 'Volunteer') c.superClasses = [...c.superClasses, EXTERNAL];
    });
    const id = await openDiagram(page);
    await panel(page).getByRole('button', { name: 'Change superclass', exact: true }).click();
    const f = form(page, 'Change superclass');
    await f.getByRole('combobox', { name: 'Class', exact: true }).selectOption(NS + 'Volunteer');
    await f.getByRole('combobox', { name: 'New superclass', exact: true }).selectOption(NS + 'Agent');
    await f.getByRole('radio', { name: /^As well as / }).check();
    await f.getByRole('button', { name: 'Add to proposal', exact: true }).click();
    await panel(page).getByRole('button', { name: 'Open change request', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${id}/changes/`));
    const cr = await (await page.request.get(`/api/change-requests/${page.url().split('/').pop()}`)).json();
    expect(cr.ops).toEqual([{ op: 'setSuperClasses', iri: NS + 'Volunteer', superClasses: [NS + 'Person', EXTERNAL, NS + 'Agent'] }]);
  });

  test('diagram picking fills the last focused class field and Cancel returns focus', async ({ page }) => {
    await openDiagram(page);
    await diagram(page).getByRole('button', { name: /^person(?:\.|$)/ }).click();
    await panel(page).getByRole('button', { name: 'Add relationship', exact: true }).click();
    const f = form(page, 'Add relationship');
    await expect(f.getByRole('combobox', { name: 'From', exact: true })).toHaveValue(NS + 'Person');
    await f.getByRole('combobox', { name: 'To', exact: true }).focus();
    await diagram(page).getByRole('button', { name: /^session(?:\.|$)/ }).click();
    await expect(f.getByRole('combobox', { name: 'To', exact: true })).toHaveValue(NS + 'Session');
    await expect(f.getByRole('combobox', { name: 'From', exact: true })).toHaveValue(NS + 'Person');
    await f.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(panel(page).getByRole('button', { name: 'Add relationship', exact: true })).toBeFocused();
    const name = `picked coordinator ${uniq()}`;
    await addClass(page, name);
    await panel(page).getByRole('button', { name: 'Add attribute', exact: true }).click();
    await diagram(page).getByRole('button', { name: new RegExp(`^${name} \\(proposed\\)`) }).click();
    await expect(form(page, 'Add attribute').getByRole('combobox', { name: 'Class', exact: true })).toHaveValue(/Coordinator/);
    await expect(page).not.toHaveURL(/term=.*Coordinator/);
  });

  test('empty fields and an existing term clash are refused before any request is sent', async ({ page }) => {
    await openDiagram(page);
    let sent = 0;
    page.on('request', (r) => { if (r.method() === 'POST' && /\/change-requests$/.test(r.url())) sent++; });
    await panel(page).getByRole('button', { name: 'Add class', exact: true }).click();
    const f = form(page, 'Add class');
    await f.getByRole('button', { name: 'Add to proposal', exact: true }).click();
    await expect(f.getByRole('alert')).toContainText('Enter a label and a definition.');
    await f.getByLabel('Label', { exact: true }).fill('PERSON');
    await f.getByLabel('Definition', { exact: true }).fill('A person who already exists in the ontology.');
    await f.getByRole('button', { name: 'Add to proposal', exact: true }).click();
    await expect(f.getByRole('alert')).toContainText('already used');
    await f.getByRole('button', { name: 'Name in the IRI', exact: true }).click();
    await expect(f.getByLabel('Local name', { exact: true })).toHaveValue('PERSON');
    await expect(list(page).getByRole('listitem')).toHaveCount(0);
    expect(sent).toBe(0);
  });

  test('attributes and superclass changes preview their counts and full parents, refusing cycles', async ({ page }) => {
    const id = await openDiagram(page);
    const attribute = `start date ${uniq()}`;
    await panel(page).getByRole('button', { name: 'Add attribute', exact: true }).click();
    const f = form(page, 'Add attribute');
    await f.getByRole('combobox', { name: 'Class', exact: true }).selectOption(NS + 'Session');
    await f.getByLabel('Label', { exact: true }).fill(attribute);
    await f.getByLabel('Definition', { exact: true }).fill('The date on which the session starts.');
    await f.getByRole('combobox', { name: 'Type', exact: true }).selectOption({ label: 'date' });
    await f.getByRole('combobox', { name: 'How many', exact: true }).selectOption({ label: 'Exactly one' });
    await f.getByRole('button', { name: 'Add to proposal', exact: true }).click();
    await expect(diagram(page).getByRole('button', { name: /^session(?:\.|$)/ })).toContainText(`${attribute} : Date [1] (proposed)`);
    await panel(page).getByRole('button', { name: 'Change superclass', exact: true }).click();
    const s = form(page, 'Change superclass');
    await s.getByRole('combobox', { name: 'Class', exact: true }).selectOption(NS + 'Person');
    await s.getByRole('combobox', { name: 'New superclass', exact: true }).selectOption(NS + 'Volunteer');
    await s.getByRole('button', { name: 'Add to proposal', exact: true }).click();
    await expect(s.getByRole('alert')).toContainText('one of its subclasses');
    await s.getByRole('combobox', { name: 'Class', exact: true }).selectOption(NS + 'Volunteer');
    await s.getByRole('combobox', { name: 'New superclass', exact: true }).selectOption(NS + 'Agent');
    await s.getByRole('radio', { name: 'As well as person', exact: true }).check();
    await s.getByRole('button', { name: 'Add to proposal', exact: true }).click();
    await expect(list(page)).toContainText('Make “volunteer” a subclass of “person” and “agent”');
    await panel(page).getByRole('button', { name: 'Change superclass', exact: true }).click();
    await s.getByRole('combobox', { name: 'Class', exact: true }).selectOption(NS + 'Volunteer');
    await s.getByRole('combobox', { name: 'New superclass', exact: true }).selectOption(NS + 'Session');
    await s.getByRole('radio', { name: 'Instead of person and agent', exact: true }).check();
    await s.getByRole('button', { name: 'Add to proposal', exact: true }).click();
    await expect(diagram(page).getByRole('button', { name: /^volunteer(?:\.|$)/ })).toHaveAccessibleName(/subclass of session/);
    await panel(page).getByRole('button', { name: 'Open change request', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${id}/changes/`));
    const cr = await (await page.request.get(`/api/change-requests/${page.url().split('/').pop()}`)).json();
    expect(cr.ops.map((op: { op: string }) => op.op)).toEqual(['addDatatypeProperty', 'addRestriction', 'setSuperClasses', 'setSuperClasses']);
    expect(cr.ops.at(-1).superClasses).toEqual([NS + 'Session']);
  });

  test('server errors retain the proposal and its title for retry', async ({ page, consoleGuard }) => {
    consoleGuard.allow(/status of 422/);
    await openDiagram(page);
    const name = `retry coordinator ${uniq()}`;
    await addClass(page, name);
    await panel(page).getByLabel('Title', { exact: true }).fill('My proposal title');
    await page.route('**/api/ontologies/*/change-requests', (route) => route.request().method() === 'POST' ? route.fulfill({ status: 422, json: { error: 'Please review the proposal.' } }) : route.continue());
    await panel(page).getByRole('button', { name: 'Open change request', exact: true }).click();
    await expect(panel(page).getByRole('alert')).toContainText('Please review the proposal.');
    await expect(list(page).getByRole('listitem')).toHaveCount(1);
    await expect(panel(page).getByLabel('Title', { exact: true })).toHaveValue('My proposal title');
    await expect(panel(page).getByRole('button', { name: 'Open change request', exact: true })).toBeEnabled();
  });

  test('proposal forms still work when local storage is unavailable', async ({ page }) => {
    await page.addInitScript(() => {
      for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
        const original = Storage.prototype[method];
        Object.defineProperty(Storage.prototype, method, { value: function (key: string, ...args: string[]) { if (key.startsWith('concord.diagramProposals.')) throw new Error('Storage blocked'); return Reflect.apply(original, this, [key, ...args]); } });
      }
    });
    await openDiagram(page);
    await addClass(page, `unstored coordinator ${uniq()}`);
    await expect(list(page).getByRole('listitem')).toHaveCount(1);
  });

  test('sign-out clears saved proposals for every ontology and account switching clears the previous draft', async ({ page }) => {
    await openDiagram(page);
    await addClass(page, `private coordinator ${uniq()}`);
    const { id } = await demoOntology(page.request);
    await page.evaluate(() => localStorage.setItem('concord.diagramProposals.another.ontology', '{}'));
    await signIn(page, { name: `Another proposer ${uniq()}`, role: 'member' });
    // SessionProvider observes account changes when the tab regains focus.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(panel(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Propose changes', exact: true }).click();
    await expect(list(page).getByRole('listitem')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('concord.diagramProposals.')))).toEqual([]);
    await addClass(page, `another coordinator ${uniq()}`);
    await page.getByRole('button', { name: /Another proposer/ }).click();
    await page.getByRole('navigation', { name: 'Account', exact: true }).getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL(/\/login/);
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('concord.diagramProposals.')))).toEqual([]);
    await page.goto(`/o/${id}/browse?view=diagram`);
    await expect(page).toHaveURL(/\/login/);
  });
});

test('signed-out visitors are asked to sign in and cannot POST structured diagram proposals', async ({ page }) => {
  const { id } = await demoOntology(page.request);
  await page.goto(`/o/${id}/browse?view=diagram`);
  await expect(page).toHaveURL(/\/login\?next=/);
  await expect(page.getByRole('button', { name: 'Propose changes', exact: true })).toHaveCount(0);
  const response = await page.request.post(`/api/ontologies/${id}/change-requests`, { data: { title: `Unauthorized ${uniq()}`, description: '', kind: 'feature', ops: [{ op: 'addClass', localName: `Unauthorized${uniq()}`, label: 'Unauthorized class', definition: 'A class that must never be created.' }], submit: true } });
  expect(response.status()).toBe(401);
});
