import { APP_VERSION, compareVersions } from '@concord/shared';
import { config } from './config.js';
import { get, put } from './db.js';
import { withLease } from './lease.js';

/**
 * Work a server does once it starts: hashing old OAuth client secrets, the demo's pictures and seed, release pages
 * from an older renderer, sharing testers' feedback folders. On the VM it all runs at every start, as before. On
 * Vercel there is no "start": every new function instance would do it again, several at once. So each task
 * records that it is done (`kv startup:<name>`, with the app version and deployment that did it), one instance at a
 * time runs them (a lease), and a deployment skips a task this deployment, or a newer app version, has done. A
 * task that throws, or says it isn't finished (returns false), is tried again by the next instance.
 */
export interface StartupTask {
  name: string;
  run: () => Promise<boolean | void>;
}

export const STARTUP_LEASE_MS = 60_000;

interface Done {
  id: string;
  appVersion: string;
  deployment: string;
  at: string;
}

/** This deployment: the app version and, on Vercel, the deployment's own id (a redeploy with new settings counts). */
export const deployment = () => process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_GIT_COMMIT_SHA ?? 'local';

const doneFor = (rec: Done | undefined, appVersion: string) =>
  !!rec && (compareVersions(rec.appVersion, appVersion) > 0 || (compareVersions(rec.appVersion, appVersion) === 0 && rec.deployment === deployment()));

/**
 * Runs the tasks in order. `always` (the VM): every task runs, done or not. Otherwise only those not done yet,
 * and nothing if another instance is running them. Returns the names of the tasks that ran and finished.
 */
export async function runStartupTasks(tasks: StartupTask[], opts: { always?: boolean; appVersion?: string } = {}): Promise<string[] | undefined> {
  const appVersion = opts.appVersion ?? APP_VERSION;
  const runAll = async () => {
    const finished: string[] = [];
    for (const t of tasks) {
      const key = `startup:${t.name}`;
      if (!opts.always && doneFor(await get<Done>('kv', key), appVersion)) continue;
      try {
        if ((await t.run()) === false) continue;
        await put<Done>('kv', { id: key, appVersion, deployment: deployment(), at: new Date().toISOString() });
        finished.push(t.name);
      } catch (err) {
        console.error(`[startup] ${t.name} failed; it is tried again later`, err);
      }
    }
    return finished;
  };
  // The VM waits out a lease its own previous process left behind when it crashed; on Vercel another instance
  // already running them is enough.
  return opts.always
    ? withLease('startup', STARTUP_LEASE_MS, runAll, { renew: true, waitMs: 2 * STARTUP_LEASE_MS })
    : withLease('startup', STARTUP_LEASE_MS, runAll, { wait: false, renew: true });
}

/** The server's start-up tasks. */
export async function defaultStartupTasks(): Promise<StartupTask[]> {
  const [{ migrateClientSecrets }, { backfillDemoAvatars }, { seedDemo }, { refreshReleasePages }, { syncFeedbackSharing }] = await Promise.all([
    import('./oauth.js'),
    import('./services/users.js'),
    import('./services/simulation.js'),
    import('./public/routes.js'),
    import('./services/feedback.js'),
  ]);
  return [
    {
      name: 'oauth-client-secrets',
      run: async () => {
        const secrets = await migrateClientSecrets();
        if (secrets.hashed) console.log(`[oauth] hashed ${secrets.hashed} stored client secret(s)`);
        if (!secrets.scrubbed) console.warn('[oauth] could not scrub old copies of client secrets from the database (another connection was busy); will retry');
        return secrets.scrubbed;
      },
    },
    ...(config.demoMode
      ? [
          {
            name: 'demo-avatars',
            run: async () => {
              const pictures = await backfillDemoAvatars();
              if (pictures) console.log(`[seed] gave ${pictures} demo account(s) a profile picture`);
            },
          },
          { name: 'demo-seed', run: async () => void (await seedDemo()) },
        ]
      : []),
    // Release pages written by an older renderer (or without a use case snapshot) are regenerated.
    { name: 'release-pages', run: () => refreshReleasePages() },
    // ADMIN_WEBIDS may have changed: share testers' pod feedback folders with exactly that list.
    {
      name: 'feedback-sharing',
      run: async () => {
        const c = await syncFeedbackSharing();
        if (c.shared || c.failed) console.log(`[solid] feedback folders shared with ${config.adminWebIds.length} admin WebID(s): ${c.shared} updated, ${c.unchanged} unchanged, ${c.failed} failed`);
        return !c.failed;
      },
    },
  ];
}
