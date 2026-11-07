#!/usr/bin/env node
// Splits the local browser suite into N shards of similar length, using e2e/timings.json
// (seconds per spec file from an earlier run), and prints one line of spec files per shard.
// Playwright's own --shard splits by file count, which put the four slowest files together.
//
//   node scripts/e2e-shards.mjs 4
//   node scripts/e2e-shards.mjs --update report1.json report2.json   (Playwright JSON reports)
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const timingsFile = path.join(root, 'e2e/timings.json');

if (process.argv[2] === '--update') {
  const old = JSON.parse(fs.readFileSync(timingsFile, 'utf8'));
  const seconds = {};
  const walk = (suite) => {
    for (const spec of suite.specs ?? [])
      for (const t of spec.tests ?? [])
        for (const r of t.results ?? []) {
          const f = path.basename(spec.file ?? suite.file);
          seconds[f] = (seconds[f] ?? 0) + r.duration / 1000;
        }
    for (const s of suite.suites ?? []) walk(s);
  };
  for (const report of process.argv.slice(3)) for (const s of JSON.parse(fs.readFileSync(report, 'utf8')).suites ?? []) walk(s);
  const merged = { _comment: old._comment };
  for (const [f, v] of Object.entries({ ...old, ...seconds }).sort(([a], [b]) => a.localeCompare(b))) if (f !== '_comment') merged[f] = Math.round(v);
  fs.writeFileSync(timingsFile, JSON.stringify(merged, null, 2) + '\n');
  console.log(`Updated ${Object.keys(seconds).length} spec timings in e2e/timings.json`);
  process.exit(0);
}

const n = Math.max(1, Number(process.argv[2] ?? 3));
const timings = JSON.parse(fs.readFileSync(timingsFile, 'utf8'));
const specs = fs.readdirSync(path.join(root, 'e2e')).filter((f) => f.endsWith('.spec.ts') && f !== 'live.spec.ts' && !f.startsWith('solid-'));
const known = specs.map((f) => timings[f]).filter((s) => typeof s === 'number').sort((a, b) => a - b);
const median = known.length ? known[Math.floor(known.length / 2)] : 20;
const shards = Array.from({ length: n }, () => ({ total: 0, files: [] }));
// Longest first, each into the shard with the least so far.
for (const f of specs.sort((a, b) => (timings[b] ?? median) - (timings[a] ?? median))) {
  const s = shards.reduce((a, b) => (b.total < a.total ? b : a));
  s.files.push(f);
  s.total += timings[f] ?? median;
}
for (const s of shards) console.log(s.files.map((f) => `e2e/${f}`).join(' '));
if (process.env.SHARDS_VERBOSE) for (const s of shards) console.error(`${Math.round(s.total)}s ${s.files.length} files`);
