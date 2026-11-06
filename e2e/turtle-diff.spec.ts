import { test, expect, demoOntology, signIn, signInAsPersona } from './fixtures';

/**
 * A change request's Diff tab: the ontology's Turtle before and after the change, like a pull
 * request on GitHub. It replaced the raw "Triples" view (Jesse, 6 Nov 2026).
 */
test.describe('Turtle diff on a change request', () => {
  test('a reviewer sees the changed lines, removed and added, with line numbers and context', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signInAsPersona(page, 'Mei Chen');
    const crs = (await (await page.request.get(`/api/ontologies/${demo.id}/change-requests`)).json()) as { id: string; title: string }[];
    // "Allow only one location per session" makes has location functional: one line changes.
    const cr = crs.find((c) => /one location per session/.test(c.title));
    expect(cr, 'the demo change request').toBeTruthy();
    await page.goto(`/o/${demo.id}/changes/${cr!.id}`);
    await page.getByRole('tab', { name: /^Diff/ }).click();
    await expect(page).toHaveURL(/view=diff/);
    const diff = page.getByRole('table', { name: 'Turtle diff' });
    await expect(diff.locator('[data-diff="del"]').filter({ hasText: 'vol:hasLocation a owl:ObjectProperty ;' })).toHaveCount(1);
    await expect(diff.locator('[data-diff="add"]').filter({ hasText: 'owl:FunctionalProperty' })).toHaveCount(1);
    // Three lines of context each side, under a hunk header.
    await expect(diff.getByText(/^@@ −\d+,7 \+\d+,7 @@$/)).toBeVisible();
    await expect(diff.locator('[data-diff="same"]')).toHaveCount(6);
    await expect(page.getByTestId('turtle-diff-summary')).toHaveText('+1 −1 lines');
    // The link to the tab can be shared.
    await page.reload();
    await expect(page.getByRole('tab', { name: /^Diff/ })).toHaveAttribute('aria-selected', 'true');
    await expect(diff).toBeVisible();
  });

  test('signed-out visitors can’t read a change request’s Turtle diff', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signIn(page, { name: 'Diff reader', role: 'contributor' });
    const crs = (await (await page.request.get(`/api/ontologies/${demo.id}/change-requests`)).json()) as { id: string }[];
    await page.context().clearCookies();
    const r = await page.request.get(`/api/change-requests/${crs[0].id}/turtle-diff`);
    expect(r.status()).toBe(401);
  });
});
