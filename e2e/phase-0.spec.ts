import type { Page } from '@playwright/test';
import { test, expect, signIn, signInAsPersona, demoOntology, settle, uniq } from './fixtures';

async function ontology(page: Page) {
  const r = await page.request.post('/api/ontologies', { data: { title: `Tidy demo ${uniq()}`, prefix: `td${uniq()}` } });
  expect(r.status()).toBe(201);
  return r.json();
}

async function draft(page: Page, id: string, title: string) {
  const r = await page.request.post(`/api/ontologies/${id}/change-requests`, { data: { title, description: 'Regression check', kind: 'editorial' } });
  expect(r.status()).toBe(201);
  return r.json();
}

// Fresh testers cannot sign back in by persona ID. Keep their original session instead.
async function rememberSession(page: Page) {
  const cookies = (await page.context().cookies()).filter((c) => c.name === 'concord_session');
  return async () => {
    await page.context().clearCookies({ name: 'concord_session' });
    await page.context().addCookies(cookies);
  };
}

test('the first interview answer gives an untouched default title a useful name', async ({ page, request }) => {
  // Abandoned interviews used to retain titles such as "Tom Okafor's use case".
  const demo = await demoOntology(request);
  await signIn(page, { name: `Interview ${uniq()}`, role: 'contributor' });
  await page.goto(`/o/${demo.id}/use-cases`);
  await page.getByRole('button', { name: 'Describe a use case' }).click();
  const answer = `Find local volunteering opportunities for students ${uniq()}. Then apply.`;
  await page.getByRole('textbox', { name: 'Type your answer, or tap the mic and talk…' }).fill(answer);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('heading', { name: answer.split('.')[0], exact: true })).toBeVisible();
});

test('Open lists exclude withdrawn items and other people’s draft use cases', async ({ page }) => {
  // Shared unfinished interviews and smoke withdrawals used to clutter the default lists.
  await signIn(page, { name: `Author ${uniq()}`, role: 'owner' });
  const asOwner = await rememberSession(page);
  const o = await ontology(page);
  const cr = await draft(page, o.id, `Withdrawn change ${uniq()}`);
  expect((await page.request.post(`/api/change-requests/${cr.id}/withdraw`)).ok()).toBeTruthy();
  const s = await (await page.request.post(`/api/ontologies/${o.id}/interviews`, { data: {} })).json();
  const title = `Unfinished interview ${uniq()}`;
  expect((await page.request.patch(`/api/use-cases/${s.useCaseId}`, { data: { sections: { name: title } } })).ok()).toBeTruthy();
  expect((await page.request.post(`/api/use-cases/${s.useCaseId}/visibility`, { data: { visibility: 'group' } })).ok()).toBeTruthy();
  const withdrawn = await (await page.request.post(`/api/ontologies/${o.id}/interviews`, { data: {} })).json();
  const withdrawnTitle = `Withdrawn interview ${uniq()}`;
  expect((await page.request.patch(`/api/use-cases/${withdrawn.useCaseId}`, { data: { sections: { name: withdrawnTitle } } })).ok()).toBeTruthy();
  expect((await page.request.post(`/api/use-cases/${withdrawn.useCaseId}/visibility`, { data: { visibility: 'group' } })).ok()).toBeTruthy();
  expect((await page.request.post(`/api/use-cases/${withdrawn.useCaseId}/withdraw`)).ok()).toBeTruthy();
  const viewer = await signIn(page, { name: `Reader ${uniq()}`, role: 'member' });
  const asViewer = await rememberSession(page);
  await asOwner();
  expect((await page.request.put(`/api/ontologies/${o.id}/members/${viewer.user.id}`, { data: { roles: ['member'] } })).ok()).toBeTruthy();
  await asViewer();
  await page.goto(`/o/${o.id}/use-cases`);
  await settle(page);
  await expect(page.getByRole('link', { name: title })).toHaveCount(0);
  await expect(page.getByRole('link', { name: withdrawnTitle })).toHaveCount(0);
  await page.goto(`/o/${o.id}/changes`);
  await settle(page);
  await expect(page.getByRole('link', { name: new RegExp(cr.title) })).toHaveCount(0);
  // Authors can still find their own unfinished work.
  await asOwner();
  await page.goto(`/o/${o.id}/use-cases`);
  await expect(page.getByRole('link', { name: title })).toBeVisible();
});

