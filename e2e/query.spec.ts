import { test, expect, signIn, demoOntology, type Page } from './fixtures';

/**
 * The Query tab: sparq (WebAssembly) loads in the browser, the query assistant
 * writes and refines SPARQL from a chat (the offline helper in tests), which
 * runs when the person presses Run, the SPARQL editor highlights, autocompletes and runs every query form,
 * and SHACL checks run.
 */

async function setEditor(page: Page, testId: string, text: string) {
  await page.getByTestId(testId).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
}

const results = (page: Page) => page.getByTestId('query-results');
const run = (page: Page) => page.getByRole('button', { name: 'Run', exact: true }).click();
const toggle = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const chat = (page: Page) => page.getByTestId('query-chat');
const editorText = (page: Page) => page.getByTestId('sparql-editor').evaluate((el) => (el as HTMLElement).innerText.replace(/\u00a0/g, ' '));

/** Sends a message to the query assistant and waits for its reply. */
async function ask(page: Page, text: string) {
  const replies = chat(page).getByTestId('chat-message-assistant');
  await expect(replies.first()).toBeVisible();
  const before = await replies.count();
  await chat(page).getByLabel('Describe what you want to find…').fill(text);
  await chat(page).getByRole('button', { name: 'Send' }).click();
  await expect(replies).toHaveCount(before + 1);
}

/** Runs the query the assistant just wrote: it never runs without this click. */
async function runWritten(page: Page) {
  const prompt = page.getByTestId('query-run-prompt');
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: 'Run this query' }).click();
  await expect(prompt).toHaveCount(0);
}

async function askAndRun(page: Page, text: string) {
  await ask(page, text);
  await runWritten(page);
}

