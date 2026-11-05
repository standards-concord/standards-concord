// Starts a busy worker (busyWorker.mjs), prints its pid, then dies without
// cleaning up, the way a server killed with SIGKILL would.
import { fork } from 'node:child_process';

const child = fork(new URL('./busyWorker.mjs', import.meta.url), ['orphan']);
child.on('message', () => {
  process.stdout.write(`${child.pid}\n`, () => process.kill(process.pid, 'SIGKILL'));
});
