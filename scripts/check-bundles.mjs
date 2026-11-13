import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const dist = fileURLToPath(new URL('../apps/web/dist/', import.meta.url));
const ENTRY_BUDGET = 175_000;
// Also cover static imports, so moving code to an eager vendor chunk cannot hide growth.
const INITIAL_BUDGET = 535_000;
const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
const entry = /<script\b[^>]*\bsrc="([^"]+\.js)"/.exec(html)?.[1];
assert(entry, 'built index.html must have a module entry');

export function moduleGraph(roots) {
  const seen = new Set();
  function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    if (!file.endsWith('.js')) return;
    const code = readFileSync(path.join(dist, file), 'utf8');
    for (const match of code.matchAll(/\b(?:import|export)\s*(?:[^"'();]*?\bfrom\s*)?["'](\.[^"']+)["']/g)) {
      visit(path.posix.join(path.posix.dirname(file), match[1]));
    }
  }
  roots.forEach((file) => visit(file.replace(/^\//, '')));
  return [...seen];
}

const initial = moduleGraph([entry]);
const entrySize = statSync(path.join(dist, entry)).size;
const entryBytes = initial.reduce((sum, file) => sum + statSync(path.join(dist, file)).size, 0);
if (process.argv.includes('--sizes')) {
  const sizes = readdirSync(path.join(dist, 'assets')).filter((f) => /\.(js|css)$/.test(f)).sort().map((file) => {
    const bytes = readFileSync(path.join(dist, 'assets', file));
    return { file, raw: bytes.length, gzip: gzipSync(bytes).length };
  });
  console.log(JSON.stringify({ sizes, initial, entrySize, entryBytes }, null, 2));
} else {
  assert(entrySize <= ENTRY_BUDGET, `entry JS is ${entrySize} bytes; budget is ${ENTRY_BUDGET} bytes`);
  assert(entryBytes <= INITIAL_BUDGET, `initial JS is ${entryBytes} bytes; budget is ${INITIAL_BUDGET} bytes`);
  // The offline install must keep lazy pages, shared code and both workers too.
  const sw = readFileSync(path.join(dist, 'sw.js'), 'utf8');
  for (const file of readdirSync(path.join(dist, 'assets')).filter((f) => /\.(js|css|wasm)$/.test(f))) {
    assert(sw.includes(JSON.stringify(`/assets/${file}`)), `${file} is missing from the service worker's install list`);
    if (file.endsWith('.js')) {
      assert(statSync(path.join(dist, 'assets', file)).size <= 800_000, `${file} exceeds the 800,000 byte chunk limit`);
      moduleGraph([`assets/${file}`]); // Every emitted relative module import, including workers, must resolve.
    }
  }
  console.log(`Entry: ${entrySize} / ${ENTRY_BUDGET} bytes; initial JS: ${entryBytes} / ${INITIAL_BUDGET} bytes; all chunks are kept offline.`);
}
