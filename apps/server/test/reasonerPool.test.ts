import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OntologyGraph } from '@concord/core';
import { reasonInWorker } from '../src/reasoner/pool.js';

const fixture = readFileSync(new URL('../../../packages/core/fixtures/volunteering.ttl', import.meta.url), 'utf8');

describe('reasoner worker pool', () => {
  it('reasons in the worker, one job at a time, with the same result for each', async () => {
    const g = await OntologyGraph.fromTurtle(fixture);
    const [a, b] = await Promise.all([reasonInWorker(g), reasonInWorker(g)]);
    expect(a).toMatchObject({ engine: 'sparq', available: true, checked: 'complete', consistent: true, unsatisfiable: [] });
    expect(b.inferredSubClassOf).toEqual(a.inferredSubClassOf);
  });

  // A reasoner that never answers must not hold up a validation, and must not count as a pass.
  // It also used to take the next job down with it: the stopped worker's exit failed every
  // pending job, including the healthy one already queued on its replacement ("stopped (exit 1)").
  it('stops a job that runs too long and reports no verdict, and the next job in the same pool still gets one', async () => {
    const g = await OntologyGraph.fromTurtle(fixture);
    const [slow, next] = await Promise.all([reasonInWorker(g, { timeoutMs: 1 }), reasonInWorker(g)]);
    expect(slow).toMatchObject({ available: false, checked: 'none' });
    expect(slow.error).toMatch(/took longer than/);
    expect(next.error).toBeUndefined();
    expect(next.checked).toBe('complete');
  });

  // Used to go wrong: the no-verdict result ran the structural checks on the server's main thread,
  // which took about 17 s for a 1,000-class chain and stalled every other request meanwhile.
  it('answers at once after a timeout, without running the structural checks on the main thread', async () => {
    const owl = 'http://www.w3.org/2002/07/owl#', rdfs = 'http://www.w3.org/2000/01/rdf-schema#', ex = 'https://example.org/chain#';
    const lines = [`<https://example.org/chain> a <${owl}Ontology> .`];
    for (let i = 0; i < 1000; i++) lines.push(`<${ex}C${i}> a <${owl}Class>${i ? ` ; <${rdfs}subClassOf> <${ex}C${i - 1}>` : ''} .`);
    const g = await OntologyGraph.fromTurtle(lines.join('\n'));
    let ticks = 0;
    const heartbeat = setInterval(() => ticks++, 10);
    const t0 = performance.now();
    const r = await reasonInWorker(g, { timeoutMs: 20 });
    const elapsed = performance.now() - t0;
    clearInterval(heartbeat);
    expect(r).toMatchObject({ available: false, checked: 'none' });
    expect(elapsed).toBeLessThan(1000);
    expect(ticks).toBeGreaterThan(0);
  });
});
