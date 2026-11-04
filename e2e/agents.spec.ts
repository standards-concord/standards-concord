import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { test, expect, demoOntology, settle, signIn, uniq } from './fixtures';

/**
 * Coding agents over MCP, with a personal token (the route for agents that can't open a
 * browser; the OAuth route is in oauth.spec.ts). A tester creates a token in Settings, an
 * agent uses every tool with it, what it reports shows up for the working group, and
 * revoking the token cuts it off.
 */

type Text = { content: { type: string; text: string }[]; isError?: boolean };
const parse = (r: unknown) => JSON.parse((r as Text).content[0].text);

test('a personal token lets an agent use every tool, and revoking it cuts the agent off', async ({ page, baseURL, request }) => {
  const demo = await demoOntology(request);
  await signIn(page, { name: `Agent owner ${uniq()}`, role: 'editor' });
  await page.goto('/settings#tokens');
  await settle(page);
  const name = `CI agent ${uniq()}`;
  await page.getByRole('textbox', { name: 'Token name' }).fill(name);
  await page.getByRole('button', { name: 'Create token' }).click();
  await expect(page.getByText('Copy your token now — it won’t be shown again.')).toBeVisible();
  const token = (await page.locator('#tokens code').first().innerText()).trim();
  expect(token.length).toBeGreaterThan(20);
  const row = page.locator('#tokens li').filter({ hasText: name });
  await expect(row).toContainText('never used');

  const mcpUrl = new URL('/mcp', baseURL);
  const connect = async () => {
    const client = new Client({ name: 'e2e-ci-agent', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  };
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['list_ontologies', 'get_ontology', 'search_terms', 'get_term', 'sparql_query', 'report_gap', 'propose_change', 'get_change_request']));

    const list = parse(await client.callTool({ name: 'list_ontologies', arguments: {} }));
    expect(JSON.stringify(list)).toContain('volunteering');
    const source = await client.callTool({ name: 'get_ontology', arguments: { ontology: 'volunteering', format: 'turtle' } });
    expect((source as Text).content[0].text).toContain('owl:Ontology');
    const hits = parse(await client.callTool({ name: 'search_terms', arguments: { ontology: 'volunteering', query: 'skill' } }));
    expect(JSON.stringify(hits).toLowerCase()).toContain('skill');
    const term = parse(await client.callTool({ name: 'get_term', arguments: { ontology: 'volunteering', term: 'vol:Volunteer' } }));
    expect(JSON.stringify(term)).toContain('Volunteer');
    const rows = await client.callTool({ name: 'sparql_query', arguments: { ontology: 'volunteering', query: 'SELECT ?c WHERE { ?c a <http://www.w3.org/2002/07/owl#Class> } LIMIT 3' } });
    expect((rows as Text).isError).toBeFalsy();

    // A gap report becomes an agent report for the working group.
    const summary = `No way to record shift handovers ${uniq()}`;
    const gap = parse(await client.callTool({ name: 'report_gap', arguments: { ontology: 'volunteering', kind: 'missing-concept', summary, details: 'Our rota app records who hands over to whom at the end of a shift.' } }));
    expect(gap.recommendation).toBeTruthy();

    // A proposal opens a change request, already submitted for review.
    const term2 = `Handover${uniq()}`;
    const cr = parse(await client.callTool({ name: 'propose_change', arguments: { ontology: 'volunteering', title: `Add a class ${term2}`, description: `Add a class ${term2} as a subclass of Session.` } }));
    expect(cr.status).not.toBe('draft');
    const again = parse(await client.callTool({ name: 'get_change_request', arguments: { id: cr.id } }));
    expect(again.number).toBe(cr.number);
    const missing = await client.callTool({ name: 'get_change_request', arguments: { id: 'cr_nope' } });
    expect((missing as Text).isError).toBe(true);

    // The people in the browser see both, attributed to the agent.
    await page.goto(`/o/${demo.id}/agents`);
    await settle(page);
    await expect(page.getByRole('main').getByText(summary).first()).toBeVisible();
    await page.goto(new URL(cr.url).pathname);
    await settle(page);
    await expect(page.getByRole('heading', { level: 2, name: new RegExp(term2) })).toBeVisible();
    await expect(page.getByText('e2e-ci-agent').or(page.getByText(name)).first()).toBeVisible();

    // The token now shows when it was last used.
    await page.goto('/settings#tokens');
    await expect(page.locator('#tokens li').filter({ hasText: name })).toContainText('last used');
  } finally {
    await client.close();
  }

  // Revoked, the token no longer works.
  page.once('dialog', (d) => void d.accept());
  await page.locator('#tokens li').filter({ hasText: name }).getByRole('button', { name: 'Revoke' }).click();
  await expect(page.locator('#tokens li').filter({ hasText: name })).toHaveCount(0);
  const r = await request.post('/mcp', {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  expect(r.status()).toBe(401);
});

test('agents without a token are refused and pointed at sign-in', async ({ request }) => {
  const r = await request.post('/mcp', {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  expect(r.status()).toBe(401);
  expect(r.headers()['www-authenticate']).toMatch(/resource_metadata=/);
});
