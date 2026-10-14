import { createApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db.js';
import { runTick, seedDemo } from './services/simulation.js';

openDb();
if (config.demoMode) {
  await seedDemo().catch((err) => console.error('[seed] failed', err));
}

const app = createApp();
app.listen(config.port, () => {
  console.log(`Concord listening on ${config.publicUrl} (LLM: ${config.llm.provider}${config.llm.provider === 'anthropic' ? ` ${config.llm.model}` : ''}; Solid: ${config.solid.serverUrl ?? 'local'}; demo: ${config.demoMode})`);
});

// The governance clock: close review periods and votes, auto-merge, auto-draft releases.
setInterval(() => {
  runTick().catch((err) => console.warn('[tick]', (err as Error).message));
}, 60_000).unref();
void runTick();
