#!/usr/bin/env node
/**
 * Vendors the Solid Suite's shared sign-in card (and the suite's list of Solid
 * providers) from jeswr/solid-sdk into packages/suite-ui and packages/pod-auth.
 *
 * Neither package is published to npm yet. Until it is, Concord keeps a pinned,
 * unmodified copy here so every suite app shows the same sign-in modal. When the
 * packages are published, replace the two workspace packages with the npm
 * versions: Concord imports them by their published names and subpaths
 * (@jeswr/suite-ui/sign-in, @jeswr/suite-ui/styles/sign-in.css,
 * @jeswr/pod-auth/directory), so no import changes.
 *
 *   node scripts/vendor-solid-sdk.mjs <path to a solid-sdk checkout>   sync from upstream
 *   node scripts/vendor-solid-sdk.mjs --check                          verify nobody edited the copy
 *
 * The only transformations: each file's leading authorship comment line is dropped, and
 * pod-auth's KNOWN_PROVIDERS list is lifted out of directory.ts on its own (the rest of
 * that file is pod-auth's sign-in client, which Concord's server replaces).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'packages/suite-ui/VENDORED.json');

/** Upstream path (relative to the solid-sdk checkout) -> path in this repository. */
const SUITE_UI = [
  'src/sign-in/index.ts',
  'src/sign-in/types.ts',
  'src/sign-in/model.ts',
  'src/sign-in/brands.tsx',
  'src/sign-in/sign-in-card.tsx',
  'src/components/ui/alert.tsx',
  'src/components/ui/avatar.tsx',
  'src/components/ui/button.tsx',
  'src/components/ui/collapsible.tsx',
  'src/components/ui/dialog.tsx',
  'src/components/ui/icon-button.tsx',
  'src/components/ui/input.tsx',
  'src/components/ui/label.tsx',
  'src/components/ui/separator.tsx',
  'src/components/ui/sheet.tsx',
  'src/components/ui/tooltip.tsx',
  'src/lib/utils.ts',
  'src/lib/density.tsx',
  'src/styles/components.css',
  'src/styles/sign-in.css',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
];
const FILES = [
  ...SUITE_UI.map((p) => ({ from: `packages/suite-ui/${p}`, to: `packages/suite-ui/${p}` })),
  { from: 'LICENSE', to: 'packages/pod-auth/LICENSE' },
];
const PROVIDERS = { from: 'packages/pod-auth/src/directory.ts', to: 'packages/pod-auth/src/directory.ts' };

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Drop a leading "AUTHORED-BY" provenance comment (the suite's generator stamp), nothing else. */
function stripStamp(text) {
  const stamp = /^(?:\/\/|\/\*|<!--)\s*AUTHORED-BY[^\n]*\n/;
  let out = text;
  while (stamp.test(out)) out = out.replace(stamp, '');
  return out;
}

function extractProviders(source, commit) {
  const iface = source.match(/\/\*\*[^\n]*\*\/\nexport interface SolidProvider \{[\s\S]*?\n\}\n/);
  const list = source.match(/(?:\/\/[^\n]*\n)*export const KNOWN_PROVIDERS[\s\S]*?\n\);\n/);
  if (!iface || !list) throw new Error('KNOWN_PROVIDERS or SolidProvider not found in pod-auth/src/directory.ts');
  return [
    `// Vendored from jeswr/solid-sdk packages/pod-auth/src/directory.ts at ${commit}`,
    '// by scripts/vendor-solid-sdk.mjs. Only the provider list; do not edit by hand.',
    '',
    iface[0],
    list[0],
  ].join('\n');
}

function check() {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bad = [];
  for (const [path, hash] of Object.entries(manifest.files)) {
    const full = join(root, path);
    if (!existsSync(full)) bad.push(`${path}: missing`);
    else if (sha256(readFileSync(full, 'utf8')) !== hash) bad.push(`${path}: edited`);
  }
  if (bad.length) {
    console.error(`Vendored solid-sdk files differ from ${manifest.commit}:\n  ${bad.join('\n  ')}`);
    console.error('Change them upstream in jeswr/solid-sdk and re-run node scripts/vendor-solid-sdk.mjs <checkout>.');
    process.exit(1);
  }
  console.log(`Vendored solid-sdk files match ${manifest.source}@${manifest.commit.slice(0, 7)} (${Object.keys(manifest.files).length} files).`);
}

function sync(checkout) {
  const commit = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const files = {};
  const write = (to, text) => {
    const full = join(root, to);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
    files[to] = sha256(text);
  };
  for (const { from, to } of FILES) write(to, stripStamp(readFileSync(join(checkout, from), 'utf8')));
  write(PROVIDERS.to, extractProviders(stripStamp(readFileSync(join(checkout, PROVIDERS.from), 'utf8')), commit));
  writeFileSync(manifestPath, `${JSON.stringify({ source: 'https://github.com/jeswr/solid-sdk', commit, files }, null, 2)}\n`);
  console.log(`Vendored ${Object.keys(files).length} files from solid-sdk ${commit.slice(0, 7)}.`);
}

const arg = process.argv[2];
if (arg === '--check') check();
else if (arg) sync(arg);
else {
  console.error('Usage: node scripts/vendor-solid-sdk.mjs <solid-sdk checkout> | --check');
  process.exit(2);
}
