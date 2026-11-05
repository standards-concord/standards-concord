import { canCastVote, type ApprovalRule, type ChangeRequest, type GovernancePolicy, type Membership, type Review, type Role } from '@concord/shared';

/**
 * The rule that governs a change at this level, with the ODI's privilege applied. This mirrors
 * effectiveRule() in apps/server/src/services/governance.ts: keep the two in step.
 */
function effectiveRule(policy: GovernancePolicy, cr: ChangeRequest): ApprovalRule {
  const base = policy.changes[cr.classification?.level ?? 'minor'];
  if (policy.odiPrivilege === 'none' || base.vetoRoles.includes('odi')) return base;
  return { ...base, vetoRoles: [...base.vetoRoles, 'odi'] };
}

/** Whether the ODI must approve this change before it can pass (governance.ts evaluate()). */
export function needsOdiApproval(policy: GovernancePolicy, cr: ChangeRequest): boolean {
  return policy.odiPrivilege === 'final-say' && (cr.classification?.level ?? 'minor') === 'major';
}

const roleOf = (members: Membership[], userId: string) => members.find((m) => m.userId === userId)?.roles ?? [];

/**
 * Whether someone who holds the ODI role has approved the current edits. As on the server, only each
 * person's latest decision since the edits last changed counts, and roles are read from today's members.
 */
export function odiApproved(reviews: Pick<Review, 'userId' | 'decision' | 'at'>[], members: Membership[], since: string): boolean {
  const latest = new Map<string, string>();
  for (const r of [...reviews].sort((a, b) => a.at.localeCompare(b.at))) if (r.decision !== 'comment' && r.at >= since) latest.set(r.userId, r.decision);
  return [...latest].some(([userId, decision]) => decision === 'approve' && roleOf(members, userId).includes('odi'));
}

const REVIEW_VERBS: Record<string, Review['decision']> = { approved: 'approve', 'requested changes': 'request-changes', objected: 'object' };

/**
 * The same check for a change request in a list, which carries its timeline but not its reviews.
 * The server writes each review into the timeline as "approved", "requested changes" or "objected".
 */
export function odiApprovedFromTimeline(cr: ChangeRequest, members: Membership[]): boolean {
  const reviews = (cr.timeline ?? []).flatMap((e) => {
    if (e.type !== 'review' || !e.actorId) return [];
    const verb = Object.keys(REVIEW_VERBS).find((v) => e.message.startsWith(v));
    return verb ? [{ userId: e.actorId, decision: REVIEW_VERBS[verb], at: e.at }] : [];
  });
  return odiApproved(reviews, members, cr.opsUpdatedAt ?? cr.createdAt ?? '');
}

export interface AskContext {
  /** The person's roles in this ontology. */
  roles: Role[];
  me?: string;
  /** Platform administrators can merge and revise anything, as the server allows. */
  isAdmin?: boolean;
  /** Whether the ODI has already approved the current edits (see odiApproved). */
  odiApproved?: boolean;
}

/**
 * What a change at this stage needs from this person, if anything, by the ontology's own policy:
 * the same rules the server enforces (services/changeRequests.ts) and the detail page offers.
 * Any member can review, and any member's request for changes or objection can change the
 * outcome, so every member but the author is asked to review. Administrators only vote or review
 * through the roles they hold.
 */
export function askOf(cr: ChangeRequest, policy: GovernancePolicy, { roles, me, isAdmin = false, odiApproved = false }: AskContext): string | undefined {
  const rule = effectiveRule(policy, cr);
  const has = (allowed: Role[]) => allowed.some((r) => roles.includes(r));
  const canEdit = isAdmin || has(['editor', 'steward', 'owner']);
  if (cr.status === 'voting') {
    // The vote can open before the ODI approves, but it cannot pass without that approval.
    if (needsOdiApproval(policy, cr) && !odiApproved && has(['odi'])) return 'Approve';
    return rule.vote && canCastVote(roles, rule.vote.voterRoles) ? 'Vote on' : undefined;
  }
  if (cr.status === 'review') return cr.authorId !== me && roles.length > 0 ? 'Review' : undefined;
  if (cr.status === 'approved') return !rule.autoMerge && canEdit ? 'Merge' : undefined;
  if (cr.status === 'needs-work') return cr.authorId === me || canEdit ? 'Revise' : undefined;
  return undefined;
}
