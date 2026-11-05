import type {
  ApprovalRule,
  ChangeLevel,
  ChangeRequestStatus,
  GovernanceEvaluation,
  GovernancePolicy,
  GovernanceTemplateId,
  Membership,
  Review,
  Role,
  Vote,
} from '@concord/shared';
import { addDays } from '../clock.js';

/* ------------------------------------------------------------------------ */
/* Policy templates (the "drop-down of ways to govern")                      */
/* ------------------------------------------------------------------------ */

const rule = (r: Partial<ApprovalRule>): ApprovalRule => ({
  approverRoles: ['steward', 'editor', 'reviewer'],
  minApprovals: 1,
  reviewPeriodDays: 0,
  lazyConsensus: false,
  vetoRoles: ['owner'],
  autoMerge: true,
  ...r,
});

const vote = (threshold: number, quorum: number, durationDays: number, voterRoles: Role[] = ['member']) => ({
  voterRoles,
  threshold,
  quorum,
  durationDays,
});

const automation = { autoTriage: true, autoDraftRelease: true, reminders: true };

export const GOVERNANCE_TEMPLATES: Record<GovernanceTemplateId, GovernancePolicy> = {
  'steward-led': {
    templateId: 'steward-led',
    name: 'Steward-led',
    description:
      'A small editorial team moves quickly. Editors fix typos alone, two reviewers sign off new terms, and breaking changes go to a members vote. Good for early drafts.',
    changes: {
      patch: rule({ approverRoles: ['steward', 'editor'], minApprovals: 1, reviewPeriodDays: 0 }),
      minor: rule({ minApprovals: 2, reviewPeriodDays: 2 }),
      major: rule({ approverRoles: ['steward'], minApprovals: 1, reviewPeriodDays: 5, vote: vote(0.5, 0.5, 5) }),
    },
    releases: {
      patch: rule({ approverRoles: ['steward'], minApprovals: 1 }),
      minor: rule({ approverRoles: ['steward'], minApprovals: 1 }),
      major: rule({ approverRoles: ['steward', 'owner'], minApprovals: 1, vote: vote(0.5, 0.5, 5) }),
    },
    ownership: { model: 'single', transfer: 'owner-decides' },
    odiPrivilege: 'none',
    automation,
    requireValidation: true,
  },
  'lazy-consensus': {
    templateId: 'lazy-consensus',
    name: 'Lazy consensus (Apache / IETF style)',
    description:
      'Silence is consent. A change is accepted once its comment period ends with no objections. Any objection turns it into a vote, so nobody has to be pulled into a meeting.',
    changes: {
      patch: rule({ minApprovals: 0, reviewPeriodDays: 1, lazyConsensus: true, vetoRoles: [] , vote: vote(0.5, 0.25, 3, ['member', 'editor', 'reviewer'])}),
      minor: rule({ minApprovals: 0, reviewPeriodDays: 3, lazyConsensus: true, vetoRoles: [], vote: vote(0.5, 0.25, 5, ['member', 'editor', 'reviewer']) }),
      major: rule({ minApprovals: 1, reviewPeriodDays: 7, lazyConsensus: true, vetoRoles: ['owner'], vote: vote(2 / 3, 0.5, 7, ['member', 'editor', 'reviewer']) }),
    },
    releases: {
      patch: rule({ approverRoles: ['steward'], minApprovals: 0, lazyConsensus: true, reviewPeriodDays: 1, vetoRoles: [] }),
      minor: rule({ approverRoles: ['steward'], minApprovals: 0, lazyConsensus: true, reviewPeriodDays: 3, vetoRoles: [] }),
      major: rule({ approverRoles: ['steward'], minApprovals: 1, reviewPeriodDays: 7, vote: vote(2 / 3, 0.5, 7, ['member', 'editor', 'reviewer']) }),
    },
    ownership: { model: 'group', transfer: 'member-vote' },
    odiPrivilege: 'none',
    automation,
    requireValidation: true,
  },
  'working-group': {
    templateId: 'working-group',
    name: 'Working group (W3C style)',
    description:
      'Editors and reviewers do the detailed work; a chair (steward) confirms consensus, and breaking changes and major releases need a two-thirds working group vote with quorum.',
    changes: {
      patch: rule({ approverRoles: ['editor', 'steward'], minApprovals: 1, reviewPeriodDays: 1 }),
      minor: rule({ approverRoles: ['editor', 'reviewer', 'steward'], minApprovals: 2, reviewPeriodDays: 7 }),
      major: rule({ approverRoles: ['steward'], minApprovals: 1, reviewPeriodDays: 14, vote: vote(2 / 3, 0.5, 7, ['member', 'editor', 'reviewer', 'steward']) }),
    },
    releases: {
      patch: rule({ approverRoles: ['steward'], minApprovals: 1 }),
      minor: rule({ approverRoles: ['steward'], minApprovals: 1, reviewPeriodDays: 3 }),
      major: rule({ approverRoles: ['steward'], minApprovals: 1, reviewPeriodDays: 7, vote: vote(2 / 3, 0.5, 7, ['member', 'editor', 'reviewer', 'steward']) }),
    },
    ownership: { model: 'group', transfer: 'member-vote' },
    odiPrivilege: 'none',
    automation,
    requireValidation: true,
  },
  'membership-vote': {
    templateId: 'membership-vote',
    name: 'Membership vote',
    description:
      'Every new term and every breaking change is put to the membership. Slower, but every member has a direct say. Editors can still fix typos on their own.',
    changes: {
      patch: rule({ approverRoles: ['editor', 'steward'], minApprovals: 1 }),
      minor: rule({ approverRoles: ['reviewer', 'editor'], minApprovals: 1, reviewPeriodDays: 3, vote: vote(0.5, 0.33, 5) }),
      major: rule({ approverRoles: ['reviewer', 'editor'], minApprovals: 1, reviewPeriodDays: 7, vote: vote(2 / 3, 0.5, 7) }),
    },
    releases: {
      patch: rule({ approverRoles: ['steward'], minApprovals: 1 }),
      minor: rule({ approverRoles: ['steward'], minApprovals: 1, vote: vote(0.5, 0.33, 5) }),
      major: rule({ approverRoles: ['steward'], minApprovals: 1, vote: vote(2 / 3, 0.5, 7) }),
    },
    ownership: { model: 'group', transfer: 'member-vote' },
    odiPrivilege: 'none',
    automation,
    requireValidation: true,
  },
  'odi-stewarded': {
    templateId: 'odi-stewarded',
    name: 'ODI stewarded',
    description:
      'For standards the ODI stewards through the hub. The community works as in steward-led, and ODI oversight can veto any change and must approve major changes, releases and ownership transfers.',
    changes: {
      patch: rule({ approverRoles: ['steward', 'editor'], minApprovals: 1 }),
      minor: rule({ minApprovals: 2, reviewPeriodDays: 3, vetoRoles: ['owner', 'odi'] }),
      major: rule({ approverRoles: ['steward', 'odi'], minApprovals: 2, reviewPeriodDays: 7, vetoRoles: ['owner', 'odi'], vote: vote(0.5, 0.5, 7) }),
    },
    releases: {
      patch: rule({ approverRoles: ['steward'], minApprovals: 1 }),
      minor: rule({ approverRoles: ['steward', 'odi'], minApprovals: 1 }),
      major: rule({ approverRoles: ['odi'], minApprovals: 1, vetoRoles: ['odi'], vote: vote(0.5, 0.5, 7) }),
    },
    ownership: { model: 'single', transfer: 'odi-approval' },
    odiPrivilege: 'final-say',
    automation,
    requireValidation: true,
  },
};

