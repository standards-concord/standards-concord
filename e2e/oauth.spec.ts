import { expect, signIn, test } from './fixtures';
import { fakeAgent } from './mcp-agent';

test.describe('Connecting an agent with OAuth (no token)', () => {
  test('a signed-out person signs in, allows the agent, and the agent can use the tools', async ({ page, baseURL }) => {
    const agent = await fakeAgent(baseURL!, 'Claude Code (playwright)');
    try {
      // The agent opens the browser at the authorization URL it discovered from /mcp's 401.
      const authUrl = await agent.authorizationUrl;
      expect(authUrl.origin).toBe(baseURL);
      expect(authUrl.pathname).toBe('/authorize');
      expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
      expect(authUrl.searchParams.get('resource')).toBe(`${baseURL}/mcp`);

      await page.goto(authUrl.href);
      await expect(page).toHaveURL(/\/oauth\/authorize\?request=/);
      await expect(page.getByTestId('oauth-title')).toHaveText('Claude Code (playwright) wants to connect to Concord');

      // Not signed in yet: sign in, and come straight back to the consent page.
      await page.getByTestId('oauth-sign-in').click();
      await expect(page).toHaveURL(/\/login\?next=/);
      await page.getByRole('button', { name: 'Try the demo' }).click();
      await expect(page).toHaveURL(/\/oauth\/authorize\?request=/);
      await expect(page.getByText('It will act as you')).toBeVisible();
      await expect(page.getByText(/you’ll go back to/)).toContainText('localhost');

      await page.getByTestId('oauth-allow').click();
      // The browser lands on the agent's loopback callback with a code.
      await expect(page.locator('#done')).toHaveText('Agent connected. You can close this tab.');
      const q = await agent.callback;
      expect(q.get('error')).toBeNull();
      expect(q.get('iss')).toBe(`${baseURL}/`);
      await agent.finish(q.get('code')!);
      expect(agent.store.tokens?.access_token).toMatch(/^cna_/);

      const client = await agent.connect();
      const { tools } = await client.listTools();
      expect(tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(['list_ontologies', 'search_terms', 'report_gap']));
      const res = await client.callTool({ name: 'search_terms', arguments: { ontology: 'volunteering', query: 'skill' } });
      expect(JSON.stringify(res.content)).toContain('vol:Skill');
      await client.close();

      // The connection is listed in Settings and can be disconnected.
      await page.goto('/settings#agents');
      const row = page.getByTestId('connections').getByRole('listitem').filter({ hasText: 'Claude Code (playwright)' });
      await expect(row).toBeVisible();
      page.once('dialog', (d) => void d.accept());
      await row.getByRole('button', { name: 'Disconnect' }).click();
      await expect(page.getByTestId('connections')).toContainText('No agents connected yet.');

      // The agent's token stops working at once.
      const after = await fetch(`${baseURL}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${agent.store.tokens!.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(after.status).toBe(401);
      expect(after.headers.get('www-authenticate')).toContain('error="invalid_token"');
    } finally {
      await agent.close();
    }
  });

  test('a signed-in person can decline', async ({ page, baseURL }) => {
    await signIn(page);
    const agent = await fakeAgent(baseURL!, 'Codex (playwright)');
    try {
      await page.goto((await agent.authorizationUrl).href);
      await expect(page.getByTestId('oauth-title')).toHaveText('Codex (playwright) wants to connect to Concord');
      await page.getByTestId('oauth-deny').click();
      const q = await agent.callback;
      expect(q.get('error')).toBe('access_denied');
      expect(q.get('code')).toBeNull();
    } finally {
      await agent.close();
    }
  });

  test('an old or unknown sign-in link explains what to do', async ({ page, consoleGuard }) => {
    consoleGuard.allow(/status of 404/);
    await page.goto('/oauth/authorize?request=authz_doesnotexist');
    await expect(page.getByText(/expired/)).toBeVisible();
    await expect(page.getByText(/try connecting again/i)).toBeVisible();
  });

  test('discovery works through the site, so clients need only the URL', async ({ request, baseURL }) => {
    const res = await request.post('/mcp', { data: { jsonrpc: '2.0', id: 1, method: 'initialize' }, failOnStatusCode: false });
    expect(res.status()).toBe(401);
    expect(res.headers()['www-authenticate']).toBe(`Bearer resource_metadata="${baseURL}/.well-known/oauth-protected-resource/mcp"`);
    const prm = await (await request.get('/.well-known/oauth-protected-resource/mcp')).json();
    expect(prm).toMatchObject({ resource: `${baseURL}/mcp`, authorization_servers: [`${baseURL}/`] });
    const as = await (await request.get('/.well-known/oauth-authorization-server')).json();
    expect(as).toMatchObject({ authorization_endpoint: `${baseURL}/authorize`, token_endpoint: `${baseURL}/token`, registration_endpoint: `${baseURL}/register`, client_id_metadata_document_supported: true });
  });
});
