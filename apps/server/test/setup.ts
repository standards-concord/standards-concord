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
