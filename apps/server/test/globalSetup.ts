import { testDatabaseName } from './testDatabase.js';

/**
 * Once per run, before any test file: with TEST_DATABASE_URL, drop the per-worker databases an earlier run of this
 * ontology store left on that server (setup.ts makes them again). A database kept from an earlier run still named
 * that run's demo ontology, whose history (a git repository in a temporary folder, or a database the run never
 * imported) was gone, so the tests that read it failed with "No ontology at <commit>".
 */
export default async function dropEarlierTestDatabases() {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) return;
  const prefix = testDatabaseName(new URL(base).pathname.slice(1) || 'postgres', process.env.ONTOLOGY_STORE, '');
  const { default: pg } = await import('pg');
  const admin = new pg.Client({ connectionString: base, application_name: 'concord-test-setup' });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ datname: string }>('SELECT datname FROM pg_database WHERE starts_with(datname, $1)', [prefix]);
    for (const { datname } of rows) {
      if (/^\d+$/.test(datname.slice(prefix.length))) await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }
}
