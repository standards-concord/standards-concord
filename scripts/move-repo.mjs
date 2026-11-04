#!/usr/bin/env node
// Points every link to Concord's GitHub repository at a new owner (and optionally a new
// name), for when the repository is transferred to an organisation.
//
//   node scripts/move-repo.mjs <owner>[/<name>]   rewrite links, plugin listings, the MCP
//                                                 Registry name and the container image
//   node scripts/move-repo.mjs --check            fail if any file still names another repo
//
// What it changes: github.com/<owner>/<name> URLs (plugins, marketplace, server.json,
// docs), the "plugin marketplace add <owner>/<name>" install commands (web app and their
// e2e checks), the ghcr.io/<owner>/<name> image the deploy scripts pull, and the MCP
// Registry name io.github.<owner>/concord, which GitHub's OIDC token ties to the owner.
// The site's URL is separate: use scripts/public-url.mjs for that.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const INSTALL = 'apps/web/src/lib/install.ts';
const SKIP = [/^pnpm-lock\.yaml$/, /^docs\/research\//, /\.(png|jpe?g|gif|webp|ico|mp4|webm|woff2?|ttf|wasm|zip|gz)$/i];

const current = readFileSync(path.join(root, INSTALL), 'utf8').match(/MARKETPLACE_REPO = '([^'/]+)\/([^']+)'/);
if (!current) throw new Error(`Couldn't find MARKETPLACE_REPO in ${INSTALL}`);
const [, oldOwner, oldName] = current;

const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !SKIP.some((re) => re.test(f)) && f !== 'scripts/move-repo.mjs');

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const read = (f) => {
  try {
    return readFileSync(path.join(root, f), 'utf8');
  } catch {
    return null; // deleted in the working tree
  }
};

const arg = process.argv[2];
if (!arg || arg === '--help' || arg === '-h') {
  console.log('Usage: node scripts/move-repo.mjs <owner>[/<name>] | --check');
  console.log(`Currently: ${oldOwner}/${oldName}`);
  process.exit(arg ? 0 : 1);
}

if (arg === '--check') {
  // Any "<owner>/<name>" for this repo, or MCP Registry name, that isn't the current one.
  const repoRef = new RegExp(`(?<![\\w.-])([\\w.-]+)/${esc(oldName)}(?![\\w-])`, 'g');
  const registryName = /io\.github\.([\w-]+)\/concord\b/g;
  const stale = [];
  for (const f of files) {
    const text = read(f);
    if (text == null) continue;
    for (const m of text.matchAll(repoRef)) {
      if (m[1].toLowerCase() !== oldOwner.toLowerCase() && !['github.com', 'ghcr.io', 'www.github.com'].includes(m[1])) stale.push(`${f}: ${m[0]}`);
    }
    for (const m of text.matchAll(registryName)) if (m[1] !== oldOwner) stale.push(`${f}: ${m[0]}`);
  }
  if (stale.length) {
    console.error(`These don't match ${oldOwner}/${oldName} (${INSTALL}). Run node scripts/move-repo.mjs ${oldOwner}/${oldName}:`);
    for (const s of stale) console.error(`  ${s}`);
    process.exit(1);
  }
  console.log(`Every repo link names ${oldOwner}/${oldName}.`);
  process.exit(0);
}

if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9._-]+)?$/.test(arg)) {
  console.error(`"${arg}" isn't a GitHub owner or owner/name.`);
  process.exit(1);
}
const [newOwner, newName = oldName] = arg.split('/');

const rules = [
  // The repo itself, wherever it's named: URLs, install commands, the image.
  [new RegExp(`(?<![\\w.-])${esc(oldOwner)}/${esc(oldName)}(?![\\w-])`, 'g'), `${newOwner}/${newName}`],
  // Container images are always lower case.
  [new RegExp(`ghcr\\.io/${esc(newOwner)}/${esc(newName)}`, 'gi'), `ghcr.io/${newOwner.toLowerCase()}/${newName.toLowerCase()}`],
  // The MCP Registry namespace is the GitHub owner the publishing workflow runs under.
  [new RegExp(`io\\.github\\.${esc(oldOwner)}/concord\\b`, 'g'), `io.github.${newOwner}/concord`],
  [new RegExp(`repo owned by ${esc(oldOwner)}\\b`, 'g'), `repo owned by ${newOwner}`],
  [new RegExp(`belongs to \`${esc(oldOwner)}\``, 'g'), `belongs to \`${newOwner}\``],
];

const changed = [];
for (const f of files) {
  const before = read(f);
  if (before == null) continue;
  let after = before;
  for (const [re, to] of rules) after = after.replace(re, to);
  if (after !== before) {
    writeFileSync(path.join(root, f), after);
    changed.push(f);
  }
}
console.log(`${oldOwner}/${oldName} -> ${newOwner}/${newName}: updated ${changed.length} files`);
for (const f of changed) console.log(`  ${f}`);
if (changed.includes('server.json')) {
  console.log('\nserver.json has a new MCP Registry name, so the next publish creates a new entry.');
  console.log(`Retire the old one afterwards (docs/mcp-listings.md) once io.github.${newOwner}/concord is live.`);
}
