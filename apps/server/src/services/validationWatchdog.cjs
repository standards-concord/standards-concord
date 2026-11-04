// Runs on its own thread inside each validation worker process
// (validationWorker.ts), so it keeps watch even while the worker's main thread
// is stuck in synchronous work (converting JSON-LD, the SHACL engine). It kills
// the process when a job overruns its deadline (the server stops it sooner,
// but the server may be gone), when the process uses more memory than the job
// allows (resident set, so WebAssembly and native memory count; SIGUSR2 tells
// the server why), or when the server process has gone away.
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');

const parent = workerData.parent;
const die = () => process.kill(process.pid, 'SIGKILL');

/** Whether the server that started this worker is still its parent and still running. */
function parentAlive() {
  try {
    // Linux: the parent as the kernel sees it now (an orphan is re-parented).
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) === parent;
  } catch {
    try {
      process.kill(parent, 0);
      return true;
    } catch {
      return false;
    }
  }
}

let deadline;
let memory;
// The worker sends each job's limits as it starts it, and 0 when it is done.
parentPort.on('message', (job) => {
  clearTimeout(deadline);
  clearInterval(memory);
  if (!job) return;
  deadline = setTimeout(die, job.deadlineMs);
  const limit = job.rssMb * 1024 * 1024;
  memory = setInterval(() => {
    if (process.memoryUsage.rss() > limit) process.kill(process.pid, 'SIGUSR2');
  }, 2);
});
setInterval(() => {
  if (!parentAlive()) die();
}, 250);
