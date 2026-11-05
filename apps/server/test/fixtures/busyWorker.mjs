// A stand-in for a validation worker stuck in synchronous work, for
// validationWatchdog.test.ts: it starts the real watchdog thread, then never
// yields its own thread again.
import { Worker } from 'node:worker_threads';

const [mode, ms] = process.argv.slice(2);
const watchdog = new Worker(new URL('../../src/services/validationWatchdog.cjs', import.meta.url), { workerData: { parent: process.ppid } });
watchdog.on('online', () => {
  if (mode === 'deadline') watchdog.postMessage({ deadlineMs: Number(ms), rssMb: 1e6 });
  process.send?.('busy');
  const until = Date.now() + 20_000;
  while (Date.now() < until);
});
