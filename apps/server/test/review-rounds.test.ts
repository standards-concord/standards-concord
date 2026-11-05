import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GovernancePolicy } from '@concord/shared';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { ontologyStore } from '../src/services/ontologyStore.js';

/**
 * Review rounds: what counts after a request is resubmitted or edited, which decisions are refused,
 * and what can still stop a merge. Each test makes its own ontology with a policy it sets, so the demo
 * data doesn't matter. Most of these reproduce findings from the GPT-6 Astra reviews of PR #47.
 */

const app = createApp();
type Agent = ReturnType<typeof request.agent>;
let n = 0;

async function person(role: string): Promise<{ agent: Agent; id: string }> {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/demo').send({ name: `Rounds ${role} ${++n}`, role });
  expect(res.status).toBe(200);
  return { agent, id: res.body.user.id };
}

type Minor = Partial<GovernancePolicy['changes']['minor']>;

/** An ontology whose minor changes need reviewer approvals (one by default), with no review period. */
async function setUp(minor: Minor = {}) {
  const owner = await person('steward');
  const created = await owner.agent.post('/api/ontologies').send({ title: `Rounds ${++n}`, description: 'A vocabulary for testing review rounds.', prefix: `rr${n}`, governanceTemplate: 'steward-led' });
  expect(created.status).toBe(201);
  const id: string = created.body.id;
  const policy = structuredClone(created.body.governance) as GovernancePolicy;
  policy.changes.minor = { ...policy.changes.minor, approverRoles: ['reviewer'], minApprovals: 1, reviewPeriodDays: 0, vetoRoles: ['owner'], autoMerge: true, lazyConsensus: false, vote: undefined, ...minor };
  policy.automation.autoDraftRelease = false;
  expect((await owner.agent.put(`/api/ontologies/${id}/governance`).send({ policy })).status).toBe(200);
  const author = await person('editor');
  const a = await person('reviewer');
  const b = await person('reviewer');
  for (const [p, roles] of [[author, ['editor', 'member']], [a, ['reviewer', 'member']], [b, ['reviewer', 'member']]] as const)
    expect((await owner.agent.put(`/api/ontologies/${id}/members/${p.id}`).send({ roles })).status).toBe(200);
  const cr = await author.agent.post(`/api/ontologies/${id}/change-requests`).send({
    title: 'Add shifts',
    description: 'Coordinators plan in shifts.',
    kind: 'feature',
    ops: [{ op: 'addClass', localName: `Shift${n}`, label: `shift ${n}`, definition: 'A period of time a volunteer is scheduled to work.', altLabels: ['rota slot'] }],
  });
  expect(cr.status).toBe(201);
  expect(cr.body.classification.level).toBe('minor');
  const crId: string = cr.body.id;
  const submitted = await author.agent.post(`/api/change-requests/${crId}/submit`);
  expect(['review', 'voting']).toContain(submitted.body.status);
  return { owner, author, a, b, crId, ops: cr.body.ops };
}

const get = async (p: { agent: Agent }, crId: string) => (await p.agent.get(`/api/change-requests/${crId}`)).body;
/** A review on the round currently stored, unless a round is given. */
const review = async (p: { agent: Agent }, crId: string, decision: string, opts: { comment?: string; round?: number } = {}) => {
  const round = opts.round ?? (await get(p, crId)).round;
  return p.agent.post(`/api/change-requests/${crId}/reviews`).send({ decision, comment: opts.comment, round });
};
const vote = async (p: { agent: Agent }, crId: string, choice: string, round?: number) => {
  const r = round ?? (await get(p, crId)).round;
  return p.agent.post(`/api/change-requests/${crId}/votes`).send({ choice, round: r });
};
const mentions = (cr: { timeline: { message: string }[] }, re: RegExp) => cr.timeline.some((e) => re.test(e.message));

