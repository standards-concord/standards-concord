import { createApp } from './app.js';
import { config } from './config.js';
import { list, openDb } from './db.js';
import { importVerified } from './migrate/index.js';
import { acquireProcessLock } from './processLock.js';
import { claimGitStore, ontologyStore } from './services/ontologyStore.js';
import { runDue } from './services/scheduler.js';
import { defaultStartupTasks, runStartupTasks } from './startup.js';
import type { OntologyProject } from '@concord/shared';

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
  // Start-up work (src/startup.ts) runs at every start here, as one server; feedback sharing (slow: it writes to
  // pods) carries on after the server is listening.
  const tasks = await defaultStartupTasks();
  const later = tasks.filter((t) => t.name === 'feedback-sharing');
  await runStartupTasks(tasks.filter((t) => !later.includes(t)), { always: true });

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

  void runStartupTasks(later, { always: true }).catch((err) => console.warn('[startup]', (err as Error).message));
}
