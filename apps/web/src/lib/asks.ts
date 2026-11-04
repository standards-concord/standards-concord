import type { ApprovalRule, ChangeRequest, GovernancePolicy, Role } from '@concord/shared';

/**
 * The rule that governs a change at this level, with the ODI's privilege applied. This mirrors
 * effectiveRule() in apps/server/src/services/governance.ts: keep the two in step.
 */
function effectiveRule(policy: GovernancePolicy, cr: ChangeRequest): ApprovalRule {
  const base = policy.changes[cr.classification?.level ?? 'minor'];
  if (policy.odiPrivilege === 'none' || base.vetoRoles.includes('odi')) return base;
  return { ...base, vetoRoles: [...base.vetoRoles, 'odi'] };
}

/** Roles whose review can change a change request's outcome (governance.ts evaluate()). */
export function reviewerRoles(policy: GovernancePolicy, cr: ChangeRequest): Role[] {
  const rule = effectiveRule(policy, cr);
  const odiFinalSay = policy.odiPrivilege === 'final-say' && (cr.classification?.level ?? 'minor') === 'major';
  // Approvals count from approverRoles, objections from vetoRoles block, an ODI approval is needed
  // under final say, and the steward chairs every review.
  return [...new Set<Role>([...rule.approverRoles, ...rule.vetoRoles, ...(odiFinalSay ? (['odi'] as Role[]) : []), 'steward'])];
}

/**
 * What a change at this stage needs from this person, if anything, by the ontology's own policy:
 * the same rules the server enforces (services/changeRequests.ts) and the detail page offers.
 * Platform administrators can merge and revise anything, as the server allows, but only vote or
 * review through the roles they hold.
 */
export function askOf(cr: ChangeRequest, policy: GovernancePolicy, roles: Role[], me?: string, isAdmin = false): string | undefined {
  const rule = effectiveRule(policy, cr);
  const has = (allowed: Role[]) => allowed.some((r) => roles.includes(r));
  const canEdit = isAdmin || has(['editor', 'steward', 'owner']);
  if (cr.status === 'voting') return rule.vote && has(rule.vote.voterRoles) ? 'Vote on' : undefined;
  if (cr.status === 'review') return cr.authorId !== me && has(reviewerRoles(policy, cr)) ? 'Review' : undefined;
  if (cr.status === 'approved') return !rule.autoMerge && canEdit ? 'Merge' : undefined;
  if (cr.status === 'needs-work') return cr.authorId === me || canEdit ? 'Revise' : undefined;
  return undefined;
}
