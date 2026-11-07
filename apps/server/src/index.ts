import { createApp } from './app.js';
import { config } from './config.js';
import { list, openDb } from './db.js';
import { migrateClientSecrets } from './oauth.js';
import { importVerified } from './migrate/index.js';
import { acquireProcessLock } from './processLock.js';
import { refreshReleasePages } from './public/routes.js';
import { claimGitStore, ontologyStore } from './services/ontologyStore.js';
import { seedDemo } from './services/simulation.js';
import { runDue } from './services/scheduler.js';
import type { OntologyProject } from '@concord/shared';
import { syncFeedbackSharing } from './services/feedback.js';
import { backfillDemoAvatars } from './services/users.js';

acquireProcessLock(config.dataDir);
await openDb();
// An imported database is served only once its import was verified (src/migrate, docs/cutover.md).
if (ontologyStore.kind === 'db' && !config.readOnly && !(await importVerified())) {
  console.error('[store] this database has ontologies but no verified import: run src/migrate/cli.ts verify (docs/cutover.md) before serving it');
  process.exit(1);
}
if (config.readOnly) {
  // Reads only, while Concord moves (docs/cutover.md): no claim on the repositories, no repairs, no start-up writes
  // and no scheduled work.
  console.warn('[store] CONCORD_READ_ONLY is set: serving reads only');
  createApp().listen(config.port, () => console.log(`Concord (read-only) listening on ${config.publicUrl}`));
} else await startWritable();

async function startWritable() {
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
    const pictures = await backfillDemoAvatars();
    if (pictures) console.log(`[seed] gave ${pictures} demo account(s) a profile picture`);
    await seedDemo().catch((err) => console.error('[seed] failed', err));
  }
  // Release pages written by an older renderer (or without a use case snapshot) are regenerated.
  await refreshReleasePages().catch((err) => console.error('[public] refresh failed', err));

  const app = createApp();
  app.listen(config.port, () => {
    console.log(`Concord listening on ${config.publicUrl} (LLM: ${config.llm.provider}${config.llm.provider === 'anthropic' ? ` ${config.llm.model}` : ''}; Solid: ${config.solid.serverUrl ?? 'local'}; demo: ${config.demoMode})`);
  });

  // Scheduled work (the governance clock, the Meet bot's calendar, GitHub App runs, feedback retries): a minute
  // timer here; on Vercel, after requests and a daily cron call instead (services/scheduler.ts).
  if (config.schedule === 'timer') {
    setInterval(() => void runDue().catch((err) => console.warn('[schedule]', (err as Error).message)), 60_000).unref();
    void runDue().catch((err) => console.warn('[schedule]', (err as Error).message));
  }

  // ADMIN_WEBIDS may have changed since the last start: share testers' pod feedback folders with exactly that list.
  void syncFeedbackSharing()
    .then((c) => (c.shared || c.failed ? console.log(`[solid] feedback folders shared with ${config.adminWebIds.length} admin WebID(s): ${c.shared} updated, ${c.unchanged} unchanged, ${c.failed} failed`) : undefined))
    .catch((err) => console.warn('[solid] feedback sharing sync failed', (err as Error).message));
}
