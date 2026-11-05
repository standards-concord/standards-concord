import { createApp } from './app.js';
import { config } from './config.js';
import type { OntologyProject } from '@concord/shared';
import { list, openDb } from './db.js';
import { migrateClientSecrets } from './oauth.js';
import { meetBotTick } from './services/meetBot.js';
import { refreshReleasePages } from './public/routes.js';
import { processOutstanding } from './services/feedbackIssues.js';
import { ontologyStore } from './services/ontologyStore.js';
import { runTick, seedDemo } from './services/simulation.js';

openDb();
const secrets = migrateClientSecrets();
if (secrets.hashed) console.log(`[oauth] hashed ${secrets.hashed} stored client secret(s)`);
if (!secrets.scrubbed) console.warn('[oauth] could not scrub old copies of client secrets from the database (another connection was busy); will retry at the next start');
if (config.demoMode) {
  await seedDemo().catch((err) => console.error('[seed] failed', err));
}
// A process that stopped mid-update may have left a checkout behind HEAD (only people browsing the repository see it).
for (const p of list<OntologyProject>('ontologies')) ontologyStore.syncCheckout(p);
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

// Public feedback summaries that couldn't be posted straight away (GitHub down, hourly cap, rate limit) are retried.
setInterval(() => {
  processOutstanding().catch((err) => console.warn('[feedback]', (err as Error).message));
}, 60_000).unref();
void processOutstanding().catch(() => undefined);
