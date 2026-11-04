import { createApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db.js';
import { refreshReleasePages } from './public/routes.js';
import { processOutstanding } from './services/feedbackIssues.js';
import { runTick, seedDemo } from './services/simulation.js';

openDb();
if (config.demoMode) {
  await seedDemo().catch((err) => console.error('[seed] failed', err));
}
// Release pages written by an older renderer (or without a use case snapshot) are regenerated.
await refreshReleasePages().catch((err) => console.error('[public] refresh failed', err));

const app = createApp();
app.listen(config.port, () => {
  console.log(`Concord listening on ${config.publicUrl} (LLM: ${config.llm.provider}${config.llm.provider === 'anthropic' ? ` ${config.llm.model}` : ''}; Solid: ${config.solid.serverUrl ?? 'local'}; demo: ${config.demoMode})`);
});

// The governance clock: close review periods and votes, auto-merge, auto-draft releases.
setInterval(() => {
  runTick().catch((err) => console.warn('[tick]', (err as Error).message));
}, 60_000).unref();
void runTick();

// Public feedback summaries that couldn't be posted straight away (GitHub down, hourly cap, rate limit) are retried.
setInterval(() => {
  processOutstanding().catch((err) => console.warn('[feedback]', (err as Error).message));
}, 60_000).unref();
void processOutstanding().catch(() => undefined);
