/**
 * Run by the tests as a separate process, to stop or kill a writer at an exact
 * point (SIGKILL: no finally blocks, no git sync, nothing after it runs).
 *
 *   node --import tsx test/writerProcess.ts merge <changeRequestId> <userId>
 *   node --import tsx test/writerProcess.ts publish <releaseId> <userId>
 *   node --import tsx test/writerProcess.ts advance <label>
 *   node --import tsx test/writerProcess.ts prune
 *
 * merge and publish are killed the instant the database transaction that
 * moves the working draft commits. advance commits a draft with one more
 * triple (labelled <label>) and prints `committed <sha>` or `refused <status>`;
 * prune cleans up pins and prints `pruned` or `refused <message>`.
 *
 * With WRITER_AT=pin (right after a writer pins its commit, before its
 * transaction) or WRITER_AT=draft-read (right after pruning reads
 * refs/concord/draft, before moving it), WRITER_DO=kill kills it there, and
 * WRITER_DO=pause prints `paused` and waits there, synchronously, until the
 * file WRITER_RESUME exists.
 */
import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { DatabaseSync, StatementSync } from 'node:sqlite';

const at = process.env.WRITER_AT;
const childProcess = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
const execFileSync = childProcess.execFileSync as (...args: unknown[]) => unknown;
childProcess.execFileSync = function (this: unknown, ...args: unknown[]) {
  const out = execFileSync.apply(this, args);
  const [file, argv] = args as [string, string[]];
  const point =
    file !== 'git'
      ? undefined
      : argv[0] === 'update-ref' && argv[1]?.startsWith('refs/concord/commits/') && argv.length === 3
        ? 'pin'
        : argv[0] === 'rev-parse' && argv.at(-1) === 'refs/concord/draft^{commit}'
          ? 'draft-read'
          : undefined;
  if (point && point === at) {
    if (process.env.WRITER_DO === 'kill') process.kill(process.pid, 'SIGKILL');
    fs.writeSync(1, 'paused\n');
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(process.env.WRITER_RESUME!)) Atomics.wait(wait, 0, 0, 20);
  }
  return out;
} as typeof childProcess.execFileSync;
syncBuiltinESMExports();

let movesDraft = false;
const run = StatementSync.prototype.run as (this: StatementSync, ...args: unknown[]) => ReturnType<StatementSync['run']>;
StatementSync.prototype.run = function (this: StatementSync, ...args: unknown[]) {
  if (args.some((a) => typeof a === 'string' && a.startsWith('draft-head:'))) movesDraft = true;
  return run.apply(this, args);
} as StatementSync['run'];
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
  exec.call(this, sql);
  if (sql === 'ROLLBACK') movesDraft = false;
  if (sql === 'COMMIT' && movesDraft && !at) process.kill(process.pid, 'SIGKILL');
};

const [op, id, userId] = process.argv.slice(2);
const { getUser } = await import('../src/services/users.js');
if (op === 'merge' || op === 'publish') {
  const actor = await getUser(userId);
  if (!actor) throw new Error(`No user ${userId}`);
  if (op === 'merge') {
    const crs = await import('../src/services/changeRequests.js');
    await crs.merge(await crs.getCR(id), actor);
  } else {
    const releases = await import('../src/services/releases.js');
    await releases.publishRelease(await releases.getRelease(id), actor);
  }
  console.error('finished without being killed');
  process.exit(3);
} else if (op === 'advance') {
  const { OntologyGraph } = await import('@concord/core');
  const { ontologyStore } = await import('../src/services/ontologyStore.js');
  const { list } = await import('../src/db.js');
  const project = (await list<{ id: string; slug: string }>('ontologies')).find((p) => p.slug === process.env.WRITER_SLUG)!;
  const graph = await OntologyGraph.fromTurtle(`${await ontologyStore.readWorkingText(project)}\n<urn:concord-test:${id}> <http://www.w3.org/2000/01/rdf-schema#label> "${id}" .\n`);
  try {
    console.log(`committed ${await ontologyStore.commitWorking(project as never, graph, `writer ${id}`, { name: 'Writer' })}`);
  } catch (err) {
    console.log(`refused ${(err as { status?: number }).status ?? (err as Error).message}`);
  }
} else if (op === 'prune') {
  const { ontologyStore } = await import('../src/services/ontologyStore.js');
  const { list } = await import('../src/db.js');
  const project = (await list<{ id: string; slug: string }>('ontologies')).find((p) => p.slug === process.env.WRITER_SLUG)!;
  try {
    await ontologyStore.prunePins(project);
    console.log('pruned');
  } catch (err) {
    console.log(`refused ${(err as Error).message.split('\n')[0]}`);
  }
} else {
  throw new Error(`Unknown operation ${op}`);
}
