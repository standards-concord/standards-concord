import type { IncomingMessage, ServerResponse } from 'node:http';
import type express from 'express';
import { config } from './config.js';
import { setKeepAlive } from './keepAlive.js';
import type { StartupTask } from './startup.js';

/**
 * Concord as a Vercel function (step 5; built by scripts/vercel-build.mjs). Every request reaches this handler, on
 * whichever instance Vercel picks. Unlike the VM's src/index.ts there is no start: the first request on an instance
 * opens the database and builds the app, and start-up work (src/startup.ts) runs once per deployment, on whichever
 * instance gets there first, after that request's response.
 *
 * It needs Postgres. With no DATABASE_URL it would fall back to a SQLite file on the temporary disk, a database of
 * its own per instance that vanishes, so it refuses instead.
 */
/** How often a warm instance tries start-up tasks that haven't finished again. */
export const STARTUP_RETRY_MS = 60_000;

export function createHandler(opts: {
  waitUntil: (work: Promise<unknown>) => void;
  /** Tests: other start-up tasks, and how soon to try unfinished ones again. */
  startupTasks?: () => Promise<StartupTask[]>;
  startupRetryMs?: number;
}) {
  setKeepAlive(opts.waitUntil);
  let ready: Promise<express.Express> | undefined;
  const boot = async () => {
    if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) throw new Error('DATABASE_URL is not set: Concord on Vercel needs Postgres (Neon).');
    if (config.ontologyStore !== 'db') throw new Error('ONTOLOGY_STORE must be db on Vercel: there is no lasting disk for git repositories.');
    const [{ openDb }, { importVerified }, { createApp }] = await Promise.all([import('./db.js'), import('./migrate/index.js'), import('./app.js')]);
    await openDb();
    // As on the VM: an imported database is served only once its import was verified (docs/cutover.md).
    if (!config.readOnly && !(await importVerified())) throw new Error('This database has ontologies but no verified import: run src/migrate/cli.ts verify (docs/cutover.md).');
    if (!config.readOnly) startup();
    return createApp();
  };
  // Start-up work runs after the first request on an instance, and again after later requests (at most every
  // STARTUP_RETRY_MS) until every task has recorded that it is done for this deployment: a task that failed is
  // retried on a warm instance too, not only when a new one starts.
  let startupDone = false;
  let nextStartup = 0;
  const startup = () => {
    if (startupDone || config.readOnly || Date.now() < nextStartup) return;
    nextStartup = Date.now() + (opts.startupRetryMs ?? STARTUP_RETRY_MS);
    opts.waitUntil(
      (async () => {
        const { defaultStartupTasks, runStartupTasks, unfinishedTasks } = await import('./startup.js');
        const tasks = await (opts.startupTasks ?? defaultStartupTasks)();
        await runStartupTasks(tasks);
        startupDone = (await unfinishedTasks(tasks)).length === 0;
      })().catch((err) => console.error('[startup]', err)),
    );
  };
  return async (req: IncomingMessage, res: ServerResponse) => {
    let app: express.Express;
    try {
      app = await (ready ??= boot());
    } catch (err) {
      ready = undefined; // the next request tries again (the database may have been asleep)
      console.error('[vercel] could not start', err);
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json');
      res.setHeader('retry-after', '5');
      return void res.end(JSON.stringify({ error: 'Concord is starting up or its database is unreachable. Try again in a moment.' }));
    }
    startup();
    app(req as express.Request, res as express.Response);
  };
}
