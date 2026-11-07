import fs from 'node:fs';
import path from 'node:path';
import { closeDb, openDb } from '../db.js';
import { openStore } from '../store/index.js';
import { copyDatabase, exportHistories, exportRows, importHistories, verifyImport } from './index.js';

/**
 * The cutover tool (docs/cutover.md). The database it writes to or reads from is DATABASE_URL (Neon).
 *
 *   node --import tsx src/migrate/cli.ts copy --from /data     SQLite and repositories in /data -> DATABASE_URL, verified
 *   node --import tsx src/migrate/cli.ts verify --from /data   verify again, without copying
 *   node --import tsx src/migrate/cli.ts export --to /restore  DATABASE_URL -> SQLite and repositories in /restore
 *
 * `copy` can run again: it replaces every document and adds only git objects that are new.
 */

const [command, flag, dir] = process.argv.slice(2);
const usage = () => {
  console.error('usage: cli.ts copy --from <data dir> | verify --from <data dir> | export --to <empty dir>');
  process.exit(2);
};
if (!dir || !['copy', 'verify', 'export'].includes(command) || flag !== (command === 'export' ? '--to' : '--from')) usage();
if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
  console.error('Set DATABASE_URL to the Postgres database to copy into (or export from).');
  process.exit(2);
}
const sqliteFile = path.join(dir, 'concord.sqlite');

await openDb();
try {
  if (command === 'export') {
    if (fs.existsSync(sqliteFile) || fs.existsSync(path.join(dir, 'ontologies'))) throw new Error(`${dir} already has a database or repositories: export into an empty directory`);
    const target = await openStore({ kind: 'sqlite', file: sqliteFile });
    const rows = await exportRows();
    await target.putRows(rows);
    await target.close();
    const h = await exportHistories(dir);
    console.log(`Exported ${rows.length} documents to ${sqliteFile}, and ${h.ontologies} histories (${h.objects} objects) to ${path.join(dir, 'ontologies')}.`);
  } else {
    if (!fs.existsSync(sqliteFile)) throw new Error(`No database at ${sqliteFile}`);
    const source = await openStore({ kind: 'sqlite', file: sqliteFile });
    try {
      if (command === 'copy') {
        const c = await copyDatabase(source);
        console.log(`Copied ${c.rows} documents.`);
        const h = await importHistories(dir);
        console.log(`Imported ${h.ontologies} histories (${h.objects} objects read).`);
        for (const n of h.notes) console.log(`  note: ${n}`);
      }
      const m = await verifyImport(source, dir);
      console.log(`Verified: ${m.ontologies} ontologies, ${m.objects} objects.`);
      for (const n of m.notes) console.log(`  note: ${n}`);
    } finally {
      await source.close();
    }
  }
} catch (err) {
  console.error(`Failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
