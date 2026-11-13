import type { ChangeRequestDetail, OntologyProject, Role } from '@concord/shared';
import type { Page } from '@playwright/test';
import { test, expect, demoOntology, settle, signIn, uniq } from './fixtures';

async function person(page: Page, label: string, role: Role) {
  const { user } = await signIn(page, { name: `${label} ${uniq()}`, role });
  const cookies = (await page.context().cookies()).filter((c) => c.name === 'concord_session');
  return { ...user, async restore() {
    await page.context().clearCookies({ name: 'concord_session' });
    await page.context().addCookies(cookies);
  } };
}

async function project(page: Page) {
  const response = await page.request.post('/api/ontologies', { data: { title: `Review regressions ${uniq()}`, description: 'Checks who made each decision.', prefix: `rr${uniq()}` } });
  expect(response.status()).toBe(201);
  const o = await response.json() as OntologyProject;
  o.governance.requireValidation = false;
  o.governance.automation.autoDraftRelease = false;
  for (const rule of Object.values(o.governance.changes)) Object.assign(rule, {
    minApprovals: 1, reviewPeriodDays: 0, autoMerge: false, lazyConsensus: false,
    approverRoles: ['owner', 'editor', 'reviewer'], vetoRoles: ['owner'], vote: undefined,
  });
  expect((await page.request.put(`/api/ontologies/${o.id}/governance`, { data: { policy: o.governance } })).ok()).toBeTruthy();
  return o;
}

async function addMember(page: Page, id: string, userId: string, roles: Role[]) {
  expect((await page.request.put(`/api/ontologies/${id}/members/${userId}`, { data: { roles } })).ok()).toBeTruthy();
}

async function change(page: Page, o: OntologyProject) {
  const response = await page.request.post(`/api/ontologies/${o.id}/change-requests`, { data: {
    title: `Reviewed change ${uniq()}`, description: 'Check who made the decision.', kind: 'editorial',
    ops: [{ op: 'addClass', localName: 'Reviewed', label: 'Reviewed', definition: 'A reviewed term.' }],
  } });
  expect(response.status()).toBe(201);
  return response.json() as Promise<ChangeRequestDetail>;
}

test('restricted activity cannot reorder the member summary for an outside viewer', async ({ page }) => {
  // A group-only action used to move its author above other members even for an outside contributor.
  const owner = await person(page, 'Owner', 'owner');
  const o = await project(page);
  const author = await person(page, 'Private author', 'member');
  const peer = await person(page, 'Visible peer', 'member');
  const outsider = await person(page, 'Outside contributor', 'contributor');
  await owner.restore();
  for (const p of [author, peer]) await addMember(page, o.id, p.id, ['member']);
  await addMember(page, o.id, outsider.id, ['contributor']);
  await peer.restore();
  expect((await page.request.post('/api/simulation/clock', { data: { advanceDays: 1 } })).ok()).toBeTruthy();
  await change(page, o); // Public, attributed activity places the peer first among voting members.
  await outsider.restore();
  await page.goto(`/o/${o.id}/governance`);
  const summary = page.locator('#roles').getByRole('button', { name: /Members and roles/ });
  await expect(summary).toHaveAccessibleDescription(new RegExp(`${peer.name}.*${author.name}`));
  const descriptionId = await summary.getAttribute('aria-describedby');
  const outsideSummary = (await page.locator(`[id="${descriptionId}"]`).innerText()).replace(/\s+/g, ' ').trim();
  await author.restore();
  expect((await page.request.post('/api/simulation/clock', { data: { advanceDays: 1 } })).ok()).toBeTruthy();
  const interview = await page.request.post(`/api/ontologies/${o.id}/interviews`, { data: {} });
  expect(interview.ok()).toBeTruthy();
  const { useCaseId } = await interview.json();
  expect((await page.request.post(`/api/use-cases/${useCaseId}/visibility`, { data: { visibility: 'group' } })).ok()).toBeTruthy();
  await outsider.restore();
  await page.reload();
  await expect(summary).toHaveAccessibleDescription(outsideSummary);
  await peer.restore();
  await page.reload();
  await expect(summary).toHaveAccessibleDescription(new RegExp(`${author.name}.*${peer.name}`));
  await expect(page.locator('#roles').getByRole('button', { name: 'Edit roles' })).toHaveCount(0);
});

