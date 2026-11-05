import { describe, expect, it } from 'vitest';
import type { Review, Vote } from '@concord/shared';
import { reviewsInRound, votesOnEdits } from '../src/services/governance.js';

/**
 * Which reviews count in a change request's current round. Regression: resubmitting used to leave
 * the old "request changes" counting, so the request bounced straight back to Needs work; and the
 * first fix used times as the cutoff, which misplaced reviews made in the same millisecond or under
 * a clock that moved back. The API-level tests are in review-rounds.test.ts, the browser test in
 * e2e/change-requests.spec.ts.
 */

let i = 0;
const rev = (userId: string, decision: Review['decision'], round: number, at = `2026-03-01T10:00:${String(i++).padStart(2, '0')}Z`) =>
  ({ id: `r${i}`, changeRequestId: 'cr', userId, roles: ['reviewer'], decision, at, round }) as Review & { round: number };
const count = (reviews: (Review & { round: number })[], round: number) => {
  const { counted, stale } = reviewsInRound(reviews, round, (r) => r.round);
  return { counted: counted.map((r) => `${r.userId}:${r.decision}`).sort(), stale: reviews.filter((r) => stale.has(r.id)).map((r) => `${r.userId}:${r.decision}`) };
};

describe('reviews in a round', () => {
  it('counts each person’s latest decision in the current round', () => {
    expect(count([rev('a', 'request-changes', 1), rev('a', 'approve', 1), rev('b', 'approve', 1)], 1).counted).toEqual(['a:approve', 'b:approve']);
  });

  it('approvals and requests for changes from an earlier round are stale', () => {
    const r = count([rev('a', 'request-changes', 1), rev('b', 'approve', 1)], 2);
    expect(r.counted).toEqual([]);
    expect(r.stale).toEqual(['a:request-changes', 'b:approve']);
  });

  it('an objection stands across rounds until the objector changes it', () => {
    expect(count([rev('a', 'object', 1)], 3).counted).toEqual(['a:object']);
    expect(count([rev('a', 'object', 1), rev('a', 'approve', 2)], 2).counted).toEqual(['a:approve']);
  });

  it('orders by round, not time: a later round wins even if the clock went back', () => {
    const r = count([rev('a', 'approve', 1, '2026-03-02T00:00:00Z'), rev('a', 'request-changes', 2, '2026-03-01T00:00:00Z')], 2);
    expect(r.counted).toEqual(['a:request-changes']);
  });

  it('a review made in the same millisecond as the resubmission still belongs to its own round', () => {
    const at = '2026-03-01T12:00:00.000Z';
    expect(count([rev('a', 'request-changes', 1, at)], 2).counted).toEqual([]);
    expect(count([rev('a', 'request-changes', 2, at)], 2).counted).toEqual(['a:request-changes']);
  });

  // Within a round, an owner's approval followed (after the clock moved back) by their veto used to
  // pick the approval, because it had the later time.
  it('orders decisions within a round by their sequence, not the clock', () => {
    const approve = { ...rev('a', 'approve', 1, '2026-03-02T00:00:00Z'), seq: 1 };
    const veto = { ...rev('a', 'object', 1, '2026-03-01T00:00:00Z'), seq: 2 };
    expect(count([approve, veto], 1).counted).toEqual(['a:object']);
  });

  it('comments never count and are never stale', () => {
    const r = count([rev('a', 'comment', 1)], 2);
    expect(r.counted).toEqual([]);
    expect(r.stale).toEqual([]);
  });
});

/**
 * Which votes count on the current edits. Regression: rewriting the edits to the same effect used to
 * erase "no" votes, so an author could clear opposition before a threshold vote.
 */
const vote = (userId: string, choice: Vote['choice'], editsVersion: number, seq: number) =>
  ({ id: `v${seq}`, subjectType: 'change-request', subjectId: 'cr', userId, roles: ['member'], choice, at: '2026-03-01T10:00:00Z', editsVersion, seq }) as Vote & { editsVersion: number };
const tally = (votes: (Vote & { editsVersion: number })[], version: number) => {
  const { counted, stale } = votesOnEdits(votes, version, (v) => v.editsVersion);
  return { counted: counted.map((v) => `${v.userId}:${v.choice}`).sort(), stale: votes.filter((v) => stale.has(v.id)).map((v) => `${v.userId}:${v.choice}`) };
};

describe('votes on the edits', () => {
  it('a "no" stands when the edits change; "yes" and "abstain" are asked again', () => {
    const r = tally([vote('a', 'no', 1, 1), vote('b', 'yes', 1, 2), vote('c', 'abstain', 1, 3)], 2);
    expect(r.counted).toEqual(['a:no']);
    expect(r.stale).toEqual(['b:yes', 'c:abstain']);
  });

  it('only the latest vote can stand: a "no" changed to "yes" doesn’t come back when the edits change', () => {
    expect(tally([vote('a', 'no', 1, 1), vote('a', 'yes', 1, 2)], 2).counted).toEqual([]);
  });

  it('a vote on the new edits replaces a standing "no"', () => {
    expect(tally([vote('a', 'no', 1, 1), vote('a', 'yes', 2, 2)], 2).counted).toEqual(['a:yes']);
  });
});