test('draft changes stay out of the header count and only my drafts appear on Overview', async ({ page }) => {
  // The header counted drafts while Overview said nothing was in progress.
  await signIn(page, { name: `Owner ${uniq()}`, role: 'owner' });
  const asOwner = await rememberSession(page);
  const o = await ontology(page);
  const mine = await draft(page, o.id, `My draft ${uniq()}`);
  await signIn(page, { name: `Other author ${uniq()}`, role: 'contributor' });
  const other = await draft(page, o.id, `Other draft ${uniq()}`);
  await asOwner();
  await page.goto(`/o/${o.id}`);
  await expect(page.getByRole('link', { name: /^\d+ open changes?$/ })).toHaveCount(0);
  const changes = page.getByRole('table', { name: 'Changes in progress' });
  await expect(changes.getByRole('row').filter({ hasText: mine.title })).toContainText('Your draft');
  await expect(changes.getByText(other.title)).toHaveCount(0);
  await page.goto(`/o/${o.id}/changes`);
  for (const cr of [mine, other]) await expect(page.getByRole('link', { name: new RegExp(cr.title) })).toContainText('Draft');
});

test('large member lists have a short ordered summary and a searchable panel', async ({ page }) => {
  // Governance printed every member name inline and offered no way to find one.
  const owner = await signIn(page, { name: `Chair ${uniq()}`, role: 'owner' });
  const asOwner = await rememberSession(page);
  const o = await ontology(page);
  const first = (await signIn(page, { name: `Participant 0 ${uniq()}`, role: 'member' })).user;
  const asMember = await rememberSession(page);
  const people = [first];
  for (let i = 1; i < 13; i++) people.push((await signIn(page, { name: `Participant ${i} ${uniq()}`, role: 'member' })).user);
  await asOwner();
  for (const p of people) expect((await page.request.put(`/api/ontologies/${o.id}/members/${p.id}`, { data: { roles: ['member'] } })).ok()).toBeTruthy();
  await page.goto(`/o/${o.id}/governance`);
  const members = page.locator('#roles');
  await expect(members.getByRole('button', { name: /Members and roles/ })).toHaveAccessibleDescription(new RegExp(`14 members: ${owner.user.name}.*and 6 others`));
  await members.getByRole('button', { name: /Members and roles/ }).click();
  await members.getByRole('searchbox', { name: 'Find a member' }).fill(people[0].name);
  await expect(members.getByText(people[0].name, { exact: true })).toBeVisible();
  await expect(members.getByText(people[1].name, { exact: true })).toHaveCount(0);
  await asMember();
  // A hash-only goto keeps the single-page app (and the owner's session) alive, so load the page afresh.
  await page.goto('/');
  await page.goto(`/o/${o.id}/governance`);
  await expect(page.getByText('Viewing as')).toContainText(first.name);
  await members.getByRole('button', { name: /Members and roles/ }).click();
  await members.getByRole('searchbox', { name: 'Find a member' }).fill(owner.user.name);
  await expect(members.getByText(owner.user.name, { exact: true })).toBeVisible();
  await expect(members.getByRole('button', { name: 'Edit roles' })).toHaveCount(0);
});

