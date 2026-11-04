import type { Page } from '@playwright/test';
import { demoOntology, expect, expectNoCrash, settle, signIn, test } from './fixtures';

/**
 * Use case sharing modes (private, working group, public), the anonymised version
 * offered for private ones, the lifecycle, links between use cases and calls,
 * change requests and releases, and the per-release use cases and requirements document.
 */

const ANSWERS = [
  'We want to help Riverside Youth Trust match young people with short volunteering opportunities near their school.',
  'Students, teachers, the council youth service and local charities.',
  'A student in Northvale wants a one-off Saturday activity. Email jo.tester@example.org for details.',
  'A teacher wants to find group opportunities for a whole class.',
  '1. Charity posts an opportunity. 2. Platform checks the minimum age. 3. Student applies.',
  'Sometimes the opportunity is cancelled because of weather.',
  'Which opportunities near Northvale accept 15-year-olds? -> Park clean-up on Saturday\nWhich charities offer group volunteering? -> Northvale Food Bank',
  'Our CRM and a shared spreadsheet.',
  'Paid placements are out of scope.',
];

async function useCaseCard(page: Page, title: string) {
  return page.getByRole('link', { name: title, exact: true });
}

test.describe('use cases', () => {
  test('contributors see public use cases, with status and sharing badges and filters', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signIn(page, { name: 'Contributor Cleo', role: 'contributor' });
    await page.goto(`/o/${demo.id}/use-cases`);
    await settle(page);
    const filters = page.getByRole('group', { name: 'Filter use cases' });
    await expect(filters).toBeVisible();
    // Closed use cases are under "Closed", not "Open".
    await filters.getByRole('button', { name: /^All/ }).click();
    await expect(await useCaseCard(page, 'Aggregate volunteering opportunities across platforms')).toBeVisible();
    await expect(await useCaseCard(page, 'Find weekly shifts that need volunteers')).toBeVisible();
    await expect(page.getByText('Anonymised', { exact: true }).first()).toBeVisible();
    // Working group only: not for contributors.
    await expect(page.getByRole('link', { name: 'Publish recurring shifts once' })).toHaveCount(0);
    await filters.getByRole('button', { name: /^Closed/ }).click();
    await expect(await useCaseCard(page, 'Aggregate volunteering opportunities across platforms')).toBeVisible();
    await expect(page.getByText('Closed in 1.0.0').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Find weekly shifts that need volunteers' })).toHaveCount(0);
    await expectNoCrash(page);
  });

  test('an interview stays private and offers an anonymised version that is published only with consent', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signIn(page, { name: 'Jo Tester', role: 'contributor' });
    await page.goto(`/o/${demo.id}/use-cases`);
    await settle(page);
    await page.getByRole('button', { name: 'Describe a use case' }).first().click();
    await expect(page).toHaveURL(/\/interview\//);
    const box = page.getByPlaceholder(/Type your answer/);
    for (const a of ANSWERS) {
      if (await page.getByRole('heading', { name: 'What happens to this use case?' }).isVisible()) break;
      await box.fill(a);
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(page.getByLabel('Assistant is typing')).toHaveCount(0, { timeout: 20_000 });
    }
    const share = page.getByRole('region', { name: 'Anonymised version' });
    await expect(page.getByRole('heading', { name: 'What happens to this use case?' })).toBeVisible();
    await expect(page.getByText(/It is private: only you can see it/)).toBeVisible();
    await expect(page.getByText(/anonymised, synthetic version/).first()).toBeVisible();
    await expect(share).toBeVisible();
    await expect(share).not.toContainText('Riverside Youth Trust');
    await expect(share).not.toContainText('jo.tester@example.org');
    await share.getByText(/What the assistant changed/).click();
    await expect(share.getByText(/Replaced/)).toBeVisible();
    // Every published field is shown, including example answers.
    await expect(share.getByLabel('Example answer 1')).toBeVisible();
    // The private choice is selected.
    await expect(page.getByRole('radio', { name: /Private/ })).toHaveAttribute('aria-checked', 'true');

    await share.getByLabel('Title').fill('Match young people with local opportunities');
    // Publishing needs the author to confirm they have read it all.
    await expect(share.getByRole('button', { name: 'Publish anonymously' })).toBeDisabled();
    await share.getByRole('checkbox', { name: /I have read every field/ }).check();
    await share.getByRole('button', { name: 'Publish anonymously' }).click();
    await expect(page.getByTestId('anonymised-published')).toBeVisible();
    await page.getByRole('link', { name: 'View the published version' }).click();
    await settle(page);
    await expect(page.getByRole('heading', { name: 'Match young people with local opportunities' })).toBeVisible();
    await expect(page.getByText('Published anonymously')).toBeVisible();
    await expect(page.getByText('Anonymised', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Needs triage').first()).toBeVisible();
    await expect(page.getByText('Anonymised from a use case described privately')).toBeVisible();

    // Someone else sees the anonymised version but not the private original.
    const other = await page.context().browser()!.newContext();
    const p2 = await other.newPage();
    await signIn(p2, { name: 'Member Mira', role: 'member' });
    await p2.goto(`/o/${demo.id}/use-cases`);
    await settle(p2);
    await p2.getByRole('group', { name: 'Filter use cases' }).getByRole('button', { name: /^All/ }).click();
    await expect(p2.getByRole('link', { name: 'Match young people with local opportunities' })).toBeVisible();
    await expect(p2.getByRole('link', { name: /Riverside Youth Trust/ })).toHaveCount(0);

    // The author withdraws it: from then on only they can see it.
    await page.getByRole('button', { name: 'Withdraw this use case' }).click();
    await page.getByRole('group', { name: 'Withdraw this use case' }).getByRole('button', { name: 'Withdraw' }).click();
    await expect(page.getByText(/You withdrew this use case/)).toBeVisible();
    await p2.reload();
    await settle(p2);
    await p2.getByRole('group', { name: 'Filter use cases' }).getByRole('button', { name: /^All/ }).click();
    await expect(p2.getByRole('link', { name: 'Match young people with local opportunities' })).toHaveCount(0);
    await other.close();
    await expectNoCrash(page);
  });

  test('a change request citing a withdrawn use case is withheld from others, and its author still sees it', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signIn(page, { name: 'Citing Cora', role: 'contributor' });
    const s = await (await page.request.post(`/api/ontologies/${demo.id}/interviews`, { data: {} })).json();
    const id = s.useCaseId as string;
    expect((await page.request.patch(`/api/use-cases/${id}`, { data: { sections: { name: 'Harbour ferry passes', goal: 'Issue ferry passes' }, competencyQuestions: [{ question: 'Which ferry passes expire this week?' }] } })).ok()).toBe(true);
    expect((await page.request.post(`/api/use-cases/${id}/visibility`, { data: { visibility: 'public' } })).ok()).toBe(true);
    expect((await page.request.post(`/api/use-cases/${id}/submit`)).ok()).toBe(true);
    const cr = await (
      await page.request.post(`/api/ontologies/${demo.id}/change-requests`, { data: { title: 'Model Harbour ferry passes', naturalLanguage: 'Add a FerryPass class', useCaseIds: [id] } })
    ).json();
    expect((await page.request.post(`/api/use-cases/${id}/withdraw`)).ok()).toBe(true);

    const other = await page.context().browser()!.newContext();
    const p2 = await other.newPage();
    await signIn(p2, { name: 'Outsider Olu', role: 'contributor' });
    await p2.goto(`/o/${demo.id}/changes/${cr.id}`);
    await settle(p2);
    await expect(p2.getByRole('note').filter({ hasText: /no longer shared with you/ })).toBeVisible();
    await expect(p2.getByText(/Harbour ferry passes/)).toHaveCount(0);
    await p2.goto(`/o/${demo.id}/changes`);
    await settle(p2);
    await expect(p2.getByText(/Harbour ferry passes/)).toHaveCount(0);
    await expectNoCrash(p2);
    await other.close();

    // The use case's author still sees the request in full.
    await page.goto(`/o/${demo.id}/changes/${cr.id}`);
    await settle(page);
    await expect(page.getByRole('heading', { name: /Model Harbour ferry passes/ })).toBeVisible();
    await expectNoCrash(page);
  });

  test('sharing a private use case with the working group submits it for triage', async ({ page, request }) => {
    const demo = await demoOntology(request);
    const me = await signIn(page, { name: 'Sharer Sid', role: 'contributor' });
    // Start and finish an interview through the API, then share in the UI.
    const s = await page.request.post(`/api/ontologies/${demo.id}/interviews`, { data: {} });
    const session = await s.json();
    for (const content of ANSWERS) {
      const r = await page.request.post(`/api/interviews/${session.id}/messages`, { data: { content } });
      if ((await r.json()).session.done) break;
    }
    await page.request.post(`/api/interviews/${session.id}/finish`);
    await page.goto(`/o/${demo.id}/use-cases/${session.useCaseId}`);
    await settle(page);
    await expect(page.getByText('Private', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/Private use cases are not triaged/)).toBeVisible();
    await page.getByRole('radio', { name: /Working group/ }).click();
    await expect(page.getByRole('radio', { name: /Working group/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('Needs triage').first()).toBeVisible();
    await expect(page.getByRole('region', { name: 'Anonymised version' })).toHaveCount(0);
    expect(me.user.name).toBe('Sharer Sid');
    await expectNoCrash(page);
  });

  test('a call and its use case link to each other, with the transcript lines it came from', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signIn(page, { name: 'Member Lou', role: 'member' });
    await page.goto(`/o/${demo.id}/meetings`);
    await settle(page);
    await page.getByRole('link', { name: 'Working group call: recurring shifts' }).first().click();
    await settle(page);
    const linked = page.getByTestId('meeting-use-cases');
    await expect(linked.getByRole('link', { name: /Publish recurring shifts once/ })).toBeVisible();
    // The transcript lines it came from carry a chip. The use case is group-only, so it is numbered in the working group's WG-n sequence.
    const chips = page.locator('main').getByRole('link', { name: /^WG-\d+$/ });
    expect(await chips.count()).toBeGreaterThan(0);
    // Once turned into use cases, the button is gone so it can't be done twice.
    await expect(page.getByRole('button', { name: 'Turn into use cases' })).toHaveCount(0);

    await chips.first().click();
    await settle(page);
    await expect(page.getByRole('heading', { name: 'Publish recurring shifts once' })).toBeVisible();
    await expect(page.getByText('Working group', { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId('source-lines')).toContainText('recurrence');
    await expect(page.getByText('Related to').first()).toBeVisible();
    await expect(page.getByRole('link', { name: /Find weekly shifts that need volunteers/ })).toBeVisible();

    // Group-only, so changes can't be drafted from it until it is public.
    await expect(page.getByRole('button', { name: 'Draft changes' })).toHaveCount(0);

    // And back to the call.
    await page.getByRole('link', { name: 'Working group call: recurring shifts' }).click();
    await expect(page).toHaveURL(/\/meetings\//);
    await expectNoCrash(page);
  });

  test('signed-out visitors and contributors see no meetings', async ({ page, request }) => {
    const demo = await demoOntology(request);
    expect((await request.get(`/api/ontologies/${demo.id}/meetings`)).status()).toBe(401);
    await signIn(page, { name: 'Contributor Cal', role: 'contributor' });
    await page.goto(`/o/${demo.id}/meetings`);
    await settle(page);
    await expect(page.getByRole('link', { name: 'Working group call: recurring shifts' })).toHaveCount(0);
    await expectNoCrash(page);
  });

  test('editors triage: accept with a note, defer and reopen', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signIn(page, { name: 'Editor Evi', role: 'editor' });
    await page.goto(`/o/${demo.id}/use-cases`);
    await settle(page);
    await page.getByRole('group', { name: 'Filter use cases' }).getByRole('button', { name: /^All/ }).click();
    await page.getByRole('link', { name: 'Publish recurring shifts once' }).click();
    await settle(page);
    await page.getByLabel('Triage note').fill('In scope for the next minor release');
    await page.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect(page.getByText('In scope for the next minor release')).toBeVisible();
    await expect(page.getByText('Accepted', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Defer', exact: true }).click();
    await expect(page.getByText('Deferred', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Reopen' }).click();
    await expect(page.getByText('Needs triage').first()).toBeVisible();
    // Contributors don't get the triage controls.
    await signIn(page, { name: 'Contributor Cal', role: 'contributor' });
    await page.goto(`/o/${demo.id}/use-cases`);
    await settle(page);
    await page.getByRole('group', { name: 'Filter use cases' }).getByRole('button', { name: /^All/ }).click();
    await page.getByRole('link', { name: 'Find weekly shifts that need volunteers' }).click();
    await settle(page);
    await expect(page.getByLabel('Triage note')).toHaveCount(0);
    await expectNoCrash(page);
  });

  test('links a use case to a web page and removes it again', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signIn(page, { name: 'Member Lin', role: 'member' });
    await page.goto(`/o/${demo.id}/use-cases`);
    await settle(page);
    await page.getByRole('group', { name: 'Filter use cases' }).getByRole('button', { name: /^All/ }).click();
    await page.getByRole('link', { name: 'Find weekly shifts that need volunteers' }).click();
    await settle(page);
    await page.getByRole('button', { name: 'Add link' }).click();
    await page.getByLabel('Link to').selectOption('url');
    await page.getByLabel('URL').fill('https://www.w3.org/TR/vc-use-cases/');
    await page.getByLabel('Label (optional)').fill('VC use cases');
    await page.getByRole('button', { name: 'Add link' }).last().click();
    const link = page.getByRole('link', { name: 'VC use cases' });
    await expect(link).toHaveAttribute('href', 'https://www.w3.org/TR/vc-use-cases/');
    await page.getByRole('button', { name: 'Remove link' }).click();
    await expect(link).toHaveCount(0);
    // A change request it is addressing, linked both ways.
    const cr = page.getByRole('link', { name: /Say whether an opportunity reimburses expenses/ });
    await expect(cr).toBeVisible();
    await cr.click();
    await settle(page);
    await expect(page.getByTestId('cr-use-cases').getByRole('link', { name: /Find weekly shifts that need volunteers/ })).toBeVisible();
    await expectNoCrash(page);
  });

  test('the 1.0.0 use cases and requirements document tells a story with working links', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signIn(page, { name: 'Reader Rae', role: 'contributor' });
    await page.goto(`/o/${demo.id}/use-cases`);
    await settle(page);
    await page.getByRole('link', { name: /v1\.0\.0/ }).click();
    await settle(page);
    await expect(page).toHaveURL(/\/requirements\/1\.0\.0$/);
    await expect(page.getByRole('heading', { level: 2, name: /use cases and requirements for 1\.0\.0/ })).toBeVisible();
    await expect(page.getByText('Published', { exact: true })).toBeVisible();
    await expect(page.getByTestId('coverage')).toHaveText(/1 of 1/);
    await expect(page.getByRole('navigation', { name: 'Contents' })).toBeVisible();
    // A citation in the story jumps to its use case on the same page.
    const cite = page.locator('article .prose-chat a[href^="#uc-"]').first();
    await expect(cite).toBeVisible();
    const target = (await cite.getAttribute('href'))!;
    await cite.click();
    await expect(page).toHaveURL(new RegExp(`${target}$`));
    await expect(page.locator(target)).toBeInViewport();
    // Requirements table with anchors and links to use cases.
    const r1 = page.locator('#req-R1');
    await expect(r1).toBeVisible();
    await expect(r1.getByRole('link', { name: /^UC-\d+$/ })).toBeVisible();
    await expect(r1).toContainText('Met');
    // Markdown download.
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Markdown' }).click()]);
    expect(dl.suggestedFilename()).toBe('use-cases-1.0.0.md');
    await expectNoCrash(page);
  });

  test('a release links to its document and the use cases it closes', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signIn(page, { name: 'Steward Sol', role: 'steward' });
    await page.goto(`/o/${demo.id}/releases`);
    await settle(page);
    await page.getByRole('link', { name: /1\.0\.0/ }).first().click();
    await settle(page);
    await expect(page.getByRole('heading', { name: 'Use cases and requirements' })).toBeVisible();
    await page.getByRole('link', { name: /use cases and requirements for 1\.0\.0/i }).click();
    await expect(page).toHaveURL(/\/requirements\/1\.0\.0/);
    await expectNoCrash(page);
  });

  test('use case pages fit a phone screen', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, { name: 'Phone Pia', role: 'member' });
    const list = await (await page.request.get(`/api/ontologies/${demo.id}/use-cases`)).json();
    const uc = list.find((u: { sections: { name?: string } }) => u.sections.name === 'Publish recurring shifts once');
    for (const path of [`/o/${demo.id}/use-cases`, `/o/${demo.id}/use-cases/${uc.id}`, `/o/${demo.id}/requirements/1.0.0`]) {
      await page.goto(path);
      await settle(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, path).toBeLessThanOrEqual(1);
    }
    await expectNoCrash(page);
  });
});
