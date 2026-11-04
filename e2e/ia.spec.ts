import { test, expect, expectNoCrash, settle, signIn, demoOntology } from './fixtures';

/**
 * Information architecture: summaries first, detail one click away. These check that each
 * piece of detail that moved behind a bubble, disclosure or collapsed card is still there.
 */

test.describe('progressive disclosure', () => {
  let demo: { id: string; title: string };
  test.beforeEach(async ({ page, request }) => {
    await signIn(page, { name: 'IA tester', role: 'steward' });
    demo = await demoOntology(request);
  });

  test('the lifecycle stage is a bubble that opens the whole process', async ({ page }) => {
    await page.goto(`/o/${demo.id}`);
    const bubble = page.getByRole('button', { name: /^Lifecycle stage: / });
    await expect(bubble).toBeVisible();
    const stage = (await bubble.innerText()).trim();
    await expect(page.getByRole('dialog', { name: /^Lifecycle stage/ })).toHaveCount(0);

    await bubble.click();
    await expect(bubble).toHaveAttribute('aria-expanded', 'true');
    const panel = page.getByRole('dialog', { name: /^Lifecycle stage/ });
    await expect(panel.getByText('Where this ontology is in its lifecycle')).toBeVisible();
    for (const s of ['Discovery', 'Drafting', 'Review', 'Released', 'Maintenance']) await expect(panel.getByText(s, { exact: true })).toBeVisible();
    // The current stage is marked, and matches the bubble's label.
    const current = panel.locator('[aria-current="step"]');
    await expect(current).toHaveCount(1);
    await expect(current).toContainText(stage);
    await expect(current).toContainText('Now');

    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    // Clicking elsewhere closes it too.
    await bubble.click();
    await expect(panel).toBeVisible();
    await page.getByRole('heading', { name: demo.title }).click();
    await expect(panel).toHaveCount(0);
  });

  test('the stage bubble is on every page of the ontology', async ({ page }) => {
    for (const path of ['', '/browse', '/changes', '/governance', '/agents']) {
      await page.goto(`/o/${demo.id}${path}`);
      await expect(page.getByRole('button', { name: /^Lifecycle stage: / }), path || 'overview').toBeVisible();
    }
  });

  test('the health chip summarises validation and links to the full lint report', async ({ page }) => {
    await page.goto(`/o/${demo.id}/browse`);
    const chip = page.getByRole('button', { name: /^Health: / });
    await chip.click();
    const panel = page.getByRole('dialog', { name: /^Health: / });
    for (const row of ['Reasoner', 'FAIR score', 'Lint (OWL best practice)', 'Overall validation']) await expect(panel.getByText(row, { exact: true })).toBeVisible();
    await panel.getByRole('link', { name: /full report/ }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${demo.id}#health$`));
    await settle(page);
    // Arriving from the chip opens the lint findings, so linting is visible straight away.
    const lint = page.getByRole('button', { name: /Lint findings/ });
    await expect(lint).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#health').getByText(/No lint issues|Errors \(|Warnings \(|Suggestions \(/).first()).toBeVisible();
  });

  test('the overview keeps lint, FAIR and competency-question detail one click away', async ({ page, request }) => {
    const report = await (await request.get(`/api/ontologies/${demo.id}/validation?ref=working`)).json();
    await page.goto(`/o/${demo.id}`);
    await settle(page);
    const health = page.locator('#health');
    await expect(health.getByText('Health of the working draft')).toBeVisible();

    const lint = health.getByRole('button', { name: /Lint findings/ });
    const lintCount = report.lint?.length ?? 0;
    if (lintCount) {
      if ((await lint.getAttribute('aria-expanded')) !== 'true') await lint.click();
      // Every finding is listed by its message.
      for (const issue of report.lint.slice(0, 5)) await expect(health.getByText(issue.message, { exact: true }).first()).toBeVisible();
    }

    const fair = health.getByRole('button', { name: /FAIR checks/ });
    await expect(fair).toContainText(/\d+ of \d+ pass/);
    if ((await fair.getAttribute('aria-expanded')) !== 'true') await fair.click();
    await expect(health.getByText(/All \d+ FAIR checks pass|Show all \d+ checks|Show failing only/).first()).toBeVisible();

    const cqs = health.getByRole('button', { name: /Competency questions/ });
    if ((await cqs.getAttribute('aria-expanded')) !== 'true') await cqs.click();
    if (report.competencyQuestions?.length) await expect(health.getByText(report.competencyQuestions[0].question).first()).toBeVisible();
    await cqs.click();
    await expect(cqs).toHaveAttribute('aria-expanded', 'false');
  });

  test('members show as avatars, with roles one click away', async ({ page }) => {
    await page.goto(`/o/${demo.id}`);
    await settle(page);
    const card = page.locator('main').locator('div.rounded-xl', { has: page.getByRole('heading', { name: /^Members \(\d+\)$/ }) });
    const avatars = card.getByRole('list', { name: 'Members' }).getByRole('listitem');
    expect(await avatars.count()).toBeGreaterThan(1);
    await expect(card.getByText('Voting member')).toHaveCount(0);
    await card.getByRole('button', { name: 'Who does what' }).click();
    await expect(card.getByText('Priya Shah').first()).toBeVisible();
    await expect(card.getByText('Voting member').first()).toBeVisible();
  });

  test('recent activity starts short and expands', async ({ page }) => {
    await page.goto(`/o/${demo.id}`);
    await settle(page);
    const feed = page.locator('text=Recent activity').locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]');
    const before = await feed.locator('ol > li').count();
    expect(before).toBeLessThanOrEqual(5);
    await page.getByRole('button', { name: 'Show more activity' }).click();
    await settle(page);
    await expect.poll(() => feed.locator('ol > li').count()).toBeGreaterThanOrEqual(before);
    await page.getByRole('button', { name: 'Show less' }).click();
  });

  test('governance leads with a plain-language summary and keeps every setting', async ({ page }) => {
    await page.goto(`/o/${demo.id}/governance`);
    await settle(page);
    const summary = page.getByRole('list', { name: 'What each kind of change needs' });
    await expect(summary.getByRole('listitem')).toHaveCount(3);
    for (const level of ['patch', 'minor', 'major']) await expect(summary.getByText(level, { exact: true })).toBeVisible();
    await expect(summary).toContainText(/sign-off|no sign-off needed/);

    // Each section is collapsed to a summary and opens to the full controls.
    const sections: [RegExp, RegExp][] = [
      [/Policy template/, /Lazy consensus|Steward-led/],
      [/Change request rules/, /Minimum approvals/],
      [/Release rules/, /Minimum approvals/],
      [/Ownership, ODI and automation/, /Ownership transfer/],
      [/Members and roles/, /Transfer ownership/],
    ];
    for (const [title, inside] of sections) {
      await test.step(title.source, async () => {
        const header = page.getByRole('button', { name: title });
        await expect(header).toHaveAttribute('aria-expanded', 'false');
        await header.click();
        await expect(header).toHaveAttribute('aria-expanded', 'true');
        await expect(page.getByText(inside).first()).toBeVisible();
        await header.click();
        await expect(header).toHaveAttribute('aria-expanded', 'false');
      });
    }
  });

  test('the Manage members link opens the roles section', async ({ page }) => {
    await page.goto(`/o/${demo.id}`);
    await page.getByRole('link', { name: 'Manage' }).click();
    await expect(page).toHaveURL(/\/governance#roles$/);
    await expect(page.getByRole('button', { name: /Members and roles/ })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('Transfer ownership')).toBeVisible();
  });

  test('a change request shows its status as a bubble with the full flow, and readable dates', async ({ page }) => {
    await page.goto(`/o/${demo.id}/changes?status=all`);
    await settle(page);
    const first = page.locator('main a[href*="/changes/"]').first();
    await first.click();
    await settle(page);
    await expectNoCrash(page);
    const bubble = page.getByRole('button', { name: /^Status: / });
    await bubble.click();
    const panel = page.getByRole('dialog', { name: /^Status: / });
    await expect(panel.getByText('How a change request progresses')).toBeVisible();
    for (const s of ['Draft', 'Triage', 'In review', 'Approved', 'Merged', 'Released']) await expect(panel.getByText(s, { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    // Validation detail is collapsed behind summaries.
    await expect(page.getByRole('button', { name: /Lint findings/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /FAIR checks/ })).toBeVisible();
    // What happens next comes first; the approval arithmetic is behind "Approval details".
    await expect(page.getByText('Next:', { exact: true })).toBeVisible();
    const details = page.getByRole('button', { name: /Approval details/ });
    await expect(details).toHaveAttribute('aria-expanded', 'false');
    await details.click();
    await expect(page.getByText(/Rules for a/)).toBeVisible();
    // The AI rationale and the classification reasons open on request.
    const rationale = page.getByRole('button', { name: /Rationale and risks/ });
    if (await rationale.count()) {
      await rationale.click();
      await expect(page.getByText('Rationale', { exact: true })).toBeVisible();
    }
    const why = page.getByRole('button', { name: /Why it’s/ });
    if (await why.count()) {
      await why.click();
      await expect(why).toHaveAttribute('aria-expanded', 'true');
    }
    // No raw ISO timestamps leak into the page.
    await expect(page.locator('main')).not.toContainText(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  test('the simulated clock is one chip that opens fast-forward controls', async ({ page }) => {
    await page.goto(`/o/${demo.id}`);
    const clock = page.getByRole('button', { name: /^Simulated clock/ });
    await expect(clock).toBeVisible();
    await expect(page.getByRole('button', { name: '7 days', exact: true })).toHaveCount(0);
    await clock.click();
    const panel = page.getByRole('dialog', { name: /^Simulated clock/ });
    await expect(panel.getByText('Simulated governance clock')).toBeVisible();
    const before = await clock.innerText();
    await panel.getByRole('button', { name: '1 day', exact: true }).click();
    await expect(clock).not.toHaveText(before);
    await expect(clock).toContainText(/\(\+\d+d\)/);
  });

  test('requirements pages, including an interview, sit under Requirements', async ({ page }) => {
    await page.goto(`/o/${demo.id}/use-cases`);
    const nav = page.getByRole('navigation', { name: 'Ontology sections' });
    await expect(nav.getByRole('link', { name: 'Requirements' })).toHaveAttribute('aria-current', 'page');
    const sub = page.getByRole('navigation', { name: 'Requirements pages' });
    await expect(sub.getByRole('link')).toHaveText(['Use cases', 'Meetings', 'Agent reports']);
    await sub.getByRole('link', { name: 'Agent reports' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${demo.id}/agents$`));
    await expect(nav.getByRole('link', { name: 'Requirements' })).toHaveAttribute('aria-current', 'page');
  });

  test('change requests filter by Open, All or one status', async ({ page }) => {
    await page.goto(`/o/${demo.id}/changes`);
    await settle(page);
    await expect(page.getByRole('button', { name: 'Open', exact: true })).toBeVisible();
    const select = page.getByRole('combobox', { name: 'Filter by status' });
    await select.selectOption('merged');
    await expect(page).toHaveURL(/status=merged/);
    await settle(page);
    await expectNoCrash(page);
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await expect(page).toHaveURL(/status=all/);
    await expect(select).toHaveValue('');
  });

  test('members list shows assigned roles, with the full picker behind Edit roles', async ({ page }) => {
    await page.goto(`/o/${demo.id}/governance#roles`);
    await settle(page);
    const section = page.locator('#roles');
    await expect(section.getByRole('button', { name: 'Edit roles' }).first()).toBeVisible();
    // Unassigned roles are not shown as chips until editing.
    const chipsBefore = await section.getByRole('button', { name: 'Agent', exact: true }).count();
    expect(chipsBefore).toBe(0);
    await section.getByRole('button', { name: 'Edit roles' }).first().click();
    await expect(section.getByRole('button', { name: 'Agent', exact: true })).toHaveCount(1);
    await section.getByRole('button', { name: 'Done' }).click();
    await expect(section.getByRole('button', { name: 'Agent', exact: true })).toHaveCount(0);
    await section.getByRole('button', { name: 'Transfer ownership' }).click();
    await expect(section.getByRole('combobox')).toHaveCount(2);
  });

  test('a live interview lists sections still to cover on one line', async ({ page }) => {
    await page.goto(`/o/${demo.id}/use-cases?start=1`);
    await settle(page);
    await page.getByRole('main').getByRole('button', { name: /Describe a use case|Start an interview|New use case/ }).first().click();
    await page.waitForURL(/\/interview\//, { timeout: 20_000 });
    await settle(page);
    await expectNoCrash(page);
    await expect(page.getByRole('navigation', { name: 'Ontology sections' }).getByRole('link', { name: 'Requirements' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByText('Not covered yet:').first()).toBeVisible();
    await expect(page.getByText('Not covered yet', { exact: true })).toHaveCount(0);
  });

  test('use cases list stays plain until Draft changes starts a selection', async ({ page }) => {
    await page.goto(`/o/${demo.id}/use-cases`);
    await settle(page);
    await expect(page.getByRole('main').getByRole('checkbox')).toHaveCount(0);
    await page.getByRole('button', { name: 'Draft changes', exact: true }).click();
    const boxes = page.getByRole('main').getByRole('checkbox');
    expect(await boxes.count()).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: 'Draft changes from all' })).toBeVisible();
    await page.getByRole('button', { name: 'Select all' }).click();
    await expect(page.getByRole('button', { name: new RegExp(`Draft changes from ${await boxes.count()} selected`) })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(boxes).toHaveCount(0);
  });

  test('a use case opens its first group, with the rest a click away', async ({ page, request }) => {
    const ucs = (await (await page.request.get(`/api/ontologies/${demo.id}/use-cases`)).json()) as { id: string; completeness: number; source: string; status: string }[];
    const uc = [...ucs].sort((a, b) => b.completeness - a.completeness)[0];
    await page.goto(`/o/${demo.id}/use-cases/${uc.id}`);
    await settle(page);
    await expectNoCrash(page);
    const overview = page.getByRole('button', { name: /^Overview/ });
    await expect(overview).toHaveAttribute('aria-expanded', 'true');
    await overview.click();
    await expect(overview).toHaveAttribute('aria-expanded', 'false');
    const terms = page.getByRole('button', { name: /Terms mentioned/ });
    await expect(terms).toHaveAttribute('aria-expanded', 'false');
    await terms.click();
    await expect(terms).toHaveAttribute('aria-expanded', 'true');
    // Competency questions show the question and status first; detail opens per question.
    const detail = page.getByRole('button', { name: 'Example answer, terms and test' });
    if (await detail.count()) {
      await detail.first().click();
      await expect(detail.first()).toHaveAttribute('aria-expanded', 'true');
    }
  });

  test('a use case offers one primary action, chosen by its state', async ({ page, request }) => {
    const ucs = (await (await request.get(`/api/ontologies/${demo.id}/use-cases`)).json()) as { id: string; status: string; sections: { name?: string } }[];
    // Once the working group accepts a use case, drafting changes is the next step. Other
    // tests share the demo and may move this one on, so the expectation follows its status.
    const shifts = ucs.find((u) => u.sections.name === 'Find weekly shifts that need volunteers');
    expect(shifts).toBeTruthy();
    await page.goto(`/o/${demo.id}/use-cases/${shifts!.id}`);
    await settle(page);
    const draft = page.getByRole('button', { name: 'Draft changes' });
    if (['accepted', 'in-progress'].includes(shifts!.status)) await expect(draft).toHaveClass(/bg-accent /);
    else if (shifts!.status !== 'closed') await expect(draft).not.toHaveClass(/bg-accent /);
    // A closed use case has nothing left to draft.
    const closed = ucs.find((u) => u.status === 'closed');
    expect(closed).toBeTruthy();
    await page.goto(`/o/${demo.id}/use-cases/${closed!.id}`);
    await settle(page);
    await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Draft changes' })).toHaveCount(0);
  });

  test('releases are grouped into in progress, latest and previous', async ({ page, request }) => {
    const releases = (await (await page.request.get(`/api/ontologies/${demo.id}/releases`)).json()) as { status: string; version: string }[];
    await page.goto(`/o/${demo.id}/releases`);
    await settle(page);
    await expectNoCrash(page);
    if (releases.some((r) => r.status === 'draft' || r.status === 'voting')) await expect(page.getByRole('region', { name: 'In progress' })).toBeVisible();
    const published = releases.filter((r) => r.status === 'published');
    if (published.length) await expect(page.getByRole('region', { name: 'Latest published' })).toBeVisible();
    if (published.length > 1) {
      await page.getByRole('button', { name: /Previous releases/ }).click();
      await expect(page.getByText(`v${published[1].version}`).first()).toBeVisible();
    }
  });

  test('a published release keeps approval and technical details behind disclosures', async ({ page }) => {
    await page.goto(`/o/${demo.id}/releases`);
    await settle(page);
    const latest = page.getByRole('region', { name: 'Latest published' });
    test.skip(!(await latest.count()), 'no published release in the demo');
    await latest.getByRole('link').first().click();
    await settle(page);
    await expectNoCrash(page);
    const how = page.getByRole('button', { name: /How this was approved/ });
    await expect(how).toHaveAttribute('aria-expanded', 'false');
    await how.click();
    await expect(page.getByText('Next:', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Technical details/ }).click();
    await expect(page.getByText('Version IRI:')).toBeVisible();
  });
});
