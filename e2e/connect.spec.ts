import { expect, signIn, test } from './fixtures';

const APPS = ['Claude', 'ChatGPT', 'Claude Code', 'Codex', 'Cursor', 'VS Code'];

/** WCAG contrast ratio between two rgb colours. */
function contrast(a: number[], b: number[]) {
  const lum = (rgb: number[]) => {
    const [r, g, bl] = rgb.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

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
    await pick('ChatGPT');
    await expect(page.getByTestId('install-chatgpt')).toContainText(mcp);
    await expect(page.getByTestId('open-chatgpt')).toHaveAttribute('href', 'https://chatgpt.com/plugins');
    await expect(page.getByTestId('install-chatgpt')).toContainText('Create as a plugin');
    await expect(page.getByTestId('install-chatgpt')).toContainText('Install');
    await expect(page.getByTestId('install-chatgpt')).toContainText('type @ and pick Concord');
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
    await expect(page.getByTestId('plugin-install')).toContainText('/plugin marketplace add standards-concord/standards-concord');
    await expect(page.getByTestId('plugin-install')).toContainText('/plugin install concord@concord');
    await expect(page.getByTestId('plugin-install')).toContainText('codex plugin marketplace add standards-concord/standards-concord');
    await expect(page.getByTestId('plugin-update-note')).toContainText('/plugin marketplace update concord');
    await expect(page.getByTestId('plugin-update-note')).toContainText('sign in again');
    await expect(page.getByTestId('advanced-setup').getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings#tokens');

    // The page no longer lists the MCP tools.
    for (const name of TOOL_NAMES) await expect(page.getByText(name, { exact: true })).toHaveCount(0);
  });

  // Only Claude used to have a mark: ChatGPT, Claude Code, Codex, Cursor and VS Code showed lettered
  // placeholders ("G", ">_", "cx", "Cu", "VS"). Every app now shows its own logo, visible in both themes.
  for (const scheme of ['light', 'dark'] as const) {
    test(`every app in the picker shows its own logo (${scheme} mode)`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/connect');
      const radios = page.getByRole('radiogroup', { name: 'Which app are you connecting?' }).getByRole('radio');
      await expect(radios).toHaveCount(APPS.length);
      const seen = new Set<string>();
      for (const [i, name] of APPS.entries()) {
        const radio = radios.nth(i);
        // The button's text is just the app's name, with no lettered placeholder beside it.
        await expect(radio).toHaveAccessibleName(name);
        await expect(radio).toHaveText(name);
        const logo = radio.locator('svg[data-logo]');
        await expect(logo).toHaveCount(1);
        await expect(logo).toBeVisible();
        await expect(logo).toHaveAttribute('aria-hidden', 'true');
        const box = (await logo.boundingBox())!;
        expect([box.width, box.height], `${name} logo size`).toEqual([20, 20]);
        // Each logo is its own drawing, not a shared placeholder.
        const markup = (await logo.innerHTML()).replace(/id="[^"]*"|url\(#[^)]*\)/g, '');
        expect(seen.has(markup), `${name} has a logo of its own`).toBe(false);
        seen.add(markup);
        // Some solid colour in the logo stands out from the button behind it (a black mark on a dark page would vanish).
        const { fills, background } = await logo.evaluate((svg) => {
          let el: Element | null = svg.parentElement;
          let bg = 'rgba(0, 0, 0, 0)';
          while (el) {
            bg = getComputedStyle(el).backgroundColor;
            if (!/, 0\)$/.test(bg) && bg !== 'transparent') break;
            el = el.parentElement;
          }
          return { fills: [...svg.querySelectorAll('path')].map((p) => getComputedStyle(p).fill).filter((f) => f.startsWith('rgb')), background: bg };
        });
        const rgb = (c: string) => c.match(/[\d.]+/g)!.slice(0, 3).map(Number);
        if (fills.length) expect(Math.max(...fills.map((f) => contrast(rgb(f), rgb(background)))), `${name} logo contrast on ${background}`).toBeGreaterThan(1.5);
      }
    });
  }

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

  test('each ontology has a Connect an agent page under Explore, with no tool list', async ({ page, baseURL }) => {
    await signIn(page);
    await page.goto('/o/volunteering/browse');
    const explore = page.getByRole('navigation', { name: 'Explore pages' });
    await explore.getByRole('link', { name: 'Connect an agent' }).click();
    await expect(page).toHaveURL(/\/o\/volunteering\/connect$/);
    await expect(page.getByRole('heading', { name: 'Connect an agent' })).toBeVisible();
    await expect(page.getByTestId('connect-agent')).toBeVisible();
    // Signed-in members see the same logos on the ontology's own page.
    for (const name of APPS) await expect(page.getByRole('radio', { name, exact: true }).locator('svg[data-logo]')).toBeVisible();
    await page.getByText('Advanced setup').click();
    await expect(page.getByTestId('mcp-url')).toHaveText(`${baseURL}/mcp`);
    await expect(page.getByText('MCP tools')).toHaveCount(0);
    for (const name of TOOL_NAMES) await expect(page.getByText(name, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create token' })).toHaveCount(0);
    // Cross-link to the reports, which live under Requirements.
    await page.getByRole('link', { name: 'See agent reports' }).click();
    await expect(page).toHaveURL(/\/o\/volunteering\/agents$/);
    await expect(page.getByRole('navigation', { name: 'Ontology sections' }).getByRole('link', { name: 'Requirements' })).toHaveAttribute('aria-current', 'page');
    // Old links to the setup view land on the new page.
    await page.goto('/o/volunteering/agents?view=connect');
    await expect(page).toHaveURL(/\/o\/volunteering\/connect$/);
  });

  test('agent reports have their own page under Requirements, with the analysis collapsed', async ({ page }) => {
    await signIn(page);
    // An agent reports a gap over the REST API (what report_gap does over MCP).
    const r = await page.request.post('/api/ontologies/volunteering/agent-reports', {
      data: { agentName: 'E2E agent', kind: 'missing-concept', summary: 'No way to record volunteer badges', details: 'We award digital badges for completed hours.' },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    await page.goto('/o/volunteering/agents');
    await expect(page.getByRole('heading', { name: 'Agent reports' })).toBeVisible();
    await expect(page.getByTestId('connect-agent')).toHaveCount(0);
    const item = page.getByTestId('agent-reports').getByRole('listitem').filter({ hasText: 'No way to record volunteer badges' });
    await expect(item).toBeVisible();
    await expect(item.getByText('We award digital badges')).toBeHidden();
    await item.getByText('Details and AI analysis').click();
    await expect(item.getByText('We award digital badges')).toBeVisible();
    await page.getByRole('link', { name: 'Connect an agent' }).first().click();
    await expect(page).toHaveURL(/\/o\/volunteering\/connect$/);
  });

  test('the account menu links to the connect page and connected agents', async ({ page }) => {
    await signIn(page);
    await page.goto('/settings#agents');
    await expect(page.getByText('Connected agents')).toBeVisible();
    await expect(page.getByTestId('connections')).toContainText('No agents connected yet.');
    await expect(page.getByText('Personal tokens')).toBeVisible();
  });
});
