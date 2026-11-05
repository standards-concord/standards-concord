import { describe, expect, it } from 'vitest';
import { voteStanding } from './voteStanding';

describe('voteStanding', () => {
  it('a vote on the current edits counts', () => {
    expect(voteStanding({ editsVersion: 2 }, 2)).toBe('current');
    expect(voteStanding({}, undefined)).toBe('current');
  });

  it('a person’s own “no” on earlier edits still counts; a stale vote doesn’t', () => {
    expect(voteStanding({ editsVersion: 1 }, 2)).toBe('earlier-still-counts');
    expect(voteStanding({ editsVersion: 1, stale: true }, 2)).toBe('earlier');
  });

  // An autopilot "no" on earlier edits used to be labelled "earlier edits, still counts" next to its
  // "No longer counts" badge. Governance never counts it: autopilot votes again on new edits.
  it('an autopilot “no” on earlier edits is shown as no longer counting', () => {
    expect(voteStanding({ editsVersion: 1, autopilot: { revision: 'r1', apps: [] } }, 2)).toBe('earlier');
  });
});
