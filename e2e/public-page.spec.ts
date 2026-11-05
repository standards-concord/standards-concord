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
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    // Laid out like Browse in the app: the term tree and search on the left.
    const nav = page.getByRole('complementary', { name: 'Terms' });
    await expect(nav.getByPlaceholder('Search terms, definitions…')).toBeVisible();
    await expect(nav.getByText(/^Classes/)).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'true');
  });

  test('picking a term in the tree shows its entry, as Browse does', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(PAGE);
    const card = page.locator('article.term#VolunteeringOpportunity');
    await expect(card).toHaveCount(1);
    await expect(card).toBeHidden();
    const nav = page.getByRole('complementary', { name: 'Terms' });
    await nav.getByRole('link', { name: /^Volunteering opportunity$/i }).click();
    await expect(page).toHaveURL(/#VolunteeringOpportunity$/);
    await expect(card).toBeInViewport();
    await expect(nav.getByRole('link', { name: /^Volunteering opportunity$/i })).toHaveAttribute('aria-current', 'true');
    // Only that term shows, with the same facts as the app.
    await expect(page.locator('article.term:visible')).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeHidden();
    await expect(card.locator('.kind')).toHaveText('Class');
    await expect(card.locator('.iri')).toContainText('vol:VolunteeringOpportunity');
    for (const row of ['Subclass of', 'Restrictions', 'Disjoint with', 'In domain of']) await expect(card.locator('dt', { hasText: row })).toBeVisible();
    await expect(card.getByRole('link', { name: 'Report a problem with this term' })).toBeVisible();
    await card.getByRole('button', { name: 'Copy IRI' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://w3id.org/odi/volunteering#VolunteeringOpportunity');
    // Cross references inside an entry open the other term.
    const ref = card.locator('a.ref[href^="#"]').first();
    const target = (await ref.getAttribute('href'))!;
    await ref.click();
    await expect(page.locator(target)).toBeInViewport();
    await expect(card).toBeHidden();
    // The tree opens to show a term deep in the hierarchy.
    await page.goto(`${PAGE}#VolunteerInvolvingOrganisation`);
    await expect(nav.getByRole('link', { name: /^volunteer-involving organisation$/i })).toBeVisible();
    await expect(nav.getByRole('link', { name: /^volunteer-involving organisation$/i })).toHaveAttribute('aria-current', 'true');
    // Back to the overview.
    await nav.getByRole('link', { name: 'Overview' }).click();
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await expect(page.locator('article.term:visible')).toHaveCount(0);
    // The stats open a whole group.
    await page.locator('.overview .stat', { hasText: 'object properties' }).click();
    await expect.poll(() => page.locator('article.term:visible').count()).toBe(12);
  });

  test('a term IRI fragment opens the right tab and scrolls to the term', async ({ page }) => {
    await page.goto(`${PAGE}/1.0.0#tab-download`);
    await expect(page.getByRole('heading', { name: 'Formats' })).toBeVisible();
    await page.goto(`${PAGE}/1.0.0#Volunteer`);
    await expect(page.getByRole('tab', { name: 'Specification' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('article.term#Volunteer')).toBeInViewport();
  });

  test('search narrows the tree by name or definition', async ({ page }) => {
    await page.goto(PAGE);
    const nav = page.getByRole('complementary', { name: 'Terms' });
    const all = await nav.locator('.nav-item:visible').count();
    const search = nav.getByPlaceholder('Search terms, definitions…');
    await search.fill('volunteer');
    await expect.poll(() => nav.locator('.nav-item:visible').count()).toBeLessThan(all);
    await expect(nav.getByRole('link', { name: /^volunteer$/i })).toBeVisible();
    // A match deep in the tree keeps its parents, opened.
    await search.fill('volunteer-involving');
    await expect(nav.getByRole('link', { name: /^volunteer-involving organisation$/i })).toBeVisible();
    await expect(nav.getByRole('link', { name: /^organisation$/i })).toBeVisible();
    await expect(nav.getByRole('link', { name: /^agent$/i })).toBeVisible();
    await expect(nav.getByRole('link', { name: /^accessibility feature$/i })).toBeHidden();
    // Definitions count too.
    await search.fill('two hours a week');
    await expect(nav.getByRole('link', { name: /^time commitment$/i })).toBeVisible();
    // Screen readers hear how many terms match.
    await expect(nav.locator('[data-search-status]')).toHaveText(/^\d+ terms? match/);
    await search.fill('zzzz-no-match');
    await expect(nav.getByText('No terms match.')).toBeVisible();
    await search.fill('');
    await expect.poll(() => nav.locator('.nav-item:visible').count()).toBe(all);
  });

  test('the use cases tab shows the use cases behind the release and their status', async ({ page }) => {
    await page.goto(PAGE);
    await page.getByRole('tab', { name: /Use cases and requirements/ }).click();
    await expect(page).toHaveURL(/#tab-use-cases$/);
    const panel = page.getByRole('tabpanel', { name: /Use cases and requirements/ });
    await expect(panel.getByRole('heading', { name: 'Use cases and requirements', exact: true })).toBeVisible();
    const closed = panel.locator('article.uc', { hasText: 'Aggregate volunteering opportunities across platforms' });
    await expect(closed).toBeVisible();
    await expect(closed.locator('.ucs')).toHaveText('Closed in 1.0.0');
    await expect(closed).toContainText('Questions the ontology must answer');
    // The released page is frozen: a use case raised after 1.0.0 isn't in it.
    await expect(panel.locator('article.uc', { hasText: 'Find weekly shifts that need volunteers' })).toHaveCount(0);
    // A use case anchor deep-links into the tab.
    const id = (await closed.getAttribute('id'))!;
    await page.goto(`${PAGE}#${id}`);
    await expect(page.getByRole('tab', { name: /Use cases/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator(`#${id}`)).toBeInViewport();
  });

  test('the working draft shows the public use cases as they stand now, and can filter by status', async ({ page }) => {
    await page.goto(`${PAGE}/draft#tab-use-cases`);
    const panel = page.getByRole('tabpanel', { name: /Use cases and requirements/ });
    const closed = panel.locator('article.uc', { hasText: 'Aggregate volunteering opportunities across platforms' });
    const open = panel.locator('article.uc', { hasText: 'Find weekly shifts that need volunteers' });
    await expect(closed.locator('.ucs')).toHaveText('Closed in 1.0.0');
    // Other tests share the demo and may merge the change that addresses it.
    await expect(open.locator('.ucs')).toHaveText(/^(Accepted|In progress|In the working draft)$/);
    // Anonymised versions of private use cases are public; working group ones are not.
    await expect(panel.locator('article.uc', { hasText: 'Anonymised' }).first()).toBeVisible();
    await expect(panel).not.toContainText('Publish recurring shifts once');
    await panel.getByRole('button', { name: /^Closed/ }).click();
    await expect(closed).toBeVisible();
    await expect(open).toBeHidden();
    await panel.getByRole('button', { name: /^All/ }).click();
    await expect(open).toBeVisible();
  });

  test('a deep link to a use case clears a status filter that hides it', async ({ page }) => {
    // The weekly shifts use case came after 1.0.0, so it is on the working draft's page.
    await page.goto(`${PAGE}/draft#tab-use-cases`);
    const panel = page.getByRole('tabpanel', { name: /Use cases and requirements/ });
    const open = panel.locator('article.uc', { hasText: 'Find weekly shifts that need volunteers' });
    const id = (await open.getAttribute('id'))!;
    await panel.getByRole('button', { name: /^Closed/ }).click();
    await expect(open).toBeHidden();
    await page.goto(`${PAGE}/draft#${id}`);
    await expect(open).toBeVisible();
    await expect(open).toBeInViewport();
    await expect(panel.getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'true');
  });

  test('printing shows every use case and term, whatever the filters', async ({ page }) => {
    await page.goto(`${PAGE}/draft#tab-use-cases`);
    const panel = page.getByRole('tabpanel', { name: /Use cases and requirements/ });
    await panel.getByRole('button', { name: /^Closed/ }).click();
    await page.getByRole('tab', { name: 'Specification' }).click();
    await page.getByPlaceholder('Search terms, definitions…').fill('zzzz-no-match');
    // The draft page: its use cases are today's public ones, open and closed (a release shows only the ones it was published with).
    await page.goto(`${PAGE}/draft#Volunteer`);
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('article.uc', { hasText: 'Find weekly shifts that need volunteers' })).toBeVisible();
    await expect(page.locator('article.term#VolunteeringOpportunity')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
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
    expect(hrefs.length).toBe(10); // seven RDF and LinkML formats, SHACLC, and the JavaScript and TypeScript classes
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
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await expect(page.locator('article.term#VolunteeringOpportunity')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Use cases and requirements', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Formats' })).toBeVisible();
    // Search needs the script, so it isn't offered without it.
    await expect(page.getByPlaceholder('Search terms, definitions…')).toBeHidden();
    // Reporting still works: the button goes to a report page with a plain form.
    await page.locator('article.term#VolunteeringOpportunity').getByRole('link', { name: 'Report a problem with this term' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Report a problem with “volunteering opportunity”');
    await expect(page.getByRole('link', { name: 'Sign in and report' })).toHaveAttribute('href', /\/login\?next=.*report%3D1/);
    await page.waitForTimeout(3_100);
    await page.getByLabel('What’s the problem?').fill(`No-JS report ${Date.now()}: the range should allow several roles.`);
    await page.getByRole('button', { name: 'Send report' }).click();
    await expect(page.getByRole('heading', { name: 'Thanks for your report' })).toBeVisible();
    await context.close();
  });

  test('the app links to the public page from the ontology header and the release', async ({ page, request }) => {
    await signIn(page, { name: 'E2E public page', role: 'contributor' });
    const { id } = await demoOntology(request);
    await page.goto(`/o/${id}`);
    const link = page.getByTestId('public-page-link');
    await expect(link).toHaveAttribute('href', '/def/volunteering');
    const releases = await (await page.request.get(`/api/ontologies/${id}/releases`)).json();
    const published = releases.find((r: { status: string; version: string }) => r.status === 'published' && r.version === '1.0.0');
    await page.goto(`/o/${id}/releases/${published.id}`);
    await expect(page.getByTestId('release-public-page')).toHaveAttribute('href', '/def/volunteering/1.0.0');
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByTestId('release-public-page').click()]);
    await expect(popup.getByText('Version 1.0.0', { exact: true })).toBeVisible();
  });

  test('fragments resolve the way the browser does: as written first, then percent-decoded', async ({ page }) => {
    await page.goto(PAGE);
    // Stand-ins for terms whose IRIs end in #%41, #A and #Café, in different tabs.
    await page.evaluate(() => {
      const add = (panel: string, id: string) => {
        const el = document.createElement('article');
        el.id = id;
        el.textContent = id;
        document.getElementById(panel)!.appendChild(el);
      };
      add('tab-download', '%41');
      add('tab-changes', 'A');
      add('tab-changes', 'Café');
    });
    const selected = page.locator('[role="tab"][aria-selected="true"]');
    await page.evaluate(() => (location.hash = '%41'));
    await expect(selected).toHaveText('Download and cite');
    await page.evaluate(() => (location.hash = 'A'));
    await expect(selected).toHaveText('Changes');
    await page.evaluate(() => (location.hash = 'tab-spec'));
    await expect(selected).toHaveText('Specification');
    await page.evaluate(() => (location.hash = 'Caf%C3%A9'));
    await expect(selected).toHaveText('Changes');
  });

  test('a new ontology names its creator publicly only if they say so', async ({ page }) => {
    const { user } = await signIn(page, { name: 'E2E Uncredited Owner', role: 'contributor' });
    await page.goto('/');
    await page.getByRole('button', { name: 'New ontology' }).first().click();
    const dialog = page.getByRole('dialog');
    const credit = dialog.getByTestId('credit-creator');
    // Off unless the owner asks for it.
    await expect(credit).not.toBeChecked();
    await expect(dialog).toContainText('No creator is listed');
    await credit.check();
    await expect(dialog).toContainText(`“${user.name}” is shown publicly`);
    await credit.uncheck();
    await dialog.getByLabel('Title').fill(`Uncredited ${Date.now()}`);
    await dialog.getByRole('button', { name: 'Create ontology' }).click();
    await expect(page).toHaveURL(/\/o\/[^/]+/);
    const [pub] = await Promise.all([page.waitForEvent('popup'), page.getByTestId('public-page-link').click()]);
    await expect(pub.getByRole('heading', { level: 1 })).toContainText('Uncredited');
    await expect(pub.locator('body')).not.toContainText(user.name);
  });

  test('anyone can report a problem with a term; it waits for a moderator, shown as plain text', async ({ page, browser, consoleGuard }) => {
    // The first try is refused on purpose (too quick), which the browser logs.
    consoleGuard.allow(/status of 400/);
    const marker = `Dialog report ${Date.now()}`;
    await page.goto(`${PAGE}#VolunteeringOpportunity`);
    await page.locator('article.term#VolunteeringOpportunity').getByRole('link', { name: 'Report a problem with this term' }).click();
    const dialog = page.getByRole('dialog', { name: 'Report a problem with “volunteering opportunity”' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'As a member', exact: true })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'As a member of the public' })).toBeVisible();
    await dialog.getByLabel('Short title (optional)').fill('Internships');
    await dialog.getByLabel('What’s the problem?').fill(`${marker}: does an unpaid internship count? ![probe](https://attacker.example/pixel)`);
    // Sent straight away, the form token isn't accepted yet: the error is shown and the next try gets a fresh token.
    await dialog.getByRole('button', { name: 'Send report' }).click();
    await expect(dialog.getByRole('alert')).toContainText('That was quick');
    await page.waitForTimeout(3_100);
    await dialog.getByRole('button', { name: 'Send report' }).click();
    // The form is replaced by the confirmation, which takes focus so it's announced.
    const thanks = dialog.getByRole('heading', { name: 'Thanks for your report' });
    await expect(thanks).toBeVisible();
    await expect(thanks).toBeFocused();
    await expect(dialog.locator('[data-report-ref]')).toHaveText(/^prp_/);
    await dialog.getByRole('button', { name: 'Close' }).last().click();
    await expect(dialog).toBeHidden();

    // A steward finds it waiting on the change requests page, as typed: no image is loaded.
    const context = await browser.newContext();
    const steward = await context.newPage();
    const remote: string[] = [];
    steward.on('request', (r) => {
      if (r.url().includes('attacker.example')) remote.push(r.url());
    });
    await signIn(steward, { name: 'E2E moderator', role: 'steward' });
    await steward.goto('/o/volunteering/changes');
    const queue = steward.getByRole('region', { name: /Reports from the public page/ });
    const item = queue.locator('[data-public-report]').filter({ hasText: marker });
    await expect(item).toBeVisible();
    await expect(item).toContainText('![probe](https://attacker.example/pixel)');
    await expect(item.locator('img')).toHaveCount(0);
    // Opened as a bug report, it's still plain text.
    await item.getByRole('button', { name: 'Open as bug report' }).click();
    await expect(steward).toHaveURL(/\/o\/volunteering\/changes\/cr_/);
    await expect(steward.getByRole('heading', { name: 'Internships' }).first()).toBeVisible();
    await expect(steward.getByText(`${marker}: does an unpaid internship count? ![probe](https://attacker.example/pixel)`)).toBeVisible();
    await expect(steward.locator('img[src*="attacker.example"]')).toHaveCount(0);
    expect(remote).toEqual([]);
    await context.close();
  });

  test('a reply to a report sent earlier never confirms the report being written now', async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let posted = 0;
    // Hold the first report's reply until a second report is being written.
    await page.route('**/def/volunteering/-/report', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      posted++;
      await held;
      await route.fulfill({ status: 201, json: { reference: 'prp_first' } });
    });
    await page.goto(`${PAGE}#VolunteeringOpportunity`);
    await page.locator('article.term#VolunteeringOpportunity').getByRole('link', { name: 'Report a problem with this term' }).click();
    const dialog = page.locator('dialog.report-dialog');
    await dialog.getByLabel('What’s the problem?').fill('The first report, about the first term.');
    await page.waitForTimeout(3_100);
    await dialog.getByRole('button', { name: 'Send report' }).click();
    await expect.poll(() => posted).toBe(1);
    await dialog.getByRole('button', { name: 'Close' }).first().click();
    // A second term, a second report being typed when the first reply arrives.
    await page.goto(`${PAGE}#Volunteer`);
    await page.locator('article.term#Volunteer').getByRole('link', { name: 'Report a problem with this term' }).click();
    await expect(dialog.getByLabel('What’s the problem?')).toHaveValue('');
    await dialog.getByLabel('What’s the problem?').fill('The second report, not sent yet.');
    release();
    await page.waitForTimeout(500);
    await expect(dialog.getByRole('heading', { name: 'Thanks for your report' })).toBeHidden();
    await expect(dialog.getByLabel('What’s the problem?')).toHaveValue('The second report, not sent yet.');
    await expect(dialog.getByRole('button', { name: 'Send report' })).toBeEnabled();
  });

  test('the form says what happens to a report if the working group takes it up', async ({ page }) => {
    await page.goto(`${PAGE}#VolunteeringOpportunity`);
    await page.locator('article.term#VolunteeringOpportunity').getByRole('link', { name: 'Report a problem with this term' }).click();
    await expect(page.locator('dialog.report-dialog')).toContainText('it becomes a change request that people signed in to Concord can read, and AI tools may help analyse it');
  });

  test('moderators are told when the report queue can’t be loaded, and can retry', async ({ page, consoleGuard }) => {
    consoleGuard.allow(/status of 500/);
    await signIn(page, { name: 'E2E queue moderator', role: 'steward' });
    let fail = true;
    await page.route('**/api/ontologies/*/public-reports', (route) => (fail ? route.fulfill({ status: 500, json: { error: 'The queue is unavailable' } }) : route.fulfill({ json: [] })));
    await page.goto('/o/volunteering/changes');
    const alert = page.getByRole('alert').filter({ hasText: 'Couldn’t load reports from the public page' });
    await expect(alert).toBeVisible();
    fail = false;
    await alert.getByRole('button', { name: /Retry|Try again/ }).click();
    await expect(alert).toHaveCount(0);
  });

  test('dismissing a report keeps keyboard focus in the queue and says what happened', async ({ page }) => {
    await signIn(page, { name: 'E2E dismiss moderator', role: 'steward' });
    const report = (n: number) => ({ id: `prp_focus${n}`, ontologyId: 'x', termIri: 'https://w3id.org/x#T', termName: `term ${n}`, version: 'draft', title: `Focus report ${n}`, description: 'A problem.', createdAt: new Date().toISOString() });
    let queue = [report(1), report(2)];
    await page.route('**/api/ontologies/*/public-reports', (route) => route.fulfill({ json: queue }));
    await page.route('**/api/ontologies/*/public-reports/*/dismiss', async (route) => {
      const id = new URL(route.request().url()).pathname.split('/').at(-2);
      queue = queue.filter((r) => r.id !== id);
      await route.fulfill({ json: { ok: true } });
    });
    await page.goto('/o/volunteering/changes');
    const region = page.getByRole('region', { name: /Reports from the public page/ });
    await region.locator('[data-public-report]').first().getByRole('button', { name: 'Dismiss' }).focus();
    await page.keyboard.press('Enter');
    await expect(region.locator('[data-public-report]')).toHaveCount(1);
    // Focus moves to the report that took its place.
    await expect(region.locator('[data-public-report]').first().getByRole('button', { name: 'Open as bug report' })).toBeFocused();
    await expect(region.getByRole('status')).toHaveText('Report dismissed.');
    await region.getByRole('button', { name: 'Dismiss' }).focus();
    await page.keyboard.press('Enter');
    await expect(region).toContainText('No reports left to review.');
    await expect(page.locator('#public-reports-h')).toBeFocused();
  });

  test('people without a moderating role never see public reports', async ({ page }) => {
    await signIn(page, { name: 'E2E contributor', role: 'contributor' });
    await page.goto('/o/volunteering/changes');
    await expect(page.getByRole('heading', { name: 'Change requests' })).toBeVisible();
    await expect(page.getByRole('region', { name: /Reports from the public page/ })).toHaveCount(0);
  });

  test('a member signs in from the public page and lands on the term with the report form open', async ({ page }) => {
    await signIn(page, { name: 'E2E public reporter', role: 'contributor' });
    await page.goto(`${PAGE}#VolunteeringOpportunity`);
    await page.locator('article.term#VolunteeringOpportunity').getByRole('link', { name: 'Report a problem with this term' }).click();
    await page.getByRole('dialog').getByRole('link', { name: 'Sign in and report' }).click();
    await expect(page).toHaveURL(/\/o\/volunteering\/browse\?term=/);
    const dialog = page.getByRole('dialog').filter({ hasText: 'Report a problem with “volunteering opportunity”' });
    await expect(dialog).toBeVisible();
    // The flag is used once: it's gone from the address, so reloading doesn't reopen the form.
    await expect(page).not.toHaveURL(/report=1/);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('heading', { name: /volunteering opportunity/i }).first()).toBeVisible();
  });
});
