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
  changes: {
    patch: rule({ approverRoles: ['editor', 'steward'], autoMerge: true }),
    minor: rule({ approverRoles: ['editor', 'reviewer', 'steward'] }),
    major: rule({ vote: { voterRoles: ['member', 'editor', 'reviewer', 'steward'], quorum: 0.5, threshold: 2 / 3, durationDays: 7 } }),
  },
} as unknown as GovernancePolicy;

const cr = (status: ChangeRequest['status'], level: 'patch' | 'minor' | 'major', authorId = 'someone') =>
  ({ status, authorId, classification: { level } }) as unknown as ChangeRequest;
const ask = (c: ChangeRequest, roles: Role[], me = 'me') => askOf(c, policy, roles, me);

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

  it('asks nothing while triage runs', () => {
    expect(ask(cr('triage', 'minor'), ['steward', 'owner'])).toBeUndefined();
  });
});
