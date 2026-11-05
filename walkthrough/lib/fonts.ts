/**
 * Serves the web fonts the app loads from Google Fonts out of walkthrough/fonts/, so a
 * recording renders the same type on every run and needs no network for it.
 *
 * Each response is stored under a hash of its URL. A missing font is fetched live once
 * and saved (commit the new files); a --publish run never fetches, it reports the miss.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext } from '@playwright/test';

export const FONT_HOSTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;

const TYPES: Record<string, string> = { css: 'text/css; charset=utf-8', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf' };

export function fontFile(dir: string, url: string) {
  const u = new URL(url);
  const ext = u.hostname === 'fonts.googleapis.com' ? 'css' : (u.pathname.match(/\.(woff2?|ttf)$/)?.[1] ?? 'bin');
  return path.join(dir, `${createHash('sha256').update(url).digest('hex').slice(0, 20)}.${ext}`);
}

export async function serveFonts(context: BrowserContext, o: { dir: string; offline: boolean; fetched: Set<string>; missing: Set<string>; fetch?: typeof fetch }) {
  await mkdir(o.dir, { recursive: true });
  await context.route(FONT_HOSTS, async (route) => {
    const url = route.request().url();
    const file = fontFile(o.dir, url);
    const ext = path.extname(file).slice(1);
    const headers = { 'access-control-allow-origin': '*' };
    if (existsSync(file)) return route.fulfill({ status: 200, contentType: TYPES[ext], body: await readFile(file), headers });
    if (o.offline) {
      o.missing.add(url);
      return route.abort('blockedbyclient');
    }
    // Fetched here, not through the browser: the browser may only reach the recording's
    // own origins. This is the one download a draft may make, and only from Google Fonts.
    const res = await (o.fetch ?? fetch)(url, { headers: { 'user-agent': route.request().headers()['user-agent'] ?? '' }, redirect: 'error', signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
    if (!res) return route.abort('internetdisconnected');
    const body = Buffer.from(await res.arrayBuffer());
    if (res.ok) {
      await writeFile(file, body);
      o.fetched.add(url);
    }
    return route.fulfill({ status: res.status, contentType: res.headers.get('content-type') ?? TYPES[ext], body, headers });
  });
}