test('phone Health anchor stays in view when the cached tab strip resizes', async ({ page, request }) => {
  // scrollIntoView on a tab used to pull the document back to the header after Health received focus.
  const demo = await demoOntology(request);
  await signIn(page, { name: `Health reader ${uniq()}`, role: 'member' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/o/${demo.id}`);
  await settle(page);
  await page.getByRole('navigation', { name: 'Ontology sections' }).getByRole('link', { name: 'Explore', exact: true }).click();
  await page.getByRole('button', { name: /^Health: / }).click();
  await page.getByRole('dialog', { name: /^Health: / }).getByRole('link', { name: /full report/ }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${demo.id}#health$`));
  const health = page.locator('#health');
  await expect(health).toBeFocused();
  await settle(page);
  await page.evaluate(() => document.fonts.ready);
  // A resize after cached content mounts also covers delayed font/layout changes.
  await page.setViewportSize({ width: 389, height: 844 });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  await expect(health).toBeFocused();
  await expect(health.getByRole('heading', { name: 'Health of the working draft' })).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('a request for changes does not claim another owner’s veto', async ({ page }) => {
  // The decision used to credit the first owner to request changes instead of the actual objector.
  const author = await person(page, 'Author', 'owner');
  const o = await project(page);
  const requester = await person(page, 'Requests changes', 'owner');
  const vetoer = await person(page, 'Vetoes', 'owner');
  const reader = await person(page, 'Reader', 'member');
  await author.restore();
  for (const p of [requester, vetoer]) await addMember(page, o.id, p.id, ['owner']);
  await addMember(page, o.id, reader.id, ['member']);
  const cr = await change(page, o);
  expect((await page.request.post(`/api/change-requests/${cr.id}/submit`)).ok()).toBeTruthy();
  await requester.restore();
  await page.goto(`/o/${o.id}/changes/${cr.id}`);
  await page.getByRole('group', { name: 'Your actions' }).getByRole('button', { name: 'Request changes', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Status: Needs work/ })).toBeVisible();
  await vetoer.restore();
  await page.reload();
  await page.getByRole('group', { name: 'Your actions' }).getByRole('button', { name: 'Object', exact: true }).click();
  await expect(page.getByTestId('decision-outcome')).toContainText(`Rejected by ${vetoer.name} (owner veto) on`);
  await reader.restore();
  await page.reload();
  await expect(page.getByTestId('decision-outcome')).toContainText(`Rejected by ${vetoer.name} (owner veto) on`);
  await expect(page.getByRole('group', { name: 'Your actions' })).toHaveCount(0);
});

test('a merged change names its independent approver even after they leave', async ({ page }) => {
  // The merge summary used to name author and co-author approvals even though neither counted.
  const author = await person(page, 'Author', 'owner');
  const o = await project(page);
  const coauthor = await person(page, 'Co-author', 'editor');
  const approver = await person(page, 'Approver', 'reviewer');
  const reader = await person(page, 'Reader', 'member');
  await author.restore();
  await addMember(page, o.id, coauthor.id, ['editor']);
  await addMember(page, o.id, approver.id, ['reviewer']);
  await addMember(page, o.id, reader.id, ['member']);
  let cr = await change(page, o);
  await coauthor.restore();
  const edited = await page.request.patch(`/api/change-requests/${cr.id}`, { data: { ops: [
    { op: 'addClass', localName: 'Rewritten', label: 'Rewritten', definition: 'A rewritten term.' },
  ] } });
  expect(edited.ok()).toBeTruthy();
  cr = await edited.json();
  expect(cr.revisedBy).toContain(coauthor.id);
  expect((await page.request.post(`/api/change-requests/${cr.id}/submit`)).ok()).toBeTruthy();
  for (const p of [author, coauthor, approver]) {
    await p.restore();
    await page.goto('/'); // Refresh the client session when switching fresh testers.
    await page.goto(`/o/${o.id}/changes/${cr.id}`);
    await page.getByRole('group', { name: 'Your actions' }).getByRole('button', { name: 'Approve', exact: true }).click();
    if (p !== approver) await expect(page.getByRole('button', { name: /^Status: In review/ })).toBeVisible();
  }
  await author.restore();
  await page.reload();
  await page.getByRole('group', { name: 'Your actions' }).getByRole('button', { name: 'Merge into working draft', exact: true }).click();
  const outcome = page.getByTestId('decision-outcome');
  await expect(outcome).toContainText(`after sign-off from ${approver.name}.`);
  await expect(outcome).not.toContainText(author.name);
  await expect(outcome).not.toContainText(coauthor.name);
  // Live evaluation used to erase this historical sign-off when the member was removed.
  await page.goto(`/o/${o.id}/governance#roles`);
  const member = page.locator('#roles .divide-y > div').filter({ hasText: approver.name });
  page.once('dialog', (dialog) => void dialog.accept());
  await member.getByRole('button', { name: 'Remove member' }).click();
  await expect(member).toHaveCount(0);
  await page.goto(`/o/${o.id}/changes/${cr.id}`);
  await expect(outcome).toContainText(`after sign-off from ${approver.name}.`);
  await reader.restore();
  await page.reload();
  await expect(outcome).toContainText(`after sign-off from ${approver.name}.`);
  await expect(page.getByRole('group', { name: 'Your actions' })).toHaveCount(0);
});

test('a previous-version saved merged request opens while its refresh waits', async ({ page, request }) => {
  // IndexedDB details without approvedBy used to crash the page before fresh details arrived.
  const reader = await signIn(page, { name: `Saved change reader ${uniq()}`, role: 'member' });
  const o = await demoOntology(request);
  const response = await page.request.get(`/api/ontologies/${o.id}/change-requests`);
  const merged = (await response.json() as ChangeRequestDetail[]).find((c) => ['merged', 'released'].includes(c.status));
  expect(merged).toBeTruthy();
  const url = `/api/change-requests/${merged!.id}`;
  const legacy = await (await page.request.get(url)).json();
  delete legacy.governance.approvedBy;
  delete legacy.approvedAs;
  await page.goto('/');
  await settle(page);
  await page.evaluate(({ key, value }) => new Promise<void>((resolve, reject) => {
    const opening = indexedDB.open('concord-offline', 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore('kept');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const tx = db.transaction('kept', 'readwrite');
      tx.objectStore('kept').put({ value, at: Date.now() }, key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  }), { key: `${reader.user.id}|changeRequest|${merged!.id}`, value: legacy });
  let release!: () => void;
  const refreshing = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**${url}`, async (route) => { await refreshing; await route.continue(); });
  try {
    await page.goto(`/o/${o.id}/changes/${merged!.id}`);
    await expect(page.getByTestId('decision-outcome')).toHaveText(/^Merged on .+\.$/);
    await expect(page.getByTestId('decision-outcome')).not.toContainText('after sign-off');
    await expect(page.getByRole('group', { name: 'Your actions' })).toHaveCount(0);
    const refreshed = page.waitForResponse(`**${url}`);
    release();
    await refreshed;
  } finally {
    release();
  }
  await page.unroute(`**${url}`);
});

test('removing the person you searched for brings the rest of a now-small group back', async ({ page }) => {
  // With 13 members, finding one and removing them hid the search box (12 members need none) but kept
  // its text filtering the list: it said "No members match" with no way to clear it.
  const owner = await person(page, 'Owner', 'owner');
  const o = await project(page);
  const people = [];
  for (let i = 0; i < 12; i++) people.push(await person(page, `Member ${i}`, 'member'));
  await owner.restore();
  for (const p of people) await addMember(page, o.id, p.id, ['member']);
  await page.goto(`/o/${o.id}/governance#roles`);
  const members = page.locator('#roles');
  await members.getByRole('searchbox', { name: 'Find a member' }).fill(people[0].name);
  await expect(members.getByText(people[1].name, { exact: true })).toHaveCount(0);
  page.once('dialog', (d) => void d.accept());
  await members.getByRole('button', { name: 'Remove member' }).click();
  await expect(members.getByRole('searchbox', { name: 'Find a member' })).toHaveCount(0);
  await expect(members.getByText(people[0].name, { exact: true })).toHaveCount(0);
  await expect(members.getByText(people[1].name, { exact: true })).toBeVisible();
  await expect(members.getByText(owner.name, { exact: true })).toBeVisible();
  await expect(members.getByText('No members match.')).toHaveCount(0);
});

test('a veto stays with the person who made it when another objector later gains a veto role', async ({ page }) => {
  // The decision read today's roles: promote an earlier objector to owner and the closed request
  // said that person had vetoed it.
  const author = await person(page, 'Author', 'owner');
  const o = await project(page);
  const objector = await person(page, 'Objects as reviewer', 'reviewer');
  const vetoer = await person(page, 'Vetoes', 'owner');
  await author.restore();
  await addMember(page, o.id, objector.id, ['reviewer']);
  await addMember(page, o.id, vetoer.id, ['owner']);
  const cr = await change(page, o);
  expect((await page.request.post(`/api/change-requests/${cr.id}/submit`)).ok()).toBeTruthy();
  await objector.restore();
  await page.goto(`/o/${o.id}/changes/${cr.id}`);
  await page.getByRole('group', { name: 'Your actions' }).getByRole('button', { name: 'Object', exact: true }).click();
  await expect(page.getByText('You previously chose “object”.')).toBeVisible();
  await vetoer.restore();
  await page.reload();
  await page.getByRole('group', { name: 'Your actions' }).getByRole('button', { name: 'Object', exact: true }).click();
  await expect(page.getByTestId('decision-outcome')).toContainText(`Rejected by ${vetoer.name} (owner veto) on`);
  await author.restore();
  await addMember(page, o.id, objector.id, ['owner']);
  await page.reload();
  await expect(page.getByTestId('decision-outcome')).toContainText(`Rejected by ${vetoer.name} (owner veto) on`);
});
