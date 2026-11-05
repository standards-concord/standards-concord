/** Runs the OWL reasoner (sparq) off the main thread. Messages: { id, turtle } → { id, result | error }. */
import { parentPort } from 'node:worker_threads';
import { reasonOverTurtle } from '@concord/core/reasoner';

parentPort!.on('message', async ({ id, turtle }: { id: number; turtle: string }) => {
  try {
    parentPort!.postMessage({ id, result: await reasonOverTurtle(turtle) });
  } catch (e) {
    parentPort!.postMessage({ id, error: (e as Error).message ?? String(e) });
  }
});
