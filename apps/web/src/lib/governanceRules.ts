import type { ApprovalRule, ChangeLevel } from '@concord/shared';

/**
 * Whether silence decides it: under lazy consensus, a patch or minor change (or release) with no objections
 * needs no sign-off and no vote once its review period ends. Major levels always need their sign-offs and
 * vote. Mirrors evaluate() in apps/server/src/services/governance.ts.
 */
export function acceptedOnSilence(rule: Pick<ApprovalRule, 'lazyConsensus'>, level: ChangeLevel): boolean {
  return rule.lazyConsensus && level !== 'major';
}
