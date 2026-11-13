import { expect, it } from 'vitest';
import type { ChangeRequestDetail, Review } from '@concord/shared';
import { changeOutcome } from './changeOutcome';

const at = '2026-11-08T12:00:00Z';
const names = (id?: string) => id ? ({ owner: 'Priya Shah', author: 'Tom Okafor' }[id]) : undefined;
const base = (patch: Partial<ChangeRequestDetail> = {}) => ({
  status: 'rejected', statusSince: at, timeline: [{ type: 'status', at, message: 'rejected: the vote did not pass' }],
  reviews: [], votes: [], governance: { approvedBy: [], vetoedBy: [], rule: { approverRoles: ['steward'], vetoRoles: ['owner'] }, vote: { yes: 0, no: 4, abstain: 0 } },
  ...patch,
} as ChangeRequestDetail);

// A terminal Decision card used to say only "No further action", hiding the decision.
it('gives the vote outcome and date, including abstentions only when present', () => {
  const cr = base();
  expect(changeOutcome(cr, names)).toBe('Rejected by vote on 8 Nov 2026: 0 in favour, 4 against.');
  cr.governance.vote!.abstain = 1;
  expect(changeOutcome(cr, names)).toBe('Rejected by vote on 8 Nov 2026: 0 in favour, 4 against, 1 abstention.');
});

it('names the veto actor and role before any vote tally', () => {
  const cr = base();
  cr.governance.vetoedBy = ['owner'];
  cr.reviews = [{ userId: 'owner', decision: 'object', at, roles: ['owner'] } as Review];
  cr.timeline[0].message = 'rejected (vetoed)';
  expect(changeOutcome(cr, names)).toBe('Rejected by Priya Shah (owner veto) on 8 Nov 2026.');
});

it('credits the owner who objects, not an owner who only requests changes', () => {
  // A request for changes used to take the credit for another owner's veto.
  const cr = base();
  cr.governance.vetoedBy = ['owner'];
  cr.timeline[0].message = 'rejected (vetoed)';
  cr.reviews = [
    { userId: 'author', decision: 'request-changes', at, roles: ['owner'], seq: 1 },
    { userId: 'owner', decision: 'object', at, roles: ['owner'], seq: 2 },
  ] as Review[];
  expect(changeOutcome(cr, names)).toBe('Rejected by Priya Shah (owner veto) on 8 Nov 2026.');
});

it('keeps a failed vote a failed vote when an objector has since been given a veto role', () => {
  // Today's roles used to decide: promote someone who had objected and the vote became their veto.
  const cr = base();
  cr.governance.vetoedBy = ['owner'];
  cr.reviews = [{ userId: 'owner', decision: 'object', at, roles: ['reviewer'] } as Review];
  expect(changeOutcome(cr, names)).toBe('Rejected by vote on 8 Nov 2026: 0 in favour, 4 against.');
});

it('names the objector who held the veto role at the time, whoever holds it now', () => {
  // An earlier objector promoted afterwards used to be named as the person who vetoed.
  const cr = base();
  cr.timeline[0].message = 'rejected (vetoed)';
  cr.reviews = [
    { userId: 'author', decision: 'object', at, roles: ['reviewer'], seq: 1 },
    { userId: 'owner', decision: 'object', at, roles: ['owner'], seq: 2 },
  ] as Review[];
  cr.governance.vetoedBy = ['author', 'owner'];
  expect(changeOutcome(cr, names)).toBe('Rejected by Priya Shah (owner veto) on 8 Nov 2026.');
  // The person who vetoed has since lost the role, and the other objector gained it.
  cr.governance.vetoedBy = ['author'];
  expect(changeOutcome(cr, names)).toBe('Rejected by Priya Shah (owner veto) on 8 Nov 2026.');
});

it('still reads a veto from the evaluator when the decision was never recorded or reviews carry no roles', () => {
  const cr = base({ timeline: [] });
  cr.governance.vetoedBy = ['owner'];
  cr.reviews = [{ userId: 'owner', decision: 'object', at } as Review];
  expect(changeOutcome(cr, names)).toBe('Rejected by Priya Shah (veto) on 8 Nov 2026.');
});