test('future activity uses a date and sorts newest first on home and Overview', async ({ page, request }) => {
  // A future timestamp used to read "next week" or "in 22 hours".
  const demo = await demoOntology(request);
  await signInAsPersona(page, 'Tom Okafor');
  const session = await (await page.request.get('/api/session')).json();
  const future = new Date(Date.parse(session.now) + 7 * 86400e3);
  const older = new Date(future.getTime() - 86400e3);
  await page.route('**/api/activity*', (route) => route.fulfill({ json: [
    { id: 'earlier', ontologyId: demo.id, at: older.toISOString(), message: 'Earlier future event', type: 'test' },
    { id: 'later', ontologyId: demo.id, at: future.toISOString(), message: 'Latest future event', type: 'test' },
  ] }));
  for (const path of ['/', `/o/${demo.id}`]) {
    await page.goto(path);
    const feed = page.getByRole('list').filter({ hasText: 'Latest future event' });
    await expect(feed.getByRole('listitem').first()).toContainText('Latest future event');
    await expect(feed).toContainText(future.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }));
    await expect(feed).not.toContainText(/next week|in \d+/);
  }
});

for (const width of [1280, 390]) test(`the minimised walkthrough is compact and leaves the footer clear at ${width}px`, async ({ page }) => {
  // The old fixed box covered the end of every page, especially on a phone.
  await signIn(page, { name: `Guide ${uniq()}`, role: 'member' });
  await page.setViewportSize({ width, height: 844 });
  await page.goto('/');
  const guide = page.getByRole('button', { name: 'Walkthrough, step 1 of 5', exact: true });
  await expect(guide).toBeVisible();
  await settle(page);
  const box = (await guide.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(width < 768 ? 44 : 190);
  expect(box.height).toBeLessThanOrEqual(44);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const footer = (await page.getByRole('contentinfo').boundingBox())!;
  expect(footer.y + footer.height).toBeLessThanOrEqual(box.y + 1);
  await guide.click();
  await expect(page.getByRole('complementary').filter({ hasText: 'Alpha walkthrough' })).toBeVisible();
  await page.getByRole('button', { name: 'Close walkthrough' }).click();
  await expect(guide).toBeVisible();
});

test('phone navigation reveals the active tabs and the persona banner stays on one line', async ({ page, request }) => {
  // Governance was off screen and the full role list wrapped over three lines.
  const demo = await demoOntology(request);
  await signInAsPersona(page, 'Tom Okafor');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/o/${demo.id}/governance`);
  const nav = page.getByRole('navigation', { name: 'Ontology sections' });
  const active = nav.getByRole('link', { name: 'Governance', exact: true });
  await expect(active).toBeInViewport({ ratio: 1 });
  await expect(nav).toHaveAttribute('data-more-before', 'true');
  const banner = page.getByTestId('demo-persona');
  // Flex gaps used to leave no actual space between "Viewing as" and the name.
  await expect(banner).toContainText('Viewing as Tom Okafor');
  expect((await banner.boundingBox())!.height).toBeLessThan(30);
  await expect(banner.getByRole('button', { name: /switch role.*Editor.*Reviewer.*Voting member/i })).toBeVisible();
  await page.goto(`/o/${demo.id}/connect`);
  const pages = page.getByRole('navigation', { name: 'Explore pages' });
  await expect(pages.getByRole('link', { name: 'Connect an agent', exact: true })).toBeInViewport({ ratio: 1 });
  await expect(pages).toHaveAttribute('data-more-before', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('a withdrawn request names its outcome and actor above Approval details', async ({ page }) => {
  // Closed Decision cards said only "Next: No further action" and "No actions".
  const author = await signIn(page, { name: `Withdrawer ${uniq()}`, role: 'owner' });
  const o = await ontology(page);
  const cr = await draft(page, o.id, `Outcome ${uniq()}`);
  await page.goto(`/o/${o.id}/changes/${cr.id}`);
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Withdraw', exact: true }).click();
  await expect(page.getByText(new RegExp(`Withdrawn by ${author.user.name} on`))).toBeVisible();
  await expect(page.getByText(/Next: No further action|No actions/)).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Your actions' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Approval details' }).click();
  await expect(page.getByText('Rules for a', { exact: false })).toBeVisible();
});

test('Import an ontology has the secondary button treatment and opens the dialog', async ({ page, request }) => {
  // The import control was styled as plain text.
  const demo = await demoOntology(request);
  await signInAsPersona(page, 'Aisha Rahman');
  await page.goto(`/o/${demo.id}`);
  const button = page.getByRole('button', { name: 'Import an ontology', exact: true });
  expect(await button.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('solid');
  expect(await button.evaluate((el) => getComputedStyle(el).borderTopColor)).not.toBe('rgba(0, 0, 0, 0)');
  await button.click();
  await expect(page.getByRole('dialog', { name: 'Import an ontology' })).toBeVisible();
});

test('Browse starts with counts, linked top-level classes and a Diagram control', async ({ page, request }) => {
  // The details panel used to start as an empty dashed "Pick a term" box.
  const demo = await demoOntology(request);
  await signInAsPersona(page, 'Tom Okafor');
  const v = await (await page.request.get(`/api/ontologies/${demo.id}/view`)).json() as import('@concord/shared').OntologyView;
  await page.goto(`/o/${demo.id}/browse`);
  const summary = page.getByRole('region', { name: 'Ontology summary' });
  await expect(summary).toContainText(`${v.classes.length} classes and ${v.objectProperties.length + v.datatypeProperties.length} properties.`);
  const links = summary.getByRole('link');
  expect(await links.count()).toBeGreaterThan(0);
  expect(await links.count()).toBeLessThanOrEqual(12);
  await expect(summary.getByRole('term')).toHaveCount(await links.count());
  const iris = await links.evaluateAll((els) => els.map((el) => new URL((el as HTMLAnchorElement).href).searchParams.get('term')));
  const properties = [...v.objectProperties, ...v.datatypeProperties];
  const counts = iris.map((iri) => {
    const c = v.classes.find((c) => c.iri === iri)!;
    expect([...c.superClasses, ...(c.superClassConjuncts ?? []).flatMap((x) => x.classes)].every((p) => p === 'http://www.w3.org/2002/07/owl#Thing')).toBe(true);
    return properties.filter((p) => p.domain.includes(c.iri) || p.range.includes(c.iri)).length;
  });
  expect(counts).toEqual([...counts].sort((a, b) => b - a));
  await links.first().click();
  await expect(page).toHaveURL(/term=/);
  await page.goto(`/o/${demo.id}/browse`);
  await page.getByRole('button', { name: 'Show the diagram' }).click();
  await expect(page.getByRole('radio', { name: 'Diagram', exact: true })).toBeChecked();
});

for (const count of [10, 12, 13, 75]) test(`Browse shows up to twelve definitions when all ${count} classes are roots`, async ({ page }) => {
  // The summary used to stop at eight classes and join labels to definitions with a full stop.
  await signIn(page, { name: `Flat vocabulary ${uniq()}`, role: 'owner' });
  const o = await ontology(page);
  const response = await page.request.get(`/api/ontologies/${o.id}/view`);
  expect(response.ok()).toBeTruthy();
  const view = await response.json() as import('@concord/shared').OntologyView;
  view.objectProperties = [];
  view.datatypeProperties = [];
  const prefix = `Root ${uniq()}`;
  view.classes = Array.from({ length: count }, (_, i) => ({
    kind: 'class', iri: `https://example.org/${o.id}/Root${i}`, label: `${prefix} ${String(i).padStart(2, '0')}`,
    definition: `A definition for root ${i}. More detail belongs on the term page.`,
    superClasses: [], equivalentClasses: [], disjointWith: [], restrictions: [],
  }));
  await page.route(`**/api/ontologies/${o.id}/view*`, (route) => route.fulfill({ json: view }));
  await page.goto(`/o/${o.id}/browse`);
  const summary = page.getByRole('region', { name: 'Ontology summary' });
  const shown = Math.min(count, 12);
  await expect(summary).toContainText(`${count} classes and 0 properties.`);
  await expect(summary.getByRole('link')).toHaveCount(shown);
  await expect(summary.getByRole('term')).toHaveText(view.classes.slice(0, shown).map((c) => c.label!));
  await expect(summary.getByRole('definition')).toHaveText(Array.from({ length: shown }, (_, i) => `A definition for root ${i}.`));
  await expect(summary).not.toContainText('More detail belongs on the term page.');
  if (count > shown) await expect(summary.getByText(`and ${count - shown} more in the list`, { exact: true })).toBeVisible();
  else await expect(summary.getByText(/and \d+ more in the list/)).toHaveCount(0);
  const termBox = (await summary.getByRole('term').first().boundingBox())!;
  const definitionBox = (await summary.getByRole('definition').first().boundingBox())!;
  expect(definitionBox.y).toBeGreaterThanOrEqual(termBox.y + termBox.height - 1);
  await summary.getByRole('link').first().click();
  await expect(page).toHaveURL(new RegExp(`term=${encodeURIComponent(view.classes[0].iri)}$`));
  await expect(page.getByRole('heading', { name: view.classes[0].label, exact: true })).toBeVisible();
});

