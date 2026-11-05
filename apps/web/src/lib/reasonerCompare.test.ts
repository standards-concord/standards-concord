import { describe, expect, it } from 'vitest';
import type { ReasonerResult } from '@concord/core/types';
import { compareWithServer } from './reasonerCompare';

const run = (r: Partial<ReasonerResult> = {}): ReasonerResult => ({
  engine: 'sparq', available: true, checked: 'complete', consistent: true, unsatisfiable: [], inferredSubClassOf: [['urn:A', 'urn:B']], durationMs: 3, checkMs: 1, ...r,
});

describe('comparing the in-browser reasoner run with the server', () => {
  it('says "same" for the same revision and result, whatever the timings', () => {
    expect(compareWithServer(run(), 'r1', run({ durationMs: 90, checkMs: 40 }), 'r1')).toBe('same');
  });

  // Used to go wrong: the panel stored only "same revision: yes" from when the check ran, so after
  // the server's report was reloaded for a newer revision it still said "Same result as the server."
  it('never compares runs of different revisions, including after the server report moves on', () => {
    expect(compareWithServer(run(), 'r1', run(), 'r2')).toBe('other-revision');
    expect(compareWithServer(run(), undefined, run(), 'r1')).toBe('other-revision');
    expect(compareWithServer(run(), 'r1', run(), undefined)).toBe('other-revision');
  });

  it.each<[string, Partial<ReasonerResult>]>([
    ['inferred relations', { inferredSubClassOf: [] }],
    ['profile notes', { profile: [{ kind: 'Undeclared', detail: 'ex:Ghost is not declared' }] }],
    ['the explanation', { explanation: 'Something else.' }],
    ['why the check stopped', { available: false, checked: 'none', error: 'out of budget' }],
    ['how far the check got', { available: false, checked: 'consistency' }],
    ['unsatisfiable classes', { unsatisfiable: ['urn:A'] }],
  ])('notices a difference in %s', (_, diff) => {
    expect(compareWithServer(run(), 'r1', run(diff), 'r1')).toBe('differs');
  });
});
