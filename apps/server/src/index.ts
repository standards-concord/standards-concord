import { createApp } from './app.js';
import { config } from './config.js';
import { list, openDb } from './db.js';
import { migrateClientSecrets } from './oauth.js';
import { acquireProcessLock } from './processLock.js';
import { meetBotTick } from './services/meetBot.js';
import { refreshReleasePages } from './public/routes.js';
import { claimGitStore, ontologyStore } from './services/ontologyStore.js';
import { processOutstanding } from './services/feedbackIssues.js';
import { runTick, seedDemo } from './services/simulation.js';
import type { OntologyProject } from '@concord/shared';
import { syncFeedbackSharing } from './services/feedback.js';

acquireProcessLock(config.dataDir);
await openDb();
if (ontologyStore.kind === 'git') {
  // One server at a time changes the repositories (upgrades are exclusive; see docs/deploy.md). It exits if it ever loses them.
  const store = await claimGitStore();
  setInterval(store.renew, 5_000).unref();
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, async () => {
      await store.release();
      process.exit(0);
    });
  // A demo reset that a crash interrupted is finished or undone.
  await ontologyStore.recoverWipe();
  // Git is a projection of the database: repair anything a crash left half-done.
  for (const p of await list<OntologyProject>('ontologies')) await ontologyStore.ensureSynced(p);
}
const secrets = await migrateClientSecrets();
if (secrets.hashed) console.log(`[oauth] hashed ${secrets.hashed} stored client secret(s)`);
if (!secrets.scrubbed) console.warn('[oauth] could not scrub old copies of client secrets from the database (another connection was busy); will retry at the next start');
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

// ADMIN_WEBIDS may have changed since the last start: share testers' pod feedback folders with exactly that list.
void syncFeedbackSharing()
  .then((c) => (c.shared || c.failed ? console.log(`[solid] feedback folders shared with ${config.adminWebIds.length} admin WebID(s): ${c.shared} updated, ${c.unchanged} unchanged, ${c.failed} failed`) : undefined))
  .catch((err) => console.warn('[solid] feedback sharing sync failed', (err as Error).message));

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
