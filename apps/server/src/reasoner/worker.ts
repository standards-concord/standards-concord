/**
 * Runs the OWL reasoner (sparq), or the structural checks alone, off the main thread.
 * Messages: { id, turtle, mode } → { id, result | error }. Mode 'hang' never answers (tests only).
 */
import { parentPort } from 'node:worker_threads';
import { reasonOverTurtle, structuralOverTurtle } from '@concord/core/reasoner';

parentPort!.on('message', async ({ id, turtle, mode }: { id: number; turtle: string; mode: 'owl' | 'structural' | 'hang' }) => {
  if (mode === 'hang') return;
  try {
    parentPort!.postMessage({ id, result: mode === 'structural' ? await structuralOverTurtle(turtle) : await reasonOverTurtle(turtle) });
  } catch (e) {
    parentPort!.postMessage({ id, error: (e as Error).message ?? String(e) });
  }
});
