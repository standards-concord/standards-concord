import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { OntologyGraph } from '@concord/core';

const fixture = readFileSync(new URL('../../../packages/core/fixtures/volunteering.ttl', import.meta.url), 'utf8');

describe('reasoner worker pool', () => {
  it('reasons in the worker, one job at a time, with the same result for each', async () => {
    const { reasonInWorker } = await import('../src/reasoner/pool.js');
    const g = await OntologyGraph.fromTurtle(fixture);
    const [a, b] = await Promise.all([reasonInWorker(g), reasonInWorker(g)]);
    expect(a).toMatchObject({ engine: 'sparq', available: true, checked: 'complete', consistent: true, unsatisfiable: [] });
    expect(b.inferredSubClassOf).toEqual(a.inferredSubClassOf);
  });

  // A reasoner that never answers must not hold up a validation, and must not count as a pass.
  it('stops a job that runs too long and reports no verdict, then keeps working', async () => {
    vi.resetModules();
    vi.stubEnv('REASONER_TIMEOUT_MS', '1');
    try {
      const { reasonInWorker } = await import('../src/reasoner/pool.js');
      const g = await OntologyGraph.fromTurtle(fixture);
      const r = await reasonInWorker(g);
      expect(r).toMatchObject({ available: false, checked: 'none' });
      expect(r.error).toMatch(/took longer than/);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
    const { reasonInWorker } = await import('../src/reasoner/pool.js');
    expect((await reasonInWorker(await OntologyGraph.fromTurtle(fixture))).checked).toBe('complete');
  });
});
