import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { test, expect, demoOntology, expectNoCrash, settle, signInAsPersona, uniq } from './fixtures';

/**
 * Meetings as a source of requirements: upload (or paste) a transcript, analyse it, and turn
 * it into use cases and a change request; run a simulated live call that streams in; and invite
 * the Meet bot (which, without a Recall.ai key, explains it can't join).
 *
 * The bot's invite-by-email and Meet chat prompts are in PR #11, which brings its own spec.
 */

const TRANSCRIPT = `Priya Shah: Thanks for joining. Today we want to agree how to describe recurring shifts.
Aisha Rahman: At the council we run the same food bank shift every Tuesday from 10 to 2.
Tom Okafor: So we need a Shift class with a start time, an end time and a recurrence rule.
Aisha Rahman: And coordinators need to know which shifts next week still need volunteers.
Gareth Lewis: Our CRM already exports shifts, but without recurrence. Migration would be painful.
Priya Shah: Let's capture that as a requirement and propose the change.`;

test.describe('meetings', () => {
  test('an uploaded transcript is analysed and turned into use cases and a change request', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signInAsPersona(page, 'Priya Shah');
    await page.goto(`/o/${demo.id}/meetings`);
    await page.getByRole('button', { name: 'Upload' }).click();
    const d = page.getByRole('dialog', { name: 'Upload a meeting transcript' });
    await expect(d.getByRole('button', { name: /Upload/ }).last()).toBeDisabled();
    const title = `Recurring shifts call ${uniq()}`;
    await d.getByLabel('Title').fill(title);
    await d.getByLabel('…or paste it here').fill(TRANSCRIPT);
    await d.getByRole('button', { name: /Upload/ }).last().click();

    await expect(page).toHaveURL(/\/meetings\/[^/]+$/, { timeout: 30_000 });
    await settle(page);
    await expectNoCrash(page);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Transcript' })).toBeVisible();
    await expect(page.getByText('6 lines')).toBeVisible();
    await expect(page.getByText(/every Tuesday from 10 to 2/)).toBeVisible();

    // An upload is analysed straight away (the button is there if it hasn't been yet).
    const analyse = page.getByRole('button', { name: 'Analyse transcript' });
    if (await analyse.isVisible()) await analyse.click();
    await expect(page.getByRole('heading', { name: 'Analysis' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Analysed', { exact: true })).toBeVisible();
    await expect(page.getByText(/A call with 4 participants/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Decisions' })).toBeVisible();
    await page.getByRole('button', { name: 'Turn into use cases and a change request' }).click();
    // With proposed changes it opens the new change request; otherwise it says which use cases it made.
    await expect(page.getByRole('button', { name: /^Status: / }).or(page.getByText(/^Created \d+ use cases?\./))).toBeVisible({ timeout: 30_000 });
    if (/\/changes\//.test(page.url())) await expect(page.getByRole('link', { name: 'view meeting' })).toBeVisible();

    // The meeting is listed, with its source.
    await page.goto(`/o/${demo.id}/meetings`);
    await expect(page.getByRole('main').getByText(title)).toBeVisible();
    await expect(page.getByRole('main').getByText('Uploaded transcript').first()).toBeVisible();
  });

  test('a transcript file can be chosen instead of pasting', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signInAsPersona(page, 'Priya Shah');
    const file = path.join(os.tmpdir(), `meeting-${uniq()}.vtt`);
    fs.writeFileSync(file, `WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Aisha Rahman>We need to record DBS checks.\n\n00:00:05.000 --> 00:00:08.000\n<v Tom Okafor>That could be a Credential class.\n`);
    await page.goto(`/o/${demo.id}/meetings`);
    await page.getByRole('button', { name: 'Upload' }).click();
    const d = page.getByRole('dialog', { name: 'Upload a meeting transcript' });
    await d.getByLabel('Transcript file').setInputFiles(file);
    await expect(d.getByLabel('…or paste it here')).toHaveValue(/DBS checks/);
    await d.getByRole('button', { name: /Upload/ }).last().click();
    await expect(page).toHaveURL(/\/meetings\/[^/]+$/, { timeout: 30_000 });
    await expect(page.getByText(/We need to record DBS checks/)).toBeVisible();
  });

  test('a simulated live call streams in, and the bot raises prompts', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signInAsPersona(page, 'Priya Shah');
    await page.goto(`/o/${demo.id}/meetings`);
    await page.getByRole('button', { name: 'Start simulation' }).click();
    await expect(page).toHaveURL(/\/meetings\/[^/]+$/, { timeout: 30_000 });
    await settle(page).catch(() => {});
    await expectNoCrash(page);
    await expect(page.getByRole('heading', { name: 'Transcript' })).toBeVisible();
    // Lines arrive over time.
    const lines = page.getByRole('main').getByText(/^\d+ lines$|Streaming live…/);
    await expect(lines.first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Co-lead bot prompts' })).toBeVisible({ timeout: 30_000 });
  });

  test('inviting the Meet bot checks the link, and says when the bot service is not set up', async ({ page, request, consoleGuard }) => {
    consoleGuard.allow(/status of (4|5)\d\d/);
    const demo = await demoOntology(request);
    await signInAsPersona(page, 'Priya Shah');
    await page.goto(`/o/${demo.id}/meetings`);
    await page.getByRole('button', { name: 'Invite to a Meet' }).click();
    const d = page.getByRole('dialog', { name: 'Invite the co-lead bot to a Google Meet' });
    const invite = d.getByRole('button', { name: /Invite|Send the bot/ }).last();
    await d.getByLabel('Meet link').fill('https://zoom.us/j/123');
    await expect(invite).toBeDisabled();
    await d.getByLabel('Meet link').fill('https://meet.google.com/abc-defg-hij');
    await expect(invite).toBeEnabled();
    await invite.click();
    // With no bot provider configured (as in these tests), the meeting records the error or the dialog shows it.
    await expect(page.getByText(/Bot error|not configured|RECALL|isn’t set up|not set up/i).first()).toBeVisible({ timeout: 20_000 });
  });
});