beforeAll(() => {
  openDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('review rounds', () => {
  // Resubmitting without changes used to keep B's approval while dismissing A's request for changes,
  // so the request merged straight away without anyone looking again.
  it('an unchanged resubmission needs fresh reviews: earlier approvals no longer merge it', async () => {
    const { author, a, b, crId } = await setUp();
    expect((await review(a, crId, 'request-changes', { comment: 'Is a shift a session?' })).body.status).toBe('needs-work');
    expect((await review(b, crId, 'approve')).body.status).toBe('needs-work');

    const resubmitted = await author.agent.post(`/api/change-requests/${crId}/submit`);
    expect(resubmitted.status).toBe(200);
    expect(resubmitted.body.status).toBe('review');
    expect(resubmitted.body.round).toBe(2);
    expect(resubmitted.body.governance.approvals).toBe(0);
    expect(resubmitted.body.reviews.filter((r: { stale: boolean }) => r.stale)).toHaveLength(2);
    expect(mentions(resubmitted.body, /earlier approvals and requests for changes no longer count/)).toBe(true);

    // A fresh approval in the new round is what merges it.
    expect((await review(b, crId, 'approve')).body.status).toBe('merged');
  });

  it('a reviewer can approve from Needs work in the same round', async () => {
    const { a, crId } = await setUp({ autoMerge: false });
    expect((await review(a, crId, 'request-changes')).body.status).toBe('needs-work');
    const approved = await review(a, crId, 'approve');
    expect(approved.body.status).toBe('approved');
    expect(approved.body.reviews.some((r: { stale: boolean }) => r.stale)).toBe(false);
  });

  it('an objection stands after a resubmission until the objector changes it', async () => {
    const { author, a, b, crId } = await setUp({ autoMerge: false });
    await review(a, crId, 'object', { comment: 'We already have Session.' });
    expect((await review(b, crId, 'request-changes')).body.status).toBe('needs-work');
    const resubmitted = (await author.agent.post(`/api/change-requests/${crId}/submit`)).body;
    expect(resubmitted.reviews.find((r: { decision: string }) => r.decision === 'object').stale).toBe(false);
    expect(mentions(resubmitted, /an objection stands until withdrawn/)).toBe(true);
  });

  // A request for changes by the author, then a resubmission, used to erase everyone's reviews and votes.
  it('the author can’t request changes to or object to their own edits', async () => {
    const { author, crId } = await setUp();
    for (const decision of ['request-changes', 'object']) {
      const res = await review(author, crId, decision);
      expect(res.status).toBe(403);
      expect(res.body.error ?? res.text).toMatch(/You wrote these edits/);
    }
  });

  // Rewriting the edits to the same effect (a duplicate alias, extra whitespace, an empty list, a field
  // the edit ignores, a blank entry) used to erase the "no" votes, so an author could clear opposition and
  // pass a 75% vote with one "yes". Comparing edits by their effect kept finding new equivalent encodings,
  // so now any change to the edits starts again, but a vote against stands until the voter changes it.
  it('rewriting the edits can’t erase a vote against: a "no" stands, a "yes" is asked again', async () => {
    const { owner, author, a, b, crId, ops } = await setUp({ minApprovals: 0, vote: { voterRoles: ['member'], threshold: 0.75, quorum: 0.5, durationDays: 5 } });
    const c = await person('reviewer');
    expect((await owner.agent.put(`/api/ontologies/${(await get(owner, crId)).ontologyId}/members/${c.id}`).send({ roles: ['reviewer', 'member'] })).status).toBe(200);
    expect((await vote(a, crId, 'no')).status).toBe(200);
    expect((await vote(c, crId, 'yes')).status).toBe(200);
    const op = ops[0];
    let version = 1;
    for (const same of [
      { ...op, altLabels: ['rota slot', 'rota slot'] },
      { ...op, altLabels: ['rota slot', '  '] },
      { ...op, label: `  ${op.label}  ` },
      { ...op, subClassOf: [] },
      { ...op, ignoredByTheEdit: 'anything' },
    ]) {
      const res = await author.agent.patch(`/api/change-requests/${crId}`).send({ ops: [same] });
      expect(res.status).toBe(200);
      expect(res.body.editsVersion, JSON.stringify(same)).toBe(++version);
      expect(res.body.governance.vote.no, JSON.stringify(same)).toBe(1);
      expect(res.body.governance.vote.yes).toBe(0);
    }
    const now = await get(author, crId);
    expect(now.votes.find((v: { userId: string }) => v.userId === a.id).stale).toBe(false);
    expect(now.votes.find((v: { userId: string }) => v.userId === c.id).stale).toBe(true);
    // One "yes" doesn't outvote the standing "no" at 75%.
    const after = (await vote(b, crId, 'yes')).body;
    expect(after.governance.vote.no).toBe(1);
    expect(after.governance.vote.yes).toBe(1);
    expect(after.status).toBe('voting');
    // The voter can still change their mind on the new edits.
    expect((await vote(a, crId, 'yes')).body.governance.vote.no).toBe(0);
  });

  // A resubmission of the same edits used to erase the ballot, "no" votes included.
  it('votes stay with the edits they were cast on: an unchanged resubmission keeps the ballot', async () => {
    const { author, a, b, crId } = await setUp({ minApprovals: 0, vote: { voterRoles: ['member'], threshold: 0.5, quorum: 0.5, durationDays: 5 } });
    expect((await get(author, crId)).status).toBe('voting');
    expect((await vote(a, crId, 'no')).status).toBe(200);
    expect((await review(b, crId, 'request-changes')).body.status).toBe('needs-work');
    const resubmitted = (await author.agent.post(`/api/change-requests/${crId}/submit`)).body;
    expect(resubmitted.status).toBe('voting');
    expect(resubmitted.governance.vote.no).toBe(1);
    expect(resubmitted.votes.every((v: { stale: boolean }) => !v.stale)).toBe(true);
  });

  // An AI revision that changed nothing used to reset everyone's reviews.
  it('the same edits again keep the reviews', async () => {
    const { author, b, crId, ops } = await setUp({ minApprovals: 2 });
    await review(b, crId, 'approve');
    const res = await author.agent.patch(`/api/change-requests/${crId}`).send({ ops });
    expect(res.status).toBe(200);
    expect(res.body.round).toBe(1);
    expect(res.body.governance.approvals).toBe(1);
    const changed = await author.agent.patch(`/api/change-requests/${crId}`).send({ ops: [{ ...ops[0], definition: 'A scheduled block of volunteering time.' }] });
    expect(changed.body.round).toBe(2);
    expect(changed.body.governance.approvals).toBe(0);
  });

  // The comparison by effect called some different edits the same (it sorted lists whose order matters,
  // such as a property's ranges, and its own provenance hid a "source" the edit set), and then silently
  // kept the old edits and their approvals. Any difference is now saved as new edits.
  it('edits that differ in any way are saved as new edits, with a new round', async () => {
    const { author, b, crId, ops } = await setUp({ minApprovals: 2 });
    const op = ops[0];
    let round = 1;
    for (const different of [
      { ...op, altLabels: ['rota slot', 'duty'] },
      { ...op, altLabels: ['duty', 'rota slot'] },
      { ...op, altLabels: ['duty', 'rota slot'], source: ['compare'] },
      Object.fromEntries(Object.entries({ ...op, altLabels: ['duty', 'rota slot'], source: ['compare'] }).reverse()),
    ]) {
      await review(b, crId, 'approve');
      const res = await author.agent.patch(`/api/change-requests/${crId}`).send({ ops: [different] });
      expect(res.status).toBe(200);
      expect(res.body.ops, JSON.stringify(different)).toEqual([different]);
      expect(res.body.round).toBe(++round);
      expect(res.body.governance.approvals).toBe(0);
    }
  });

  // A real edit while in review kept the old review period, so under lazy consensus it could be
  // approved at once with nobody having seen the new edits.
  it('new edits get a review period of their own', async () => {
    const { author, crId, ops } = await setUp({ reviewPeriodDays: 3 });
    const before = await get(author, crId);
    await new Promise((r) => setTimeout(r, 5));
    const changed = (await author.agent.patch(`/api/change-requests/${crId}`).send({ ops: [{ ...ops[0], definition: 'A scheduled block of volunteering time.' }] })).body;
    expect(changed.status).toBe('review');
    expect(Date.parse(changed.governance.reviewPeriodEndsAt)).toBeGreaterThan(Date.parse(before.governance.reviewPeriodEndsAt));
  });

  // A decision made on a page showing an older version used to land in the new round, even when it
  // said which round it was made on.
  it('a decision made on an older version is refused, and the API requires the round', async () => {
    const { author, b, crId, ops } = await setUp({ autoMerge: false });
    await author.agent.patch(`/api/change-requests/${crId}`).send({ ops: [{ ...ops[0], definition: 'A scheduled block of volunteering time.' }] });
    const stale = await review(b, crId, 'approve', { round: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error ?? stale.text).toMatch(/changed since you opened it/);
    const missing = await b.agent.post(`/api/change-requests/${crId}/reviews`).send({ decision: 'approve' });
    expect(missing.status).toBe(400);
    // Comments don't need it.
    expect((await b.agent.post(`/api/change-requests/${crId}/reviews`).send({ decision: 'comment', comment: 'Looking now.' })).status).toBe(200);
    expect((await review(b, crId, 'approve', { round: 2 })).body.status).toBe('approved');
  });

  // A merge that failed because the draft had moved on said earlier approvals no longer counted, but they
  // still did, so a later re-check could return it to Approved without anyone reviewing it again.
  it('a merge that fails on the latest draft really sets the approvals aside', async () => {
    const first = await setUp({ autoMerge: false });
    expect((await review(first.b, first.crId, 'approve')).body.status).toBe('approved');
    // A second request adding the same class to the same ontology, approved too.
    const { ops } = first;
    const dup = await first.author.agent.post(`/api/ontologies/${(await get(first.owner, first.crId)).ontologyId}/change-requests`).send({ title: 'Add shifts again', description: '', kind: 'feature', ops, submit: true });
    expect(dup.status).toBe(201);
    expect((await review(first.b, dup.body.id, 'approve')).body.status).toBe('approved');
    expect((await first.owner.agent.post(`/api/change-requests/${first.crId}/merge`)).body.status).toBe('merged');
    // The second no longer applies on the draft the first merged into.
    const failed = await first.owner.agent.post(`/api/change-requests/${dup.body.id}/merge`);
    const after = await get(first.owner, dup.body.id);
    expect(failed.status === 409 || after.status === 'needs-work').toBe(true);
    expect(after.status).not.toBe('approved');
    expect(after.governance.approvals).toBe(0);
    expect(after.reviews.find((r: { decision: string }) => r.decision === 'approve').stale).toBe(true);
    // Something prompting a re-check (a comment) doesn't bring the approval back.
    expect((await review(first.a, dup.body.id, 'comment', { comment: 'Hmm.' })).body.status).not.toBe('approved');
  });

  // The simulated reviewers used to post the same comment again in the same round, because only
  // reviews that count were checked.
  it('a comment counts as having responded in this round, but not as a review that counts', async () => {
    const { b, crId } = await setUp();
    await review(b, crId, 'comment', { comment: 'Reading it now.' });
    const crs = await import('../src/services/changeRequests.js');
    const cr = crs.getCR(crId);
    expect(crs.hasCurrentReview(cr, b.id)).toBe(false);
    expect(crs.hasRespondedThisRound(cr, b.id)).toBe(true);
  });

  // A veto recorded on an approved request left it approved, and it could still be merged.
  it('a veto after approval rejects the request, and it can no longer be merged', async () => {
    const { owner, b, crId } = await setUp({ autoMerge: false });
    expect((await review(b, crId, 'approve')).body.status).toBe('approved');
    expect((await review(owner, crId, 'object', { comment: 'Not in this ontology.' })).body.status).toBe('rejected');
    expect((await owner.agent.post(`/api/change-requests/${crId}/merge`)).status).toBe(409);
  });

  it('a request for changes after approval sends it back for more work', async () => {
    const { a, b, crId } = await setUp({ autoMerge: false });
    expect((await review(b, crId, 'approve')).body.status).toBe('approved');
    expect((await review(a, crId, 'request-changes')).body.status).toBe('needs-work');
  });

  // When the only approver switched to an ordinary objection, governance said "review" but the
  // request stayed Approved and could be merged.
  it('an approval that no longer holds sends it back to review, and it can’t be merged', async () => {
    const { owner, b, crId } = await setUp({ autoMerge: false });
    expect((await review(b, crId, 'approve')).body.status).toBe('approved');
    const objected = await review(b, crId, 'object', { comment: 'On reflection, no.' });
    expect(objected.body.status).toBe('review');
    expect(objected.body.governance.approvals).toBe(0);
    expect((await owner.agent.post(`/api/change-requests/${crId}/merge`)).status).toBe(409);
  });

  // A veto recorded while a merge was reading the draft was overtaken by the merge, which ended
  // "merged" with the veto on record. Now changes to a request wait for the merge, and land after it.
  it('a merge is never overtaken by a veto: decisions wait for it', async () => {
    const { owner, b, crId } = await setUp({ autoMerge: false });
    expect((await review(b, crId, 'approve')).body.status).toBe('approved');
    const round = (await get(owner, crId)).round;

    const real = ontologyStore.workingAt.bind(ontologyStore);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const spy = vi.spyOn(ontologyStore, 'workingAt').mockImplementationOnce(async (p) => {
      await gate;
      return real(p);
    });
    const merging = owner.agent.post(`/api/change-requests/${crId}/merge`).then((r) => r);
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    const veto = review(owner, crId, 'object', { comment: 'Stop!', round }).then((r) => r);
    release();

    const merged = await merging;
    const vetoed = await veto;
    const final = await get(owner, crId);
    // Whichever lands first, a request is never merged with a veto on record.
    if (final.status === 'merged') {
      expect(merged.body.status).toBe('merged');
      expect(vetoed.status).toBe(409);
      expect(final.governance.vetoedBy).toEqual([]);
    } else {
      expect(final.status).toBe('rejected');
    }
  });
});
