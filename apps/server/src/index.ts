import { createApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db.js';
import { meetBotTick } from './services/meetBot.js';
import { refreshReleasePages } from './public/routes.js';
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

// The co-lead bot's calendar: pick up invites to its address, book bots before calls start.
setInterval(() => {
  meetBotTick().catch((err) => console.warn('[meet-bot]', (err as Error).message));
}, 60_000).unref();
void meetBotTick().catch((err) => console.warn('[meet-bot]', (err as Error).message));
