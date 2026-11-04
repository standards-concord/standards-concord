import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { OntologyProject } from '@concord/shared';
import { HttpError } from '../db.js';
import { ontologyStore } from './ontologyStore.js';

/**
 * Mutual exclusion for read-check-commit on an ontology's working draft, both
 * within this process (a promise queue) and across processes sharing the same
 * data directory (an exclusive lock file in the repository's .git folder).
 * A lock file older than STALE_MS is assumed to belong to a crashed process.
 */
const STALE_MS = 2 * 60 * 1000;
const WAIT_MS = 30 * 1000;
const queues = new Map<string, Promise<unknown>>();

async function acquire(file: string) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      fs.closeSync(fd);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > STALE_MS) fs.rmSync(file, { force: true });
      } catch {
        /* removed by its owner meanwhile */
      }
      if (Date.now() > deadline) throw new HttpError(503, 'The working draft is busy with another merge. Try again shortly.');
      await sleep(25);
    }
  }
}

export function withWorkingDraftLock<T>(project: Pick<OntologyProject, 'slug' | 'id'>, fn: () => Promise<T>): Promise<T> {
  const file = path.join(ontologyStore.dir(project), '.git', 'concord-merge.lock');
  const locked = async () => {
    await acquire(file);
    try {
      return await fn();
    } finally {
      fs.rmSync(file, { force: true });
    }
  };
  const run = (queues.get(project.id) ?? Promise.resolve()).then(locked, locked);
  queues.set(project.id, run.catch(() => undefined));
  return run;
}
