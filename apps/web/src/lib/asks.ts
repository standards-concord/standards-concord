import type { ChangeRequest, GovernancePolicy, Role } from '@concord/shared';

/**
 * What a change at this stage needs from this person, if anything, by the ontology's own policy:
 * the same rules the server enforces (services/changeRequests.ts) and the detail page offers.
 */
export function askOf(cr: ChangeRequest, policy: GovernancePolicy, roles: Role[], me?: string): string | undefined {
  const rule = policy.changes[cr.classification?.level ?? 'minor'];
  const has = (allowed: Role[]) => allowed.some((r) => roles.includes(r));
  if (cr.status === 'voting') return rule.vote && has(rule.vote.voterRoles) ? 'Vote on' : undefined;
  if (cr.status === 'review') return cr.authorId !== me && has(rule.approverRoles) ? 'Review' : undefined;
  if (cr.status === 'approved') return !rule.autoMerge && has(['editor', 'steward', 'owner']) ? 'Merge' : undefined;
  if (cr.status === 'needs-work') return cr.authorId === me || has(['editor', 'steward', 'owner']) ? 'Revise' : undefined;
  return undefined;
}
