import fs from 'node:fs';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, expectNoCrash, settle, signIn, demoOntology } from './fixtures';

/**
 * The co-lead bot for Google Meet: inviting it by email (its calendar feed is a
 * local file here), uploading a calendar invite, and posting its prompts into
 * the Meet chat. There is no Recall.ai key in these tests, so no real bot joins.
 */

const BOT_FEED = process.env.E2E_BOT_ICS!;
const ics = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function invite(o: { uid: string; title: string; start: Date; minutes?: number; attendee?: string; rrule?: string; description?: string; organizer?: string }) {
  const end = new Date(o.start.getTime() + (o.minutes ?? 60) * 60_000);
  return [
    'BEGIN:VEVENT',
    `DTSTART:${ics(o.start)}`,
    `DTEND:${ics(end)}`,
    ...(o.rrule ? [`RRULE:${o.rrule}`] : []),
    'DTSTAMP:20261101T120000Z',
    `ORGANIZER;CN=Organiser:mailto:${o.organizer ?? 'priya@example.org'}`,
    `UID:${o.uid}`,
    `ATTENDEE;CN=bot;PARTSTAT=NEEDS-ACTION:mailto:${o.attendee ?? 'concord.bot@example.org'}`,
    'X-GOOGLE-CONFERENCE:https://meet.google.com/eee-test-abc',
    `DESCRIPTION:${o.description ?? ''}\\nJoin with Google Meet: https://meet.google.com/eee-test-abc`,
    `SUMMARY:${o.title}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
  ].join('\r\n');
}
const calendar = (...events: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Concord e2e//EN', ...events, 'END:VCALENDAR', ''].join('\r\n');

async function writeBotCalendar(request: APIRequestContext, ...events: string[]) {
  fs.writeFileSync(BOT_FEED, calendar(...events));
  const r = await request.post('/api/meet-bot/sync');
  expect(r.ok(), `POST /api/meet-bot/sync: ${r.status()} ${await r.text()}`).toBeTruthy();
  return r.json();
}

const inHours = (h: number) => new Date(Math.ceil((Date.now() + h * 3600e3) / 60_000) * 60_000);

async function openBotDialog(page: Page, ontologyId: string) {
  await page.goto(`/o/${ontologyId}/meetings`);
  await settle(page);
  // An empty list offers three cards; once there are meetings, an "Add meeting" menu.
  const add = page.getByRole('button', { name: 'Add meeting' });
  if (await add.isVisible()) {
    await add.click();
    await page.getByRole('menuitem', { name: /Invite the co-lead bot/ }).click();
  } else await page.getByRole('button', { name: 'Invite to a Meet' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Bring the co-lead bot to a Google Meet' })).toBeVisible();
  return dialog;
}

test.describe('Meet co-lead bot', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, { name: 'E2E facilitator', role: 'steward' });
  });

  test.afterEach(async ({ page }) => {
    // Leave the bot's calendar empty for the next test; this also drops calls it had scheduled.
    await writeBotCalendar(page.request);
  });

  test('the invite dialog gives the bot’s email address for this ontology', async ({ page, request }) => {
    const demo = await demoOntology(request);
    const ontology = (await (await request.get(`/api/ontologies/${demo.id}`)).json()) as { slug: string };
    const dialog = await openBotDialog(page, demo.id);

    await expect(dialog.getByRole('radio', { name: 'Schedule through Google Calendar' })).toBeVisible();
    await expect(dialog.getByTestId('bot-invite-address')).toHaveText('concord.bot@example.org');
    await expect(dialog.getByText(`#${ontology.slug}`, { exact: true })).toBeVisible();
    await expect(dialog.getByText(`concord.bot+${ontology.slug}@example.org`)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Copy' })).toBeVisible();
    // The calendar feed is connected in these tests, so there's no "not connected" warning.
    await expect(dialog.getByText(/isn’t connected/)).toHaveCount(0);

    // The other two ways in, each with the chat option (off by default).
    await dialog.getByRole('radio', { name: 'Join a call now' }).click();
    await expect(dialog.getByPlaceholder('https://meet.google.com/abc-defg-hij')).toBeVisible();
    const chat = dialog.getByRole('switch', { name: 'Post prompts in the Meet chat automatically' });
    await expect(chat).toHaveAttribute('aria-checked', 'false');
    await chat.click();
    await expect(chat).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.getByText('Everyone in the call sees each new follow-up question in the chat.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Send the bot now' })).toBeDisabled();

    await dialog.getByRole('radio', { name: 'Import calendar occurrences' }).click();
    await expect(dialog.getByLabel('Calendar invite file')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Import and schedule' })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('inviting the bot’s address puts the call under Upcoming calls, where it can be skipped', async ({ page, request }) => {
    const demo = await demoOntology(request);
    const ontology = (await (await request.get(`/api/ontologies/${demo.id}`)).json()) as { slug: string };
    const sync = await writeBotCalendar(
      page.request,
      invite({ uid: 'e2e-email-1', title: 'E2E use case workshop', start: inHours(3), attendee: `concord.bot+${ontology.slug}@example.org` }),
    );
    expect(sync.lastSync).toMatchObject({ ok: true, events: 1 });

    await page.goto(`/o/${demo.id}/meetings`);
    await settle(page);
    const upcoming = page.locator('div', { has: page.getByRole('heading', { name: 'Upcoming calls' }) }).last();
    const row = page.getByRole('listitem').filter({ hasText: 'E2E use case workshop' });
    await expect(row).toBeVisible();
    await expect(upcoming).toBeVisible();
    // An invite can't prove who sent it, so a facilitator approves it first.
    await expect(row.getByText('Needs approval')).toBeVisible();
    await row.getByRole('button', { name: 'Approve' }).click();
    // No Recall.ai key in these tests: the row says so, separately from the switch.
    await expect(row.getByText('No bot provider on this server')).toBeVisible();
    await expect(row.getByRole('switch', { name: /^Bot joins “E2E use case workshop” on / })).toHaveAttribute('aria-checked', 'true');
    await expect(upcoming.getByText(/Calendar checked/)).toBeVisible();

    // Skip this one from the list.
    await row.getByRole('switch').click();
    await expect(row.getByRole('switch', { name: /^Bot joins “E2E use case workshop”/ })).toHaveAttribute('aria-checked', 'false');
    await expect(row.getByText('Skipping')).toBeVisible();

    // The meeting page shows where it came from, and both options.
    await row.getByRole('link', { name: /E2E use case workshop/ }).click();
    await settle(page);
    await expectNoCrash(page);
    await expect(page.getByRole('heading', { name: 'E2E use case workshop' })).toBeVisible();
    await expect(page.getByTestId('meeting-calendar')).toContainText('From a calendar invite');
    await expect(page.getByTestId('meeting-calendar')).toContainText('organised by priya@example.org');
    await expect(page.getByText('Bot skipping')).toBeVisible();
    await expect(page.getByText('The bot is skipping this call.')).toBeVisible();
    const joins = page.getByRole('switch', { name: 'Bot joins this call' });
    await expect(joins).toHaveAttribute('aria-checked', 'false');
    await joins.click();
    await expect(joins).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText(/The bot joins when the call starts, in (3 hours|2 hours|180 minutes)/)).toBeVisible();

    const chat = page.getByRole('switch', { name: 'Post prompts in the Meet chat automatically' });
    await expect(chat).toHaveAttribute('aria-checked', 'false');
    await chat.click();
    await expect(chat).toHaveAttribute('aria-checked', 'true');
    await page.reload();
    await expect(page.getByRole('switch', { name: 'Post prompts in the Meet chat automatically' })).toHaveAttribute('aria-checked', 'true');

    // Cancelling the invite takes the call off the list.
    await writeBotCalendar(page.request);
    await page.goto(`/o/${demo.id}/meetings`);
    await settle(page);
    await expect(page.getByText('E2E use case workshop')).toHaveCount(0);
  });

  test('an invite from anyone waits for a facilitator’s approval', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await writeBotCalendar(page.request, invite({ uid: 'e2e-stranger', title: 'E2E stranger’s call', start: inHours(4), organizer: 'stranger@elsewhere.test', description: '#volunteering' }));
    await page.goto(`/o/${demo.id}/meetings`);
    await settle(page);
    const row = page.getByRole('listitem').filter({ hasText: 'E2E stranger’s call' });
    await expect(row.getByText('Needs approval')).toBeVisible();
    await expect(row.getByRole('switch')).toHaveCount(0);
    await row.getByRole('button', { name: 'Approve' }).click();
    await expect(row.getByRole('switch', { name: /^Bot joins/ })).toHaveAttribute('aria-checked', 'true');
    await expect(row.getByText('Needs approval')).toHaveCount(0);
  });

  test('uploading a recurring invite schedules each week of the series', async ({ page, request }) => {
    const demo = await demoOntology(request);
    const dialog = await openBotDialog(page, demo.id);
    await dialog.getByRole('radio', { name: 'Import calendar occurrences' }).click();
    const series = calendar(invite({ uid: `e2e-series-${Date.now()}`, title: 'E2E weekly working group', start: inHours(26), rrule: 'FREQ=WEEKLY;COUNT=4' }));
    await dialog.getByLabel('Calendar invite file').setInputFiles({ name: 'invite.ics', mimeType: 'text/calendar', buffer: Buffer.from(series) });
    await expect(dialog.getByTestId('ics-preview')).toHaveText('invite.ics: “E2E weekly working group”, a recurring series');
    await dialog.getByRole('button', { name: 'Import and schedule' }).click();
    await expect(dialog).toHaveCount(0);

    // Two weeks ahead: the first two calls of the series.
    await expect(page).toHaveURL(new RegExp(`/o/${demo.id}/meetings$`));
    const rows = page.getByRole('listitem').filter({ hasText: 'E2E weekly working group' });
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('part of a series');
    await expectNoCrash(page);
  });

  test('a bad invite file explains what is wrong', async ({ page, request, consoleGuard }) => {
    consoleGuard.allow(/status of 400/);
    const demo = await demoOntology(request);
    const dialog = await openBotDialog(page, demo.id);
    await dialog.getByRole('radio', { name: 'Import calendar occurrences' }).click();
    await dialog.getByLabel('Calendar invite file').setInputFiles({ name: 'notes.ics', mimeType: 'text/calendar', buffer: Buffer.from('not a calendar') });
    await dialog.getByRole('button', { name: 'Import and schedule' }).click();
    await expect(dialog.getByText('That file is not a calendar invite (.ics).')).toBeVisible();
  });

  test('during a call, prompts can be posted into the Meet chat one by one or all automatically', async ({ page, request }) => {
    const demo = await demoOntology(request);
    // A slow simulated call, so there's time to act while it's live.
    const r = await page.request.post(`/api/ontologies/${demo.id}/meetings/simulate`, { data: { title: 'E2E simulated call', delayMs: 1500 } });
    expect(r.ok()).toBeTruthy();
    const m = (await r.json()) as { id: string };
    await page.goto(`/o/${demo.id}/meetings/${m.id}`);
    await expect(page.getByText('Live', { exact: true })).toBeVisible();

    const chat = page.getByRole('switch', { name: 'Post prompts in the Meet chat automatically' });
    await expect(chat).toHaveAttribute('aria-checked', 'false');
    const prompts = page.getByTestId('facilitator-prompt');

    // The first prompt is only suggested to the facilitator, with a button to post it.
    await expect(prompts.first()).toContainText('suggested to the facilitator', { timeout: 30_000 });
    await prompts.first().getByRole('button', { name: 'Post in the Meet chat' }).click();
    await expect(prompts.first()).toContainText('posted in the Meet chat (simulated)');
    await expect(prompts.first().getByRole('button', { name: 'Post in the Meet chat' })).toHaveCount(0);

    // Switched on, later prompts go straight into the chat.
    await chat.click();
    await expect(chat).toHaveAttribute('aria-checked', 'true');
    await expect(prompts.nth(1)).toContainText('posted in the Meet chat (simulated)', { timeout: 30_000 });

    // Ending the call stops the bot and analyses the transcript.
    await page.getByRole('button', { name: 'End call and analyse' }).click();
    await expect(page.getByRole('heading', { name: 'Summary' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'End call and analyse' })).toHaveCount(0);
    await expectNoCrash(page);
  });

  test('a finished meeting opens on its summary, with the transcript, prompts and extracted items one click away', async ({ page, request }) => {
    const demo = await demoOntology(request);
    const r = await page.request.post(`/api/ontologies/${demo.id}/meetings/simulate`, { data: { title: 'E2E finished call', delayMs: 0 } });
    const m = (await r.json()) as { id: string };
    await page.goto(`/o/${demo.id}/meetings/${m.id}`);
    await settle(page);
    const views = page.getByRole('radiogroup', { name: 'Meeting views' });
    await expect(views.getByRole('radio', { name: /Summary/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('heading', { name: 'Summary' })).toBeVisible();
    // The summary shows counts, not the whole transcript.
    await expect(page.getByRole('list', { name: 'What the call produced' })).toContainText('transcript lines');
    await expect(page.getByText('Thanks for joining.', { exact: false })).toHaveCount(0);

    await page.getByRole('button', { name: /transcript lines/ }).click();
    await expect(page.getByText(/Thanks for joining/)).toBeVisible();
    await expect(views.getByRole('radio', { name: /Transcript/ })).toHaveAttribute('aria-checked', 'true');
    await views.getByRole('radio', { name: /Bot prompts/ }).click();
    await expect(page.getByTestId('facilitator-prompt').first()).toBeVisible();
    await views.getByRole('radio', { name: /Extracted items/ }).click();
    await expect(page.getByRole('heading', { name: 'Extracted items' })).toBeVisible();
    // Quotes are behind each term's disclosure.
    const quote = page.getByRole('button', { name: /What was said/ }).first();
    if (await quote.count()) {
      await quote.click();
      await expect(page.locator('blockquote').first()).toBeVisible();
    }
    await expectNoCrash(page);
  });

  test('a populated list has one "Add meeting" menu; an empty one keeps the three cards', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await page.request.post(`/api/ontologies/${demo.id}/meetings/simulate`, { data: { title: 'E2E list call', delayMs: 0 } });
    await page.goto(`/o/${demo.id}/meetings`);
    await settle(page);
    await expect(page.getByRole('button', { name: 'Start simulation' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Add meeting' }).click();
    const menu = page.getByRole('menu', { name: 'Add meeting' });
    await expect(menu.getByRole('menuitem')).toHaveCount(3);
    await menu.getByRole('menuitem', { name: /Upload a transcript/ }).click();
    const dialog = page.getByRole('dialog', { name: undefined }).filter({ has: page.getByRole('heading', { name: 'Upload a meeting transcript' }) });
    // Choose a file or paste text first; only that input shows.
    await expect(dialog.getByLabel('Transcript file')).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Transcript' })).toHaveCount(0);
    // The choice is a radio group: one tab stop, arrow keys move between options.
    const fromFile = dialog.getByRole('radio', { name: 'From a file' });
    await expect(fromFile).toHaveAttribute('tabindex', '0');
    await expect(dialog.getByRole('radio', { name: 'Paste text' })).toHaveAttribute('tabindex', '-1');
    await fromFile.focus();
    await page.keyboard.press('ArrowRight');
    await expect(dialog.getByRole('radio', { name: 'Paste text' })).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.getByRole('radio', { name: 'Paste text' })).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(fromFile).toHaveAttribute('aria-checked', 'true');
    await dialog.getByRole('radio', { name: 'Paste text' }).click();
    await expect(dialog.getByLabel('Transcript file')).toHaveCount(0);
    await dialog.getByRole('textbox', { name: 'Transcript' }).fill('Priya: Which shifts need a DBS check?\nTom: The Saturday ones.');
    await expect(dialog.getByRole('button', { name: 'Upload and analyse' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // With no meetings, the explanatory cards come back.
    await page.route('**/api/ontologies/*/meetings', (route) => route.fulfill({ json: [] }));
    await page.reload();
    await settle(page);
    await expect(page.getByRole('button', { name: 'Add meeting' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Start simulation' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Invite to a Meet' })).toBeVisible();
    await expect(page.getByText('No meetings yet')).toBeVisible();
  });
});

test.describe('Meet co-lead bot, as a contributor', () => {
  test('only owners, stewards and editors can bring the bot in or change its calls', async ({ page, request }) => {
    const demo = await demoOntology(request);
    // A steward puts a call on the bot's calendar first.
    await signIn(page, { name: 'E2E steward', role: 'steward' });
    await writeBotCalendar(page.request, invite({ uid: 'e2e-contrib', title: 'E2E contributor view', start: inHours(5), description: '#volunteering' }));
    const meetingsNow = (await (await page.request.get(`/api/ontologies/${demo.id}/meetings`)).json()) as { id: string; title: string }[];
    const pending = meetingsNow.find((m) => m.title === 'E2E contributor view')!;
    expect((await page.request.patch(`/api/meetings/${pending.id}`, { data: { approve: true } })).ok()).toBeTruthy();
    await page.request.post(`/api/ontologies/${demo.id}/meetings/simulate`, { data: { title: 'E2E contributor list', delayMs: 0 } });

    await signIn(page, { name: 'E2E contributor', role: 'contributor' });
    // The API refuses, whatever the UI shows.
    const r = await page.request.post(`/api/ontologies/${demo.id}/meetings/bot`, { data: { title: 'Nope', meetingUrl: 'https://meet.google.com/eee-test-abc' } });
    expect(r.status()).toBe(403);

    await page.goto(`/o/${demo.id}/meetings`);
    await settle(page);
    await page.getByRole('button', { name: 'Add meeting' }).click();
    const menu = page.getByRole('menu', { name: 'Add meeting' });
    await expect(menu.getByRole('menuitem')).toHaveCount(2);
    await expect(menu.getByRole('menuitem', { name: /Invite the co-lead bot/ })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Contributors see upcoming calls but can't skip them.
    const row = page.getByRole('listitem').filter({ hasText: 'E2E contributor view' });
    await expect(row).toBeVisible();
    await expect(row.getByRole('switch')).toHaveCount(0);

    // With no meetings, the bot card explains who can use it.
    await page.route('**/api/ontologies/*/meetings', (route) => route.fulfill({ json: [] }));
    await page.reload();
    await settle(page);
    await expect(page.getByRole('button', { name: 'Invite to a Meet' })).toBeDisabled();
    await expect(page.getByText('The ontology’s owners, stewards and editors can bring the bot into a call.')).toBeVisible();

    await signIn(page, { name: 'E2E steward', role: 'steward' });
    await writeBotCalendar(page.request);
  });
});
