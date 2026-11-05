/**
 * Run by the tests in a separate process: does one operation, and is killed
 * outright (SIGKILL: no finally blocks, no git sync, nothing) the instant the
 * database transaction that moves a working draft commits.
 *
 *   node --import tsx test/killAfterCommit.ts merge <changeRequestId> <userId>
 *   node --import tsx test/killAfterCommit.ts publish <releaseId> <userId>
 *
 * Exits 3 if it was never killed.
 */
import { DatabaseSync, StatementSync } from 'node:sqlite';

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
  if (sql === 'COMMIT' && movesDraft) process.kill(process.pid, 'SIGKILL');
};

const [op, id, userId] = process.argv.slice(2);
const { getUser } = await import('../src/services/users.js');
const actor = getUser(userId);
if (!actor) throw new Error(`No user ${userId}`);
if (op === 'merge') {
  const crs = await import('../src/services/changeRequests.js');
  await crs.merge(crs.getCR(id), actor);
} else if (op === 'publish') {
  const releases = await import('../src/services/releases.js');
  await releases.publishRelease(releases.getRelease(id), actor);
} else {
  throw new Error(`Unknown operation ${op}`);
}
console.error('finished without being killed');
process.exit(3);
