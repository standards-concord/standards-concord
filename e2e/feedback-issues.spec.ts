import { test, expect, signIn } from './fixtures';

/**
 * Tester feedback is filed as an anonymised GitHub issue (here, to the local
 * stand-in for GitHub started by playwright.config.ts), and the tester is told.
 */
const STUB = `http://localhost:${process.env.E2E_GITHUB_STUB_PORT ?? 8799}`;

interface StubIssue {
  number: number;
  repo: string;
  authorized: boolean;
  title: string;
  body: string;
  labels: string[];
}

test('feedback opens an anonymised GitHub issue and the tester sees its number', async ({ page, request }) => {
  await signIn(page, { name: 'Robin Okafor', role: 'member' });
  await page.goto('/feedback');
  await page.getByRole('button', { name: /Just tell us something/ }).click();
  const box = page.getByPlaceholder('Type or tap the mic and talk…');
  await expect(box).toBeEnabled();
  const said = 'Robin here, robin.okafor@example.org: the release notes page has no link back to the ontology';
  await box.fill(said);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText(said).first()).toBeVisible();

  // The form says names and emails stay out of the issue tracker.
  await expect(page.getByText('never added to the issue tracker')).toBeVisible();
  await page.getByLabel('Name (optional)').fill('Robin Okafor');
  await page.getByLabel('Email (optional)').fill('robin.okafor@example.org');
  await page.getByRole('button', { name: /Submit/ }).first().click();

  await expect(page.getByRole('heading', { name: 'Thank you!' })).toBeVisible();
  const note = page.getByTestId('feedback-issue');
  await expect(note).toContainText(/issue #\d+/);
  await expect(note).toContainText('without your name, email or the chat transcript');
  const number = Number((await note.innerText()).match(/#(\d+)/)![1]);

  const issues = (await (await request.get(`${STUB}/__issues`)).json()) as StubIssue[];
  const issue = issues.find((i) => i.number === number)!;
  expect(issue.repo).toBe('jeswr/standards-concord');
  expect(issue.authorized).toBe(true);
  expect(issue.labels).toEqual(['feedback', 'needs-triage']);
  expect(issue.title).toBe('Feedback: [name removed] here, [email removed]: the release notes page has no link back to the ontology');
  expect(issue.body).toContain('the release notes page has no link back to the ontology');
  expect(`${issue.title}\n${issue.body}`).not.toMatch(/Robin|Okafor|example\.org/);
});
