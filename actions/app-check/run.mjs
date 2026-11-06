#!/usr/bin/env node
/**
 * Concord app check. Tests an application against the current working draft of an
 * ontology and against every open change request, then reports each result to Concord.
 *
 * Runs as the GitHub Action in this folder, or in any CI with Node 20+:
 *
 *   CONCORD_URL=https://standards-concord.vercel.app \
 *   CONCORD_APP_TOKEN=cna_... \
 *   CONCORD_TEST_COMMAND="npm test" \
 *   node run.mjs
 *
 * The test command gets these environment variables:
 *   CONCORD_ONTOLOGY_FILE   path of the ontology version under test
 *   CONCORD_ONTOLOGY_URL    where that version can be downloaded
 *   CONCORD_TARGET          "baseline" or "cr-<number>"
 *   CONCORD_CHANGE_REQUEST  the change request number (unset for the baseline)
 *   CONCORD_REVISION        fingerprint of the version under test
 *
 * An app connected through the Concord GitHub App needs no token: set CONCORD_APP to the app's id
 * instead, and on GitHub Actions (with `permissions: id-token: write`) the run signs in with
 * GitHub's proof that it runs in the app's repository.
 *
 * No dependencies, so it starts fast and there is nothing to install or audit.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const env = process.env;
const flag = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
const base = (env.CONCORD_URL || 'https://standards-concord.vercel.app').replace(/\/+$/, '');
let token = (env.CONCORD_APP_TOKEN ?? '').trim();
const appId = (env.CONCORD_APP ?? '').trim();
const command = env.CONCORD_TEST_COMMAND ?? '';
const format = env.CONCORD_FORMAT || 'turtle';
const maxChanges = Math.max(1, Number(env.CONCORD_MAX_CHANGES) || 20);
const timeoutMs = (Number(env.CONCORD_TIMEOUT_MINUTES) > 0 ? Number(env.CONCORD_TIMEOUT_MINUTES) : 15) * 60_000;
const recheck = flag(env.CONCORD_RECHECK);
const shareOutput = flag(env.CONCORD_SHARE_OUTPUT);
const failOnBreak = flag(env.CONCORD_FAIL_ON_BREAK);
const quiet = flag(env.CONCORD_QUIET);
const runUrl = env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : env.CONCORD_RUN_URL;
/**
 * The app commit under test. Results carry over between runs of the same commit, so a run only
 * needs to test what changed. Without one (and no clean git checkout to read it from) every run
 * tests every open change.
 */
function appCommit() {
  const given = (env.GITHUB_SHA || env.CONCORD_COMMIT || '').trim();
  if (given) return given;
  try {
    const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    if (execFileSync('git', ['status', '--porcelain'], opts).trim()) return undefined;
    return execFileSync('git', ['rev-parse', 'HEAD'], opts).trim() || undefined;
  } catch {
    return undefined;
  }
}
const commit = appCommit();

const EXT = { turtle: 'ttl', ntriples: 'nt', rdfxml: 'owl', jsonld: 'jsonld', manchester: 'omn', linkml: 'linkml.yaml', shacl: 'shacl.ttl' };

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}
const log = (...a) => quiet || console.log(...a);
const group = (title) => quiet || console.log(env.GITHUB_ACTIONS ? `::group::${title}` : `\n== ${title}`);
const endGroup = () => quiet || (env.GITHUB_ACTIONS && console.log('::endgroup::'));

if (token && !token.startsWith('cna_')) fail('The app token should start with cna_. Create one on the App checks page of your ontology in Concord.');
if (!token && !appId) fail('Set the app token (it starts with cna_), or, for an app connected through the Concord GitHub App, app: the app’s id. Both are on the App checks page of your ontology in Concord.');
if (!command.trim()) fail('Set test-command to the command that tests your app, e.g. "npm test".');
if (env.GITHUB_ACTIONS && token) console.log(`::add-mask::${token}`);

