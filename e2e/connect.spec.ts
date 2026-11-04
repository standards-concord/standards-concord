import { expect, signIn, test } from './fixtures';

const TOOL_NAMES = ['list_ontologies', 'get_ontology', 'search_terms', 'sparql_query', 'validate_data', 'propose_change', 'get_change_request'];

test.describe('Connect page', () => {
  test('anyone can open it, pick their app, and every option points at this site', async ({ page, baseURL }) => {
    await page.goto('/connect');
    await expect(page.getByRole('heading', { name: 'Connect your agent to Concord' })).toBeVisible();
    const mcp = `${baseURL}/mcp`;
    const pick = (name: string) => page.getByRole('radio', { name, exact: true }).click();

    // Claude is the default: the prefilled "Add custom connector" dialog on claude.ai.
    await expect(page.getByRole('radio', { name: 'Claude', exact: true })).toHaveAttribute('aria-checked', 'true');
    const claude = new URL((await page.getByTestId('add-to-claude').getAttribute('href'))!);
    expect(claude.origin + claude.pathname).toBe('https://claude.ai/customize/connectors');
    expect(claude.searchParams.get('modal')).toBe('add-custom-connector');
    expect(claude.searchParams.get('connectorName')).toBe('Concord');
    expect(claude.searchParams.get('connectorUrl')).toBe(mcp);
    await expect(page.getByTestId('add-to-claude')).toHaveAttribute('target', '_blank');
    // Only the chosen app's steps are shown.
    await expect(page.getByTestId('install-claude-code')).toHaveCount(0);

    // Claude Code and Codex: one command each, with no token in it.
    await pick('Claude Code');
    await expect(page.getByTestId('install-claude-code')).toContainText(`claude mcp add --transport http concord ${mcp}`);
    await expect(page.getByTestId('install-claude')).toHaveCount(0);
    await pick('Codex');
    await expect(page.getByTestId('install-codex')).toContainText(`codex mcp add concord --url ${mcp}`);
    await expect(page.getByTestId('install-codex')).toContainText('codex mcp login concord');
    await expect(page.getByTestId('connect-agent')).not.toContainText(/token=/i);

    // Cursor and VS Code deep links carry the same URL.
    await pick('Cursor');
    const cursor = new URL((await page.getByTestId('add-to-cursor').getAttribute('href'))!);
    expect(cursor.protocol).toBe('cursor:');
    expect(JSON.parse(Buffer.from(cursor.searchParams.get('config')!, 'base64').toString())).toEqual({ url: mcp });
    await pick('VS Code');
    const vscode = (await page.getByTestId('add-to-vscode').getAttribute('href'))!;
    expect(vscode.startsWith('vscode:mcp/install?')).toBe(true);
    expect(JSON.parse(decodeURIComponent(vscode.split('?')[1]!))).toEqual({ name: 'concord', type: 'http', url: mcp });

    // The choice is remembered.
    await page.reload();
    await expect(page.getByRole('radio', { name: 'VS Code' })).toHaveAttribute('aria-checked', 'true');

    // Advanced setup: the raw URL, plugin installs (with how to update them after a move), and headless tokens.
    await expect(page.getByTestId('mcp-url')).toBeHidden();
    await page.getByText('Advanced setup').click();
    await expect(page.getByTestId('mcp-url')).toHaveText(mcp);
    await expect(page.getByTestId('plugin-install')).toContainText('/plugin marketplace add jeswr/standards-concord');
    await expect(page.getByTestId('plugin-install')).toContainText('/plugin install concord@concord');
    await expect(page.getByTestId('plugin-install')).toContainText('codex plugin marketplace add jeswr/standards-concord');
    await expect(page.getByTestId('plugin-update-note')).toContainText('/plugin marketplace update concord');
    await expect(page.getByTestId('plugin-update-note')).toContainText('sign in again');
    await expect(page.getByTestId('advanced-setup').getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings#tokens');

    // The page no longer lists the MCP tools.
    for (const name of TOOL_NAMES) await expect(page.getByText(name, { exact: true })).toHaveCount(0);
  });

  test('copy buttons copy the command', async ({ page, context, baseURL }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/connect');
    await page.getByRole('radio', { name: 'Claude Code' }).click();
    const copy = page.getByTestId('install-claude-code').getByRole('button', { name: 'Copy' });
    await copy.click();
    await expect(copy).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`claude mcp add --transport http concord ${baseURL}/mcp`);
    await page.getByRole('radio', { name: 'Codex' }).click();
    await page.getByTestId('install-codex').getByRole('button', { name: 'Copy' }).first().click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`codex mcp add concord --url ${baseURL}/mcp`);
  });

  test('the ontology Agents tab separates reports from setup, with no tool list', async ({ page, baseURL }) => {
    await signIn(page);
    await page.goto('/o/volunteering/agents?view=connect');
    await expect(page.getByRole('tab', { name: 'Connect an agent' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('connect-agent')).toBeVisible();
    await page.getByText('Advanced setup').click();
    await expect(page.getByTestId('mcp-url')).toHaveText(`${baseURL}/mcp`);
    await expect(page.getByText('MCP tools')).toHaveCount(0);
    for (const name of TOOL_NAMES) await expect(page.getByText(name, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create token' })).toHaveCount(0);

    await page.getByRole('tab', { name: /Reports/ }).click();
    await expect(page).toHaveURL(/view=reports/);
    await expect(page.getByTestId('connect-agent')).toHaveCount(0);
    await expect(page.getByText('Agent reports')).toBeVisible();

    await page.getByRole('tab', { name: 'Connect an agent' }).click();
    await page.getByRole('link', { name: 'Open the full setup page' }).click();
    await expect(page).toHaveURL(/\/connect$/);
  });

  test('agent reports open on the Reports view, with the analysis collapsed', async ({ page }) => {
    await signIn(page);
    // An agent reports a gap over the REST API (what report_gap does over MCP).
    const r = await page.request.post('/api/ontologies/volunteering/agent-reports', {
      data: { agentName: 'E2E agent', kind: 'missing-concept', summary: 'No way to record volunteer badges', details: 'We award digital badges for completed hours.' },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    await page.goto('/o/volunteering/agents');
    await expect(page.getByRole('tab', { name: /Reports \(\d+\)/ })).toHaveAttribute('aria-selected', 'true');
    const item = page.getByTestId('agent-reports').getByRole('listitem').filter({ hasText: 'No way to record volunteer badges' });
    await expect(item).toBeVisible();
    await expect(item.getByText('We award digital badges')).toBeHidden();
    await item.getByText('Details and AI analysis').click();
    await expect(item.getByText('We award digital badges')).toBeVisible();
  });

  test('the account menu links to the connect page and connected agents', async ({ page }) => {
    await signIn(page);
    await page.goto('/settings#agents');
    await expect(page.getByText('Connected agents')).toBeVisible();
    await expect(page.getByTestId('connections')).toContainText('No agents connected yet.');
    await expect(page.getByText('Personal tokens')).toBeVisible();
  });
});
