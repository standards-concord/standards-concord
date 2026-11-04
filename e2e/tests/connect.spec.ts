import { expect, test } from '@playwright/test';
import { signInDemo } from './helpers.js';

const TOOL_NAMES = ['list_ontologies', 'get_ontology', 'search_terms', 'sparql_query', 'validate_data', 'propose_change', 'get_change_request'];

test.describe('Connect page', () => {
  test('anyone can open it, and every install option points at this site', async ({ page, baseURL }) => {
    await page.goto('/connect');
    await expect(page.getByRole('heading', { name: 'Connect your agent to Concord' })).toBeVisible();
    const mcp = `${baseURL}/mcp`;
    await expect(page.getByTestId('mcp-url')).toHaveText(mcp);

    // Claude: the prefilled "Add custom connector" dialog on claude.ai.
    const claude = new URL((await page.getByTestId('add-to-claude').getAttribute('href'))!);
    expect(claude.origin + claude.pathname).toBe('https://claude.ai/customize/connectors');
    expect(claude.searchParams.get('modal')).toBe('add-custom-connector');
    expect(claude.searchParams.get('connectorName')).toBe('Concord');
    expect(claude.searchParams.get('connectorUrl')).toBe(mcp);
    await expect(page.getByTestId('add-to-claude')).toHaveAttribute('target', '_blank');

    // Claude Code and Codex: one command each, with no token in it.
    await expect(page.getByTestId('install-claude-code')).toContainText(`claude mcp add --transport http concord ${mcp}`);
    await expect(page.getByTestId('install-codex')).toContainText(`codex mcp add concord --url ${mcp}`);
    await expect(page.getByTestId('install-codex')).toContainText('codex mcp login concord');
    await expect(page.getByTestId('connect-agent')).not.toContainText(/Bearer|token=/i);

    // Cursor and VS Code deep links carry the same URL.
    const cursor = new URL((await page.getByTestId('add-to-cursor').getAttribute('href'))!);
    expect(cursor.protocol).toBe('cursor:');
    expect(JSON.parse(Buffer.from(cursor.searchParams.get('config')!, 'base64').toString())).toEqual({ url: mcp });
    const vscode = (await page.getByTestId('add-to-vscode').getAttribute('href'))!;
    expect(vscode.startsWith('vscode:mcp/install?')).toBe(true);
    expect(JSON.parse(decodeURIComponent(vscode.split('?')[1]!))).toEqual({ name: 'concord', type: 'http', url: mcp });

    // Plugin installs that follow Concord when its domain changes.
    await page.getByText('Install as a plugin instead').click();
    await expect(page.getByTestId('plugin-install')).toContainText('/plugin marketplace add jeswr/standards-concord');
    await expect(page.getByTestId('plugin-install')).toContainText('/plugin install concord@concord');
    await expect(page.getByTestId('plugin-install')).toContainText('codex plugin marketplace add jeswr/standards-concord');

    // The page no longer lists the MCP tools.
    for (const name of TOOL_NAMES) await expect(page.getByText(name, { exact: true })).toHaveCount(0);
  });

  test('copy buttons copy the command', async ({ page, context, baseURL }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/connect');
    const copy = page.getByTestId('install-claude-code').getByRole('button', { name: 'Copy' });
    await copy.click();
    await expect(copy).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`claude mcp add --transport http concord ${baseURL}/mcp`);
    await page.getByTestId('install-codex').getByRole('button', { name: 'Copy' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`codex mcp add concord --url ${baseURL}/mcp`);
  });

  test('the ontology Agents tab shows the same install options and no tool list', async ({ page, baseURL }) => {
    await signInDemo(page);
    await page.goto('/o/volunteering/agents');
    await expect(page.getByTestId('connect-agent')).toBeVisible();
    await expect(page.getByTestId('mcp-url')).toHaveText(`${baseURL}/mcp`);
    await expect(page.getByText('MCP tools')).toHaveCount(0);
    for (const name of TOOL_NAMES) await expect(page.getByText(name, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create token' })).toHaveCount(0);
    await page.getByRole('link', { name: 'More ways to connect' }).click();
    await expect(page).toHaveURL(/\/connect$/);
  });

  test('the account menu links to the connect page and connected agents', async ({ page }) => {
    await signInDemo(page);
    await page.goto('/settings#agents');
    await expect(page.getByText('Connected agents')).toBeVisible();
    await expect(page.getByTestId('connections')).toContainText('No agents connected yet.');
    await expect(page.getByText('Personal tokens')).toBeVisible();
  });
});