/** Call Concord, trying again (up to `tries` times) when it can't be reached or has a server error. */
async function api(method, p, body, { tries = 3 } = {}) {
  const url = new URL(p, `${base}/`);
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { ...(token && { Authorization: `Bearer ${token}` }), Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      if (attempt < tries) {
        await new Promise((r) => setTimeout(r, attempt * 2000));
        continue;
      }
      const e = new Error(`Can't reach Concord at ${base}: ${err.message}`);
      e.transient = true;
      throw e;
    }
    if (res.status >= 500 && attempt < tries) {
      await new Promise((r) => setTimeout(r, attempt * 2000));
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try {
        msg = JSON.parse(text).error ?? text;
      } catch {}
      const e = new Error(`${method} ${url.pathname}: ${res.status} ${msg}`);
      e.status = res.status;
      e.transient = res.status >= 500;
      throw e;
    }
    return { text, json: () => JSON.parse(text), headers: res.headers };
  }
}

// The test run in progress, so a timeout or a cancelled job can stop all of it.
let running;
const groupKill = process.platform !== 'win32';

/** Stop the test command and everything it started (npm, test workers, servers…). */
function stop(child, signal) {
  try {
    if (groupKill) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

/** Run the test command; resolves with its exit code (or null if it couldn't run or timed out). */
function runTests(extraEnv) {
  return new Promise((resolve) => {
    const tail = [];
    const keep = (chunk, stream) => {
      stream.write(chunk);
      for (const line of chunk.toString().split('\n')) {
        tail.push(line);
        if (tail.length > 40) tail.shift();
      }
    };
    // Its own process group, so stopping it stops the processes it spawned too.
    const child = spawn(command, { shell: true, detached: groupKill, env: { ...env, ...extraEnv, CONCORD_APP_TOKEN: '', ACTIONS_ID_TOKEN_REQUEST_TOKEN: '', ACTIONS_ID_TOKEN_REQUEST_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    running = child;
    let timedOut = false;
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardKill);
      // Whatever the test started and left behind (even something that ignores SIGTERM) is
      // stopped before the next version is swapped in, so runs can't leak into each other.
      stop(child, 'SIGKILL');
      running = undefined;
      resolve(r);
    };
    let hardKill;
    const timer = setTimeout(() => {
      timedOut = true;
      stop(child, 'SIGTERM');
      hardKill = setTimeout(() => stop(child, 'SIGKILL'), 5000);
    }, timeoutMs);
    child.stdout.on('data', (c) => keep(c, process.stdout));
    child.stderr.on('data', (c) => keep(c, process.stderr));
    child.on('error', (err) => done({ code: null, error: err.message, tail: tail.join('\n') }));
    const finish = (code) =>
      done({ code: timedOut ? null : code, error: timedOut ? `timed out after ${+(timeoutMs / 60000).toFixed(2)} minutes` : undefined, tail: tail.join('\n').trim() });
    child.on('close', finish);
    // If something it started escaped the group and holds the output open, don't wait for it forever.
    child.on('exit', (code) => setTimeout(() => finish(code), 10_000).unref());
  });
}

/** A GitHub Actions OIDC token for this app's audience, or undefined outside GitHub or without the permission. */
async function runIdentity(appId) {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !requestToken) {
    if (env.GITHUB_ACTIONS)
      console.log('::warning::Add `permissions: id-token: write` to this job so GitHub can vouch for the run. Without it, results show on Concord but autopilot ignores them.');
    return undefined;
  }
  try {
    const u = new URL(url);
    u.searchParams.set('audience', `concord-app-check:${appId}`);
    const res = await fetch(u, { headers: { Authorization: `Bearer ${requestToken}`, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const value = (await res.json()).value;
    if (env.GITHUB_ACTIONS && value) console.log(`::add-mask::${value}`);
    return value || undefined;
  } catch (err) {
    console.log(`::warning::GitHub couldn't vouch for this run (${err.message}), so autopilot will ignore its results.`);
    return undefined;
  }
}

// Where each version of the ontology goes while the tests run.
const tmpDir = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), 'concord-'));
const target = env.CONCORD_ONTOLOGY_PATH ? path.resolve(env.CONCORD_ONTOLOGY_PATH) : path.join(tmpDir, `ontology.${EXT[format] ?? 'txt'}`);
const original = env.CONCORD_ONTOLOGY_PATH && fs.existsSync(target) ? fs.readFileSync(target) : undefined;
const restore = () => {
  if (!env.CONCORD_ONTOLOGY_PATH) return;
  if (original) fs.writeFileSync(target, original);
  else fs.rmSync(target, { force: true });
};
process.on('exit', () => {
  if (running) stop(running, 'SIGKILL');
  restore();
});
// A cancelled job: stop the tests, put the ontology file back, and exit.
for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, () => {
    if (running) stop(running, 'SIGTERM');
    process.exit(130);
  });

const withFormat = (p) => {
  const u = new URL(p, `${base}/`);
  u.searchParams.set('format', format);
  return u.toString();
};

async function check(label, source, extraEnv) {
  const url = withFormat(source);
  group(`${label}: ${command}`);
  try {
    const file = await api('GET', url);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.text);
  } catch (err) {
    endGroup();
    return { outcome: 'error', summary: `Could not download this version: ${err.message}` };
  }
  const r = await runTests({ ...extraEnv, CONCORD_ONTOLOGY_FILE: target, CONCORD_ONTOLOGY_URL: url });
  endGroup();
  if (r.code === 0) return { outcome: 'passed', summary: `\`${command}\` passed.` };
  if (r.code === null) return { outcome: 'error', summary: `\`${command}\` could not run: ${r.error}` };
  const summary = `\`${command}\` exited with code ${r.code}.${shareOutput && r.tail ? `\n\n${r.tail.slice(-1500)}` : ''}`;
  return { outcome: 'failed', summary };
}

