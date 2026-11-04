import { test, expect, signIn, demoOntology } from './fixtures';

/**
 * The public page behind the ontology IRI and every version IRI: what someone
 * outside the working group sees when they open https://w3id.org/odi/<slug>/<version>.
 * No sign-in is needed. RDF clients get RDF from the same address.
 */

const PAGE = '/def/volunteering';

test.describe('Public ontology page', () => {
  test('the ontology IRI shows the latest release with its metadata and tabs', async ({ page }) => {
    await page.goto(PAGE);
    await expect(page).toHaveTitle(/Volunteering.*1\.0\.0/i);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/Volunteering/i);
    await expect(page.getByText('Latest release', { exact: true })).toBeVisible();
    await expect(page.locator('dl.meta')).toContainText('https://w3id.org/odi/volunteering/1.0.0');
    const tabs = page.getByRole('tablist', { name: 'Sections' });
    for (const name of ['Specification', 'Use cases and requirements', 'Changes', 'Download and cite']) await expect(tabs.getByRole('tab', { name: new RegExp(name) })).toBeVisible();
    await expect(tabs.getByRole('tab', { name: 'Specification' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Abstract' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Class hierarchy' })).toBeVisible();
  });

  test('every term has a readable entry and the term index jumps to it', async ({ page }) => {
    await page.goto(PAGE);
    const card = page.locator('article.term#VolunteeringOpportunity');
    await expect(card).toHaveCount(1);
    await expect(card.locator('.kind')).toHaveText('Class');
    await expect(card.locator('.iri')).toContainText('https://w3id.org/odi/volunteering#VolunteeringOpportunity');
    await page.locator('#sec-index').getByRole('link', { name: /^Volunteering opportunity$/i }).click();
    await expect(page).toHaveURL(/#VolunteeringOpportunity$/);
    await expect(card).toBeInViewport();
    // Cross references inside an entry link to other entries on the page.
    const ref = card.locator('a.ref[href^="#"]').first();
    const target = (await ref.getAttribute('href'))!;
    await ref.click();
    await expect(page.locator(target)).toBeInViewport();
  });

  test('a term IRI fragment opens the right tab and scrolls to the term', async ({ page }) => {
    await page.goto(`${PAGE}/1.0.0#tab-download`);
    await expect(page.getByRole('heading', { name: 'Formats' })).toBeVisible();
    await page.goto(`${PAGE}/1.0.0#Volunteer`);
    await expect(page.getByRole('tab', { name: 'Specification' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('article.term#Volunteer')).toBeInViewport();
  });

  test('the term filter narrows the index', async ({ page }) => {
    await page.goto(PAGE);
    const index = page.locator('#sec-index');
    const all = await index.locator('[data-term]:visible').count();
    await page.getByPlaceholder('Filter terms').fill('volunteer');
    await expect.poll(() => index.locator('[data-term]:visible').count()).toBeLessThan(all);
    await expect(index.getByRole('link', { name: /^volunteer$/i })).toBeVisible();
    await page.getByPlaceholder('Filter terms').fill('zzzz-no-match');
    await expect(index.getByText('No terms match.')).toBeVisible();
  });

  test('the use cases tab shows the use cases behind the release and their status', async ({ page }) => {
    await page.goto(PAGE);
    await page.getByRole('tab', { name: /Use cases and requirements/ }).click();
    await expect(page).toHaveURL(/#tab-use-cases$/);
    const panel = page.getByRole('tabpanel', { name: /Use cases and requirements/ });
    await expect(panel.getByRole('heading', { name: 'Use cases and requirements' })).toBeVisible();
    const closed = panel.locator('article.uc', { hasText: 'Aggregate volunteering opportunities across platforms' });
    await expect(closed).toBeVisible();
    await expect(closed.locator('.ucs')).toHaveText('Closed in 1.0.0');
    await expect(closed).toContainText('Questions the ontology must answer');
    const open = panel.locator('article.uc', { hasText: 'Find weekly shifts that need volunteers' });
    await expect(open.locator('.ucs')).toHaveText('Accepted');
    // Filter by status.
    await panel.getByRole('button', { name: /^Closed/ }).click();
    await expect(closed).toBeVisible();
    await expect(open).toBeHidden();
    await panel.getByRole('button', { name: /^All/ }).click();
    await expect(open).toBeVisible();
    // A use case anchor deep-links into the tab.
    const id = (await closed.getAttribute('id'))!;
    await page.goto(`${PAGE}#${id}`);
    await expect(page.getByRole('tab', { name: /Use cases/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator(`#${id}`)).toBeInViewport();
  });

  test('a deep link to a use case clears a status filter that hides it', async ({ page }) => {
    await page.goto(`${PAGE}#tab-use-cases`);
    const panel = page.getByRole('tabpanel', { name: /Use cases and requirements/ });
    const open = panel.locator('article.uc', { hasText: 'Find weekly shifts that need volunteers' });
    const id = (await open.getAttribute('id'))!;
    await panel.getByRole('button', { name: /^Closed/ }).click();
    await expect(open).toBeHidden();
    await page.goto(`${PAGE}#${id}`);
    await expect(open).toBeVisible();
    await expect(open).toBeInViewport();
    await expect(panel.getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'true');
  });

  test('printing shows every use case and term, whatever the filters', async ({ page }) => {
    await page.goto(`${PAGE}#tab-use-cases`);
    const panel = page.getByRole('tabpanel', { name: /Use cases and requirements/ });
    await panel.getByRole('button', { name: /^Closed/ }).click();
    await page.getByRole('tab', { name: 'Specification' }).click();
    await page.getByPlaceholder('Filter terms').fill('zzzz-no-match');
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('article.uc', { hasText: 'Find weekly shifts that need volunteers' })).toBeVisible();
    await expect(page.locator('#sec-index [data-term]').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Formats' })).toBeVisible();
    await expect(page.getByText('No terms match.')).toBeHidden();
  });

  test('keyboard users can reach every tab panel, even text-only ones', async ({ page }) => {
    await page.goto(`${PAGE}#tab-changes`);
    await page.getByRole('tab', { name: 'Changes' }).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('tabpanel', { name: 'Changes' })).toBeFocused();
    await page.getByRole('tab', { name: 'Changes' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Download and cite' })).toBeFocused();
    await expect(page.getByRole('tab', { name: 'Download and cite' })).toHaveAttribute('aria-selected', 'true');
  });

  test('the header links this version and the latest version', async ({ page }) => {
    await page.goto(`${PAGE}/1.0.0`);
    await page.locator('dl.meta').getByRole('link', { name: 'https://w3id.org/odi/volunteering', exact: true }).click();
    await expect(page).toHaveURL(/\/def\/volunteering$/);
    await page.locator('dl.meta').getByRole('link', { name: 'https://w3id.org/odi/volunteering/1.0.0', exact: true }).click();
    await expect(page).toHaveURL(/\/def\/volunteering\/1\.0\.0$/);
  });

  test('the changes tab shows release notes and version history', async ({ page }) => {
    await page.goto(`${PAGE}#tab-changes`);
    await expect(page.getByRole('heading', { name: 'What changed in 1.0.0' })).toBeVisible();
    const history = page.getByRole('tabpanel', { name: 'Changes' }).locator('table');
    await expect(history.getByRole('link', { name: '1.0.0' })).toHaveAttribute('href', /\/def\/volunteering\/1\.0\.0$/);
    await history.getByRole('link', { name: 'Working draft' }).click();
    await expect(page.getByText('Unreleased draft', { exact: true })).toBeVisible();
    await expect(page.getByText('This is the working draft')).toBeVisible();
  });

  test('every download link serves its format', async ({ page, request }) => {
    await page.goto(`${PAGE}#tab-download`);
    const links = page.getByRole('tabpanel', { name: 'Download and cite' }).locator('table a', { hasText: 'View' });
    const hrefs = await links.evaluateAll((as) => as.map((a) => [(a as HTMLAnchorElement).href, a.getAttribute('type')]));
    expect(hrefs.length).toBe(7);
    for (const [href, type] of hrefs) {
      const res = await request.get(href!);
      expect(res.status(), href!).toBe(200);
      expect(res.headers()['content-type'], href!).toContain(type!);
      expect((await res.text()).length, href!).toBeGreaterThan(200);
    }
    await expect(page.getByText(/curl -L -H 'Accept: text\/turtle'/)).toBeVisible();
    await page.getByText('Redirect rules').click();
    await expect(page.getByText(/RewriteRule \^\(\.\+\)\$/)).toBeVisible();
  });

  test('the same IRI answers RDF clients with RDF', async ({ request }) => {
    const turtle = await request.get(`${PAGE}/1.0.0`, { headers: { Accept: 'text/turtle' } });
    expect(turtle.headers()['content-type']).toContain('text/turtle');
    expect(turtle.headers()['vary']).toMatch(/Accept/);
    expect(await turtle.text()).toContain('owl:Ontology');
    const jsonld = await request.get(PAGE, { headers: { Accept: 'application/ld+json' } });
    expect(jsonld.headers()['content-type']).toContain('application/ld+json');
    const html = await request.get(PAGE, { headers: { Accept: 'text/html' } });
    expect(html.headers()['content-type']).toContain('text/html');
  });

  test('unknown versions get a helpful not-found page', async ({ page, consoleGuard }) => {
    consoleGuard.allow(/status of 404/);
    const res = await page.goto(`${PAGE}/7.7.7`);
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
    await page.getByRole('link', { name: 'Go to the latest version' }).click();
    await expect(page.getByText('Latest release', { exact: true })).toBeVisible();
  });

  test('works on a phone without sideways scrolling', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.goto(PAGE);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    for (const hash of ['#tab-spec', '#tab-use-cases', '#tab-changes', '#tab-download']) {
      await page.goto(`${PAGE}${hash}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, hash).toBeLessThanOrEqual(1);
    }
    await context.close();
  });

  test('reads in full without JavaScript', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(PAGE);
    await expect(page.getByRole('heading', { name: 'Abstract' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Use cases and requirements' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Formats' })).toBeVisible();
    await context.close();
  });

  test('the app links to the public page from the ontology header and the release', async ({ page, request }) => {
    await signIn(page, { name: 'E2E public page', role: 'contributor' });
    const { id } = await demoOntology(request);
    await page.goto(`/o/${id}`);
    const link = page.getByTestId('public-page-link');
    await expect(link).toHaveAttribute('href', '/def/volunteering');
    const releases = await (await request.get(`/api/ontologies/${id}/releases`)).json();
    const published = releases.find((r: { status: string; version: string }) => r.status === 'published' && r.version === '1.0.0');
    await page.goto(`/o/${id}/releases/${published.id}`);
    await expect(page.getByTestId('release-public-page')).toHaveAttribute('href', '/def/volunteering/1.0.0');
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByTestId('release-public-page').click()]);
    await expect(popup.getByText('Version 1.0.0', { exact: true })).toBeVisible();
  });
});
