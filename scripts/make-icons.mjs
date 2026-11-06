#!/usr/bin/env node
/**
 * Draws Concord's app icon files from one SVG: the climbing two-halves plane
 * on the blue tile, without the slipstream, which turns to noise at small
 * sizes (the in-app mark is `Logo` in apps/web/src/components/badges.tsx).
 *
 *   node scripts/make-icons.mjs
 *
 * Writes into apps/web/public, which is served from the site root:
 *   favicon.svg           the browser tab icon (index.html)
 *   favicon.ico           16, 32 and 48 px, for clients that only look at /favicon.ico
 *   apple-touch-icon.png  180 px, for home screens and link previews
 *   icon-192.png, icon-512.png
 *                         the icons the MCP server and the MCP Registry entry
 *                         advertise, which is what Claude shows for the connector
 *
 * The PNGs are drawn by the Chromium that Playwright already installs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'apps/web/public');

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <title>Concord</title>
  <rect width="64" height="64" rx="12" fill="#005a9c"/>
  <g fill="white" transform="translate(6.7 -6.7) rotate(45 32 32) translate(32 32) scale(.96) translate(-32 -32)">
    <path d="M31 5.5C30.3 8.5 29.7 12 29.6 16L29.4 21C28.8 31 25.5 38 18 45C14 48.6 10.6 50.5 8 52.6L8 55.2L29 55.6L29.8 59L31 60.2Z"/>
    <path fill-opacity=".62" d="M33 5.5C33.7 8.5 34.3 12 34.4 16L34.6 21C35.2 31 38.5 38 46 45C50 48.6 53.4 50.5 56 52.6L56 55.2L35 55.6L34.2 59L33 60.2Z"/>
  </g>
</svg>
`;

/** An .ico that holds PNGs (supported by every browser since Windows Vista). */
function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt8(0, e + 2);
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'favicon.svg'), SVG);

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
const png = async (size) => {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style>` +
      `<img src="data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}">`,
  );
  await page.locator('img').evaluate((img) => img.decode());
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
};

const small = [];
for (const size of [16, 32, 48]) small.push({ size, data: await png(size) });
fs.writeFileSync(path.join(out, 'favicon.ico'), ico(small));
fs.writeFileSync(path.join(out, 'apple-touch-icon.png'), await png(180));
fs.writeFileSync(path.join(out, 'icon-192.png'), await png(192));
fs.writeFileSync(path.join(out, 'icon-512.png'), await png(512));
await browser.close();
console.log(`Wrote favicon.svg, favicon.ico, apple-touch-icon.png, icon-192.png and icon-512.png to ${path.relative(root, out)}`);
