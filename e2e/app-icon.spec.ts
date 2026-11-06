import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { APIRequestContext } from '@playwright/test';
import { expect, settle, signIn, test } from './fixtures';

/**
 * Concord's own icon (the climbing two-halves plane on its blue tile, drawn by
 * scripts/make-icons.mjs) in the browser tab and on the MCP connector.
 *
 * What used to go wrong: Claude showed a generic plug for the Concord connector,
 * because the MCP server named no icon and the site had no /favicon.ico (the tab
 * icon was a data: URI, which a favicon fetcher can't see); and the default ODI
 * look swapped the tab icon for the ODI mark.
 */

const LOOKS = ['odi', 'spec', 'civic', 'workbench', 'classic'] as const;
const root = path.resolve(import.meta.dirname, '..');

/** Reads a PNG's width and height from its IHDR chunk. */
const pngSize = (b: Buffer) => [b.readUInt32BE(16), b.readUInt32BE(20)];

async function expectIcon(request: APIRequestContext, href: string, mimeType: string, sizes?: string[]) {
  const res = await request.get(href);
  expect(res.status(), href).toBe(200);
  // Served as the file itself, not the app's index.html fallback.
  expect(res.headers()['content-type'], href).toContain(mimeType === 'image/x-icon' ? 'icon' : mimeType);
  const body = await res.body();
  if (mimeType === 'image/svg+xml') {
    const svg = body.toString('utf8');
    expect(svg, href).toContain('rotate(45 32 32)');
    expect(svg, `${href}: the two halves in two tones`).toContain('fill-opacity=".62"');
    expect(svg, `${href}: no ODI mark`).not.toContain('M160');
  } else if (mimeType === 'image/png') {
    expect(body.subarray(1, 4).toString(), href).toBe('PNG');
    if (sizes?.[0]) expect(pngSize(body).join('x'), href).toBe(sizes[0]);
  } else {
    expect([...body.subarray(0, 4)], `${href} is an icon file`).toEqual([0, 0, 1, 0]);
  }
}

const tabIcons = (page: import('@playwright/test').Page) =>
  page.evaluate(() => [...document.querySelectorAll<HTMLLinkElement>('link[rel="icon"], link[rel="apple-touch-icon"]')].map((l) => new URL(l.href).pathname));

test.describe('Concord app icon', () => {
  test('a signed-out visitor gets Concord’s icon in the tab, and every icon file is served', async ({ page }) => {
    await page.goto('/login');
    expect(await tabIcons(page)).toEqual(['/favicon.ico', '/favicon.svg', '/apple-touch-icon.png']);
    await expectIcon(page.request, '/favicon.svg', 'image/svg+xml');
    await expectIcon(page.request, '/favicon.ico', 'image/x-icon');
    await expectIcon(page.request, '/apple-touch-icon.png', 'image/png', ['180x180']);
    await expectIcon(page.request, '/icon-192.png', 'image/png', ['192x192']);
    await expectIcon(page.request, '/icon-512.png', 'image/png', ['512x512']);
  });

  test('the tab icon stays Concord’s in every look, the ODI look included', async ({ page }) => {
    await signIn(page, { name: 'Tab icon tester' });
    for (const id of LOOKS) {
      await page.goto(`/?look=${id}`);
      await settle(page);
      expect(await tabIcons(page), id).toEqual(['/favicon.ico', '/favicon.svg', '/apple-touch-icon.png']);
    }
    // Picking a look on the Appearance page, once the app is running, doesn't swap it either.
    await page.goto('/appearance');
    await settle(page);
    const group = page.getByRole('radiogroup', { name: 'Visual style' });
    for (const name of [/Workbench/, /^ODI/]) {
      const choice = group.getByRole('radio', { name });
      await choice.click();
      await expect(choice).toHaveAttribute('aria-checked', 'true');
      expect(await tabIcons(page), String(name)).toEqual(['/favicon.ico', '/favicon.svg', '/apple-touch-icon.png']);
    }
  });

  test('an agent that connects sees Concord’s icon; one that isn’t signed in is refused', async ({ page, baseURL }) => {
    const mcpUrl = new URL('/mcp', baseURL);
    // Not signed in: the server answers 401 and the client has to sign in first.
    const refused = await page.request.post('/mcp', {
      headers: { Accept: 'application/json, text/event-stream' },
      data: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } },
    });
    expect(refused.status()).toBe(401);

    await signIn(page, { name: 'Icon agent owner', role: 'contributor' });
    const tok = await page.request.post('/api/agent-tokens', { data: { name: 'Icon agent' } });
    expect(tok.ok()).toBe(true);
    const { token } = (await tok.json()) as { token: string };
    const client = new Client({ name: 'playwright', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const info = client.getServerVersion()!;
    await client.close();
    expect(info).toMatchObject({ name: 'concord', title: 'Concord' });
    expect(info.icons?.length).toBeGreaterThan(0);
    for (const icon of info.icons!) {
      expect(new URL(icon.src).origin, icon.src).toBe(new URL(baseURL!).origin);
      await expectIcon(page.request, new URL(icon.src).pathname, icon.mimeType!, icon.sizes);
    }
  });

  test('the MCP Registry listing names icons the site serves', async ({ request }) => {
    const listing = JSON.parse(fs.readFileSync(path.join(root, 'server.json'), 'utf8')) as { icons: { src: string; mimeType: string; sizes?: string[] }[]; remotes: { url: string }[] };
    expect(listing.icons.length).toBeGreaterThan(0);
    for (const icon of listing.icons) {
      // Served by the same site as the connector itself; the file is then fetched from this test's server.
      expect(new URL(icon.src).origin, icon.src).toBe(new URL(listing.remotes[0].url).origin);
      await expectIcon(request, new URL(icon.src).pathname, icon.mimeType, icon.sizes);
    }
  });
});
