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
