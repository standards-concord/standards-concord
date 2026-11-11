import type { Meeting, OntologySummary } from '../packages/shared/src/index';
import type { APIRequestContext, Page, Route } from '@playwright/test';
import { test, expect, demoOntology, signIn, uniq } from './fixtures';
import { API_URL_B } from './api-servers';

test.skip(!API_URL_B, 'Requires E2E_API=vercel, E2E_DATABASE_URL and E2E_TWO_SERVERS=1 (two function processes on one Postgres database).');

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}

async function readMeeting(request: APIRequestContext, id: string): Promise<Meeting> {
  const response = await request.get(`${API_URL_B}/api/meetings/${id}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

async function nextLinesOnB(request: APIRequestContext, id: string, from: number) {
  let meeting!: Meeting;
  await expect.poll(async () => {
    meeting = await readMeeting(request, id);
    return meeting.transcript.length;
  }, { message: 'B has persisted more transcript lines while A cannot poll', timeout: 15_000 }).toBeGreaterThan(from);
  return meeting;
}

async function eachLineOnce(page: Page, meeting: Meeting) {
  for (const line of meeting.transcript) await expect(page.getByText(line.text, { exact: true })).toHaveCount(1);
}

test('a session created on A authenticates on B with the same user and cookie', async ({ page }) => {
  const { user } = await signIn(page, { name: `Two-server steward ${uniq()}`, role: 'steward' });
  // page.request shares the browser's cookie jar. Do not sign in again on B: the session
  // created through A's /api proxy must work in a different function process.
  const cookie = (await page.context().cookies()).find((c) => c.name === 'concord_session');
  expect(cookie).toBeDefined();
  const response = await page.request.get(`${API_URL_B}/api/session`);
  expect(response.ok(), await response.text()).toBeTruthy();
  expect((await response.json()).user.id).toBe(user.id);
  expect((await page.context().cookies()).find((c) => c.name === 'concord_session')?.value).toBe(cookie!.value);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible();
  await expect(page.getByRole('main').getByText(user.name, { exact: true })).toBeVisible();
});

// The old process-local stream missed lines written by another server. Hold A's polls
// while B carries on the simulation, then resume them to check cross-instance delivery.
test('lines persisted on B appear once on A, survive reload and a dropped update, and ending on B shows the summary', async ({ page, request, consoleGuard }) => {
  const ontology = await demoOntology(request);
  await signIn(page, { name: `Cross-instance facilitator ${uniq()}`, role: 'steward' });
  const response = await page.request.post(`${API_URL_B}/api/ontologies/${ontology.id}/meetings/simulate`, {
    data: { title: `Cross-instance live call ${uniq()}`, delayMs: 3000 },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const meeting = await response.json() as Meeting;
  const updates = `**/api/meetings/${meeting.id}/updates**`;
  const held = gate();
  const release = gate();
  const hold = async (route: Route) => { held.open(); await release.opened; await route.continue(); };
  await page.route(updates, hold);
  try {
    await page.goto(`/o/${ontology.id}/meetings/${meeting.id}`);
    await expect(page.getByText('Live', { exact: true })).toBeVisible();
    await held.opened;
    const before = await readMeeting(page.request, meeting.id);
    const onB = await nextLinesOnB(page.request, meeting.id, before.transcript.length);
    const arrived = page.waitForResponse((r) => r.url().includes(`/api/meetings/${meeting.id}/updates`) && r.ok());
    release.open();
    await arrived;
    // The assertions include every line read from B, rather than assuming demo transcript counts.
    await eachLineOnce(page, onB);
  } finally {
    release.open();
    await page.unroute(updates, hold);
  }

  const snapshot = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/meetings/${meeting.id}` && r.ok());
  await page.reload();
  const reloaded = await (await snapshot).json() as Meeting;
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await eachLineOnce(page, reloaded);

  const recoveryHeld = gate();
  const recover = gate();
  let dropped = false;
  const dropThenHold = async (route: Route) => {
    if (!dropped) { dropped = true; await route.abort('failed'); return; }
    recoveryHeld.open();
    await recover.opened;
    await route.continue();
  };
  // Only the deliberately aborted request's browser diagnostic is expected.
  consoleGuard.allow(/^Failed to load resource: net::ERR_FAILED$/);
  const failed = page.waitForEvent('requestfailed', (r) => r.url().includes(`/api/meetings/${meeting.id}/updates`));
  await page.route(updates, dropThenHold);
  try {
    const droppedRequest = await failed;
    const cursor = new URL(droppedRequest.url()).searchParams.get('from');
    expect(Number(cursor)).toBeGreaterThanOrEqual(reloaded.transcript.length);
    await recoveryHeld.opened;
    const before = await readMeeting(page.request, meeting.id);
    const onB = await nextLinesOnB(page.request, meeting.id, before.transcript.length);
    const recovered = page.waitForResponse((r) => r.url().includes(`/api/meetings/${meeting.id}/updates`) && r.ok());
    recover.open();
    const update = await recovered;
    expect(new URL(update.url()).searchParams.get('from')).toBe(cursor);
    await eachLineOnce(page, onB);
  } finally {
    recover.open();
    await page.unroute(updates, dropThenHold);
  }

  const ended = await page.request.post(`${API_URL_B}/api/meetings/${meeting.id}/end`);
  expect(ended.ok(), await ended.text()).toBeTruthy();
  const final = await ended.json() as Meeting;
  expect(final.status).toBe('analysed');
  await expect(page.getByText('Live', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Summary', exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'End call and analyse' })).toHaveCount(0);
  await page.getByRole('radio', { name: 'Transcript', exact: true }).click();
  await eachLineOnce(page, final);
  await expect(page.locator('[id^="line-"]')).toHaveCount(final.transcript.length);
  // A subsequent successful poll and the summary reload must not have appended duplicates in storage either.
  expect((await readMeeting(page.request, meeting.id)).transcript).toEqual(final.transcript);
});

test('a contributor cannot follow a live call’s updates on either A or B', async ({ page, request }) => {
  const ontology = await demoOntology(request);
  await signIn(page, { name: `Call owner ${uniq()}`, role: 'steward' });
  const response = await page.request.post(`${API_URL_B}/api/ontologies/${ontology.id}/meetings/simulate`, {
    data: { title: `Private cross-instance call ${uniq()}`, delayMs: 60_000 },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const meeting = await response.json() as Meeting;
  // The owner can follow the call on both servers first, so the contributor's 404s below come from
  // the role check and not from A failing to find a call that was started on B.
  for (const base of ['', API_URL_B!]) {
    const owned = await page.request.get(`${base}/api/meetings/${meeting.id}/updates?from=0`);
    expect(owned.ok(), await owned.text()).toBeTruthy();
    expect(((await owned.json()) as { meeting: Meeting }).meeting.id).toBe(meeting.id);
  }
  const ownerCookies = await page.context().cookies();
  try {
    await signIn(page, { name: `Cross-instance contributor ${uniq()}`, role: 'contributor' });
    for (const base of ['', API_URL_B!]) {
      expect((await page.request.get(`${base}/api/meetings/${meeting.id}/updates?from=0`)).status()).toBe(404);
    }
  } finally {
    await page.context().addCookies(ownerCookies);
    const ended = await page.request.post(`${API_URL_B}/api/meetings/${meeting.id}/end`);
    expect(ended.ok(), await ended.text()).toBeTruthy();
  }
});

test('a governance policy saved on B is visible on A’s already-used ontology without restarting either server', async ({ page }) => {
  await signIn(page, { name: `Policy owner ${uniq()}`, role: 'steward' });
  const suffix = uniq();
  const created = await page.request.post('/api/ontologies', {
    data: { title: `Cross-instance policy ${suffix}`, prefix: `cs${suffix}`, governanceTemplate: 'steward-led' },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const ontology = await created.json() as OntologySummary;
  await page.goto(`/o/${ontology.id}/governance`);
  await expect(page.getByRole('main').getByText('Steward-led.', { exact: true })).toBeVisible();

  const policy = {
    ...ontology.governance,
    name: `Shared policy ${uniq()}`,
    changes: { ...ontology.governance.changes, minor: { ...ontology.governance.changes.minor, minApprovals: 7 } },
  };
  const saved = await page.request.put(`${API_URL_B}/api/ontologies/${ontology.id}/governance`, { data: { policy } });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await page.reload();
  await expect(page.getByRole('main').getByText(`${policy.name}.`, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit policy' }).click();
  await page.getByRole('button', { name: /Change request rules/ }).click();
  await page.getByRole('group', { name: 'Level to edit' }).first().getByRole('button', { name: 'Edit minor' }).click();
  await expect(page.getByRole('table').first().getByRole('row').filter({ hasText: 'Minimum approvals' }).getByRole('spinbutton')).toHaveValue('7');
});
