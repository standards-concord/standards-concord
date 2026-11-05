import { test, expect, expectNoCrash, settle, demoOntology } from './fixtures';

/**
 * The alpha walkthrough at /alpha, step by step, the way a tester goes through it:
 * welcome, pick a role, try the tasks for that role, simulate the other
 * participants, then open the feedback chat.
 */

const ROLE_GROUPS = ['Ontology steward', 'Domain expert / contributor', 'Voting member', 'ODI oversight', 'Agent developer'];

test.beforeEach(async ({ page }) => {
  // The walkthrough keeps its progress in localStorage; start each test from the beginning.
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      localStorage.clear();
      sessionStorage.setItem('e2e-init', '1');
    }
  });
});

test('a tester can go through the whole walkthrough', async ({ page, request }) => {
  const demo = await demoOntology(request);
  await page.goto('/alpha');
  await expect(page.getByRole('heading', { name: 'Guided walkthrough' })).toBeVisible();

  // 1. Welcome
  await expect(page.getByRole('heading', { name: '1. Welcome' })).toBeVisible();
  // The feature tour is one click away rather than in front of the Start button.
  await page.getByRole('button', { name: 'What can I try?' }).click();
  await expect(page.getByText(/Coding agents connect over MCP/)).toBeVisible();
  await page.getByRole('button', { name: 'Let’s start' }).click();

  // 2. Pick a role: every tester-facing role group is offered; people appear once a role is chosen.
  await expect(page.getByRole('heading', { name: '2. Pick your role' })).toBeVisible();
  for (const g of ROLE_GROUPS) await expect(page.getByRole('region', { name: g }).getByRole('button').first()).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Join as a new ontology steward' })).toHaveCount(0);
  const steward = page.getByRole('region', { name: 'Ontology steward' });
  await steward.getByRole('button').first().click();
  await expect(steward.getByRole('button').first()).toHaveAttribute('aria-expanded', 'true');
  // Priya Shah (the steward) also has the ODI role, so the steward group offers to join as a new steward.
  await steward.getByRole('button', { name: 'Join as a new ontology steward' }).click();

  // 3. Explore the demo: signed in, with tasks tailored to the role.
  await expect(page.getByRole('heading', { name: '3. Explore the demo' })).toBeVisible();
  await expect(page.getByText('Viewing as Alpha tester')).toBeVisible();
  await expect(page.getByText(/As .*Steward/)).toBeVisible();
  await expect(page.getByRole('link', { name: demo.title })).toBeVisible();
  // One suggested task up front; the full list is behind "Choose another task".
  const next = page.getByRole('group', { name: 'Suggested next task' });
  await expect(next).toBeVisible();
  const firstLabel = (await next.getByRole('link').first().innerText()).trim();
  await page.getByRole('button', { name: /Choose another task/ }).click();
  const tasks = page.locator('ul li').filter({ has: page.getByRole('button', { name: /Mark (not )?done/ }) });
  await expect(tasks.first()).toBeVisible();
  const count = await tasks.count();
  expect(count).toBeGreaterThanOrEqual(3);
  await expect(page.getByText(`0 of ${count} done`)).toBeVisible();
  await next.getByRole('button', { name: 'I’ve done this' }).click();
  await expect(page.getByText(`1 of ${count} done`)).toBeVisible();
  // The suggestion moves on to the next task, and the list shows the first as done.
  await expect(next.getByRole('link').first()).not.toHaveText(firstLabel);
  // Done tasks move to their own list, apart from the ones still to try.
  const doneList = page.getByRole('list', { name: 'Done' });
  const todoList = page.getByRole('list', { name: 'Still to try' });
  await expect(doneList.getByRole('button', { name: 'Mark not done' })).toHaveCount(1);
  await expect(todoList.getByRole('button', { name: 'Mark not done' })).toHaveCount(0);
  await todoList.getByRole('button', { name: 'Mark done' }).first().click();
  await expect(page.getByText(`2 of ${count} done`)).toBeVisible();
  await expect(doneList.getByRole('listitem')).toHaveCount(2);
  await page.getByRole('button', { name: 'Next: simulate the others' }).click();

  // 4. Simulate the others: their activity appears and the clock moves.
  await expect(page.getByRole('heading', { name: '4. Simulate the others' })).toBeVisible();
  const clock = page.getByText(/^Simulated time:/);
  const before = await clock.innerText();
  await page.getByRole('button', { name: 'Simulate the others' }).click();
  await expect(page.getByText('simulated', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: '+7 days' }).click();
  await expect(clock).not.toHaveText(before);
  await page.getByRole('button', { name: 'I’m ready to give feedback' }).click();

  // 5. Feedback
  await expect(page.getByRole('heading', { name: '5. Give feedback' })).toBeVisible();
  await page.getByRole('main').getByRole('button', { name: 'Give feedback' }).click();
  await expect(page).toHaveURL(/\/feedback$/);
  await settle(page);
  await expectNoCrash(page);

  // Progress survives a reload.
  await page.goto('/alpha');
  await expect(page.getByRole('heading', { name: '5. Give feedback' })).toBeVisible();
  await page.getByRole('button', { name: 'Restart' }).click();
  await expect(page.getByRole('heading', { name: '1. Welcome' })).toBeVisible();
});