test('only people who can publish see a waiting draft release on Overview', async ({ page, request }) => {
  // A nonempty draft release waited silently, even for its steward.
  const demo = await demoOntology(request);
  await signInAsPersona(page, 'Priya Shah');
  const releases = await (await page.request.get(`/api/ontologies/${demo.id}/releases`)).json();
  const waiting = releases.find((r: { status: string; changeRequestIds: string[] }) => r.status === 'draft' && r.changeRequestIds.length);
  expect(waiting).toBeTruthy();
  // An empty draft is a possible old or imported record, but never waiting work.
  await page.route(`**/api/ontologies/${demo.id}/releases`, (route) => route.fulfill({ json: [...releases, { ...waiting, id: `empty-${uniq()}`, version: '9.9.9', changeRequestIds: [] }] }));
  await page.goto(`/o/${demo.id}`);
  await expect(page.getByRole('link', { name: /^Review draft release v9\.9\.9/ })).toHaveCount(0);
  const name = `Review draft release v${waiting.version} (${waiting.changeRequestIds.length} change${waiting.changeRequestIds.length === 1 ? '' : 's'})`;
  await page.getByRole('link', { name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/releases/${waiting.id}$`));
  await expect(page.getByRole('button', { name: `Publish v${waiting.version}` })).toBeEnabled();
  await signInAsPersona(page, 'Tom Okafor');
  await page.goto(`/o/${demo.id}`);
  await settle(page);
  await expect(page.getByRole('link', { name, exact: true })).toHaveCount(0);
});

test('Health counts questions without executable tests and keeps the detail accessible', async ({ page }) => {
  // Health said "none yet" when use cases had questions without SPARQL.
  await signIn(page, { name: `Questions ${uniq()}`, role: 'owner' });
  const o = await ontology(page);
  const s = await (await page.request.post(`/api/ontologies/${o.id}/interviews`, { data: {} })).json();
  expect((await page.request.patch(`/api/use-cases/${s.useCaseId}`, { data: { competencyQuestions: [
    { id: `cq${uniq()}`, question: 'Which shifts need volunteers?', status: 'untested' },
    { id: `cq${uniq()}`, question: 'Where are they?', status: 'untested' },
  ] } })).ok()).toBeTruthy();
  await page.goto(`/o/${o.id}`);
  const questions = page.locator('#health').getByRole('button', { name: /^Competency questions/ });
  await expect(questions).toContainText('2 questions, none tested yet');
  await questions.click();
  await expect(page.getByText(/Questions without a SPARQL test/)).toBeVisible();
});
