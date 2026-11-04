#!/usr/bin/env node
/**
 * Validates the plugin and marketplace files against the JSON Schema each one
 * declares in "$schema", so a loader that checks schemas won't reject them.
 * Files in formats without a published schema are checked against local
 * schemas below.
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

/**
 * Files that declare no $schema (Claude Code's own formats and the Codex
 * marketplace) are checked against these, written from each tool's
 * documentation: the fields each loader needs, with the right types.
 */
const str = { type: 'string', minLength: 1 };
const kebab = { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' };
const LOCAL_SCHEMAS = {
  '.claude-plugin/marketplace.json': {
    type: 'object',
    required: ['name', 'owner', 'plugins'],
    properties: {
      name: kebab,
      owner: { type: 'object', required: ['name'], properties: { name: str, email: str, url: str } },
      metadata: { type: 'object', properties: { description: str, version: str, pluginRoot: str } },
      plugins: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['name', 'source'],
          properties: {
            name: kebab,
            // The source variants Claude Code documents: a relative folder in this repo, a GitHub repo, a git URL or an npm package.
            source: {
              oneOf: [
                { type: 'string', pattern: '^\\./' },
                { type: 'object', required: ['source', 'repo'], properties: { source: { const: 'github' }, repo: { type: 'string', pattern: '^[\\w.-]+/[\\w.-]+$' }, ref: str, sha: str } },
                { type: 'object', required: ['source', 'url'], properties: { source: { const: 'url' }, url: { type: 'string', pattern: '^https://' }, ref: str, sha: str } },
                { type: 'object', required: ['source', 'package'], properties: { source: { const: 'npm' }, package: str, version: str } },
              ],
            },
            description: str,
            version: str,
          },
        },
      },
    },
  },
  '.agents/plugins/marketplace.json': {
    type: 'object',
    required: ['name', 'plugins'],
    properties: {
      name: kebab,
      interface: { type: 'object', properties: { displayName: str } },
      plugins: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['name', 'source'],
          properties: {
            name: kebab,
            source: { type: 'object', required: ['source', 'path'], properties: { source: { enum: ['local'] }, path: { type: 'string', pattern: '^\\./' } } },
            policy: { type: 'object', properties: { installation: { enum: ['AVAILABLE', 'INSTALLED_BY_DEFAULT', 'NOT_AVAILABLE'] }, authentication: { enum: ['ON_INSTALL', 'ON_USE'] } } },
            category: str,
          },
        },
      },
    },
  },
  'plugins/concord/.claude-plugin/plugin.json': {
    type: 'object',
    required: ['name'],
    properties: { name: kebab, version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+' }, description: str, author: { type: 'object', required: ['name'] }, homepage: { type: 'string', format: 'uri' }, repository: str, keywords: { type: 'array', items: str } },
  },
  'plugins/concord/.mcp.json': {
    type: 'object',
    required: ['mcpServers'],
    properties: {
      mcpServers: {
        type: 'object',
        minProperties: 1,
        additionalProperties: {
          type: 'object',
          required: ['type', 'url'],
          properties: { type: { enum: ['http', 'sse'] }, url: { type: 'string', format: 'uri', pattern: '^https://' }, headers: { type: 'object' } },
          additionalProperties: false,
        },
      },
    },
  },
};

let failed = 0;
let skipped = 0;
const report = (file, validate, doc, against) => {
  if (validate(doc)) return console.log(`ok ${file}`);
  failed++;
  console.error(`x  ${file} does not match ${against}:`);
  for (const e of validate.errors ?? []) console.error(`     ${e.instancePath || '/'} ${e.message} ${JSON.stringify(e.params)}`);
};
for (const file of FILES) {
  const doc = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  if (!doc.$schema) {
    const schema = LOCAL_SCHEMAS[file];
    if (!schema) {
      failed++;
      console.error(`x  ${file}: declares no $schema and has no local schema here`);
      continue;
    }
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats.default(ajv);
    report(file, ajv.compile(schema), doc, 'its documented format');
    // Marketplace entries must point at a folder that exists.
    for (const p of doc.plugins ?? []) {
      const rel = typeof p.source === 'string' ? p.source : p.source?.path;
      const local = typeof p.source === 'string' || p.source?.source === 'local';
      if (local && !(typeof rel === 'string' && fs.statSync(path.join(root, rel), { throwIfNoEntry: false })?.isDirectory())) {
        failed++;
        console.error(`x  ${file}: plugin ${p.name} points at ${rel}, which is not a folder in this repository`);
      }
    }
    continue;
  }
  try {
    report(file, await validatorFor(await fetchJson(doc.$schema)), doc, doc.$schema);
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
