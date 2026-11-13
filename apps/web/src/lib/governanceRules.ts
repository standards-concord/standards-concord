import type { ApprovalRule, ChangeLevel, Role } from '@concord/shared';

/** The release page and Overview use the same permission to offer publication. */
export function canPublishRelease(roles: readonly Role[], isAdmin = false): boolean {
  return isAdmin || roles.some((r) => r === 'steward' || r === 'owner');
}

/**
 * Whether silence decides it: under lazy consensus, a patch or minor change (or release) with no objections
 * needs no sign-off and no vote once its review period ends. Major levels always need their sign-offs and
 * vote. Mirrors evaluate() in apps/server/src/services/governance.ts.
 */
export function acceptedOnSilence(rule: Pick<ApprovalRule, 'lazyConsensus'>, level: ChangeLevel): boolean {
  return rule.lazyConsensus && level !== 'major';
}
