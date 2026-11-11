import fs from 'node:fs';
import { test, expect, signIn, uniq } from './fixtures';

const question = 'Which volunteering opportunities support the environment, and which organisations offer them?';
const ask = 'Is there any role that requires a background (DBS) check?';

test('a signed-out visitor reads answers, copies a query and downloads the release examples', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  for (const version of ['', '/1.0.0', '/draft']) {
    await page.goto(`/def/volunteering${version}`);
    await page.getByRole('tab', { name: 'Examples', exact: true }).click();
    const panel = page.getByRole('tabpanel', { name: 'Examples', exact: true });
    const example = panel.getByRole('region', { name: question, exact: true });
    await expect(example.getByRole('table')).toContainText('Saturday park clean-up');
    await expect(panel.getByRole('region', { name: ask, exact: true }).getByText('Yes', { exact: true })).toBeVisible();
    const query = example.locator('details').filter({ has: page.locator('summary', { hasText: /^Query$/ }) });
    await query.getByText('Query', { exact: true }).click();
    await expect(query.getByRole('code')).toContainText('SELECT ?opportunity ?title ?organisation');
    await query.getByRole('button', { name: 'Copy query', exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('SELECT ?opportunity');
    await query.getByRole('button', { name: 'Copied', exact: true }).click();
    await expect(query.getByRole('button', { name: 'Copy query', exact: true })).toBeVisible();
    const queryDownload = page.waitForEvent('download');
    await query.getByRole('link', { name: 'Download query', exact: true }).click();
    const file = await queryDownload;
    expect(file.suggestedFilename()).toMatch(/^1-.*\.rq$/);
    expect(fs.readFileSync((await file.path())!, 'utf8')).toContain('SELECT ?opportunity');
    const source = example.getByRole('link', { name: /UC-\d+:/ });
    await source.click();
    await expect(page.getByRole('tab', { name: /Use cases and requirements/ })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: 'Download and cite' }).click();
    const downloads = page.getByRole('tabpanel', { name: 'Download and cite' });
    const allDownload = page.waitForEvent('download');
    await downloads.getByRole('row', { name: /Worked examples application\/json/ }).getByRole('link', { name: 'Download', exact: true }).click();
    const json = await allDownload;
    const examples = JSON.parse(fs.readFileSync((await json.path())!, 'utf8'));
    expect(examples[0].question).toBe(question);
    expect(examples[0].result.totalCount).toBeGreaterThan(0);
    const dataDownload = page.waitForEvent('download');
    await downloads.getByRole('row', { name: /^Example data text\/turtle/ }).getByRole('link', { name: 'Download', exact: true }).click();
    const data = await dataDownload;
    expect(fs.readFileSync((await data.path())!, 'utf8')).toContain('Saturday park clean-up');
  }
});

test('example anchors and folded data work without JavaScript', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto(`${baseURL}/def/volunteering/1.0.0`);
    const panel = page.getByRole('tabpanel', { name: 'Examples', exact: true });
    const example = panel.getByRole('region', { name: question, exact: true });
    await expect(example.getByRole('table')).toContainText('Saturday park clean-up');
    await example.getByRole('link', { name: 'Link to this question', exact: true }).click();
    await expect(page).toHaveURL(/#example-/);
    await example.locator('summary').filter({ hasText: /^Example data$/ }).click();
    await expect(example.getByRole('code').filter({ hasText: /All data is fictional/ })).toBeVisible();
  } finally {
    await context.close();
  }
});

for (const role of ['editor', 'contributor']) {
  test(`${role}: start Validate data with the selected version's examples and checks clean`, async ({ page }) => {
    await signIn(page, { name: `Examples ${role} ${uniq()}`, role });
    await page.goto('/o/volunteering/validate');
    const version = page.getByLabel('Version to validate against');
    for (const value of ['1.0.0', 'draft']) {
      await version.selectOption(value);
      await page.getByRole('link', { name: 'Use example data', exact: true }).click();
      await expect(page.getByTestId('validate-editor')).toContainText('Saturday park clean-up');
      await expect(page.getByTestId('validation-verdict')).toContainText('Conforms to the shapes');
      await expect(page.getByTestId('validation-verdict')).toContainText('Every term is defined');
      await expect(page.getByTestId('validation-subtitle')).toContainText(value === 'draft' ? 'the working draft' : 'v1.0.0');
      await expect(page.getByTestId('validate-status')).toHaveText(/^Checked in/);
    }
  });
}

test('signed out, Validate data sends you to sign in', async ({ page }) => {
  await page.goto('/o/volunteering/validate');
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('link', { name: 'Use example data', exact: true })).toHaveCount(0);
});
