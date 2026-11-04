import type { Page } from '@playwright/test';
import { test, expect, signIn } from './fixtures';

/**
 * Testers can choose to post a short summary of their feedback as a public
 * GitHub issue (here, to the local stand-in for GitHub started by
 * playwright.config.ts). Nothing else is posted, and they can withdraw it.
 */
const STUB = `http://localhost:${process.env.E2E_GITHUB_STUB_PORT ?? 8799}`;

interface StubIssue {
  number: number;
  repo: string;
  authorized: boolean;
  title: string;
  body: string;
  labels: string[];
  state: string;
}

async function tellUsSomething(page: Page, said: string) {
  await signIn(page, { name: 'Robin Okafor', role: 'member' });
  await page.goto('/feedback');
  await page.getByRole('button', { name: /Just tell us something/ }).click();
  const box = page.getByPlaceholder('Type or tap the mic and talk…');
  await expect(box).toBeEnabled();
  await box.fill(said);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText(said).first()).toBeVisible();
  await page.getByLabel('Name (optional)').fill('Robin Okafor');
  await page.getByLabel('Email (optional)').fill('robin.okafor@example.org');
}

const stubIssues = async (page: Page) => (await (await page.request.get(`${STUB}/__issues`)).json()) as StubIssue[];

test('feedback is not posted anywhere unless the tester opts in', async ({ page }) => {
  const before = (await stubIssues(page)).length;
  await tellUsSomething(page, 'Robin here: private feedback that should stay private');
  await expect(page.getByLabel('Also post a short public summary as a GitHub issue')).not.toBeChecked();
  await page.getByRole('button', { name: /Submit/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Thank you!' })).toBeVisible();
  await expect(page.getByTestId('feedback-publication')).toHaveCount(0);
  expect((await stubIssues(page)).length).toBe(before);
});

test('a tester posts a public summary exactly as previewed, then withdraws it', async ({ page }) => {
  await tellUsSomething(page, 'Robin here, robin.okafor@example.org: lots of private detail about my organisation');
  await page.getByLabel('Also post a short public summary as a GitHub issue').check();
  await expect(page.getByText(/Your answers, name, email, role and the conversation are not posted/)).toBeVisible();
  // Submitting needs a summary.
  await expect(page.getByRole('button', { name: /Submit what I’ve said so far/ })).toBeDisabled();
  await page.getByLabel('Public summary', { exact: true }).fill('Release notes need a link back to the ontology. Details: me@example.org https://example.org/x');
  const preview = page.getByTestId('public-summary-preview');
  await expect(preview).toHaveText('Release notes need a link back to the ontology. Details: [email removed] [link removed]');
  await page.getByRole('button', { name: /Submit what I’ve said so far/ }).click();

  await expect(page.getByRole('heading', { name: 'Thank you!' })).toBeVisible();
  const note = page.getByTestId('feedback-publication');
  await expect(note).toContainText(/posted as issue #\d+/);
  const number = Number((await note.innerText()).match(/#(\d+)/)![1]);

  const issue = (await stubIssues(page)).find((i) => i.number === number)!;
  expect(issue.repo).toBe('jeswr/standards-concord');
  expect(issue.authorized).toBe(true);
  expect(issue.labels).toEqual(['feedback', 'needs-triage']);
  expect(issue.title).toMatch(/^Feedback: Release notes need a link back to the ontology\. Details: /);
  expect(issue.body).toContain('> Release notes need a link back to the ontology. Details: \\[email removed\\] \\[link removed\\]');
  expect(`${issue.title}\n${issue.body}`).not.toMatch(/Robin|Okafor|example\.org|organisation|member/);

  await note.getByRole('button', { name: 'Withdraw the public summary' }).click();
  await expect(note).toContainText('Your public summary has been withdrawn');
  const after = (await stubIssues(page)).find((i) => i.number === number)!;
  expect(after).toMatchObject({ state: 'closed', title: 'Withdrawn feedback', body: 'The tester withdrew this feedback.' });
});
