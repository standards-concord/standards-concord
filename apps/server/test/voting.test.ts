import { describe, expect, it } from 'vitest';
import { canCastVote, type GovernancePolicy, type Membership, type Role, type Vote } from '@concord/shared';
import { canVote, evaluate, template } from '../src/services/governance.js';

const ROLES: Role[] = ['owner', 'steward', 'editor', 'reviewer', 'member', 'contributor', 'agent', 'odi'];
const subsets = <T>(xs: T[]): T[][] => xs.reduce<T[][]>((acc, x) => acc.concat(acc.map((s) => [...s, x])), [[]]);

/** A major change under a policy that lets these roles vote, with one yes vote from someone holding `roles`. */
function tally(voterRoles: Role[], roles: Role[]) {
  const base = template('working-group') as GovernancePolicy;
  const policy: GovernancePolicy = { ...base, odiPrivilege: 'none', changes: { ...base.changes, major: { ...base.changes.major, vote: { voterRoles, quorum: 0, threshold: 0.5, durationDays: 7 } } } };
  const members: Membership[] = [{ userId: 'voter', roles } as Membership];
  const votes: Vote[] = [{ id: 'v1', subjectType: 'change-request', subjectId: 'cr', userId: 'voter', roles, choice: 'yes', at: '2026-11-01T00:00:00.000Z' }];
  const g = evaluate({ policy, level: 'major', kind: 'change', status: 'voting', statusSince: '2026-11-01T00:00:00.000Z', reviewStartedAt: '2026-10-25T00:00:00.000Z', authorId: 'author', reviews: [], votes, members, validationOk: true, now: new Date('2026-11-02T00:00:00.000Z') });
  return g.vote!.cast;
}

describe('vote eligibility', () => {
  it('never accepts a vote from someone who only acts as an agent, even when agents are listed as voters', () => {
    expect(canCastVote(['agent'], ['member', 'agent'])).toBe(false);
    expect(canCastVote(['agent', 'member'], ['member', 'agent'])).toBe(true);
    expect(canCastVote([], ['member'])).toBe(false);
    expect(tally(['member', 'agent'], ['agent'])).toBe(0);
  });

  it('accepts exactly the votes the tally counts, for every voter-role and membership combination', () => {
    const mismatches: string[] = [];
    for (const voterRoles of subsets(ROLES))
      for (const roles of subsets(ROLES).filter((r) => r.length)) {
        const accepted = canCastVote(roles, voterRoles);
        const counted = tally(voterRoles, roles) === 1;
        const offered = canVote({ vote: { voterRoles, quorum: 0, threshold: 0.5, durationDays: 7 } } as never, roles);
        if (accepted !== counted || offered !== accepted) mismatches.push(`${roles.join('+')} under [${voterRoles.join(', ')}]`);
      }
    expect(mismatches).toEqual([]);
  });
});
