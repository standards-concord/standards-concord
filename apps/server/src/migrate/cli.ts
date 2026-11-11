import fs from 'node:fs';
import path from 'node:path';
import { closeDb, openDb } from '../db.js';
import { openStore } from '../store/index.js';
import { copyDatabase, exportHistories, exportPrivateFiles, exportRows, importHistories, importPrivateFiles, verifyImport } from './index.js';

/**
 * The cutover tool (docs/cutover.md). The database it writes to or reads from is DATABASE_URL (Neon).
 *
 *   node --import tsx src/migrate/cli.ts copy --from /data [--pods /pods]     SQLite, repositories and private files in /data
 *                                                                            (and what Concord kept in the pods of the
 *                                                                            Solid server whose data directory is /pods)
 *                                                                            -> DATABASE_URL, verified
 *   node --import tsx src/migrate/cli.ts verify --from /data [--pods /pods]   verify again, without copying
 *   node --import tsx src/migrate/cli.ts export --to /restore  DATABASE_URL -> SQLite and repositories in /restore
 *
 * `copy` can run again: it replaces every document and adds only git objects that are new.
 */

const [command, flag, dir, podsFlag, podsDir, ...rest] = process.argv.slice(2);
const usage = () => {
  console.error('usage: cli.ts copy --from <data dir> [--pods <Solid server data dir>] | verify --from <data dir> [--pods <Solid server data dir>] | export --to <empty dir>');
  process.exit(2);
};
if (!dir || !['copy', 'verify', 'export'].includes(command) || flag !== (command === 'export' ? '--to' : '--from')) usage();
if (rest.length || (podsFlag !== undefined && (command === 'export' || podsFlag !== '--pods' || !podsDir))) usage();
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
    const p = await exportPrivateFiles(dir);
    console.log(`Exported ${rows.length} documents to ${sqliteFile}, ${h.ontologies} histories (${h.objects} objects) to ${path.join(dir, 'ontologies')}, and ${p.files} private files.`);
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
        console.log(`Imported ${(await importPrivateFiles(dir, podsDir)).files} private files${podsDir ? ' (with the pods’)' : ''}.`);
      }
      const m = await verifyImport(source, dir, podsDir);
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
