import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OntologyGraph } from '@concord/core';
import { poolTesting, reasonInWorker } from '../src/reasoner/pool.js';

const fixture = readFileSync(new URL('../../../packages/core/fixtures/volunteering.ttl', import.meta.url), 'utf8');
// An individual in two disjoint classes: inconsistent, and the structural checks can tell.
const inconsistent = `
  @prefix ex: <https://example.org/t#> . @prefix owl: <http://www.w3.org/2002/07/owl#> .
  ex:A a owl:Class ; owl:disjointWith ex:B . ex:B a owl:Class .
  ex:x a owl:NamedIndividual, ex:A, ex:B .`;

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
    const [slow, next] = await Promise.all([reasonInWorker(g, { timeoutMs: 50, faults: { owl: 'hang' } }), reasonInWorker(g)]);
    expect(slow).toMatchObject({ available: false, checked: 'none' });
    expect(slow.error).toMatch(/took longer than/);
    expect(next.error).toBeUndefined();
    expect(next.checked).toBe('complete');
  });

  // Used to go wrong: after a timeout the pool answered "consistent, no unsatisfiable classes"
  // without checking anything, so a caller that accepts the structural fallback (the old HermiT
  // path ran it) took an inconsistent ontology for a consistent one.
  it('falls back to the structural checks, in a worker, when the OWL reasoner times out', async () => {
    const g = await OntologyGraph.fromTurtle(inconsistent);
    const r = await reasonInWorker(g, { timeoutMs: 50, faults: { owl: 'hang' } });
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
    const r = await reasonInWorker(g, { timeoutMs: 20, structuralTimeoutMs: 50, faults: { owl: 'hang' } });
    const elapsed = performance.now() - t0;
    clearInterval(heartbeat);
    expect(r).toMatchObject({ engine: 'none', available: false, checked: 'none', consistent: false, unsatisfiable: [] });
    expect(r.error).toMatch(/took longer than 20 ms.*structural checks took longer than 50 ms/);
    expect(elapsed).toBeLessThan(1000);
    expect(ticks).toBeGreaterThan(elapsed / 10 / 3);
  });

  // The same gap as a timeout, for a crash: the worker dying mid-check must not read as "consistent".
  // The fallback must also run in a fresh worker, not the dead one.
  it('falls back to the structural checks in a fresh worker when the OWL worker crashes', async () => {
    const g = await OntologyGraph.fromTurtle(inconsistent);
    await reasonInWorker(g); // a live worker for the crash to take down
    const before = poolTesting.spawned;
    const r = await reasonInWorker(g, { faults: { owl: 'exit' } });
    expect(r).toMatchObject({ engine: 'structural', available: false, checked: 'none', consistent: false });
    expect(r.error).toMatch(/OWL reasoner stopped \(exit 3\)/);
    expect(poolTesting.spawned).toBe(before + 1);
  });

  it('falls back to the structural checks when the OWL reasoner reports a failure', async () => {
    const g = await OntologyGraph.fromTurtle(inconsistent);
    const r = await reasonInWorker(g, { faults: { owl: 'throw' } });
    expect(r).toMatchObject({ engine: 'structural', available: false, checked: 'none', consistent: false });
    expect(r.error).toMatch(/OWL reasoner failed: injected test failure/);
  });

  it('says nothing was checked, and is not consistent, when the structural checks fail too', async () => {
    const g = await OntologyGraph.fromTurtle(fixture);
    const r = await reasonInWorker(g, { faults: { owl: 'throw', structural: 'throw' } });
    expect(r).toMatchObject({ engine: 'none', available: false, checked: 'none', consistent: false, unsatisfiable: [] });
    expect(r.error).toMatch(/OWL reasoner failed: injected test failure; the structural checks failed: injected test failure/);
  });

  it('recovers after both workers crash: a fresh worker for each, no verdict, and the queued job still gets one', async () => {
    const g = await OntologyGraph.fromTurtle(fixture);
    await reasonInWorker(g);
    const before = poolTesting.spawned;
    const [crashed, next] = await Promise.all([reasonInWorker(g, { faults: { owl: 'exit', structural: 'exit' } }), reasonInWorker(g)]);
    expect(crashed).toMatchObject({ engine: 'none', available: false, checked: 'none', consistent: false });
    expect(crashed.error).toMatch(/OWL reasoner stopped \(exit 3\); the structural checks stopped \(exit 3\)/);
    expect(next).toMatchObject({ engine: 'sparq', available: true, checked: 'complete', consistent: true });
    expect(next.error).toBeUndefined();
    // One for the structural fallback after the OWL worker died, one for the queued job after that died too.
    expect(poolTesting.spawned).toBe(before + 2);
  });

  // Used to go wrong: a worker that couldn't start threw out of the fallback, so reasonInWorker
  // rejected, and the change-request code filled in its own consistent: true placeholder.
  it('says nothing was checked when a worker cannot start, and works again once it can', async () => {
    const g = await OntologyGraph.fromTurtle(fixture);
    const create = poolTesting.createWorker;
    poolTesting.createWorker = () => { throw new Error('no threads left'); };
    let r;
    try {
      r = await reasonInWorker(g, { faults: { owl: 'exit' } });
    } finally {
      poolTesting.createWorker = create;
    }
    expect(r).toMatchObject({ engine: 'none', available: false, checked: 'none', consistent: false });
    expect(r.error).toMatch(/structural checks could not start: no threads left/);
    const next = await reasonInWorker(g);
    expect(next).toMatchObject({ engine: 'sparq', checked: 'complete', consistent: true });
  });
});
