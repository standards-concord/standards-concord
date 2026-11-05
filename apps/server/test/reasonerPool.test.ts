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
    const [slow, next] = await Promise.all([reasonInWorker(g, { timeoutMs: 50, owlMode: 'hang' }), reasonInWorker(g)]);
    expect(slow).toMatchObject({ available: false, checked: 'none' });
    expect(slow.error).toMatch(/took longer than/);
    expect(next.error).toBeUndefined();
    expect(next.checked).toBe('complete');
  });

  // Used to go wrong: after a timeout the pool answered "consistent, no unsatisfiable classes"
  // without checking anything, so a caller that accepts the structural fallback (the old HermiT
  // path ran it) took an inconsistent ontology for a consistent one.
  it('falls back to the structural checks, in a worker, when the OWL reasoner times out', async () => {
    const g = await OntologyGraph.fromTurtle(`
      @prefix ex: <https://example.org/t#> . @prefix owl: <http://www.w3.org/2002/07/owl#> .
      ex:A a owl:Class ; owl:disjointWith ex:B . ex:B a owl:Class .
      ex:x a owl:NamedIndividual, ex:A, ex:B .`);
    const r = await reasonInWorker(g, { timeoutMs: 50, owlMode: 'hang' });
    expect(r).toMatchObject({ engine: 'structural', available: false, checked: 'none', consistent: false });
    expect(r.error).toMatch(/took longer than/);
  });

  // The structural checks can be slow too (about 17 s for a 1,000-class chain). They used to run on
  // the server's main thread and stall every other request; now they run in a worker with their own
  // time limit, and when that runs out too the result says nothing was checked and isn't consistent.
  it('answers at once when the structural checks also run too long, without blocking the main thread', async () => {
    const owl = 'http://www.w3.org/2002/07/owl#', rdfs = 'http://www.w3.org/2000/01/rdf-schema#', ex = 'https://example.org/chain#';
    const lines = [`<https://example.org/chain> a <${owl}Ontology> .`];
    for (let i = 0; i < 1000; i++) lines.push(`<${ex}C${i}> a <${owl}Class>${i ? ` ; <${rdfs}subClassOf> <${ex}C${i - 1}>` : ''} .`);
    const g = await OntologyGraph.fromTurtle(lines.join('\n'));
    let ticks = 0;
    const heartbeat = setInterval(() => ticks++, 10);
    const t0 = performance.now();
    const r = await reasonInWorker(g, { timeoutMs: 20, structuralTimeoutMs: 50, owlMode: 'hang' });
    const elapsed = performance.now() - t0;
    clearInterval(heartbeat);
    expect(r).toMatchObject({ engine: 'none', available: false, checked: 'none', consistent: false, unsatisfiable: [] });
    expect(r.error).toMatch(/took longer than 20 ms.*structural checks took longer than 50 ms/);
    expect(elapsed).toBeLessThan(1000);
    expect(ticks).toBeGreaterThan(elapsed / 10 / 3);
  });
});
