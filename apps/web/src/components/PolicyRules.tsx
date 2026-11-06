import { Link } from 'react-router';
import type { ApprovalRule, ChangeLevel, GovernancePolicy, Role } from '@concord/shared';
import { pct, plural, roleLabel } from '../lib/format';
import { LevelBadge } from './badges';
import { Disclosure } from './Disclosure';
import { acceptedOnSilence } from '../lib/governanceRules';

/** Read-only descriptions of a governance policy, shared by the Governance page and the decision cards. */

const LEVELS: ChangeLevel[] = ['patch', 'minor', 'major'];

/**
 * One plain-language line per rule, following how the server actually evaluates it
 * (services/governance.ts): lazy consensus skips sign-offs and the vote for patch and minor
 * levels unless someone objects, any ODI privilege adds an ODI veto, and "final say" means ODI
 * must approve major changes and releases.
 */
export function ruleSummary(r: ApprovalRule, level: ChangeLevel = 'minor', policy?: Pick<GovernancePolicy, 'odiPrivilege'>, kind: 'change' | 'release' = 'change'): string {
  // Mirrors the server's evaluate(): lazy consensus only waives sign-offs and the vote below major, and
  // only approvals from the listed roles count, so an empty list means nobody can sign off.
  const lazySkips = acceptedOnSilence(r, level);
  const signOffs = r.approverRoles.length ? `${plural(r.minApprovals, 'sign-off')} from ${r.approverRoles.map(roleLabel).join(' or ')}` : `${plural(r.minApprovals, 'sign-off')}, but no role is allowed to give them`;
  const parts: string[] = [];
  if (r.minApprovals > 0) parts.push(lazySkips ? `no sign-off unless someone objects (then ${signOffs})` : signOffs);
  else parts.push('no sign-off needed');
  if (r.reviewPeriodDays > 0) parts.push(`${plural(r.reviewPeriodDays, 'day')} open for comment`);
  if (lazySkips) parts.push('accepted if nobody objects');
  if (r.vote) parts.push(`${lazySkips ? 'a vote only if someone objects' : 'a vote'} (${pct(r.vote.threshold)} in favour, ${pct(r.vote.quorum)} turnout)`);
  const odi = policy && policy.odiPrivilege !== 'none';
  if (odi && policy.odiPrivilege === 'final-say' && level === 'major') parts.push('ODI oversight must approve');
  const veto = [...r.vetoRoles, ...(odi && !r.vetoRoles.includes('odi') ? (['odi'] as Role[]) : [])];
  if (veto.length) parts.push(`${veto.map(roleLabel).join(' or ')} can block it`);
  if (r.autoMerge) parts.push(kind === 'release' ? 'published automatically' : 'merged automatically');
  return parts.join(' · ');
}

export function RuleList({ rules, policy, label, kind = 'change' }: { rules: Record<ChangeLevel, ApprovalRule>; policy: GovernancePolicy; label: string; kind?: 'change' | 'release' }) {
  return (
    <ul className="space-y-1.5 text-sm" aria-label={label}>
      {LEVELS.map((l) => (
        <li key={l} className="flex items-start gap-2">
          <LevelBadge level={l} className="mt-0.5 w-14 shrink-0 justify-center" />
          <span>{ruleSummary(rules[l], l, policy, kind)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Rules that apply to every change and release, whatever its level. */
export function alwaysRules(policy: GovernancePolicy): string[] {
  return [
    policy.odiPrivilege === 'veto' && 'ODI oversight can veto any change or release',
    policy.odiPrivilege === 'final-say' && 'ODI oversight can veto anything and must approve major changes and releases',
    policy.requireValidation && 'changes that fail validation can never be approved',
  ].filter(Boolean) as string[];
}

/**
 * The whole policy, read-only and one click away, where people review, vote and approve. People whose
 * role doesn't need the Governance section still see how every kind of change or release is decided.
 */
export function PolicyGlance({ policy, ontologyId, kind = 'change', title, className = 'border-t border-line pt-3' }: { policy: GovernancePolicy; ontologyId: string; kind?: 'change' | 'release'; title?: string; className?: string }) {
  const always = alwaysRules(policy);
  return (
    <Disclosure tone="muted" title={title ?? `How ${kind === 'release' ? 'releases' : 'changes'} are decided`} summary={policy.name} className={className}>
      <div className="space-y-3">
        <RuleList rules={kind === 'release' ? policy.releases : policy.changes} policy={policy} kind={kind} label={kind === 'release' ? 'What each kind of release needs' : 'What each kind of change needs'} />
        {always.length > 0 && (
          <p className="text-xs text-muted">
            <span className="font-medium text-fg">Always: </span>
            {always.join('; ')}.
          </p>
        )}
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
          <Link to={`/o/${ontologyId}/governance`} className="text-accent hover:underline">
            Read the full policy
          </Link>
          <Link to={`/o/${ontologyId}/governance#roles`} className="text-accent hover:underline">
            Who holds which role
          </Link>
        </p>
      </div>
    </Disclosure>
  );
}
