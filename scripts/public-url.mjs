#!/usr/bin/env node
/**
 * Concord's public address, as published in the MCP Registry entry
 * (server.json) and the Claude Code and Codex plugins. Run it when Concord
 * moves to a new domain:
 *
 *   node scripts/public-url.mjs https://concord.example.org   # update every listing, bump versions
 *   node scripts/public-url.mjs --check                        # CI: fail if the files disagree
 *   node scripts/public-url.mjs                                # print the current address
 *
 * Merging the change to main republishes the MCP Registry entry (see
 * .github/workflows/mcp-registry.yml). Plugin installs pick it up only when
 * they update (Claude Code leaves auto-update off for third-party
 * marketplaces), and every client has to sign in again at the new address,
 * so keep the old address serving Concord for a while after a move. The web
 * app needs nothing: it always uses its own origin.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const write = (f, v) => fs.writeFileSync(path.join(root, f), `${JSON.stringify(v, null, 2)}\n`);
const bump = (v) => v.replace(/^(\d+)\.(\d+)\.(\d+).*$/, (_, a, b, c) => `${a}.${b}.${Number(c) + 1}`);

/** Every place the public address appears, with how to read and write it. */
const FILES = [
  {
    file: 'server.json',
    get: (j) => j.remotes[0].url,
    set: (j, origin) => {
      j.remotes[0].url = `${origin}/mcp`;
      j.websiteUrl = `${origin}/connect`;
      // The connector's icons are served by the web app at the same address.
      for (const icon of j.icons ?? []) icon.src = `${origin}${new URL(icon.src).pathname}`;
      // Registry versions are immutable, so a new address needs a new version.
      j.version = bump(j.version);
    },
  },
  {
    file: 'plugins/concord/.mcp.json',
    get: (j) => j.mcpServers.concord.url,
    set: (j, origin) => void (j.mcpServers.concord.url = `${origin}/mcp`),
  },
  {
    file: 'plugins/concord/.claude-plugin/plugin.json',
    get: (j) => j.homepage.replace(/\/connect$/, '/mcp'),
    set: (j, origin) => {
      j.homepage = `${origin}/connect`;
      // Plugin installs only update when the version changes.
      j.version = bump(j.version);
    },
  },
  // Codex reads the portable plugin format from the same folder.
  {
    file: 'plugins/concord/mcp.json',
    get: (j) => j.mcpServers.concord.url,
    set: (j, origin) => void (j.mcpServers.concord.url = `${origin}/mcp`),
  },
  {
    file: 'plugins/concord/plugin.json',
    get: (j) => j.homepage.replace(/\/connect$/, '/mcp'),
    set: (j, origin) => {
      j.homepage = `${origin}/connect`;
      j.version = bump(j.version);
    },
  },
];

const arg = process.argv[2];
const current = FILES.map((f) => ({ file: f.file, url: f.get(read(f.file)) }));

if (!arg) {
  console.log(current[0].url.replace(/\/mcp$/, ''));
} else if (arg === '--check') {
  const urls = new Set(current.map((c) => c.url));
  if (urls.size !== 1) {
    console.error('The public MCP URL differs between files:');
    for (const c of current) console.error(`  ${c.file}: ${c.url}`);
    console.error('Run: node scripts/public-url.mjs https://<new-origin>');
    process.exit(1);
  }
  const [url] = urls;
  if (!/^https:\/\/[^/]+\/mcp$/.test(url)) {
    console.error(`The public MCP URL must be https://<host>/mcp, got ${url}`);
    process.exit(1);
  }
  const origin = new URL(url).origin;
  const strays = (read('server.json').icons ?? []).filter((i) => new URL(i.src).origin !== origin);
  if (strays.length) {
    console.error(`server.json's icons must be served from ${origin}: ${strays.map((i) => i.src).join(', ')}`);
    process.exit(1);
  }
  console.log(`OK: ${url}`);
} else {
  let origin;
  try {
    origin = new URL(arg).origin;
  } catch {
    console.error(`Not a URL: ${arg}`);
    process.exit(1);
  }
  if (!origin.startsWith('https://')) {
    console.error('Use an https:// address.');
    process.exit(1);
  }
  for (const f of FILES) {
    const j = read(f.file);
    f.set(j, origin);
    write(f.file, j);
  }
  console.log(`Concord's public address is now ${origin}. Commit and merge to publish it.`);
}
