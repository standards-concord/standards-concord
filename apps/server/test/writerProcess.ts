/**
 * Run by the tests as a separate process, to stop or kill a writer at an exact
 * point (SIGKILL: no finally blocks, no git sync, nothing after it runs).
 *
 *   node --import tsx test/writerProcess.ts merge <changeRequestId> <userId>
 *   node --import tsx test/writerProcess.ts publish <releaseId> <userId>
 *   node --import tsx test/writerProcess.ts advance <label>
 *
 * merge and publish are killed the instant the database transaction that
 * moves the working draft commits. advance commits a draft with one more
 * triple (labelled <label>) and, with WRITER_AFTER_PIN=kill or stop, is killed
 * or stopped (SIGSTOP, until the test sends SIGCONT) the instant it has pinned
 * its commit, before its transaction; it prints `committed <sha>` or
 * `refused <status>`.
 */
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { DatabaseSync, StatementSync } from 'node:sqlite';

const afterPin = process.env.WRITER_AFTER_PIN;
const childProcess = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
const execFileSync = childProcess.execFileSync as (...args: unknown[]) => unknown;
childProcess.execFileSync = function (this: unknown, ...args: unknown[]) {
  const out = execFileSync.apply(this, args);
  const [file, argv] = args as [string, string[]];
  if (afterPin && file === 'git' && argv[0] === 'update-ref' && argv[1]?.startsWith('refs/concord/commits/') && argv.length === 3)
    process.kill(process.pid, afterPin === 'stop' ? 'SIGSTOP' : 'SIGKILL');
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
  if (sql === 'COMMIT' && movesDraft && !afterPin) process.kill(process.pid, 'SIGKILL');
};

const [op, id, userId] = process.argv.slice(2);
const { getUser } = await import('../src/services/users.js');
if (op === 'merge' || op === 'publish') {
  const actor = getUser(userId);
  if (!actor) throw new Error(`No user ${userId}`);
  if (op === 'merge') {
    const crs = await import('../src/services/changeRequests.js');
    await crs.merge(crs.getCR(id), actor);
  } else {
    const releases = await import('../src/services/releases.js');
    await releases.publishRelease(releases.getRelease(id), actor);
  }
  console.error('finished without being killed');
  process.exit(3);
} else if (op === 'advance') {
  const { OntologyGraph } = await import('@concord/core');
  const { ontologyStore } = await import('../src/services/ontologyStore.js');
  const { list } = await import('../src/db.js');
  const project = list<{ id: string; slug: string }>('ontologies').find((p) => p.slug === process.env.WRITER_SLUG)!;
  const graph = await OntologyGraph.fromTurtle(`${ontologyStore.readWorkingText(project)}\n<urn:concord-test:${id}> <http://www.w3.org/2000/01/rdf-schema#label> "${id}" .\n`);
  try {
    console.log(`committed ${await ontologyStore.commitWorking(project as never, graph, `writer ${id}`, { name: 'Writer' })}`);
  } catch (err) {
    console.log(`refused ${(err as { status?: number }).status ?? (err as Error).message}`);
  }
} else {
  throw new Error(`Unknown operation ${op}`);
}
