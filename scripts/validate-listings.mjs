#!/usr/bin/env node
/**
 * Validates the plugin and marketplace files against the JSON Schema each one
 * declares in "$schema", so a loader that checks schemas won't reject them.
 * The schemas live online: in CI a schema that can't be fetched fails the
 * check; locally it is skipped with a warning (some networks block the hosts).
 *
 *   node scripts/validate-listings.mjs
 *
 * server.json is checked separately by the MCP Registry's own publisher
 * (`publisher validate`), which knows the registry's extra rules.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import Ajv2019 from 'ajv/dist/2019.js';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  '.claude-plugin/marketplace.json',
  '.agents/plugins/marketplace.json',
  'plugins/concord/.claude-plugin/plugin.json',
  'plugins/concord/.mcp.json',
  'plugins/concord/plugin.json',
  'plugins/concord/mcp.json',
];
const ci = !!process.env.CI;

class Unreachable extends Error {}
async function fetchJson(url) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new Unreachable(`${url}: ${e.cause?.message ?? e.message}`);
  }
  if (!res.ok) throw new (res.status >= 500 || res.status === 403 ? Unreachable : Error)(`${url}: HTTP ${res.status}`);
  return res.json();
}

function validatorFor(schema) {
  const dialect = String(schema.$schema ?? '');
  const opts = { strict: false, allErrors: true, loadSchema: fetchJson };
  const ajv = dialect.includes('2020-12') ? new Ajv2020(opts) : dialect.includes('2019-09') ? new Ajv2019(opts) : new Ajv(opts);
  addFormats.default(ajv);
  return ajv.compileAsync(schema);
}

let failed = 0;
let skipped = 0;
for (const file of FILES) {
  const doc = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  if (!doc.$schema) {
    console.log(`-  ${file}: declares no $schema, nothing to check`);
    continue;
  }
  try {
    const validate = await validatorFor(await fetchJson(doc.$schema));
    if (validate(doc)) console.log(`ok ${file}`);
    else {
      failed++;
      console.error(`x  ${file} does not match ${doc.$schema}:`);
      for (const e of validate.errors ?? []) console.error(`     ${e.instancePath || '/'} ${e.message} ${JSON.stringify(e.params)}`);
    }
  } catch (e) {
    if (e instanceof Unreachable && !ci) {
      skipped++;
      console.warn(`?  ${file}: couldn't fetch its schema (${e.message}); skipped. CI checks it.`);
    } else {
      failed++;
      console.error(`x  ${file}: ${e.message}`);
    }
  }
}
if (skipped) console.warn(`${skipped} file(s) skipped because their schemas couldn't be fetched.`);
process.exit(failed ? 1 : 0);
