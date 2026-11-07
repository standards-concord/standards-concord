import type { IncomingMessage, ServerResponse } from 'node:http';
import type express from 'express';
import { config } from './config.js';
import { setKeepAlive } from './keepAlive.js';

/**
 * Concord as a Vercel function (step 5; built by scripts/vercel-build.mjs). Every request reaches this handler, on
 * whichever instance Vercel picks. Unlike the VM's src/index.ts there is no start: the first request on an instance
 * opens the database and builds the app, and start-up work (src/startup.ts) runs once per deployment, on whichever
 * instance gets there first, after that request's response.
 *
 * It needs Postgres. With no DATABASE_URL it would fall back to a SQLite file on the temporary disk, a database of
 * its own per instance that vanishes, so it refuses instead.
 */
export function createHandler(opts: { waitUntil: (work: Promise<unknown>) => void }) {
  setKeepAlive(opts.waitUntil);
  let ready: Promise<express.Express> | undefined;
  const boot = async () => {
    if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) throw new Error('DATABASE_URL is not set: Concord on Vercel needs Postgres (Neon).');
    if (config.ontologyStore !== 'db') throw new Error('ONTOLOGY_STORE must be db on Vercel: there is no lasting disk for git repositories.');
    const [{ openDb }, { importVerified }, { createApp }] = await Promise.all([import('./db.js'), import('./migrate/index.js'), import('./app.js')]);
    await openDb();
    // As on the VM: an imported database is served only once its import was verified (docs/cutover.md).
    if (!config.readOnly && !(await importVerified())) throw new Error('This database has ontologies but no verified import: run src/migrate/cli.ts verify (docs/cutover.md).');
    if (!config.readOnly) {
      const { defaultStartupTasks, runStartupTasks } = await import('./startup.js');
      opts.waitUntil(
        defaultStartupTasks()
          .then((tasks) => runStartupTasks(tasks))
          .catch((err) => console.error('[startup]', err)),
      );
    }
    return createApp();
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
    app(req as express.Request, res as express.Response);
  };
}
