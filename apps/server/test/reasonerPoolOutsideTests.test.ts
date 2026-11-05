import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { OntologyGraph } from '@concord/core';
import { poolTesting, reasonInWorker } from '../src/reasoner/pool.js';

// The reasoner pool's fault hooks exist for the tests in reasonerPool.test.ts. Outside the test
// runner (VITEST unset) they must do nothing: they used to be honoured everywhere, so a caller
// could hang or stop the server's reasoner on purpose. Its own file, because the workers these
// tests leave behind were started without VITEST and would ignore the other file's faults.

const fixture = readFileSync(new URL('../../../packages/core/fixtures/volunteering.ttl', import.meta.url), 'utf8');
const vitest = process.env.VITEST;
const create = poolTesting.createWorker;

afterEach(() => {
  process.env.VITEST = vitest;
  poolTesting.createWorker = create;
});

describe('reasoner pool fault hooks outside the test runner', () => {
  it('ignores injected faults', async () => {
    const g = await OntologyGraph.fromTurtle(fixture);
    await reasonInWorker(g); // a live worker, started under the test runner, that would honour a fault it was sent
    delete process.env.VITEST;
    const r = await reasonInWorker(g, { faults: { owl: 'exit', structural: 'exit' } });
    expect(r).toMatchObject({ engine: 'sparq', available: true, checked: 'complete' });
  });

  it('ignores a replaced worker factory', async () => {
    const g = await OntologyGraph.fromTurtle(fixture);
    await reasonInWorker(g, { faults: { owl: 'exit', structural: 'exit' } }); // no live worker, so the next job spawns one
    delete process.env.VITEST;
    poolTesting.createWorker = () => { throw new Error('replaced factory used'); };
    expect(await reasonInWorker(g)).toMatchObject({ engine: 'sparq', checked: 'complete' });
  });

  it('a worker started outside the test runner ignores a fault it is sent', async () => {
    const env = { ...process.env };
    delete env.VITEST;
    const w = new Worker(new URL('../src/reasoner/worker.boot.mjs', import.meta.url), { env });
    try {
      const reply = await new Promise<{ id: number; result?: { checked: string } }>((resolve, reject) => {
        w.once('message', resolve);
        w.once('exit', (code) => reject(new Error(`worker exited (${code})`)));
        w.postMessage({ id: 1, turtle: fixture, mode: 'owl', fault: 'exit' });
      });
      expect(reply.result?.checked).toBe('complete');
    } finally {
      await w.terminate();
    }
  });
});