it('names only the sign-offs counted by governance, excluding the author and co-author', () => {
  // The decision named everyone with an approver role, including people who wrote the edits.
  const cr = base({ authorId: 'author', revisedBy: ['co-author'], status: 'merged', timeline: [{ type: 'status', at, message: 'merged into the working draft' }] });
  cr.governance.vote = undefined;
  cr.governance.approvedBy = ['owner'];
  cr.governance.rule.approverRoles = ['steward', 'editor'];
  cr.reviews = [
    { userId: 'author', decision: 'approve', at, roles: ['editor'] },
    { userId: 'co-author', decision: 'approve', at, roles: ['editor'] },
    { userId: 'owner', decision: 'approve', at, roles: ['steward'] },
  ] as Review[];
  expect(changeOutcome(cr, names)).toBe('Merged on 8 Nov 2026 after sign-off from Priya Shah.');
});

it('uses the evaluator’s sign-off list even when other approval reviews remain in the discussion', () => {
  const cr = base({ status: 'merged', timeline: [{ type: 'status', at, message: 'merged into the working draft' }] });
  cr.approvedAs = { level: 'minor', confirmation: false }; // Merged before sign-offs were recorded.
  cr.governance.vote = undefined;
  cr.governance.rule.approverRoles = ['steward', 'editor'];
  cr.governance.approvedBy = ['owner', 'author'];
  cr.reviews = [
    { userId: 'owner', decision: 'approve', at, roles: ['steward'] },
    { userId: 'author', decision: 'approve', at, roles: ['editor'] },
    { userId: 'stale', decision: 'approve', at, roles: ['editor'], stale: true },
    { userId: 'withdrawn', decision: 'approve', at, roles: ['editor'], withdrawnAt: at },
    { userId: 'later', decision: 'approve', at: '2026-11-09T12:00:00Z', roles: ['editor'] },
  ] as Review[];
  expect(changeOutcome(cr, names)).toBe('Merged on 8 Nov 2026 after sign-off from Priya Shah and Tom Okafor.');
  cr.reviews.push({ userId: 'author', decision: 'request-changes', at, seq: 9, roles: ['editor'] } as Review);
  cr.governance.approvedBy = ['owner'];
  expect(changeOutcome(cr, names)).toBe('Merged on 8 Nov 2026 after sign-off from Priya Shah.');
});

it('reads withdrawal and merge dates from history, including after release', () => {
  const cr = base({ status: 'withdrawn', timeline: [{ type: 'status', at, actorId: 'author', message: 'withdrew this request' }] });
  expect(changeOutcome(cr, names)).toBe('Withdrawn by Tom Okafor on 8 Nov 2026.');
  expect(changeOutcome(base({ status: 'review' }), names)).toBeUndefined();
  const released = base({ status: 'released', statusSince: '2026-11-10T12:00:00Z', timeline: [{ type: 'status', at, message: 'merged into the working draft' }] });
  released.governance.vote = undefined;
  expect(changeOutcome(released, names)).toBe('Merged on 8 Nov 2026.');
});

it.each(['merged', 'released'] as const)('opens a previous-version %s payload without sign-off fields', (status) => {
  // Saved details from before approvedBy existed used to crash before the refresh could finish.
  const cr = base({ status, timeline: [{ type: 'status', at, message: 'merged into the working draft' }] });
  const legacy = JSON.parse(JSON.stringify(cr));
  delete legacy.governance.approvedBy;
  delete legacy.approvedAs;
  expect(changeOutcome(legacy, names)).toBe('Merged on 8 Nov 2026.');
  legacy.approvedAs = { level: 'minor', confirmation: false };
  expect(changeOutcome(legacy, names)).toBe('Merged on 8 Nov 2026.');
});

it.each(['merged', 'released'] as const)('keeps the recorded %s sign-offs when live approvals and membership change', (status) => {
  // Live evaluation used to erase autopilot sign-offs on merge and human sign-offs after departure.
  const cr = base({ status, timeline: [{ type: 'status', at, message: 'merged into the working draft' }] });
  cr.governance.vote = undefined;
  cr.approvedAs = { level: 'minor', confirmation: false, approvers: [{ userId: 'owner', name: 'Priya Shah' }] };
  expect(changeOutcome(cr, () => undefined)).toBe('Merged on 8 Nov 2026 after sign-off from Priya Shah.');
  cr.governance.approvedBy = ['author'];
  expect(changeOutcome(cr, names)).toBe('Merged on 8 Nov 2026 after sign-off from Priya Shah.');
  cr.approvedAs.approvers = [];
  expect(changeOutcome(cr, names)).toBe('Merged on 8 Nov 2026.');
});
