import { describe, expect, it } from 'vitest';
import type { ApprovalRule, ChangeRequest, GovernancePolicy, Role } from '@concord/shared';
import { askOf } from './asks';

const rule = (r: Partial<ApprovalRule>): ApprovalRule => ({
  approverRoles: ['steward'],
  minApprovals: 1,
  reviewPeriodDays: 0,
  lazyConsensus: false,
  vetoRoles: [],
  autoMerge: false,
  ...r,
});

// The shape of the built-in working-group policy: editors and reviewers approve minor changes,
// and a major change goes to a vote of members, editors, reviewers and stewards.
const policy = {
  odiPrivilege: 'none',
  changes: {
    patch: rule({ approverRoles: ['editor', 'steward'], autoMerge: true }),
    minor: rule({ approverRoles: ['editor', 'reviewer', 'steward'] }),
    major: rule({ vote: { voterRoles: ['member', 'editor', 'reviewer', 'steward'], quorum: 0.5, threshold: 2 / 3, durationDays: 7 } }),
  },
} as unknown as GovernancePolicy;

const cr = (status: ChangeRequest['status'], level: 'patch' | 'minor' | 'major', authorId = 'someone') =>
  ({ status, authorId, classification: { level } }) as unknown as ChangeRequest;
const ask = (c: ChangeRequest, roles: Role[], me = 'me', p: GovernancePolicy = policy, admin = false) => askOf(c, p, roles, me, admin);

describe('askOf', () => {
  it('asks the roles the policy lets vote, and nobody else', () => {
    expect(ask(cr('voting', 'major'), ['editor'])).toBe('Vote on');
    expect(ask(cr('voting', 'major'), ['reviewer'])).toBe('Vote on');
    expect(ask(cr('voting', 'major'), ['member'])).toBe('Vote on');
    // The server rejects an owner's vote when owners are not voters.
    expect(ask(cr('voting', 'major'), ['owner'])).toBeUndefined();
    expect(ask(cr('voting', 'major'), ['contributor'])).toBeUndefined();
  });

  it('asks the approver roles of the change’s level to review, but never its author', () => {
    expect(ask(cr('review', 'minor'), ['reviewer'])).toBe('Review');
    expect(ask(cr('review', 'patch'), ['reviewer'])).toBeUndefined();
    expect(ask(cr('review', 'minor', 'me'), ['editor'])).toBeUndefined();
  });

  it('asks editors, stewards and owners to merge unless the policy merges automatically', () => {
    expect(ask(cr('approved', 'minor'), ['owner'])).toBe('Merge');
    expect(ask(cr('approved', 'minor'), ['editor'])).toBe('Merge');
    expect(ask(cr('approved', 'minor'), ['member'])).toBeUndefined();
    expect(ask(cr('approved', 'patch'), ['editor'])).toBeUndefined();
  });

  it('asks the author, or an editor, to revise work sent back', () => {
    expect(ask(cr('needs-work', 'minor', 'me'), ['contributor'])).toBe('Revise');
    expect(ask(cr('needs-work', 'minor'), ['editor'])).toBe('Revise');
    expect(ask(cr('needs-work', 'minor'), ['member'])).toBeUndefined();
  });

  it('asks everyone whose review can change the outcome: vetoes, ODI oversight and the chair', () => {
    // An owner with a veto, under a policy where owners do not approve.
    const ownerVeto = { ...policy, changes: { ...policy.changes, minor: rule({ approverRoles: ['reviewer'], vetoRoles: ['owner'] }) } } as GovernancePolicy;
    expect(ask(cr('review', 'minor'), ['owner'], 'me', ownerVeto)).toBe('Review');
    // The ODI's veto applies to every level once the policy gives it a privilege.
    const odiVeto = { ...policy, odiPrivilege: 'veto' } as GovernancePolicy;
    expect(ask(cr('review', 'minor'), ['odi'], 'me', odiVeto)).toBe('Review');
    expect(ask(cr('review', 'minor'), ['odi'])).toBeUndefined();
    // Final say: an ODI approval is needed for major changes even when ODI is not an approver role.
    const finalSay = { ...policy, odiPrivilege: 'final-say', changes: { ...policy.changes, major: rule({ approverRoles: ['steward'] }) } } as GovernancePolicy;
    expect(ask(cr('review', 'major'), ['odi'], 'me', finalSay)).toBe('Review');
    // The steward chairs every review, approver or not.
    expect(ask(cr('review', 'patch'), ['steward'])).toBe('Review');
  });

  it('asks platform administrators to merge and revise, as the server allows, but not to vote', () => {
    expect(ask(cr('approved', 'minor'), [], 'me', policy, true)).toBe('Merge');
    expect(ask(cr('needs-work', 'minor'), [], 'me', policy, true)).toBe('Revise');
    expect(ask(cr('voting', 'major'), [], 'me', policy, true)).toBeUndefined();
  });

  it('asks nothing while triage runs', () => {
    expect(ask(cr('triage', 'minor'), ['steward', 'owner'])).toBeUndefined();
  });
});
