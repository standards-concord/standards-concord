import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

// The deployment smoke script used to leave both a draft request and an abandoned use case.
// A fake curl exercises the shell's response parsing and checks every requested path without a socket.
for (const mode of ['start', 'turn', 'none']) it(`withdraws its change request and uses the ${mode} interview response for cleanup`, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-smoke-'));
  try {
    const log = path.join(dir, 'calls.jsonl');
    fs.writeFileSync(path.join(dir, 'curl'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const url = args.at(-1);
const p = new URL(url).pathname;
fs.appendFileSync(process.env.SMOKE_CALLS, JSON.stringify({ path: p, args }) + '\\n');
let body = {}, status = 200;
if (p === '/mcp') status = 401;
if (p === '/api/ontologies') body = [{ id: 'ontology' }];
if (p.endsWith('/interviews')) { status = 201; body = { id: 'interview', ...(process.env.SMOKE_IDS === 'start' ? { useCaseId: 'use-case' } : {}) }; }
if (p.endsWith('/messages') && process.env.SMOKE_IDS === 'turn') body = { useCase: { id: 'use-case' } };
if (p.endsWith('/change-requests')) { status = 201; body = { id: 'change-request' }; }
process.stdout.write(JSON.stringify(body) + '\\n' + status);
`, { mode: 0o755 });
    // Media checks keep running; their networking is covered separately by check-media's tests.
    fs.writeFileSync(path.join(dir, 'node'), `#!/bin/bash
if [[ "$1" == */check-media.mjs ]]; then
  printf 'media checked\\n' >> "$SMOKE_CALLS"
  exit 0
fi
exec '${process.execPath}' "$@"
`, { mode: 0o755 });
    const script = path.resolve(import.meta.dirname, '../../../deploy/smoke.sh');
    const { stdout: output } = await promisify(execFile)('bash', [script, 'http://smoke.test'], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SMOKE_CALLS: log, SMOKE_IDS: mode }, encoding: 'utf8' });
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
    expect(lines.pop()).toBe('media checked');
    const calls = lines.map((line) => JSON.parse(line) as { path: string; args: string[] });
    const paths = calls.map((c) => c.path);
    expect(paths).toContain('/api/change-requests/change-request/withdraw');
    expect(paths.includes('/api/use-cases/use-case/withdraw')).toBe(mode !== 'none');
    expect(paths).toEqual(expect.arrayContaining(['/healthz', '/alpha', '/api/session', '/api/ontologies/ontology/view', '/api/ontologies/ontology/source', '/api/ontologies/ontology/validation', '/api/ontologies/ontology/sparql', '/api/ontologies/ontology/meetings', '/mcp', '/def/volunteering', '/def/volunteering/1.0.0', '/api/auth/logout']));
    for (const c of calls.filter((c) => c.path.endsWith('/withdraw'))) {
      expect(c.args).toContain('POST');
      expect(paths.indexOf(c.path)).toBeLessThan(paths.indexOf('/api/auth/logout'));
    }
    expect(output).toContain('All checks passed.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
