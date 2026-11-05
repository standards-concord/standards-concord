import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Concord runs as one server process per data directory. Consent checks rely
 * on it: a withdrawal and a release (or a drafted change request) built from the
 * same use case are serialised in memory (withConsentLock in
 * services/useCases.ts), which only holds within one process. A second server
 * on the same data refuses to start rather than silently break that.
 *
 * The lock is an exclusive SQLite lock on `concord.lock`, held for the life of
 * the process. The operating system takes it atomically and drops it when the
 * process ends, however it ends, so there is no stale lock to clear and no
 * window in which two servers can both take it.
 */
let held: DatabaseSync | undefined;

export function acquireProcessLock(dataDir: string): () => void {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'concord.lock'));
  try {
    db.exec('PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE;');
    // The first write takes the exclusive lock, and EXCLUSIVE mode never gives it back.
    db.exec('BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (pid INTEGER); DELETE FROM owner; INSERT INTO owner VALUES (' + process.pid + '); COMMIT;');
  } catch (err) {
    db.close();
    if (/locked|busy/i.test(String((err as Error).message)))
      throw new Error(`Another Concord server is using ${dataDir}. Run one server per data directory: consent checks depend on it.`);
    throw err;
  }
  held = db;
  return () => {
    if (held === db) held = undefined;
    db.close();
  };
}
