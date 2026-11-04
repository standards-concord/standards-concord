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

  test('every ontology page leaves a clear gap below the ontology header', async ({ page }) => {
    for (const path of ['', '/browse', '/changes', '/governance', '/use-cases', '/query']) {
      await page.goto(`/o/${demo.id}${path}`);
      await settle(page);
      const gap = await page.evaluate(() => {
        const header = document.querySelector('.ontology-header')!.getBoundingClientRect();
        const first = [...document.querySelectorAll('.ontology-content *')].find((el) => {
          const r = el.getBoundingClientRect();
          return r.height > 0 && r.width > 0;
        })!;
        return first.getBoundingClientRect().top - header.bottom;
      });
      expect(gap, `gap below the header on ${path || 'overview'}`).toBeGreaterThanOrEqual(32);
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
    // Following the link closes the popup.
    await expect(panel).toHaveCount(0);
    await settle(page);
    // Arriving from the chip opens the lint findings, so linting is visible straight away.
    const lint = page.getByRole('button', { name: /Lint findings/ });
    await expect(lint).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#health').getByText(/No lint issues|Errors \(|Warnings \(|Suggestions \(/).first()).toBeVisible();
  });

  test('the overview keeps lint, FAIR and competency-question detail one click away', async ({ page }) => {
    // The page's own request context carries the signed-in session; validation needs it.
    const report = await (await page.request.get(`/api/ontologies/${demo.id}/validation?ref=working`)).json();
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
    // Opening the group shows every check at once: there is no second "Show all" toggle inside it.
    await expect(health.getByText(/Show all \d+ checks|Show failing only/)).toHaveCount(0);
    await expect(health.getByText(report.fair.checks[0].title, { exact: true }).first()).toBeVisible();

    const cqs = health.getByRole('button', { name: /Competency questions/ });
    if ((await cqs.getAttribute('aria-expanded')) !== 'true') await cqs.click();
    if (report.competencyQuestions?.length) await expect(health.getByText(report.competencyQuestions[0].question).first()).toBeVisible();
    await cqs.click();
    await expect(cqs).toHaveAttribute('aria-expanded', 'false');
  });

  test('the overview reads as a short report: summary, what waits for you, changes in progress', async ({ page }) => {
    const crs = (await (await page.request.get(`/api/ontologies/${demo.id}/change-requests`)).json()) as { id: string; number: number; title: string; status: string }[];
    const open = crs.filter((c) => ['voting', 'review', 'triage', 'needs-work', 'approved'].includes(c.status));
    await page.goto(`/o/${demo.id}`);
    await settle(page);
    // One plain sentence of counts, each linking to where the detail lives.
    const summary = page.getByTestId('overview-summary');
    await expect(summary).toContainText(/\d+ class(es)? and \d+ propert(y|ies)/);
    await expect(summary.getByRole('link', { name: /class/ })).toHaveAttribute('href', `/o/${demo.id}/browse`);
    await expect(summary.getByRole('link', { name: /use case/ })).toHaveAttribute('href', `/o/${demo.id}/use-cases`);
    // Changes in progress are a table that links to each change.
    const table = page.getByTestId('changes-in-progress');
    expect(open.length, 'the demo has changes in progress').toBeGreaterThan(0);
    await expect(table.getByRole('columnheader')).toHaveText(['Change', 'Stage', 'Size', 'Updated']);
    await expect(table.getByRole('row')).toHaveCount(Math.min(open.length, 8) + 1);
    await table.getByRole('link', { name: new RegExp(`#${open[0].number}`) }).first().waitFor();
    // A steward sees the changes waiting on them, each a link to act on.
    const asks = page.getByTestId('overview-asks');
    await expect(asks.getByRole('heading', { name: /waiting for you/ })).toBeVisible();
    const first = asks.getByRole('link').first();
    await expect(first).toHaveText(/^(Review|Vote on|Triage|Merge|Revise) #\d+: /);
    await first.click();
    await expect(page).toHaveURL(new RegExp(`/o/${demo.id}/changes/`));
  });

  for (const look of ['odi', 'spec', 'civic', 'workbench', 'classic'])
    test(`overview links are underlined and the action banner keeps a visible focus ring (${look})`, async ({ page }) => {
      await page.goto(`/o/${demo.id}?look=${look}`);
      await settle(page);
      // Links inside sentences never rely on colour alone.
      for (const link of await page.getByTestId('overview-summary').getByRole('link').all())
        expect(await link.evaluate((el) => getComputedStyle(el).textDecorationLine), await link.innerText()).toContain('underline');
      // The banner is filled with the accent colour, so its focus ring must differ from it.
      const asks = page.getByTestId('overview-asks');
      const link = asks.getByRole('link').first();
      await link.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(link).toBeFocused();
      const [ring, bg] = await link.evaluate((el) => [getComputedStyle(el).outlineColor, getComputedStyle(el.closest('[data-testid=overview-asks]')!).backgroundColor]);
      const ratio = await page.evaluate(
        ([a, b]) => {
          const parse = (c: string) => c.match(/[\d.]+/g)!.slice(0, 3).map(Number);
          const lum = ([r, g, bl]: number[]) => {
            const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
            return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl);
          };
          const [hi, lo] = [lum(parse(a)), lum(parse(b))].sort((x, y) => y - x);
          return (hi + 0.05) / (lo + 0.05);
        },
        [ring, bg],
      );
      expect(ratio, `focus ring ${ring} on ${bg}`).toBeGreaterThanOrEqual(3);
    });

  test('the overview health checks sit one heading level below their section', async ({ page }) => {
    await page.goto(`/o/${demo.id}`);
    await settle(page);
    const health = page.locator('#health');
    await expect(health.getByRole('heading', { level: 2, name: 'Health of the working draft' })).toBeVisible();
    for (const name of [/Lint findings/, /FAIR checks/, /Competency questions/]) await expect(health.getByRole('heading', { level: 3, name })).toBeVisible();
  });

  test('a contributor with nothing to act on sees no waiting panel', async ({ page }) => {
    await signIn(page, { name: 'Bystander', role: 'contributor' });
    await page.goto(`/o/${demo.id}`);
    await settle(page);
    await expect(page.getByTestId('changes-in-progress')).toBeVisible();
    await expect(page.getByTestId('overview-asks')).toHaveCount(0);
  });

  test('members show as avatars, with roles one click away', async ({ page }) => {
    await page.goto(`/o/${demo.id}`);
    await settle(page);
    const card = page.getByTestId('overview-members');
    await expect(card.getByRole('heading', { name: /^Members \(\d+\)$/ })).toBeVisible();
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
    const feed = page.getByTestId('overview-activity');
    const before = await feed.locator('ol > li').count();
    expect(before).toBeLessThanOrEqual(3);
    await page.getByRole('button', { name: 'Show more activity' }).click();
    await settle(page);
    await expect.poll(() => feed.locator('ol > li').count()).toBeGreaterThanOrEqual(before);
    await page.getByRole('button', { name: 'Show less' }).click();
  });

  test('governance leads with a plain-language summary and keeps every setting', async ({ page }) => {
    await page.goto(`/o/${demo.id}/governance`);
    await settle(page);
    // Separate summaries for changes and releases.
    for (const name of ['What each kind of change needs', 'What each kind of release needs']) {
      const summary = page.getByRole('list', { name });
      await expect(summary.getByRole('listitem')).toHaveCount(3);
      for (const level of ['Patch', 'Minor', 'Major']) await expect(summary.getByText(level, { exact: true })).toBeVisible();
      await expect(summary).toContainText(/sign-off/);
    }

    // Each section is collapsed to a summary and opens to a readable view.
    const sections: [RegExp, RegExp][] = [
      [/Policy template/, /Lazy consensus|Steward-led|Working group|Membership vote|ODI stewarded/],
      [/Change request rules/, /Compare all levels/],
      [/Release rules/, /Compare all levels/],
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
    // Every setting is still there, side by side, under Compare all levels.
    await page.getByRole('button', { name: /Change request rules/ }).click();
    await page.getByRole('button', { name: /Compare all levels/ }).first().click();
    for (const row of ['Approver roles', 'Minimum approvals', 'Review period', 'Lazy consensus', 'Vote', 'Veto roles', 'Auto-merge']) await expect(page.getByText(row, { exact: true }).first()).toBeVisible();
    // Reading is not editing: no disabled Save button sits on the page.
    await expect(page.getByRole('button', { name: 'Save policy' })).toHaveCount(0);
  });

  test('editing the policy is an explicit mode, one level at a time, with a preview', async ({ page }) => {
    await page.goto(`/o/${demo.id}/governance`);
    await settle(page);
    await page.getByRole('button', { name: 'Edit policy' }).click();
    await expect(page.getByText('Unsaved changes')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save policy' }).first()).toBeDisabled();
    // The template picker opens while editing.
    await expect(page.getByRole('button', { name: /Policy template/ })).toHaveAttribute('aria-expanded', 'true');

    await page.getByRole('button', { name: /Change request rules/ }).click();
    const levels = page.getByRole('group', { name: 'Level to edit' }).first();
    await expect(levels.getByRole('button', { name: 'Edit minor' })).toHaveAttribute('class', /border-accent/);
    // One column at a time; Compare all shows the three levels.
    const table = page.locator('table').first();
    await expect(table.locator('thead th')).toHaveCount(2);
    await levels.getByRole('button', { name: 'Compare all' }).click();
    await expect(table.locator('thead th')).toHaveCount(4);
    await levels.getByRole('button', { name: 'Edit major' }).click();
    await expect(table.locator('thead th')).toHaveCount(2);

    // Changing a number marks the policy unsaved and previews it in the summary.
    const review = table.getByRole('row').filter({ hasText: 'Review period' }).getByRole('spinbutton');
    await review.fill('21');
    await expect(page.getByText('Unsaved changes').first()).toBeVisible();
    await expect(page.getByText('Preview of unsaved changes')).toBeVisible();
    await expect(page.getByRole('list', { name: 'What each kind of change needs' })).toContainText('21 days open for comment');

    // Discard leaves edit mode without saving.
    await page.getByRole('button', { name: 'Discard' }).first().click();
    await expect(page.getByRole('button', { name: 'Edit policy' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'What each kind of change needs' })).not.toContainText('21 days open for comment');
  });

  test('the policy summary follows lazy consensus and ODI rules', async ({ page }) => {
    await page.goto(`/o/${demo.id}/governance`);
    await settle(page);
    await page.getByRole('button', { name: 'Edit policy' }).click();
    await page.getByRole('button', { name: /Lazy consensus \(Apache/ }).click();
    const changes = page.getByRole('list', { name: 'What each kind of change needs' });
    // Patch and minor only go to a vote if someone objects; major always does.
    await expect(changes.getByRole('listitem').nth(0)).toContainText('a vote only if someone objects');
    await expect(changes.getByRole('listitem').nth(2)).not.toContainText('only if someone objects');
    await page.getByRole('button', { name: /ODI stewarded/ }).click();
    await expect(changes.getByRole('listitem').nth(2)).toContainText('ODI oversight must approve');
    await expect(changes.getByRole('listitem').nth(0)).toContainText(/ODI oversight can block it/);
    await expect(page.locator('p', { hasText: 'Always:' })).toContainText('must approve major changes and releases');
    await page.getByRole('button', { name: 'Discard' }).first().click();
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
    await expect(panel).toHaveCount(0);
    // Escape returns focus to the bubble.
    await expect(bubble).toBeFocused();

    // What happens next and the viewer's actions sit together; the approval arithmetic is behind "Approval details".
    await expect(page.getByText('Next:', { exact: true })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Your actions' })).toBeVisible();
    const details = page.getByRole('button', { name: /Approval details/ });
    await expect(details).toHaveAttribute('aria-expanded', 'false');
    await details.click();
    await expect(page.getByText(/Rules for a/)).toBeVisible();

    // The classification is explained from the level badge itself.
    const level = page.getByRole('button', { name: /^Level: / });
    if (await level.count()) {
      await level.click();
      await expect(page.getByRole('dialog', { name: /^Level: / }).getByText(/Rule-based semantic versioning/)).toBeVisible();
      await page.keyboard.press('Escape');
    }

    // Changes, Checks and Discussion are separate views.
    const tabs = page.getByRole('tablist', { name: 'Change request views' });
    await expect(tabs.getByRole('tab')).toHaveCount(3);
    await expect(tabs.getByRole('tab', { name: /Changes/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText(/Proposed changes \(\d+\)/)).toBeVisible();
    const rationale = page.getByRole('button', { name: /Rationale and risks/ });
    if (await rationale.count()) {
      await rationale.click();
      await expect(page.getByText('Rationale', { exact: true })).toBeVisible();
    }

    await tabs.getByRole('tab', { name: /Checks/ }).click();
    await expect(page).toHaveURL(/view=checks/);
    await expect(page.getByText(/Proposed changes \(\d+\)/)).toHaveCount(0);
    const lint = page.getByRole('button', { name: /Lint findings/ });
    if (await lint.count()) {
      await expect(lint).toBeVisible();
      await expect(page.getByRole('button', { name: /FAIR checks/ })).toBeVisible();
    } else await expect(page.getByText(/Not validated yet/)).toBeVisible();

    await tabs.getByRole('tab', { name: /Discussion/ }).click();
    await expect(page.getByText('Reviews and timeline')).toBeVisible();
    // The view survives a reload.
    await page.reload();
    await settle(page);
    await expect(page.getByRole('tab', { name: /Discussion/ })).toHaveAttribute('aria-selected', 'true');
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

  test('change requests filter by scope, then by any status', async ({ page }) => {
    await page.goto(`/o/${demo.id}/changes`);
    await settle(page);
    await expect(page.getByRole('button', { name: 'Open', exact: true })).toBeVisible();
    const select = page.getByRole('combobox', { name: 'Status' });
    // Every status can be chosen, including triage, rejected and withdrawn.
    const options = (await select.locator('option').allInnerTexts()).map((t) => t.trim());
    for (const s of ['Draft', 'Triage', 'In review', 'Voting', 'Needs work', 'Approved', 'Merged', 'Released', 'Rejected', 'Withdrawn']) expect(options).toContain(s);
    // The selector is compact, not a full-width row.
    expect((await select.boundingBox())!.width).toBeLessThan(260);
    await select.selectOption('merged');
    await expect(page).toHaveURL(/status=merged/);
    await settle(page);
    await expectNoCrash(page);
    await expect(page.getByText(/^\d+ merged ·/)).toBeVisible();
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(page).toHaveURL(/status=open/);
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await expect(page).toHaveURL(/status=all/);
    await expect(select).toHaveValue('');
    await expect(page.getByText(/^\d+ in total$/)).toBeVisible();
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
    // Adding a person and transferring ownership are each one click away.
    await expect(section.getByRole('combobox')).toHaveCount(0);
    await section.getByRole('button', { name: /Add a person/ }).click();
    await expect(section.getByRole('combobox', { name: 'Person to add' })).toBeVisible();
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
    // An interview belongs to Use cases at the second level too.
    await expect(page.getByRole('navigation', { name: 'Requirements pages' }).getByRole('link', { name: 'Use cases' })).toHaveAttribute('aria-current', 'page');
    // Conversation first: progress and what is still to cover on one strip, the full document on request.
    const strip = page.getByRole('region', { name: 'Use case progress' });
    await expect(strip.getByText('Not covered yet:')).toBeVisible();
    await expect(strip).toContainText(/\d+ of \d+ sections filled/);
    await expect(page.getByText('Not covered yet', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Use case document' })).toHaveCount(0);
    const layout = page.getByRole('group', { name: 'Interview layout' });
    await layout.getByRole('button', { name: 'View document' }).click();
    await expect(layout.getByRole('button', { name: 'View document' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('region', { name: 'Use case document' })).toBeVisible();
    await expect(page.getByPlaceholder(/Type your answer/)).toBeHidden();
    await layout.getByRole('button', { name: 'Side by side' }).click();
    await expect(page.getByRole('region', { name: 'Use case document' })).toBeVisible();
    await expect(page.getByPlaceholder(/Type your answer/)).toBeVisible();
    // The choice is remembered.
    await page.reload();
    await settle(page);
    await expect(page.getByRole('group', { name: 'Interview layout' }).getByRole('button', { name: 'Side by side' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('group', { name: 'Interview layout' }).getByRole('button', { name: 'Conversation' }).click();
  });

  test('each section remembers the page you were last on', async ({ page }) => {
    await page.goto(`/o/${demo.id}/query`);
    await settle(page);
    const nav = page.getByRole('navigation', { name: 'Ontology sections' });
    await nav.getByRole('link', { name: 'Governance' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${demo.id}/governance$`));
    await nav.getByRole('link', { name: 'Explore' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${demo.id}/query$`));
    // A filter is remembered with its page; a detail page is remembered as its list.
    await page.goto(`/o/${demo.id}/changes?status=merged`);
    await settle(page);
    await nav.getByRole('link', { name: 'Overview' }).click();
    await nav.getByRole('link', { name: 'Changes' }).click();
    await expect(page).toHaveURL(/\/changes\?status=merged$/);
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
    // Group toggles stay inside real headings, and say how much of each group is filled.
    await expect(page.getByRole('heading', { level: 3, name: /^Overview/ })).toBeVisible();
    await expect(overview).toContainText(/\d+ of \d+ filled/);
    await overview.click();
    await expect(overview).toHaveAttribute('aria-expanded', 'false');
    const terms = page.getByRole('button', { name: /Terms mentioned/ });
    await expect(terms).toHaveAttribute('aria-expanded', 'false');
    await terms.click();
    await expect(terms).toHaveAttribute('aria-expanded', 'true');
    // Competency questions show the question and status first; detail opens per question.
    // Each question's toggle is named after its question, and one click shows the SPARQL test too.
    const detail = page.getByRole('button', { name: /^Example answer, terms and test for “/ });
    if (await detail.count()) {
      await detail.first().click();
      await expect(detail.first()).toHaveAttribute('aria-expanded', 'true');
      if (await page.getByText('SPARQL test', { exact: true }).count()) await expect(page.getByText('SPARQL test', { exact: true }).first()).toBeVisible();
    }
    // Closing and reopening a group keeps what was open inside it.
    const cqGroup = page.getByRole('button', { name: /^Competency questions/ });
    if (await detail.count()) {
      await cqGroup.click();
      await cqGroup.click();
      await expect(detail.first()).toHaveAttribute('aria-expanded', 'true');
    }
    // One primary action, chosen by the use case's state.
    const primary = uc.source === 'chat' && uc.status === 'eliciting' ? 'Continue the interview' : uc.status === 'ready' || uc.status === 'synthesised' ? 'Draft changes' : 'Mark as ready';
    await expect(page.getByRole('button', { name: primary })).toHaveClass(/bg-accent /);
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
      // The version link and the notes toggle are separate controls.
      const link = page.getByRole('link', { name: `v${published[1].version}`, exact: true });
      await expect(link).toBeVisible();
      const notes = page.getByRole('button', { name: `Show notes for v${published[1].version}` });
      await notes.click();
      await expect(page.getByRole('button', { name: `Hide notes for v${published[1].version}` })).toHaveAttribute('aria-expanded', 'true');
      await link.click();
      await expect(page).toHaveURL(/\/releases\/[^/]+$/);
    }
    // Rejected attempts are a labelled section of their own, not buried in history.
    if (releases.some((r) => r.status === 'rejected')) {
      await page.goto(`/o/${demo.id}/releases`);
      await expect(page.getByRole('region', { name: 'Rejected attempts' })).toBeVisible();
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
    // One click reveals the approval history: no second "Approval details" click needed.
    await expect(page.getByRole('button', { name: /Approval details/ })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText(/Rules for a .* release/)).toBeVisible();
    await page.getByRole('button', { name: /Technical details/ }).click();
    await expect(page.getByText('Version IRI:')).toBeVisible();
  });
});
