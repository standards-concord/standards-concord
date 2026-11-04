import type { GovernanceEvaluation, User, Vote } from '@concord/shared';
import { CircleCheck, CircleX, ShieldAlert } from 'lucide-react';
import { formatDate, pct, roleLabel } from '../lib/format';
import { acceptedOnSilence } from '../lib/governanceRules';
import { LevelBadge } from './badges';
import { cx } from './ui';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const humaniseDates = (text: string) => text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (iso) => formatDate(iso, true));

/** The evaluator's "still needed" lines, put in the past tense: in a record they're what was missing, not instructions. */
export function pastTense(text: string) {
  return humaniseDates(text)
    .replace(/\bmust stay\b/g, 'had to stay')
    .replace(/\bmust (pass|be|approve)\b/g, 'had to $1')
    .replace(/\bhave voted\b/g, 'had voted')
    .replace(/\bneeded\b/g, 'was needed')
    .replace(/^Review period: open for comment until/, 'Review period: still open for comment until');
}

/**
 * A finished decision, read-only: the outcome, the rules that applied, the votes and who cast them.
 * Unlike GovernancePanel it never says what happens next and has no countdowns, because nothing is
 * pending any more. Use it for anything already decided (a published or rejected release).
 */
export function ApprovalRecord({
  g,
  outcome,
  decidedAt,
  votes = [],
  userById,
  subject = 'release',
  timing = 'recorded',
}: {
  g: GovernanceEvaluation;
  outcome: 'approved' | 'rejected';
  decidedAt?: string;
  votes?: Vote[];
  userById?: (id: string) => User | undefined;
  subject?: 'change' | 'release';
  /** `unavailable` for a decision re-checked against today's policy: its review and vote dates weren't kept, so none are shown. */
  timing?: 'recorded' | 'unavailable';
}) {
  const rule = g.rule;
  const v = g.vote;
  const name = (id: string) => userById?.(id)?.name ?? id;
  const decided = v ? v.yes + v.no : 0;
  const approved = outcome === 'approved';
  // Only votes cast up to the decision belong to it, and only each person's last one counts (as in the tally).
  const latest = new Map<string, Vote>();
  for (const x of votes.filter((x) => !decidedAt || x.at <= decidedAt).sort((a, b) => a.at.localeCompare(b.at))) latest.set(x.userId, x);
  const cast = [...latest.values()];
  const datesKnown = timing === 'recorded';
  const reasons = outcome === 'rejected' ? g.unmet : [];

  return (
    <div className="space-y-4 text-sm" data-testid="approval-record">
      <p className={cx('flex items-center gap-2 font-medium', approved ? 'text-ok' : 'text-danger')}>
        {approved ? <CircleCheck className="size-4" aria-hidden /> : <CircleX className="size-4" aria-hidden />}
        {approved ? 'Approved' : 'Rejected'}
        {decidedAt && <span className="font-normal text-muted">on {formatDate(decidedAt, true)}</span>}
      </p>

      {reasons.length > 0 && (
        <div>
          <h4 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Why it was rejected</h4>
          <ul className="space-y-1" aria-label="Why it was rejected">
            {reasons.map((u, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-danger" aria-hidden />
                {pastTense(u)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {g.vetoedBy.length > 0 && (
        <p className="flex items-start gap-2 rounded-lg bg-danger-soft p-3 text-danger">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>Objected to by {g.vetoedBy.map(name).join(', ')}</span>
        </p>
      )}

      <div>
        <h4 className="mb-2 flex flex-wrap items-center gap-2 text-xs font-semibold tracking-wide text-muted uppercase">
          Rules applied to this <LevelBadge level={g.level} /> {subject}
        </h4>
        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-xs">
          <dt className="text-muted">Approvals</dt>
          <dd>
            {g.requiredApprovals > 0
              ? `${g.approvals} of ${g.requiredApprovals} needed, from ${rule.approverRoles.map(roleLabel).join(', ') || 'no role (the policy named no approvers)'}`
              : 'None needed'}
          </dd>
          <dt className="text-muted">Review period</dt>
          <dd>
            {rule.reviewPeriodDays <= 0
              ? 'None'
              : !datesKnown
                ? `${plural(rule.reviewPeriodDays, 'day')} (the actual review dates weren’t recorded)`
                : g.reviewPeriodOver
                  ? `${plural(rule.reviewPeriodDays, 'day')}, ended ${formatDate(g.reviewPeriodEndsAt, true)}`
                  : `${plural(rule.reviewPeriodDays, 'day')}, not over at the decision (it was due to end ${formatDate(g.reviewPeriodEndsAt, true)})`}
            {acceptedOnSilence(rule, g.level) && ' (accepted if nobody objected)'}
          </dd>
          <dt className="text-muted">Vote</dt>
          <dd>
            {rule.vote
              ? `${rule.vote.voterRoles.map(roleLabel).join(', ')}; quorum ${pct(rule.vote.quorum)}, ${pct(rule.vote.threshold)} in favour, over ${plural(rule.vote.durationDays, 'day')}`
              : 'None needed at this level'}
          </dd>
        </dl>
      </div>

      {v && rule.vote && (
        <div>
          <h4 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Vote result</h4>
          <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-xs">
            <dt className="text-muted">Votes</dt>
            <dd>
              {v.yes} yes, {v.no} no, {v.abstain} abstain
            </dd>
            <dt className="text-muted">Turnout</dt>
            <dd>
              {v.cast} of {v.eligible} eligible ({v.quorumMet ? 'quorum met' : 'quorum not met'})
            </dd>
            <dt className="text-muted">In favour</dt>
            <dd>
              {decided ? pct(v.yes / decided) : 'no yes or no votes'} ({v.thresholdMet ? 'threshold met' : 'threshold not met'})
            </dd>
            {datesKnown && v.opensAt && (
              <>
                <dt className="text-muted">Voting opened</dt>
                <dd>{formatDate(v.opensAt, true)}</dd>
              </>
            )}
          </dl>
          {cast.length > 0 && (
            <ul className="mt-3 divide-y divide-line text-xs" aria-label="Who voted">
              {cast.map((x) => (
                <li key={x.id} className="flex flex-wrap justify-between gap-2 py-1.5">
                  <span>
                    <span className="font-medium">{name(x.userId)}</span> voted {x.choice}
                  </span>
                  <span className="text-muted">{formatDate(x.at, true)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
