import fs from 'node:fs';
import path from 'node:path';

/**
 * Concord runs as one server process per data directory. Consent checks rely
 * on it: a withdrawal and a release (or a drafted change request) built from the
 * same use case are serialised in memory (withConsentLock in
 * services/useCases.ts), which only holds within one process. A second server
 * on the same data refuses to start rather than silently break that.
 */
export function acquireProcessLock(dataDir: string) {
  const file = path.join(dataDir, 'concord.pid');
  fs.mkdirSync(dataDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      const release = () => {
        try {
          if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.rmSync(file);
        } catch {
          /* already gone */
        }
      };
      process.once('exit', release);
      for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.once(signal, () => {
          release();
          process.exit(0);
        });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const pid = Number(fs.readFileSync(file, 'utf8').trim());
      if (pid && pid !== process.pid && alive(pid))
        throw new Error(`Another Concord server (pid ${pid}) is using ${dataDir}. Run one server per data directory: consent checks depend on it.`);
      // Left behind by a server that has stopped (or by this process before a restart).
      fs.rmSync(file, { force: true });
    }
  }
  throw new Error(`Could not take the server lock in ${dataDir}`);
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