test.describe('Query tab', () => {
  test.beforeEach(async ({ page, request }) => {
    await signIn(page, { name: 'E2E query', role: 'editor' });
    const { id } = await demoOntology(request);
    const wasm = page.waitForResponse((r) => r.url().endsWith('.wasm'));
    await page.goto(`/o/${id}/query`);
    // The engine's .wasm must be served as WebAssembly, not the app's index.html
    // (the "expected magic word 00 61 73 6d" bug).
    const r = await wasm;
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toContain('application/wasm');
    await expect(page.getByTestId('sparq-ready')).toHaveText(/[\d,]+ triples loaded in \d+ ms/, { timeout: 30_000 });
    await expect(page.getByText(/magic word|WebAssembly.instantiate/)).toHaveCount(0);
  });

  test('a suggestion writes the query, runs it over the sample data and labels the columns', async ({ page }) => {
    const suggestions = page.getByTestId('query-suggestions');
    await expect(suggestions.getByRole('button')).toHaveCount(3);
    await suggestions.getByRole('button', { name: /^List every volunteering opportunity/ }).click();
    await expect(chat(page)).toContainText('This lists volunteering opportunity records');
    // The conversation has started, so the suggestions make way.
    await expect(suggestions).toHaveCount(0);
    await expect(page.getByTestId('query-chat-offline')).toBeVisible();
    expect(await editorText(page)).toContain('vol:VolunteeringOpportunity');
    await expect(page.getByLabel('Run against')).toHaveValue('data');
    // Nothing runs until the person has looked at the query and pressed Run.
    await expect(page.getByTestId('query-run-prompt')).toContainText('The assistant wrote a query');
    await expect(results(page)).toHaveCount(0);
    await runWritten(page);
    await expect(results(page)).toContainText('2 rows');
    await expect(results(page)).toContainText('Park clean-up');
    // Readable headings from the assistant, with the variable behind each one on hover.
    await expect(results(page).locator('th').first()).toHaveText('volunteering opportunity');
    await expect(results(page).locator('th', { hasText: 'title' })).toHaveAttribute('title', '?title');
  });

  test('each message refines the query: more columns, a number filter, then a count', async ({ page }) => {
    await askAndRun(page, 'List every volunteering opportunity');
    await expect(results(page)).toContainText('2 rows');

    await askAndRun(page, 'Also show the minimum age and who offers it');
    let q = await editorText(page);
    expect(q).toContain('vol:minimumAge');
    expect(q).toContain('vol:offeredBy');
    await expect(results(page).locator('th')).toContainText(['minimum age', 'offered by › label']);
    await expect(results(page)).toContainText('Northvale Food Bank');

    // The Saturday shift's age is the text "sixteen", so only the park clean-up is under 15.
    await askAndRun(page, 'Only those with a minimum age under 15');
    q = await editorText(page);
    expect(q).toContain('FILTER(?minimumAge < 15)');
    expect(q).toContain('vol:offeredBy');
    await expect(results(page)).toContainText('1 row');
    await expect(results(page)).toContainText('Park clean-up');

    await askAndRun(page, 'How many organisations are there?');
    expect(await editorText(page)).toContain('COUNT(DISTINCT');
    await expect(results(page).locator('th')).toHaveText([/Number of organisation/i]);
    await expect(results(page).locator('tbody td')).toHaveText(['1']);
  });

  test('questions about the model itself run against the ontology', async ({ page }) => {
    await page.getByTestId('query-suggestions').getByRole('button', { name: 'Which classes have no definition?' }).click();
    // The starting query already runs against the ontology, so wait for the reply before checking.
    await expect(chat(page).getByTestId('chat-message-assistant')).toHaveCount(2);
    await expect(page.getByLabel('Run against')).toHaveValue('ontology');
    expect(await editorText(page)).toContain('FILTER NOT EXISTS');
    await runWritten(page);
    await expect(results(page)).toBeVisible();
  });

  test('Start over clears the conversation and puts the starting query back', async ({ page }) => {
    const start = await editorText(page);
    await askAndRun(page, 'List every volunteering opportunity');
    await expect(results(page)).toBeVisible();
    expect(await editorText(page)).not.toBe(start);
    await chat(page).getByRole('button', { name: 'Start over' }).click();
    await expect(chat(page).getByTestId('chat-message-user')).toHaveCount(0);
    await expect(page.getByTestId('query-suggestions')).toBeVisible();
    expect(await editorText(page)).toBe(start);
    await expect(page.getByLabel('Run against')).toHaveValue('ontology');
    await expect(results(page)).toHaveCount(0);
  });

  test('the conversation, query and headings survive leaving the page', async ({ page }) => {
    await ask(page, 'List every volunteering opportunity with its minimum age');
    const url = page.url();
    await page.getByRole('link', { name: 'Source & export', exact: true }).click();
    await page.goto(url);
    await expect(chat(page).getByTestId('chat-message-user')).toHaveCount(1);
    await expect(chat(page).getByTestId('chat-message-user')).toContainText('List every volunteering opportunity with its minimum age');
    await expect(chat(page)).toContainText('This lists volunteering opportunity records');
    expect(await editorText(page)).toContain('vol:minimumAge');
    await expect(page.getByLabel('Run against')).toHaveValue('data');
    await run(page);
    await expect(results(page).locator('th')).toContainText(['minimum age']);
  });

  test('if the assistant fails, the conversation keeps the question and shows the error', async ({ page, consoleGuard }) => {
    consoleGuard.allow(/status of 500/);
    await page.route(/\/query-chat$/, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'The assistant is unavailable' }) }));
    const start = await editorText(page);
    await chat(page).getByLabel('Describe what you want to find…').fill('List every volunteering opportunity');
    await chat(page).getByRole('button', { name: 'Send' }).click();
    await expect(chat(page).getByRole('alert')).toContainText('The assistant is unavailable');
    await expect(chat(page).getByTestId('chat-message-user')).toHaveCount(1);
    expect(await editorText(page)).toBe(start);
  });

  test('another account on the same browser starts with its own conversation and draft', async ({ page }) => {
    const start = await editorText(page);
    await ask(page, 'List every volunteering opportunity');
    expect(await editorText(page)).not.toBe(start);
    await signIn(page, { name: 'E2E query, second person', role: 'editor' });
    await page.reload();
    await expect(page.getByTestId('sparq-ready')).toBeVisible({ timeout: 30_000 });
    await expect(chat(page).getByTestId('chat-message-user')).toHaveCount(0);
    expect(await editorText(page)).toBe(start);
  });

  test('replies are plain text: no links or images load from them', async ({ page }) => {
    const external: string[] = [];
    page.on('request', (r) => r.url().includes('evil.example') && external.push(r.url()));
    await page.route(/\/query-chat$/, (r) =>
      r.fulfill({ contentType: 'application/json', body: JSON.stringify({ reply: 'Done ![x](https://evil.example/x.png) [here](https://evil.example/)', query: 'SELECT ?c WHERE { ?c a <http://www.w3.org/2002/07/owl#Class> } LIMIT 3', target: 'ontology', columns: [], simulated: false }) }),
    );
    await ask(page, 'List three classes');
    await expect(chat(page)).toContainText('Done ![x](https://evil.example/x.png)');
    await expect(chat(page).locator('img, a[href*="evil.example"]')).toHaveCount(0);
    expect(external).toEqual([]);
  });

  test('the editor is locked while the assistant works, so its answer never replaces newer edits', async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route(/\/query-chat$/, async (r) => {
      await held;
      await r.fulfill({ contentType: 'application/json', body: JSON.stringify({ reply: 'Here you go.', query: 'SELECT ?c WHERE { ?c a <http://www.w3.org/2002/07/owl#Class> } LIMIT 3 # assistant', target: 'ontology', columns: [], simulated: false }) });
    });
    await chat(page).getByLabel('Describe what you want to find…').fill('List three classes');
    await chat(page).getByRole('button', { name: 'Send' }).click();
    await expect(page.getByTestId('editor-locked')).toBeVisible();
    await expect(page.getByLabel('Run against')).toBeDisabled();
    await page.getByTestId('sparql-editor').click();
    await page.keyboard.insertText('# typed while waiting');
    expect(await editorText(page)).not.toContain('typed while waiting');
    release();
    await expect(page.getByTestId('editor-locked')).toHaveCount(0);
    expect(await editorText(page)).toContain('# assistant');
    await runWritten(page);
    await expect(results(page)).toContainText('3 rows');
  });

  test('when the assistant can’t change the query, the editor and results stay as they are', async ({ page }) => {
    await run(page);
    const before = await editorText(page);
    await page.route(/\/query-chat$/, (r) =>
      r.fulfill({ contentType: 'application/json', body: JSON.stringify({ reply: 'The offline helper can only change queries it wrote itself.', query: 'SELECT * WHERE { ?s ?p ?o }', target: 'data', columns: [], simulated: true, unchanged: true, offlineReason: 'not-member' }) }),
    );
    await ask(page, 'Also show the title');
    await expect(chat(page)).toContainText('can only change queries it wrote itself');
    await expect(page.getByTestId('query-chat-offline')).toContainText('members of this ontology');
    expect(await editorText(page)).toBe(before);
    await expect(page.getByLabel('Run against')).toHaveValue('ontology');
    await expect(results(page)).toBeVisible();
  });

  test('results cut off by LIMIT say so, with a way to see them all', async ({ page }) => {
    await setEditor(page, 'sparql-editor', 'SELECT ?o WHERE { ?o a <https://w3id.org/odi/volunteering#VolunteeringOpportunity> }\nLIMIT 1');
    await page.getByLabel('Run against').selectOption('data');
    await run(page);
    await expect(results(page)).toContainText('1 row');
    const limited = page.getByTestId('result-limited');
    await expect(limited).toContainText('there may be more');
    await limited.getByRole('button', { name: 'Show all rows' }).click();
    await expect(results(page)).toContainText('2 rows');
    await expect(limited).toHaveCount(0);
    expect(await editorText(page)).not.toContain('LIMIT');
  });

  test('queries run in the background: Cancel stops one, and one that runs too long is stopped', async ({ page }) => {
    // The worker reads the time limit when it is first used.
    await page.evaluate(() => ((window as unknown as { __concordQueryTimeLimitMs: number }).__concordQueryTimeLimitMs = 1500));
    // A three-way join of everything: slow, and big enough that it would reach the memory cap first, so this test
    // raises the cap (the next test covers it).
    await page.evaluate(() => ((window as unknown as { __concordQueryMemoryMiB: number }).__concordQueryMemoryMiB = 2048));
    const slow = 'SELECT (COUNT(*) AS ?n) WHERE { ?a ?b ?c . ?d ?e ?f . ?g ?h ?i FILTER(STR(?c) = CONCAT(STR(?f), STR(?i), "x")) }';
    await setEditor(page, 'sparql-editor', slow);
    await run(page);
    await expect(page.getByTestId('query-running')).toBeVisible();
    // The page stays responsive while it runs.
    await page.getByLabel('Example queries').focus();
    await page.getByTestId('query-cancel').click();
    await expect(page.getByRole('alert')).toContainText('cancelled');
    await expect(page.getByTestId('query-running')).toHaveCount(0);

    await run(page);
    await expect(page.getByRole('alert')).toContainText('took too long', { timeout: 10_000 });
    // A fresh worker answers the next query.
    await setEditor(page, 'sparql-editor', 'SELECT ?c WHERE { ?c a <http://www.w3.org/2002/07/owl#Class> } LIMIT 2');
    await run(page);
    await expect(results(page)).toContainText('2 rows');
  });

  test('a LIMIT hidden behind a comment still counts as a limit', async ({ page }) => {
    await setEditor(page, 'sparql-editor', 'SELECT ?o WHERE { ?o a <https://w3id.org/odi/volunteering#VolunteeringOpportunity> }\nLIMIT # one row\n1');
    await page.getByLabel('Run against').selectOption('data');
    await run(page);
    await expect(page.getByTestId('result-limited')).toBeVisible();
  });

  test('Show all rows is disabled while the assistant is answering', async ({ page }) => {
    await setEditor(page, 'sparql-editor', 'SELECT ?o WHERE { ?o a <https://w3id.org/odi/volunteering#VolunteeringOpportunity> }\nLIMIT 1');
    await page.getByLabel('Run against').selectOption('data');
    await run(page);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route(/\/query-chat$/, async (r) => {
      await held;
      await r.fulfill({ contentType: 'application/json', body: JSON.stringify({ reply: 'No change.', query: '', target: 'data', columns: [], simulated: true, unchanged: true }) });
    });
    await chat(page).getByLabel('Describe what you want to find…').fill('Also show the title');
    await chat(page).getByRole('button', { name: 'Send' }).click();
    await expect(page.getByTestId('result-limited').getByRole('button', { name: 'Show all rows' })).toBeDisabled();
    release();
    await expect(page.getByTestId('result-limited').getByRole('button', { name: 'Show all rows' })).toBeEnabled();
  });

  test('signing out removes this account’s drafts and chats from the browser', async ({ page }) => {
    await ask(page, 'List every volunteering opportunity');
    const mine = () => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('concord.query.') && !k.startsWith('concord.query.guest.')));
    expect((await mine()).length).toBeGreaterThan(0);
    await page.locator('.app-user-button').click();
    await page.getByRole('button', { name: /sign out|log out/i }).click();
    await expect(page).toHaveURL(/\/login/);
    expect(await mine()).toEqual([]);
  });

  test('a reply that arrives after signing out is dropped, not saved', async ({ page }) => {
    await ask(page, 'List every volunteering opportunity');
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let body: { account?: string } = {};
    await page.route(/\/query-chat$/, async (r) => {
      body = r.request().postDataJSON() as { account?: string };
      // The server has answered; the answer is held on its way back.
      const answer = await r.fetch();
      await held;
      await r.fulfill({ response: answer });
    });
    await chat(page).getByLabel('Describe what you want to find…').fill('Also show the minimum age');
    await chat(page).getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => body.account).toBeTruthy();
    // The request names the account it belongs to, so the server can refuse it under any other.
    const me = await page.evaluate(() => fetch('/api/session').then((r) => r.json()) as Promise<{ user: { id: string } }>);
    expect(body.account).toBe(me.user.id);
    await page.locator('.app-user-button').click();
    await page.getByRole('button', { name: /sign out|log out/i }).click();
    await expect(page).toHaveURL(/\/login/);
    release();
    // Give the late reply time to arrive: nothing of the old account comes back.
    await page.waitForTimeout(1000);
    const left = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('concord.query.') && !k.startsWith('concord.query.guest.')));
    expect(left).toEqual([]);
  });

  test('a reply that arrives after signing out in another tab is dropped, not saved', async ({ page, context }) => {
    // Used to come back: the other tab cleared the drafts, then this tab's held reply wrote chat, query and state again.
    await ask(page, 'List every volunteering opportunity');
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let arrived = false;
    await page.route(/\/query-chat$/, async (r) => {
      const answer = await r.fetch();
      await held;
      await r.fulfill({ response: answer });
      arrived = true;
    });
    await chat(page).getByLabel('Describe what you want to find…').fill('Also show the minimum age');
    await chat(page).getByRole('button', { name: 'Send' }).click();
    await expect(page.getByTestId('editor-locked')).toBeVisible();
    const other = await context.newPage();
    await other.goto('/');
    await other.locator('.app-user-button').click();
    await other.getByRole('button', { name: /sign out|log out/i }).click();
    await expect(other).toHaveURL(/\/login/);
    const mine = (p: Page) => p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('concord.query.') && !k.startsWith('concord.query.guest.')));
    expect(await mine(other)).toEqual([]);
    release();
    await expect.poll(() => arrived).toBe(true);
    await page.waitForTimeout(500);
    expect(await mine(page)).toEqual([]);
    await other.close();
  });

  test('a conversation is never sent on under an account signed in from another tab', async ({ page, context }) => {
    await ask(page, 'List every volunteering opportunity');
    // Another tab signs in as someone else (the session cookie is shared).
    const other = await context.newPage();
    await signIn(other, { name: 'E2E query, other tab', role: 'editor' });
    await other.close();
    let sent = 0;
    await page.route(/\/query-chat$/, (r) => {
      sent++;
      return r.continue();
    });
    await chat(page).getByLabel('Describe what you want to find…').fill('Also show the minimum age');
    await chat(page).getByRole('button', { name: 'Send' }).click();
    // The page notices, drops to the new account's own (empty) workspace, and nothing was sent.
    await expect(chat(page).getByTestId('chat-message-user')).toHaveCount(0);
    expect(sent).toBe(0);
  });

  test('changing the question marks the old answer as stale', async ({ page }) => {
    await askAndRun(page, 'List every volunteering opportunity');
    await expect(results(page)).toContainText('2 rows');
    await expect(page.getByTestId('result-stale')).toHaveCount(0);
    await page.getByTestId('sparql-editor').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText('\n# edited by hand');
    await expect(page.getByTestId('result-stale')).toBeVisible();
    await page.getByTestId('result-stale').getByRole('button', { name: 'Run again' }).click();
    await expect(page.getByTestId('result-stale')).toHaveCount(0);

    // The SHACL report goes stale when the data changes.
    await toggle(page, 'Check data').click();
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(page.getByTestId('shacl-report')).toBeVisible();
    await page.getByTestId('data-editor').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText('\n# edited\n');
    await expect(page.getByTestId('report-stale')).toBeVisible();
  });

  test('a hand-written query keeps its dataset after leaving the page', async ({ page }) => {
    await setEditor(page, 'sparql-editor', 'SELECT ?x WHERE { ?x a <https://w3id.org/odi/volunteering#VolunteeringOpportunity> } # mine');
    await page.getByLabel('Run against').selectOption('data');
    const url = page.url();
    await page.getByRole('link', { name: 'Source & export', exact: true }).click();
    await page.goto(url);
    expect(await editorText(page)).toContain('# mine');
    await expect(page.getByLabel('Run against')).toHaveValue('data');
    await run(page);
    await expect(results(page)).toContainText('2 rows');
  });

  test('each ontology keeps its own drafts, even when the page is reused', async ({ page }) => {
    const draftA = 'SELECT ?a WHERE { ?a ?b ?c } # draft A';
    await setEditor(page, 'sparql-editor', draftA);
    const a = new URL(page.url()).pathname;
    const created = await page.request.post('/api/ontologies', { data: { title: `E2E second ${Date.now()}`, prefix: 'sec', description: 'Second ontology for draft isolation' } });
    expect(created.ok(), await created.text()).toBeTruthy();
    const b = (await created.json()) as { id: string };
    // Client-side navigation to the other ontology's Query page, so React may reuse the component.
    await page.evaluate((to) => {
      history.pushState(null, '', to);
      dispatchEvent(new PopStateEvent('popstate'));
    }, `/o/${b.id}/query`);
    await expect(page).toHaveURL(new RegExp(`/o/${b.id}/query`));
    const editor = page.getByTestId('sparql-editor');
    await expect(editor).not.toContainText('draft A');
    // B's first draft starts from B's own defaults, not A's prefix or A's volunteering sample data.
    await expect(editor).toContainText('sec:');
    await expect(editor).not.toContainText('vol:');
    await toggle(page, 'Check data').click();
    await expect(page.getByTestId('data-editor')).not.toContainText('Northvale');
    await toggle(page, 'Query ontology').click();
    await setEditor(page, 'sparql-editor', 'SELECT ?b WHERE { ?b ?p ?o } # draft B');
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${a}`));
    await expect(editor).toContainText('draft A');
    // Drafts are kept per account and ontology.
    const stored = await page.evaluate(
      ([idA, idB]) => [idA, idB].map((o) => Object.keys(localStorage).filter((k) => k.endsWith(`.${o}.sparql`)).map((k) => localStorage.getItem(k))),
      [a.split('/')[2], b.id],
    );
    expect(stored[0]).toHaveLength(1);
    expect(stored[0][0]).toContain('draft A');
    expect(stored[1][0]).toContain('draft B');
  });

  test('switching to an ontology that fails to load shows the error, not endless loading', async ({ page, consoleGuard }) => {
    // The ontology fails with a 500; its other requests (view, sources) 404.
    consoleGuard.allow(/status of 500/, /status of 404/);
    await page.route(/\/api\/ontologies\/broken-e2e(\?|$)/, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) }));
    await page.evaluate(() => {
      history.pushState(null, '', '/o/broken-e2e/query');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.getByRole('button', { name: /retry|try again/i })).toBeVisible();
    await expect(page.getByTestId('sparq-ready')).toHaveCount(0);
  });

  test('the query shows which data it runs over, with a shortcut to edit it', async ({ page }) => {
    await expect(page.getByTestId('dataset-summary')).toHaveCount(0);
    await page.getByLabel('Run against').selectOption('data');
    await expect(page.getByTestId('dataset-summary')).toContainText(/Runs over the ontology plus \d+ sample records/);
    await page.getByTestId('dataset-summary').getByRole('button', { name: 'Edit sample data' }).click();
    await expect(toggle(page, 'Check data')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('data-editor')).toBeVisible();
  });

  test('the SPARQL editor highlights, autocompletes and runs with Ctrl/⌘-Enter', async ({ page }) => {
    const editor = page.getByTestId('sparql-editor');
    await expect(editor.locator('.tok-keyword', { hasText: 'SELECT' })).toBeVisible();
    await expect(editor.locator('.tok-variable').first()).toBeVisible();
    await expect(editor.locator('.tok-iri').first()).toBeVisible();

    // The default query lists the classes.
    await editor.click();
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(results(page)).toContainText('vol:VolunteeringOpportunity');
    expect(await results(page).locator('tbody tr').count()).toBeGreaterThan(5);

    // Autocomplete offers the ontology's terms with their labels.
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('\n# vol:Volunt');
    const option = page.locator('.cm-tooltip-autocomplete li', { hasText: 'vol:VolunteeringOpportunity' });
    await expect(option).toBeVisible();
    await expect(option).toContainText('volunteering opportunity');
    await option.click();
    await expect(editor).toContainText('# vol:VolunteeringOpportunity');

    // Accepting a term whose prefix isn't declared adds the declaration, and labels find terms too.
    await setEditor(page, 'sparql-editor', 'SELECT * WHERE { ?x a volunteering');
    await page.keyboard.press('Control+Space');
    const byLabel = page.locator('.cm-tooltip-autocomplete li', { hasText: 'volunteering opportunity → vol:VolunteeringOpportunity' });
    await expect(byLabel).toBeVisible();
    await byLabel.click();
    await expect(editor).toContainText('PREFIX vol: <https://w3id.org/odi/volunteering#>');
    await expect(editor).toContainText('?x a vol:VolunteeringOpportunity');

    // A commented-out or differently cased declaration doesn't count; a conflicting one gets the full IRI.
    for (const [doc, expected] of [
      ['# PREFIX vol: <https://w3id.org/odi/volunteering#>\nSELECT * WHERE { ?x a volunteering', 'PREFIX vol: <https://w3id.org/odi/volunteering#>\n#'],
      ['PREFIX VOL: <https://other.example/>\nSELECT * WHERE { ?x a volunteering', 'PREFIX vol: <https://w3id.org/odi/volunteering#>\nPREFIX VOL:'],
      ['PREFIX vol: <https://other.example/>\nSELECT * WHERE { ?x a volunteering', '?x a <https://w3id.org/odi/volunteering#VolunteeringOpportunity>'],
    ]) {
      await setEditor(page, 'sparql-editor', doc);
      await page.keyboard.press('Control+Space');
      await byLabel.click();
      expect(await editor.evaluate((el) => (el as HTMLElement).innerText.replace(/\u00a0/g, ' '))).toContain(expected);
    }
  });

  test('every query form: ASK, CONSTRUCT, examples and errors', async ({ page }) => {
    await page.getByLabel('Example queries').selectOption({ label: 'Does every class have a label?' });
    await run(page);
    await expect(page.getByTestId('query-answer')).toHaveText(/Answer: (yes|no)/);

    await setEditor(page, 'sparql-editor', 'PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>\nCONSTRUCT { ?c rdfs:label ?l } WHERE { ?c rdfs:label ?l } LIMIT 3');
    await run(page);
    await expect(page.getByTestId('query-graph')).toContainText('3 triples');

    await page.getByLabel('Example queries').selectOption({ label: 'Instances by type (sample data)' });
    await expect(page.getByLabel('Run against')).toHaveValue('data');
    await run(page);
    await expect(results(page)).toContainText('VolunteeringOpportunity');

    for (const ex of ['Class hierarchy', 'Relationships (object properties)', 'Attributes (datatype properties)', 'Terms missing a definition', 'Deprecated terms']) {
      await page.getByLabel('Example queries').selectOption({ label: ex });
      await run(page);
      await expect(results(page), ex).toBeVisible();
    }

    await setEditor(page, 'sparql-editor', 'SELECT ?x WHERE { ?x ?y }');
    await run(page);
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(results(page)).toHaveCount(0);
  });

  test('the sample data is highlighted and checked against SHACL', async ({ page }) => {
    // One workspace at a time: the data checker is behind "Check data".
    await expect(page.getByTestId('data-editor')).toHaveCount(0);
    await toggle(page, 'Check data').click();
    await expect(page).toHaveURL(/view=check/);
    await expect(page.getByTestId('query-chat')).toHaveCount(0);
    const data = page.getByTestId('data-editor');
    await expect(data.locator('.tok-meta', { hasText: '@prefix' }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    const report = page.getByTestId('shacl-report');
    await expect(report).toContainText(/\d+ problems?/);
    await expect(report).toContainText('saturday-shift');

    // Switching away and back keeps the report.
    await toggle(page, 'Query ontology').click();
    await toggle(page, 'Check data').click();
    await expect(report).toContainText('saturday-shift');

    // Editing the data changes what queries find.
    await data.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText('\nex:extra a vol:VolunteeringOpportunity ; vol:title "Library reading buddy" .\n');
    await toggle(page, 'Query ontology').click();
    await askAndRun(page, 'List every volunteering opportunity');
    await expect(results(page)).toContainText('3 rows');
    await expect(results(page)).toContainText('Library reading buddy');
  });
  test('very long values are shortened in the results', async ({ page }) => {
    const x10 = (v: string) => `CONCAT(${Array(10).fill(v).join(', ')})`;
    await setEditor(
      page,
      'sparql-editor',
      `SELECT ?e WHERE { BIND("xxxxxxxxxx" AS ?a) BIND(${x10('?a')} AS ?b) BIND(${x10('?b')} AS ?c) BIND(${x10('?c')} AS ?d) BIND(CONCAT(?d, ?d) AS ?e) }`,
    );
    await run(page);
    await expect(results(page)).toContainText('very long values are shortened');
    const cell = await results(page).locator('tbody td').first().getAttribute('title');
    expect(cell!.length).toBeLessThanOrEqual(10_001);
    expect(cell!.endsWith('…')).toBe(true);
  });

  test('a query that would build enormous values is refused before it runs', async ({ page }) => {
    // Used to be accepted: about 840 characters of doubling CONCATs built a 64 MiB value and 500 MB of engine memory.
    const steps = Array.from({ length: 26 }, (_, i) => `BIND(CONCAT(?v${i}, ?v${i}) AS ?v${i + 1})`).join(' ');
    await setEditor(page, 'sparql-editor', `SELECT ?v26 WHERE { BIND("x" AS ?v0) ${steps} }`);
    await run(page);
    await expect(page.getByRole('alert')).toContainText('could build values of 67,108,864 characters');
    await setEditor(page, 'sparql-editor', 'SELECT ?c WHERE { ?c a <http://www.w3.org/2002/07/owl#Class> } LIMIT 2');
    await run(page);
    await expect(results(page)).toContainText('2 rows');
  });

  test('a query that needs more memory than allowed is stopped, and the next one runs', async ({ page }) => {
    // The engine's memory used to be able to grow towards 4 GB. Lower the cap so a plain cross join reaches it.
    await page.evaluate(() => ((window as unknown as { __concordQueryMemoryMiB: number }).__concordQueryMemoryMiB = 24));
    await setEditor(page, 'sparql-editor', 'SELECT * WHERE { ?a ?b ?c . ?d ?e ?f . ?g ?h ?i }');
    await run(page);
    await expect(page.getByRole('alert')).toContainText('needed more memory than a query here may use (24 MB)', { timeout: 20_000 });
    await setEditor(page, 'sparql-editor', 'SELECT ?c WHERE { ?c a <http://www.w3.org/2002/07/owl#Class> } LIMIT 2');
    await run(page);
    await expect(results(page)).toContainText('2 rows');
  });

  test('variables named like JavaScript built-ins show their values', async ({ page }) => {
    // ?__proto__ used to lose its value and crash the page.
    await setEditor(page, 'sparql-editor', 'SELECT ("ok" AS ?__proto__) ("fine" AS ?constructor) WHERE {}');
    await run(page);
    await expect(results(page).locator('th')).toHaveText(['?__proto__', '?constructor']);
    await expect(results(page).locator('tbody td')).toHaveText(['ok', 'fine']);
    const csv = await results(page).getByRole('link', { name: 'CSV' }).getAttribute('href');
    expect(decodeURIComponent(csv!.split(',').slice(1).join(','))).toBe('__proto__,constructor\nok,fine');
  });

  test('long results are paginated', async ({ page }) => {
    await setEditor(page, 'sparql-editor', 'SELECT ?s ?p ?o WHERE { ?s ?p ?o }');
    await run(page);
    const table = results(page);
    await expect(table.locator('tbody tr')).toHaveCount(50);
    const pager = page.getByRole('navigation', { name: 'Result pages' });
    await expect(pager).toContainText(/1–50 of [\d,]+/);
    const first = await table.locator('tbody tr').first().innerText();
    await pager.getByRole('button', { name: 'Next page' }).click();
    await expect(pager).toContainText('51–100');
    expect(await table.locator('tbody tr').first().innerText()).not.toBe(first);
    await pager.getByRole('button', { name: 'Previous page' }).click();
    await expect(pager).toContainText('1–50');
  });
});
