import type { ReactNode } from 'react';
import type { GovernanceEvaluation, User } from '@concord/shared';
import { ArrowRight, CircleCheck, CircleX, Clock, Hourglass, ShieldAlert, Vote as VoteIcon } from 'lucide-react';
import { duration, formatDate, pct, roleLabel } from '../lib/format';
import { useSession } from '../lib/session';
import { useTick } from '../lib/hooks';
import { LevelBadge } from './badges';
import { Badge, ProgressBar, cx } from './ui';
import { Disclosure } from './Disclosure';

export function GovernancePanel({
  g,
  userById,
  actions,
  detailsOpen,
  subject = 'change',
}: {
  g: GovernanceEvaluation;
  userById?: (id: string) => User | undefined;
  /** The viewer's available actions, shown with the blockers and next step rather than in a separate card. */
  actions?: ReactNode;
  /** Show the approval detail straight away, e.g. when the panel itself is already behind a disclosure. */
  detailsOpen?: boolean;
  subject?: 'change' | 'release';
}) {
  const { now } = useSession();
  useTick(30_000);
  const t = now();
  const reviewEnds = Date.parse(g.reviewPeriodEndsAt);
  const rule = g.rule;
  const v = g.vote;
  const decided = v ? v.yes + v.no : 0;
  const yesShare = decided ? v!.yes / decided : 0;
  const turnout = v && v.eligible ? v.cast / v.eligible : 0;

  const glance = [
    g.requiredApprovals > 0 && `${g.approvals} of ${g.requiredApprovals} approvals`,
    rule.reviewPeriodDays > 0 && (g.reviewPeriodOver ? 'review period over' : Number.isNaN(reviewEnds) ? undefined : `review ends in ${duration(reviewEnds - t)}`),
    v && rule.vote && (v.open ? `vote open, ${v.cast} of ${v.eligible} voted` : 'vote not open'),
  ].filter(Boolean);

  const voteArithmetic =
    v && rule.vote ? (
      <div className="space-y-2.5 text-xs">
        <div>
          <div className="mb-1 flex justify-between">
            <span>
              Turnout {v.cast}/{v.eligible} {v.quorumMet ? <CircleCheck className="inline size-3 text-ok" /> : null}
            </span>
            <span className="text-muted">quorum {pct(rule.vote.quorum)}</span>
          </div>
          <ProgressBar value={turnout} marker={rule.vote.quorum} tone={v.quorumMet ? 'ok' : 'accent'} />
        </div>
        <div>
          <div className="mb-1 flex justify-between">
            <span>
              In favour {pct(yesShare)} {v.thresholdMet ? <CircleCheck className="inline size-3 text-ok" /> : null}
            </span>
            <span className="text-muted">threshold {pct(rule.vote.threshold)}</span>
          </div>
          <ProgressBar value={yesShare} marker={rule.vote.threshold} tone={v.thresholdMet ? 'ok' : 'warn'} />
        </div>
      </div>
    ) : null;

  const voteBox =
    v && rule.vote ? (
      <div className="rounded-lg border border-line p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 font-medium">
            <VoteIcon className="size-4 text-muted" /> Vote {v.open ? <Badge tone="accent">Open</Badge> : v.closesAt && Date.parse(v.closesAt) < t ? <Badge>Closed</Badge> : <Badge tone="outline">Not open yet</Badge>}
          </span>
          {v.open && v.closesAt && (
            <span className="flex items-center gap-1 text-xs text-muted">
              <Clock className="size-3.5" /> closes in {duration(Date.parse(v.closesAt) - t)}
            </span>
          )}
        </div>
        <div className="mb-3 grid grid-cols-3 gap-2 text-center">
          <Tally label="Yes" n={v.yes} cls="text-ok" />
          <Tally label="No" n={v.no} cls="text-danger" />
          <Tally label="Abstain" n={v.abstain} cls="text-muted" />
        </div>
        {v.open ? (
          <Disclosure tone="muted" title={<span className="text-xs">Turnout and threshold</span>} summary={`${v.quorumMet ? 'quorum met' : 'quorum not met'}, ${v.thresholdMet ? 'threshold met' : 'threshold not met'}`}>
            {voteArithmetic}
          </Disclosure>
        ) : (
          voteArithmetic
        )}
        <p className="mt-2 text-xs text-muted">Voters: {rule.vote.voterRoles.map(roleLabel).join(', ')}</p>
      </div>
    ) : null;

  // What happens next, and what is missing, come first; the arithmetic is one click away.
  return (
    <div className="space-y-4 text-sm">
      <p className="flex items-start gap-2 rounded-lg bg-accent-soft p-3 text-sm">
        <ArrowRight className="mt-0.5 size-4 shrink-0 text-accent" />
        <span>
          <strong className="font-medium">Next: </strong>
          {humaniseDates(g.next)}
        </span>
      </p>

      {/* Vetoes */}
      {g.vetoedBy.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg bg-danger-soft p-3 text-danger">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <div>
            <div className="font-medium">Blocked by objection</div>
            <div className="text-xs">{g.vetoedBy.map((u) => userById?.(u)?.name ?? u).join(', ')}</div>
          </div>
        </div>
      )}

      {!g.validationOk && (
        <div className="flex items-center gap-2">
          {g.validationOk ? <CircleCheck className="size-4 text-ok" /> : <CircleX className="size-4 text-danger" />}
          <span>{g.validationOk ? 'Validation passes' : 'Validation must pass before approval'}</span>
        </div>
      )}
      {g.unmet.length > 0 && (
        <div>
          <div className="mb-1 text-sm font-semibold">Still needed</div>
          <ul className="space-y-1">
            {g.unmet.map((u, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warn" />
                {humaniseDates(u)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {v?.open && voteBox}

      {actions && (
        <div className="border-t border-line pt-4" role="group" aria-label="Your actions">
          <div className="mb-2 text-sm font-semibold">Your actions</div>
          {actions}
        </div>
      )}

      <Disclosure title="Approval details" summary={glance.join(' · ')} summaryPlacement="below" tone="muted" defaultOpen={detailsOpen}>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            Rules for a <LevelBadge level={g.level} /> {subject}
            {rule.lazyConsensus && <Badge tone="accent">Lazy consensus</Badge>}
            {rule.autoMerge && <Badge tone="outline">Auto-merge</Badge>}
          </div>

          {/* Approvals */}
          {g.requiredApprovals > 0 && (
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="font-medium">Approvals</span>
                <span className={cx('tabular-nums', g.approvals >= g.requiredApprovals ? 'text-ok' : 'text-muted')}>
                  {g.approvals} / {g.requiredApprovals}
                </span>
              </div>
              <ProgressBar value={g.approvals / g.requiredApprovals} tone={g.approvals >= g.requiredApprovals ? 'ok' : 'accent'} />
              <p className="mt-1 text-xs text-muted">From: {rule.approverRoles.map(roleLabel).join(', ') || 'anyone'}</p>
            </div>
          )}

          {/* Review period */}
          {rule.reviewPeriodDays > 0 && (
            <div className="flex items-start gap-2">
              {g.reviewPeriodOver ? <CircleCheck className="mt-0.5 size-4 text-ok" /> : <Hourglass className="mt-0.5 size-4 text-accent" />}
              <div>
                <div className="font-medium">Review period ({rule.reviewPeriodDays} day{rule.reviewPeriodDays === 1 ? '' : 's'})</div>
                <div className="text-xs text-muted">
                  {g.reviewPeriodOver || Number.isNaN(reviewEnds)
                    ? `Ended ${formatDate(g.reviewPeriodEndsAt, true)}`
                    : `${duration(reviewEnds - t)} left · ends ${formatDate(g.reviewPeriodEndsAt, true)}`}
                  {rule.lazyConsensus && !g.reviewPeriodOver && ' — approved automatically if nobody objects'}
                </div>
              </div>
            </div>
          )}

          {v && !v.open && voteBox}

          <div className="flex items-center gap-2">
            {g.validationOk ? <CircleCheck className="size-4 text-ok" /> : <CircleX className="size-4 text-danger" />}
            <span>{g.validationOk ? 'Validation passes' : 'Validation must pass before approval'}</span>
          </div>

        </div>
      </Disclosure>
    </div>
  );
}

function Tally({ label, n, cls }: { label: string; n: number; cls: string }) {
  return (
    <div className="rounded-md bg-surface-2 py-1.5">
      <div className={cx('text-lg font-semibold tabular-nums', cls)}>{n}</div>
      <div className="text-[0.7rem] text-muted">{label}</div>
    </div>
  );
}

/** Server messages carry raw ISO timestamps ("until 2026-11-07T15:33:35.245Z"); show them as dates. */
function humaniseDates(text: string) {
  return text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (iso) => formatDate(iso, true));
}
