import { describe, expect, it, vi } from 'vitest';
import { OntologyGraph, type FederationMemberInput } from '@concord/core';

// The OWL reasoner failing on demand, with the pool's own fault injection (as in fork-rebase.test.ts).
const reasoner = vi.hoisted(() => ({ down: false, calls: 0 }));
vi.mock('../src/reasoner/pool.js', async (real) => {
  const pool = await real<typeof import('../src/reasoner/pool.js')>();
  return {
    ...pool,
    reasonInWorker: (graph: Parameters<typeof pool.reasonInWorker>[0], opts: Parameters<typeof pool.reasonInWorker>[1] = {}) => {
      reasoner.calls++;
      return pool.reasonInWorker(graph, reasoner.down ? { ...opts, faults: { owl: 'throw', structural: 'throw' } } : opts);
    },
  };
});

const { checkInputs } = await import('../src/services/federations.js');

describe('federation check cache', () => {
  // Review r1: a check the reasoner couldn't finish was cached like any other, so "check again" kept
  // returning the failure after the reasoner recovered, blocking releases and committed changes.
  it('does not keep a check the reasoner could not finish', async () => {
    const graph = await OntologyGraph.fromTurtle('<https://ex.org/a> a <http://www.w3.org/2002/07/owl#Ontology> . <https://ex.org/a#X> a <http://www.w3.org/2002/07/owl#Class> .');
    const inputs: FederationMemberInput[] = [{ id: 'a', title: 'A', version: '1.0.0', graph, closure: { imported: [], unresolved: [], direct: [] } }];
    const key = `cache-test:${Date.now()}`;

    reasoner.down = true;
    const failed = await checkInputs('urn:test:fed', inputs, key);
    expect(failed.joint.checked).toBe('none');
    expect(failed.passed).toBe(false);

    reasoner.down = false;
    const before = reasoner.calls;
    const recovered = await checkInputs('urn:test:fed', inputs, key);
    expect(reasoner.calls).toBeGreaterThan(before);
    expect(recovered).toMatchObject({ passed: true, joint: { checked: 'complete' } });

    // A finished check is kept: asking again doesn't reason again.
    const after = reasoner.calls;
    expect(await checkInputs('urn:test:fed', inputs, key)).toBe(await checkInputs('urn:test:fed', inputs, key));
    expect(reasoner.calls).toBe(after);
  });
});