export const listTemplates = () => Object.values(GOVERNANCE_TEMPLATES).map((t) => structuredClone(t));
export const template = (id: GovernanceTemplateId | undefined) =>
  structuredClone(GOVERNANCE_TEMPLATES[id ?? 'steward-led'] ?? GOVERNANCE_TEMPLATES['steward-led']);

/* ------------------------------------------------------------------------ */
/* Evaluation                                                                */
/* ------------------------------------------------------------------------ */

export interface EvalInput {
  policy: GovernancePolicy;
  level: ChangeLevel;
  kind: 'change' | 'release';
  status: ChangeRequestStatus | 'draft' | 'voting' | 'published' | 'rejected';
  /** When the subject entered its current status. */
  statusSince: string;
  /** When review started (for change requests: when it entered 'review'). */
  reviewStartedAt: string;
  authorId: string;
  /** Others who wrote the current edits; their approvals don't count either. */
  coAuthorIds?: string[];
  reviews: Review[];
  votes: Vote[];
  members: Membership[];
  validationOk: boolean;
  now: Date;
  /**
   * Set when the change needs someone other than the author to sign it off
   * whatever the policy says (e.g. a reworded definition, whose meaning must
   * be confirmed unchanged): lazy consensus or zero-approval rules then need one.
   */
  independentConfirmation?: string;
  /** Users who are simulated personas; not used for logic, just passed through. */
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const roleList = (roles: Role[]) => roles.join(', ');

/** Effective rule after applying the ODI privilege setting. */
export function effectiveRule(policy: GovernancePolicy, level: ChangeLevel, kind: 'change' | 'release'): ApprovalRule {
  const base = structuredClone(kind === 'change' ? policy.changes[level] : policy.releases[level]);
  if (policy.odiPrivilege !== 'none' && !base.vetoRoles.includes('odi')) base.vetoRoles.push('odi');
  return base;
}

/**
 * Order of decisions: by the sequence number a change request gives each review and vote, which the
 * clock can't disturb; older ones without it (and releases' votes) by time, before any that have one.
 */
export const decisionOrder = (a: { seq?: number; at: string }, b: { seq?: number; at: string }) => (a.seq ?? 0) - (b.seq ?? 0) || a.at.localeCompare(b.at);

/**
 * Which reviews of a change request count in its current round, and which are stale.
 *
 * Each person's latest decision counts if it was given in the current round. A round moves on when the
 * author resubmits or the edits change, so approvals and requests for changes from an earlier round stop
 * counting and the reviewer is asked again (as GitHub dismisses stale reviews). An objection is different:
 * it is a formal position the author can't dismiss, so it stands until the objector changes their review.
 */
export function reviewsInRound<T extends Review>(reviews: T[], round: number, roundOf: (r: T) => number): { counted: T[]; stale: Set<string> } {
  const ordered = reviews.map((r, i) => ({ r, i, n: roundOf(r) })).sort((a, b) => a.n - b.n || decisionOrder(a.r, b.r) || a.i - b.i);
  const latest = new Map<string, { r: T; n: number }>();
  for (const x of ordered) if (x.r.decision !== 'comment') latest.set(x.r.userId, x);
  const counted = [...latest.values()].filter((x) => x.n === round || x.r.decision === 'object').map((x) => x.r);
  const keep = new Set(counted.map((r) => r.id));
  const stale = new Set(ordered.filter((x) => x.r.decision !== 'comment' && x.n !== round && !keep.has(x.r.id)).map((x) => x.r.id));
  return { counted, stale };
}

/**
 * Which votes count on a change request's current edits. A vote is on the edits it was cast on, so when
 * the edits change, "yes" and "abstain" stop counting and the voter is asked again. A "no" stands until
 * the voter changes it, like an objection: otherwise rewriting the edits, even to the same effect, would
 * be a way for an author to erase opposition. Only each person's latest vote can count.
 */
export function votesOnEdits<T extends Vote>(votes: T[], editsVersion: number, versionOf: (v: T) => number): { counted: T[]; stale: Set<string> } {
  const ordered = votes.map((v, i) => ({ v, i, n: versionOf(v) })).sort((a, b) => a.n - b.n || decisionOrder(a.v, b.v) || a.i - b.i);
  const latest = new Map<string, { v: T; n: number }>();
  for (const x of ordered) latest.set(x.v.userId, x);
  const counted = [...latest.values()].filter((x) => x.n === editsVersion || x.v.choice === 'no').map((x) => x.v);
  const keep = new Set(counted.map((v) => v.id));
  const stale = new Set(ordered.filter((x) => x.n !== editsVersion && !keep.has(x.v.id)).map((x) => x.v.id));
  return { counted, stale };
}

/** Latest review per person (a later approval supersedes an earlier request for changes). */
function latestReviews(reviews: Review[]): Review[] {
  const byUser = new Map<string, Review>();
  for (const r of [...reviews].sort(decisionOrder)) {
    if (r.decision === 'comment') continue;
    byUser.set(r.userId, r);
  }
  return [...byUser.values()];
}

function rolesOf(members: Membership[], userId: string): Role[] {
  return members.find((m) => m.userId === userId)?.roles ?? [];
}

export function evaluate(input: EvalInput): GovernanceEvaluation {
  const { policy, level, kind, members, now } = input;
  const r = effectiveRule(policy, level, kind);
  const unmet: string[] = [];

  const latest = latestReviews(input.reviews);
  const approverRoles: Role[] = r.approverRoles.length ? r.approverRoles : ['owner', 'steward', 'editor', 'reviewer'];
  const writers = new Set([input.authorId, ...(input.coAuthorIds ?? [])]);
  const counts = (rev: Review) => !writers.has(rev.userId) && rolesOf(members, rev.userId).some((role) => approverRoles.includes(role));
  const approvals = latest.filter((rev) => rev.decision === 'approve' && counts(rev)).length;

  const odiFinalSay = policy.odiPrivilege === 'final-say' && level === 'major';
  const odiApproved = latest.some((rev) => rev.decision === 'approve' && rolesOf(members, rev.userId).includes('odi'));

  const vetoedBy = latest
    .filter((rev) => (rev.decision === 'object' || rev.decision === 'request-changes') && rolesOf(members, rev.userId).some((role) => r.vetoRoles.includes(role)))
    .filter((rev) => rev.decision === 'object')
    .map((rev) => rev.userId);
  const objections = latest.filter((rev) => rev.decision === 'object' && !vetoedBy.includes(rev.userId));
  const changesRequested = latest.filter((rev) => rev.decision === 'request-changes');
  // A standing vote against is opposition too (it outlasts new edits, see votesOnEdits), so lazy consensus
  // mustn't read it as silence: like an objection, it sends the change to a vote.
  const lastVote = new Map<string, Vote>();
  for (const v of [...input.votes].sort(decisionOrder)) lastVote.set(v.userId, v);
  const votesAgainst = [...lastVote.values()].filter((v) => v.choice === 'no' && members.some((m) => m.userId === v.userId));
  const opposed = objections.length > 0 || votesAgainst.length > 0;
  const opposition = objections.length ? 'An objection was raised' : 'A vote against stands';

  const reviewPeriodEndsAt = addDays(input.reviewStartedAt, r.reviewPeriodDays);
  const reviewPeriodOver = now.getTime() >= new Date(reviewPeriodEndsAt).getTime();
  const policyApprovals = r.lazyConsensus && !opposed ? Math.min(r.minApprovals, level === 'major' ? r.minApprovals : 0) : r.minApprovals;
  const requiredApprovals = input.independentConfirmation ? Math.max(policyApprovals, 1) : policyApprovals;
  const validationOk = !policy.requireValidation || input.validationOk;

  // Votes
  let voteState: GovernanceEvaluation['vote'];
  let voteNeeded = !!r.vote;
  // Lazy consensus without opposition skips the vote for non-major changes.
  if (r.vote && r.lazyConsensus && !opposed && level !== 'major') voteNeeded = false;
  if (r.vote && voteNeeded) {
    const eligibleIds = members
      .filter((m) => m.roles.some((role) => r.vote!.voterRoles.includes(role)) && !m.roles.every((x) => x === 'agent'))
      .map((m) => m.userId);
    const latestVotes = new Map<string, Vote>();
    for (const v of [...input.votes].sort(decisionOrder)) if (eligibleIds.includes(v.userId)) latestVotes.set(v.userId, v);
    const vs = [...latestVotes.values()];
    const yes = vs.filter((v) => v.choice === 'yes').length;
    const no = vs.filter((v) => v.choice === 'no').length;
    const abstain = vs.filter((v) => v.choice === 'abstain').length;
    const cast = vs.length;
    const eligible = eligibleIds.length;
    const open = input.status === 'voting';
    const opensAt = open ? input.statusSince : undefined;
    const closesAt = open ? addDays(input.statusSince, r.vote.durationDays) : undefined;
    voteState = {
      open,
      opensAt,
      closesAt,
      eligible,
      cast,
      yes,
      no,
      abstain,
      quorumMet: eligible > 0 && cast / eligible >= r.vote.quorum - 1e-9,
      thresholdMet: yes + no > 0 && yes / (yes + no) >= r.vote.threshold - 1e-9,
    };
  }

  let outcome: ChangeRequestStatus = (input.status as ChangeRequestStatus) ?? 'review';
  let next = '';

  const terminal = ['merged', 'released', 'rejected', 'withdrawn', 'published', 'draft'];
  if (terminal.includes(input.status)) {
    next =
      input.status === 'draft'
        ? 'The author needs to submit this for review.'
        : input.status === 'merged'
          ? 'Waiting to be included in the next release.'
          : 'No further action.';
  } else if (vetoedBy.length) {
    outcome = 'rejected';
    unmet.push(`Vetoed by a holder of a veto role (${roleList(r.vetoRoles)}).`);
    next = 'This change was vetoed. The author can revise it and submit a new request.';
  } else if (!validationOk) {
    outcome = 'needs-work';
    unmet.push('Validation must pass: the ontology must stay consistent with no lint errors.');
    next = 'Fix the validation errors (or ask the AI to revise the change).';
  } else if (changesRequested.length) {
    outcome = 'needs-work';
    unmet.push(`${changesRequested.length} reviewer(s) requested changes.`);
    next = 'The author should revise the change; reviewers can then re-approve.';
  } else if (input.status === 'voting' && voteState) {
    const closed = voteState.closesAt ? now.getTime() >= new Date(voteState.closesAt).getTime() : false;
    const everyoneVoted = voteState.cast >= voteState.eligible && voteState.eligible > 0;
    if (!voteState.quorumMet) unmet.push(`Quorum: ${voteState.cast}/${voteState.eligible} have voted, ${pct(r.vote!.quorum)} needed.`);
    if (!voteState.thresholdMet) unmet.push(`Threshold: ${pct(r.vote!.threshold)} of yes/no votes must be yes.`);
    if (closed || everyoneVoted) {
      outcome = voteState.quorumMet && voteState.thresholdMet && (!odiFinalSay || odiApproved) ? 'approved' : 'rejected';
      if (odiFinalSay && !odiApproved) unmet.push('ODI oversight must approve major changes.');
      next = outcome === 'approved' ? 'The vote passed.' : 'The vote did not pass.';
    } else {
      outcome = 'voting';
      next = `Voting closes ${voteState.closesAt}. ${voteState.eligible - voteState.cast} eligible voter(s) have not voted yet.`;
    }
  } else {
    // review (or triage / needs-work being re-evaluated)
    if (!reviewPeriodOver) unmet.push(`Review period: open for comment until ${reviewPeriodEndsAt}.`);
    if (approvals < requiredApprovals)
      unmet.push(
        `Approvals: ${approvals}/${requiredApprovals} from ${roleList(approverRoles)} (not the author or anyone who rewrote the edits).${requiredApprovals > policyApprovals && input.independentConfirmation ? ` ${input.independentConfirmation}` : ''}`,
      );
    if (odiFinalSay && !odiApproved) unmet.push('ODI oversight must approve major changes.');
    const reviewDone = reviewPeriodOver && approvals >= requiredApprovals && (!odiFinalSay || odiApproved || voteNeeded);
    if (reviewDone) {
      if (voteNeeded) {
        outcome = 'voting';
        next = r.lazyConsensus && opposed ? `${opposition}, so this goes to a vote.` : 'Review is complete, so the vote opens now.';
      } else {
        outcome = 'approved';
        next = r.lazyConsensus && approvals === 0 ? 'No objections were raised during the comment period (lazy consensus).' : 'Approved by reviewers.';
      }
    } else {
      outcome = 'review';
      if (opposed && r.lazyConsensus) next = `${opposition}; it will go to a vote when the comment period ends.`;
      else if (approvals < requiredApprovals) next = `Needs ${requiredApprovals - approvals} more approval(s) from ${roleList(approverRoles)}.`;
      else next = `Waiting for the review period to end (${reviewPeriodEndsAt}).`;
    }
  }

  return {
    rule: r,
    level,
    approvals,
    requiredApprovals,
    reviewPeriodEndsAt,
    reviewPeriodOver,
    vote: voteState,
    vetoedBy,
    validationOk,
    outcome,
    unmet,
    next,
  };
}

/** Who may act on a subject, for UI hints and API checks. */
export function canApprove(rule: ApprovalRule, roles: Role[]) {
  return roles.some((r) => rule.approverRoles.includes(r) || rule.vetoRoles.includes(r));
}
export function canVote(rule: ApprovalRule, roles: Role[]) {
  return !!rule.vote && roles.some((r) => rule.vote!.voterRoles.includes(r));
}