for (const group of ROLE_GROUPS) {
  test(`every task suggested to a ${group} opens a working page`, async ({ page }) => {
    await page.goto('/alpha');
    await page.getByRole('button', { name: 'Let’s start' }).click();
    const region = page.getByRole('region', { name: group });
    await region.getByRole('button').first().click();
    const first = region.getByRole('button').nth(1);
    await expect(first).toBeVisible();
    await first.click();
    await expect(page.getByRole('heading', { name: '3. Explore the demo' })).toBeVisible();

    await page.getByRole('button', { name: /Choose another task/ }).click();
    const links = page.locator('ul li a.text-sm');
    await expect(links.first()).toBeVisible();
    const targets = await links.evaluateAll((as) => as.map((a) => ({ label: a.textContent ?? '', href: a.getAttribute('href') ?? '' })));
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) {
      await test.step(t.label, async () => {
        await page.goto(t.href);
        await settle(page);
        await expectNoCrash(page);
        await expect(page.getByRole('navigation', { name: 'Ontology sections' })).toBeVisible();
      });
    }
  });
}

test('the floating walkthrough panel follows a tester around the app', async ({ page }) => {
  await page.goto('/alpha');
  await page.getByRole('button', { name: 'Let’s start' }).click();
  const contributor = page.getByRole('region', { name: 'Domain expert / contributor' });
  await contributor.getByRole('button').first().click();
  await contributor.getByRole('button').nth(1).click();
  // Wait until the demo ontology is known, so the button opens it rather than the hub.
  await expect(page.getByText(/The demo ontology is/)).toBeVisible();
  await page.getByRole('button', { name: 'Keep the guide open while I explore' }).click();
  await expect(page).toHaveURL(/\/o\/[^/]+$/);
  const panel = page.getByRole('complementary').filter({ hasText: 'Alpha walkthrough' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Step 3: Explore the demo')).toBeVisible();
  // The floating guide shows one suggested task, with the rest on request.
  await expect(panel.getByRole('group', { name: 'Suggested next task' })).toBeVisible();
  await expect(panel.getByRole('button', { name: /Choose another task/ })).toHaveAttribute('aria-expanded', 'false');
  // The step chooser is in a menu rather than always on screen.
  await panel.getByRole('button', { name: 'All walkthrough steps' }).click();
  await expect(panel.getByRole('dialog', { name: 'All walkthrough steps' }).getByRole('button')).toHaveCount(5);
  await page.keyboard.press('Escape');
  await panel.getByRole('button', { name: 'Close walkthrough' }).click();
  await expect(panel).toHaveCount(0);
  // Closed, the guide still names the next task and how far through the tester is.
  const pill = page.getByRole('button', { name: /^Walkthrough: Try next: .+\. Open the guide$/ });
  await expect(pill).toBeVisible();
  await expect(pill).toContainText(/\d+\/\d+ tasks/);
  await page.getByRole('button', { name: /Walkthrough/ }).click();
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Full view' }).click();
  await expect(page).toHaveURL(/\/alpha$/);
});

test('on a short screen the steps menu opens upwards and stays on screen', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 560 });
  await page.goto('/alpha');
  await page.getByRole('button', { name: 'Let’s start' }).click();
  const contributor = page.getByRole('region', { name: 'Domain expert / contributor' });
  await contributor.getByRole('button').first().click();
  await contributor.getByRole('button').nth(1).click();
  await expect(page.getByText(/The demo ontology is/)).toBeVisible();
  await page.getByRole('button', { name: 'Keep the guide open while I explore' }).click();
  const panel = page.getByRole('complementary').filter({ hasText: 'Alpha walkthrough' });
  const trigger = panel.getByRole('button', { name: 'All walkthrough steps' });
  await trigger.click();
  const menu = panel.getByRole('dialog', { name: 'All walkthrough steps' });
  await expect(menu).toBeVisible();
  const box = (await menu.boundingBox())!;
  const t = (await trigger.boundingBox())!;
  // Fully inside the viewport, vertically as well as sideways.
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(560);
  // Near the bottom of the screen there's more room above the trigger, so it opens upwards.
  if (t.y > 560 / 2) await expect(menu).toHaveAttribute('data-placement', 'top');
});

test('the steps menu keeps its height cap through resizes, and never outgrows a very short screen', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 560 });
  await page.goto('/alpha');
  await page.getByRole('button', { name: 'Let’s start' }).click();
  const contributor = page.getByRole('region', { name: 'Domain expert / contributor' });
  await contributor.getByRole('button').first().click();
  await contributor.getByRole('button').nth(1).click();
  await page.getByRole('button', { name: 'Keep the guide open while I explore' }).click();
  const panel = page.getByRole('complementary').filter({ hasText: 'Alpha walkthrough' });
  await panel.getByRole('button', { name: 'All walkthrough steps' }).click();
  const menu = panel.getByRole('dialog', { name: 'All walkthrough steps' });
  await expect(menu).toBeVisible();
  const cap = () => menu.evaluate((el) => (el as HTMLElement).style.maxHeight);
  const before = await cap();
  expect(before).toMatch(/^min\(32rem, \d+px\)$/);
  // A width-only resize leaves the room above and below unchanged; the cap must still be there afterwards.
  await page.setViewportSize({ width: 1000, height: 560 });
  await expect.poll(cap).toBe(before);
  const inView = async (vh: number) => {
    const box = (await menu.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(vh);
  };
  await inView(560);
  // On a much shorter screen the cap follows the room that's actually there, so it still fits.
  await page.setViewportSize({ width: 1000, height: 380 });
  await expect.poll(cap).not.toBe(before);
  await inView(380);
});