const rows = [];
let pending;
if (!token) {
  // Connected through the Concord GitHub App: trade GitHub's proof that this run is in the app's
  // repository for a token that lasts the run. Each proof can be used once, so every try asks
  // GitHub for a fresh one (Concord may have used up the last one before its reply was lost).
  for (let attempt = 1; !token; attempt++) {
    const proof = await runIdentity(appId);
    if (!proof) fail('Without an app token, the run signs in with GitHub’s proof that it runs in the app’s repository. Run it on GitHub Actions with `permissions: id-token: write`.');
    try {
      token = (await api('POST', '/api/app-checks/session', { app: appId, oidc: proof }, { tries: 1 })).json().token;
    } catch (err) {
      if (!err.transient || attempt >= 3) fail(`Concord didn’t accept this run for app ${appId}: ${err.message}`);
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  if (env.GITHUB_ACTIONS) console.log(`::add-mask::${token}`);
}
try {
  // Say which app commit this run tests: results carry over only between runs of the same commit.
  const q = new URLSearchParams({ ...(recheck && { all: '1' }), ...(commit && { commit }) }).toString();
  pending = (await api('GET', `/api/app-checks/pending${q ? `?${q}` : ''}`)).json();
} catch (err) {
  fail(err.status === 401 ? 'Concord did not accept the app token. Create a new one on the App checks page.' : err.message);
}
log(`Concord: ${pending.app.name} on ${pending.ontology.title} (${pending.ontology.ontologyIRI})${commit ? `, app commit ${commit.slice(0, 12)}` : ''}`);

let exitCode = 0;
// Always test the working draft first: if the app fails there, its results say nothing about the changes.
const baseline = await check('Working draft', pending.baseline.source, { CONCORD_TARGET: 'baseline', CONCORD_REVISION: pending.baseline.revision });
const attempt = pending.attempt;
// Ask GitHub to vouch for this run (needs `permissions: id-token: write`), just before reporting,
// because the proof is short-lived. Only results from a vouched-for run move autopilot.
const oidc = await runIdentity(pending.app.id);
const baselineReply = (await api('POST', '/api/app-checks', { target: 'baseline', revision: pending.baseline.revision, attempt, outcome: baseline.outcome, summary: baseline.summary, runUrl, commit, ...(oidc && { oidc }) })).json();
// One key per change: it proves that change's result comes from the run GitHub vouched for.
const runKeys = baselineReply.runKeys ?? {};
if (env.GITHUB_ACTIONS) for (const k of Object.values(runKeys)) console.log(`::add-mask::${k}`);
if (oidc && baselineReply.verified) log('GitHub vouched for this run, so autopilot can act on its results.');
rows.push(['Working draft', '', baseline.outcome, baselineReply.stale ? 'superseded by a newer run, or the draft moved on' : '']);
if (baseline.outcome !== 'passed') {
  // Whatever Concord made of it, an app that fails (or couldn't be tested on) the draft fails the job.
  console.error(`::error::${pending.app.name} ${baseline.outcome === 'failed' ? 'fails' : 'could not be tested'} against the current working draft of ${pending.ontology.title}, so the proposed changes were not tested. ${baseline.summary}`);
  exitCode = 1;
} else if (baselineReply.stale) {
  // A newer run (or a newer working draft) has taken over: this run's results wouldn't count.
  log('The working draft moved on, or a newer run already reported it, so this run stops here. The next run tests the changes.');
} else {
  // Concord answers the draft result with what this run should test: anything that has no
  // result counting under it, longest waiting first.
  const all = Array.isArray(baselineReply.targets) ? baselineReply.targets : pending.targets;
  // Every run stays within max-changes, so its length is bounded however many changes are open.
  const targets = all.slice(0, maxChanges);
  log(`${all.length} change request(s) to test${all.length > targets.length ? `, ${targets.length} this run` : ''}.`);
  if (!commit && all.length > maxChanges) {
    // Without a commit, results only count for the run that made them: the changes left out now
    // keep no result that counts, so autopilot can't speak for them. Say so loudly.
    console.error(`::error::No app commit is known, so results from one run can't be reused by the next, and ${all.length - targets.length} of ${all.length} open change(s) are left without a result that counts. Set CONCORD_COMMIT (GITHUB_SHA is used on GitHub), or raise max-changes to at least ${all.length}.`);
    exitCode = 1;
  }
  for (const t of targets) {
    const r = await check(`#${t.number} ${t.title}`, t.source, { CONCORD_TARGET: `cr-${t.number}`, CONCORD_CHANGE_REQUEST: String(t.number), CONCORD_REVISION: t.revision });
    const out = (await api('POST', '/api/app-checks', { target: t.changeRequestId, revision: t.revision, attempt, outcome: r.outcome, summary: r.summary, runUrl, commit, ...(runKeys[t.changeRequestId] && { runKey: runKeys[t.changeRequestId] }) })).json();
    const note = out.stale ? 'the change moved on while testing (or a newer run reported first); it will be tested again' : out.autopilot && out.autopilot.action !== 'none' ? `autopilot: ${out.autopilot.message}` : '';
    rows.push([`[#${t.number} ${t.title}](${new URL(t.page, `${base}/`)})`, t.level ?? '', r.outcome, note]);
    log(`#${t.number}: ${r.outcome}${r.outcome === 'error' ? `: ${r.summary}` : ''}${note ? ` (${note})` : ''}`);
  }
}

const failed = rows.filter((r) => r[2] === 'failed' && r[0] !== 'Working draft');
const errored = rows.filter((r) => r[2] === 'error' && r[0] !== 'Working draft');
if (failOnBreak && failed.length) exitCode = 1;
// A change that couldn't be tested isn't a pass: fail the job so someone looks.
if (errored.length) {
  console.error(`::error::${errored.length} proposed change(s) could not be tested. Concord will ask for them again on the next run.`);
  exitCode = 1;
}

const icon = { passed: '✅ passed', failed: '❌ failed', error: '⚠️ error' };
const md = [
  `### Concord: ${pending.app.name} against ${pending.ontology.title}`,
  '',
  rows.length > 1 || baseline.outcome !== 'passed' ? '| Version | Level | Result | Notes |\n| --- | --- | --- | --- |' : '',
  ...rows.map(([v, level, outcome, note]) => `| ${v} | ${level} | ${icon[outcome] ?? outcome} | ${note ?? ''} |`),
  '',
  rows.length === 1 && baseline.outcome === 'passed' ? 'No new proposed changes to test. The working draft passes.' : '',
].join('\n');
if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${md}\n`);
if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `checked=${rows.length - 1}\nfailed=${failed.map((r) => r[0].match(/#(\d+)/)?.[1]).join(',')}\n`);
if (!env.GITHUB_STEP_SUMMARY) log(`\n${md}`);
process.exit(exitCode);
