import { createApp } from './app.js';
import { config } from './config.js';
import { list, openDb } from './db.js';
import { migrateClientSecrets } from './oauth.js';
import { refreshReleasePages } from './public/routes.js';
import { claimGitStore, ontologyStore } from './services/ontologyStore.js';
import { runTick, seedDemo } from './services/simulation.js';
import type { OntologyProject } from '@concord/shared';

openDb();
// One server at a time changes the repositories (upgrades are exclusive; see docs/deploy.md). It exits if it ever loses them.
const store = await claimGitStore();
setInterval(store.renew, 5_000).unref();
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    store.release();
    process.exit(0);
  });
// Git is a projection of the database: repair anything a crash left half-done.
for (const p of list<OntologyProject>('ontologies')) ontologyStore.ensureSynced(p);
const secrets = migrateClientSecrets();
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
