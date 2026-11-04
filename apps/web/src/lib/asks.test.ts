import { describe, expect, it } from 'vitest';
import type { ApprovalRule, ChangeRequest, GovernancePolicy, Membership, Role } from '@concord/shared';
import { askOf, odiApproved, odiApprovedFromTimeline } from './asks';

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
const ask = (c: ChangeRequest, roles: Role[], me = 'me', p: GovernancePolicy = policy, isAdmin = false, odi = false) =>
  askOf(c, p, { roles, me, isAdmin, odiApproved: odi });

describe('askOf', () => {
  it('asks the roles the policy lets vote, and nobody else', () => {
    expect(ask(cr('voting', 'major'), ['editor'])).toBe('Vote on');
    expect(ask(cr('voting', 'major'), ['reviewer'])).toBe('Vote on');
    expect(ask(cr('voting', 'major'), ['member'])).toBe('Vote on');
    // The server rejects an owner's vote when owners are not voters.
    expect(ask(cr('voting', 'major'), ['owner'])).toBeUndefined();
    expect(ask(cr('voting', 'major'), ['contributor'])).toBeUndefined();
    // Someone who only acts as an agent is never counted, so is never asked, even when agents are listed.
    const agents = { ...policy, changes: { ...policy.changes, major: rule({ vote: { voterRoles: ['member', 'agent'], quorum: 0.5, threshold: 0.5, durationDays: 7 } }) } } as GovernancePolicy;
    expect(ask(cr('voting', 'major'), ['agent'], 'me', agents)).toBeUndefined();
    expect(ask(cr('voting', 'major'), ['agent', 'member'], 'me', agents)).toBe('Vote on');
  });

  it('asks every member but the author to review, since any member’s objection or request for changes counts', () => {
    expect(ask(cr('review', 'minor'), ['reviewer'])).toBe('Review');
    // Not an approver of patches, but a request for changes would still send the change back.
    expect(ask(cr('review', 'patch'), ['reviewer'])).toBe('Review');
    expect(ask(cr('review', 'minor'), ['member'])).toBe('Review');
    expect(ask(cr('review', 'minor'), ['contributor'])).toBe('Review');
    expect(ask(cr('review', 'minor', 'me'), ['editor'])).toBeUndefined();
    // The server only takes reviews from members.
    expect(ask(cr('review', 'minor'), [])).toBeUndefined();
    expect(ask(cr('review', 'minor'), [], 'me', policy, true)).toBeUndefined();
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

  it('keeps asking the ODI to approve a major change under final say while the vote runs', () => {
    const finalSay = { ...policy, odiPrivilege: 'final-say', changes: { ...policy.changes, major: rule({ approverRoles: ['steward'], vote: { voterRoles: ['member'], quorum: 0.5, threshold: 0.5, durationDays: 7 } }) } } as GovernancePolicy;
    expect(ask(cr('voting', 'major'), ['odi'], 'me', finalSay)).toBe('Approve');
    expect(ask(cr('voting', 'major'), ['odi', 'member'], 'me', finalSay)).toBe('Approve');
    // Once the ODI has approved, a voter is asked to vote and the ODI is not asked again.
    expect(ask(cr('voting', 'major'), ['odi'], 'me', finalSay, false, true)).toBeUndefined();
    expect(ask(cr('voting', 'major'), ['odi', 'member'], 'me', finalSay, false, true)).toBe('Vote on');
    // Only final say over a major change needs the ODI's approval.
    expect(ask(cr('voting', 'major'), ['odi'], 'me', { ...finalSay, odiPrivilege: 'veto' } as GovernancePolicy)).toBeUndefined();
    expect(ask(cr('voting', 'major'), ['member'], 'me', finalSay)).toBe('Vote on');
  });

  it('reads the ODI’s approval from each person’s latest decision since the edits changed', () => {
    const members = [
      { userId: 'odi1', roles: ['odi'] },
      { userId: 'm1', roles: ['member'] },
    ] as Membership[];
    const at = (n: number) => `2026-11-04T10:0${n}:00.000Z`;
    expect(odiApproved([{ userId: 'odi1', decision: 'approve', at: at(2) }], members, at(1))).toBe(true);
    // An approval from before the edits changed no longer counts.
    expect(odiApproved([{ userId: 'odi1', decision: 'approve', at: at(0) }], members, at(1))).toBe(false);
    // A later request for changes replaces the approval; a comment does not.
    expect(odiApproved([{ userId: 'odi1', decision: 'approve', at: at(2) }, { userId: 'odi1', decision: 'request-changes', at: at(3) }], members, at(1))).toBe(false);
    expect(odiApproved([{ userId: 'odi1', decision: 'approve', at: at(2) }, { userId: 'odi1', decision: 'comment', at: at(3) }], members, at(1))).toBe(true);
    // Someone without the ODI role cannot give it.
    expect(odiApproved([{ userId: 'm1', decision: 'approve', at: at(2) }], members, at(1))).toBe(false);

    const listed = (timeline: ChangeRequest['timeline']) => ({ createdAt: at(0), timeline }) as unknown as ChangeRequest;
    expect(odiApprovedFromTimeline(listed([{ type: 'review', actorId: 'odi1', at: at(2), message: 'approved: “Fine by us”' }]), members)).toBe(true);
    expect(odiApprovedFromTimeline(listed([{ type: 'review', actorId: 'odi1', at: at(2), message: 'approved' }, { type: 'review', actorId: 'odi1', at: at(3), message: 'objected' }]), members)).toBe(false);
    // A status change to "approved" is not anyone's review.
    expect(odiApprovedFromTimeline(listed([{ type: 'status', actorId: 'odi1', at: at(2), message: 'approved — Approved by reviewers.' }]), members)).toBe(false);
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
