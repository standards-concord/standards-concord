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

      // The connection is listed on the Connect an agent page and can be disconnected.
      await page.goto('/connect#agents');
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

  test('the consent page never follows a script address, even if the server sent one', async ({ page, baseURL, consoleGuard }) => {
    await signIn(page);
    const agent = await fakeAgent(baseURL!, 'Suspicious agent (playwright)');
    try {
      await page.goto((await agent.authorizationUrl).href);
      await expect(page.getByTestId('oauth-title')).toBeVisible();
      const dialogs: string[] = [];
      page.on('dialog', (d) => void (dialogs.push(d.message()), d.dismiss()));
      // Pretend the server was tricked into handing back a javascript: address for both buttons.
      for (const action of ['approve', 'deny'] as const) {
        await page.route(`**/api/oauth/requests/*/${action}`, (r) => r.fulfill({ json: { redirect: 'javascript:alert("pwned")//' } }));
      }
      for (const button of ['oauth-allow', 'oauth-deny']) {
        await page.getByTestId(button).click();
        await expect(page.getByText('This app’s return address is not allowed.')).toBeVisible();
      }
      await expect(page).toHaveURL(/\/oauth\/authorize\?request=/);
      await expect(page.getByTestId('oauth-done')).toHaveCount(0);
      expect(dialogs).toEqual([]);
      consoleGuard.allow(/return address is not allowed/);
    } finally {
      await agent.close();
    }
  });

  test('agents cannot register a script or plain-http return address', async ({ request }) => {
    for (const uri of ['javascript:alert(1)', 'data:text/html,hi', 'http://evil.example/callback']) {
      const res = await request.post('/register', { data: { client_name: 'Bad', redirect_uris: [uri], token_endpoint_auth_method: 'none' }, failOnStatusCode: false });
      expect(res.status(), uri).toBe(400);
    }
  });

  test('another website cannot approve a connection in the background', async ({ page, baseURL, consoleGuard }) => {
    consoleGuard.allow(/CORS|Access-Control|Failed to fetch|net::ERR/i);
    await signIn(page);
    const agent = await fakeAgent(baseURL!, 'Background agent (playwright)');
    try {
      const authUrl = (await agent.authorizationUrl).href;
      await page.goto(authUrl);
      await expect(page.getByTestId('oauth-title')).toBeVisible();
      const id = new URL(page.url()).searchParams.get('request')!;
      // A page on another site tries to approve it with the person's session.
      await page.route('http://attacker.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>attacker</title>' }));
      await page.goto('http://attacker.test/');
      const outcome = await page.evaluate(async (url) => {
        const tries = [
          { headers: { 'Content-Type': 'application/json' }, body: '{}' },
          { headers: { 'Content-Type': 'text/plain' }, body: '{}' },
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=1' },
        ];
        const results: string[] = [];
        for (const t of tries) {
          try {
            const r = await fetch(url, { method: 'POST', credentials: 'include', mode: 'cors', ...t });
            results.push(`status ${r.status}`);
          } catch {
            results.push('blocked');
          }
        }
        return results;
      }, `${baseURL}/api/oauth/requests/${id}/approve`);
      expect(outcome.every((o) => o === 'blocked' || o === 'status 415' || o === 'status 401')).toBe(true);
      // The request is still waiting for the person, and the agent got nothing.
      await page.goto(`/oauth/authorize?request=${id}`);
      await expect(page.getByTestId('oauth-allow')).toBeVisible();
      await page.getByTestId('oauth-deny').click();
      expect((await agent.callback).get('error')).toBe('access_denied');
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
