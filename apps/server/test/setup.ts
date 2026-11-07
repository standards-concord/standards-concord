import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated data dir, simulated LLM and no external services, before config is imported.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-test-'));
process.env.CONCORD_DATA_DIR = dir;
process.env.LLM_PROVIDER = 'simulated';
process.env.DEMO_MODE = 'true';
delete process.env.SOLID_SERVER_URL;
delete process.env.RECALL_API_KEY;
// git ignores the machine's own configuration (a developer's tag.gpgSign, say, would change the ids the tests check).
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

// Test files run in parallel, one per worker. Those that use a real Postgres server
// (TEST_DATABASE_URL) get a database of their own per worker, so two files never reset or
// lock each other's tables. Files in the same worker run one after another and share it.
const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
if (baseDatabaseUrl) {
  const url = new URL(baseDatabaseUrl);
  const name = `${url.pathname.slice(1) || 'postgres'}_w${process.env.VITEST_POOL_ID ?? '1'}`;
  const { default: pg } = await import('pg');
  const admin = new pg.Client({ connectionString: baseDatabaseUrl, application_name: 'concord-test-setup' });
  await admin.connect();
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await admin.query(`CREATE DATABASE "${name}"`);
        break;
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === '42P04' || code === '23505') break; // made already, by this worker's earlier file
        // Two workers copying template1 at once: Postgres lets only one do so at a time.
        if (code === '55006' && attempt < 50) await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
        else throw e;
      }
    }
  } finally {
    await admin.end();
  }
  url.pathname = `/${name}`;
  process.env.TEST_DATABASE_URL = url.toString();
}
