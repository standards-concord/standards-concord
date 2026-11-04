import { createApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db.js';
import { refreshReleasePages } from './public/routes.js';
import { fileOutstandingFeedback, markSwitchOn } from './services/feedbackIssues.js';
import { runTick, seedDemo } from './services/simulation.js';

openDb();
if (config.demoMode) {
  await seedDemo().catch((err) => console.error('[seed] failed', err));
}
// Release pages written by an older renderer (or without a use case snapshot) are regenerated.
await refreshReleasePages().catch((err) => console.error('[public] refresh failed', err));

// Note which feedback predates GitHub issue filing (it isn't filed unless FEEDBACK_ISSUES_BACKFILL is set).
markSwitchOn();

const app = createApp();
app.listen(config.port, () => {
  console.log(`Concord listening on ${config.publicUrl} (LLM: ${config.llm.provider}${config.llm.provider === 'anthropic' ? ` ${config.llm.model}` : ''}; Solid: ${config.solid.serverUrl ?? 'local'}; demo: ${config.demoMode})`);
});

// The governance clock: close review periods and votes, auto-merge, auto-draft releases.
setInterval(() => {
  runTick().catch((err) => console.warn('[tick]', (err as Error).message));
}, 60_000).unref();
void runTick();

// Feedback that couldn't be filed as a GitHub issue straight away (GitHub down, hourly cap) is retried.
setInterval(() => {
  fileOutstandingFeedback().catch((err) => console.warn('[feedback]', (err as Error).message));
}, 5 * 60_000).unref();
void fileOutstandingFeedback().catch(() => undefined);
