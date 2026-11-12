#!/usr/bin/env node
// Vercel's build command (vercel.json). Builds the web app and, unless the API still runs on a server
// (BACKEND_URL is set), Concord's API as a Vercel function, written in the Build Output API format
// (.vercel/output), which Vercel deploys as it is.
//
//   node scripts/vercel-build.mjs              web app + function (.vercel/output)
//   node scripts/vercel-build.mjs --function   the function only, for a local check (scripts/vercel-serve.mjs)
//
// With BACKEND_URL set it builds the web app only, and vercel.json's rewrites and middleware.ts forward the API
// to that server, as before step 5. So moving back to the VM is a variable change and a redeploy. CONCORD_API
// overrides that: `function` builds the function even with BACKEND_URL set (a preview of the function while
// production still uses the VM), `backend` never does.
//
// The function holds the server's source, the two packages it imports (with their fixtures) and its production
// dependencies as plain folders (no symlinks), and loads the TypeScript at run time with tsx, as on the VM: the
// validation pool and the reasoner start workers from files next to their sources, which a bundler would break.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { outputConfig } from './vercel-output.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '.vercel/output');
const functionOnly = process.argv.includes('--function');
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

const api = process.env.CONCORD_API ?? (process.env.BACKEND_URL ? 'backend' : 'function');
if (!['function', 'backend'].includes(api)) throw new Error(`CONCORD_API must be function or backend, not ${api}`);
if (api === 'backend' && !functionOnly) {
  console.log(`The API stays on ${process.env.BACKEND_URL ?? 'BACKEND_URL (unset!)'}: building the web app only.`);
  fs.rmSync(out, { recursive: true, force: true }); // a stale function output would take over
  run('pnpm', ['--filter', '@concord/web', 'build']);
  process.exit(0);
}

fs.rmSync(out, { recursive: true, force: true });
if (!functionOnly) {
  run('pnpm', ['--filter', '@concord/web', 'build']);
  fs.cpSync(path.join(root, 'apps/web/dist'), path.join(out, 'static'), { recursive: true });
}

/* ------------------------------------------------------------- the function */

const fn = path.join(out, 'functions/api.func');
const copy = (rel, to = rel) => fs.cpSync(path.join(root, rel), path.join(fn, to), { recursive: true, dereference: true });
copy('tsconfig.base.json');
copy('docs/licences');
for (const f of ['package.json', 'tsconfig.json', 'vercel-entry.mjs', 'src']) copy(`apps/server/${f}`);
for (const pkg of ['core', 'shared'])
  for (const f of ['package.json', 'src', 'fixtures'])
    if (fs.existsSync(path.join(root, `packages/${pkg}/${f}`))) {
      copy(`packages/${pkg}/${f}`); // where the server reads fixtures (config.repoRoot)
      copy(`packages/${pkg}/${f}`, `node_modules/@concord/${pkg}/${f}`); // where imports find it
    }

// Production dependencies from the lockfile, installed flat in a scratch workspace of just these packages.
fs.mkdirSync(path.join(root, '.vercel'), { recursive: true });
const scratch = fs.mkdtempSync(path.join(root, '.vercel/deps-'));
try {
  for (const f of ['package.json', 'pnpm-lock.yaml']) fs.copyFileSync(path.join(root, f), path.join(scratch, f));
  fs.writeFileSync(path.join(scratch, 'pnpm-workspace.yaml'), 'packages:\n  - packages/core\n  - packages/shared\n  - apps/server\n');
  for (const p of ['apps/server', 'packages/core', 'packages/shared']) {
    fs.mkdirSync(path.join(scratch, p), { recursive: true });
    fs.copyFileSync(path.join(root, p, 'package.json'), path.join(scratch, p, 'package.json'));
  }
  run('pnpm', ['install', '--frozen-lockfile', '--prod', '--config.node-linker=hoisted', '--ignore-scripts', '--reporter=silent'], scratch);
  for (const entry of fs.readdirSync(path.join(scratch, 'node_modules'))) {
    if (entry === '@concord' || entry === '.bin' || entry.startsWith('.')) continue;
    fs.cpSync(path.join(scratch, 'node_modules', entry), path.join(fn, 'node_modules', entry), { recursive: true, dereference: true });
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

// The lockfile install brings every workspace package's dependencies; keep only what the server can reach.
const keep = new Set();
const visit = (fromDir, name) => {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      if (keep.has(candidate)) return;
      keep.add(candidate);
      const pkg = JSON.parse(fs.readFileSync(path.join(candidate, 'package.json'), 'utf8'));
      for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) visit(candidate, dep);
      return;
    }
    if (dir === fn) return; // optional or peer dependency that isn't installed
    dir = path.dirname(dir);
  }
};
const server = JSON.parse(fs.readFileSync(path.join(root, 'apps/server/package.json'), 'utf8'));
for (const dep of Object.keys(server.dependencies)) visit(path.join(fn, 'apps/server'), dep);
let pruned = 0;
for (const entry of fs.readdirSync(path.join(fn, 'node_modules'))) {
  const names = entry.startsWith('@') ? fs.readdirSync(path.join(fn, 'node_modules', entry)).map((n) => `${entry}/${n}`) : [entry];
  for (const name of names) {
    const dir = path.join(fn, 'node_modules', name);
    if (!keep.has(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      pruned++;
    }
  }
}
for (const entry of fs.readdirSync(path.join(fn, 'node_modules')))
  if (entry.startsWith('@') && !fs.readdirSync(path.join(fn, 'node_modules', entry)).length) fs.rmdirSync(path.join(fn, 'node_modules', entry));

// tsx and esbuild are resolved from the entry; check they made it, so a broken package fails here, not at run time.
createRequire(path.join(fn, 'apps/server/vercel-entry.mjs')).resolve('tsx/esm/api');

fs.writeFileSync(
  path.join(fn, '.vc-config.json'),
  JSON.stringify(
    {
      runtime: 'nodejs22.x',
      handler: 'apps/server/vercel-entry.mjs',
      launcherType: 'Nodejs',
      shouldAddHelpers: false,
      supportsResponseStreaming: true,
      // A Recall.ai webhook or a change check can take a while; Hobby allows up to 300 s with Fluid compute.
      maxDuration: 300,
      regions: ['lhr1'],
    },
    null,
    2,
  ),
);

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
const mb = size(fn) / 1024 / 1024;
console.log(`Function: ${mb.toFixed(0)} MB unzipped (Vercel's limit is 250 MB), ${keep.size} packages kept, ${pruned} pruned.`);
if (mb > 240) throw new Error('The function is too close to Vercel’s 250 MB limit.');

/* ----------------------------------------------------------------- routing */

fs.writeFileSync(path.join(out, 'config.json'), JSON.stringify(outputConfig(), null, 2));
console.log(`Wrote ${path.relative(root, out)}.`);
