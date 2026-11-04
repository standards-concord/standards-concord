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
 * No dependencies, so it starts fast and there is nothing to install or audit.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const env = process.env;
const flag = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
const base = (env.CONCORD_URL || 'https://standards-concord.vercel.app').replace(/\/+$/, '');
const token = env.CONCORD_APP_TOKEN ?? '';
const command = env.CONCORD_TEST_COMMAND ?? '';
const format = env.CONCORD_FORMAT || 'turtle';
const maxChanges = Math.max(1, Number(env.CONCORD_MAX_CHANGES) || 20);
const timeoutMs = Math.max(1, Number(env.CONCORD_TIMEOUT_MINUTES) || 15) * 60_000;
const recheck = flag(env.CONCORD_RECHECK);
const shareOutput = flag(env.CONCORD_SHARE_OUTPUT);
const failOnBreak = flag(env.CONCORD_FAIL_ON_BREAK);
const quiet = flag(env.CONCORD_QUIET);
const runUrl = env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : env.CONCORD_RUN_URL;
const commit = env.GITHUB_SHA || env.CONCORD_COMMIT;

const EXT = { turtle: 'ttl', ntriples: 'nt', rdfxml: 'owl', jsonld: 'jsonld', manchester: 'omn', linkml: 'linkml.yaml', shacl: 'shacl.ttl' };

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}
const log = (...a) => quiet || console.log(...a);
const group = (title) => quiet || console.log(env.GITHUB_ACTIONS ? `::group::${title}` : `\n== ${title}`);
const endGroup = () => quiet || (env.GITHUB_ACTIONS && console.log('::endgroup::'));

if (!token.startsWith('cna_')) fail('Set the app token (it starts with cna_). Create one on the App checks page of your ontology in Concord.');
if (!command.trim()) fail('Set test-command to the command that tests your app, e.g. "npm test".');
if (env.GITHUB_ACTIONS) console.log(`::add-mask::${token}`);

async function api(method, p, body) {
  const url = new URL(p, `${base}/`);
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, attempt * 2000));
        continue;
      }
      throw new Error(`Can't reach Concord at ${base}: ${err.message}`);
    }
    if (res.status >= 500 && attempt < 3) {
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
      throw e;
    }
    return { text, json: () => JSON.parse(text), headers: res.headers };
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
    const child = spawn(command, { shell: true, env: { ...env, ...extraEnv, CONCORD_APP_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);
    child.stdout.on('data', (c) => keep(c, process.stdout));
    child.stderr.on('data', (c) => keep(c, process.stderr));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, error: err.message, tail: tail.join('\n') });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code, error: timedOut ? `timed out after ${timeoutMs / 60000} minutes` : undefined, tail: tail.join('\n').trim() });
    });
  });
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
process.on('exit', restore);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

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
try {
  pending = (await api('GET', `/api/app-checks/pending${recheck ? '?all=1' : ''}`)).json();
} catch (err) {
  fail(err.status === 401 ? 'Concord did not accept the app token. Create a new one on the App checks page.' : err.message);
}
log(`Concord: ${pending.app.name} on ${pending.ontology.title} (${pending.ontology.ontologyIRI})`);
const targets = pending.targets.slice(0, maxChanges);
log(`${pending.targets.length} change request(s) to test${pending.targets.length > targets.length ? `, ${targets.length} this run` : ''}.`);

let exitCode = 0;
// Always test the working draft first: if the app fails there, its results say nothing about the changes.
const baseline = await check('Working draft', pending.baseline.source, { CONCORD_TARGET: 'baseline', CONCORD_REVISION: pending.baseline.revision });
await api('POST', '/api/app-checks', { target: 'baseline', revision: pending.baseline.revision, outcome: baseline.outcome, summary: baseline.summary, runUrl, commit });
rows.push(['Working draft', '', baseline.outcome]);
if (baseline.outcome !== 'passed') {
  console.error(`::error::${pending.app.name} ${baseline.outcome === 'failed' ? 'fails' : 'could not be tested'} against the current working draft of ${pending.ontology.title}, so the proposed changes were not tested. ${baseline.summary}`);
  exitCode = 1;
} else {
  for (const t of targets) {
    const r = await check(`#${t.number} ${t.title}`, t.source, { CONCORD_TARGET: `cr-${t.number}`, CONCORD_CHANGE_REQUEST: String(t.number), CONCORD_REVISION: t.revision });
    const out = (await api('POST', '/api/app-checks', { target: t.changeRequestId, revision: t.revision, outcome: r.outcome, summary: r.summary, runUrl, commit })).json();
    const note = out.stale ? 'the change moved on while testing; it will be tested again' : out.autopilot && out.autopilot.action !== 'none' ? `autopilot: ${out.autopilot.message}` : '';
    rows.push([`[#${t.number} ${t.title}](${new URL(t.page, `${base}/`)})`, t.level ?? '', r.outcome, note]);
    log(`#${t.number}: ${r.outcome}${note ? ` (${note})` : ''}`);
  }
}

const failed = rows.filter((r) => r[2] === 'failed' && r[0] !== 'Working draft');
if (failOnBreak && failed.length) exitCode = 1;

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
