/**
 * Runs the OWL reasoner (sparq), or the structural checks alone, off the main thread.
 * Messages: { id, turtle, mode, fault? } → { id, result | error }. A fault (tests only) makes the job
 * never answer ('hang'), stop the worker ('exit') or report a failure ('throw'); it is ignored
 * unless the worker runs under the test runner (VITEST is set).
 */
import { parentPort } from 'node:worker_threads';
import { reasonOverTurtle, structuralOverTurtle } from '@concord/core/reasoner';

type Job = { id: number; turtle: string; mode: 'owl' | 'structural'; fault?: 'hang' | 'exit' | 'throw' };

const testing = process.env.VITEST !== undefined;

parentPort!.on('message', async ({ id, turtle, mode, fault: requested }: Job) => {
  const fault = testing ? requested : undefined;
  if (fault === 'hang') return;
  if (fault === 'exit') process.exit(3);
  try {
    if (fault === 'throw') throw new Error('injected test failure');
    parentPort!.postMessage({ id, result: mode === 'structural' ? await structuralOverTurtle(turtle) : await reasonOverTurtle(turtle) });
  } catch (e) {
    parentPort!.postMessage({ id, error: (e as Error).message ?? String(e) });
  }
});
