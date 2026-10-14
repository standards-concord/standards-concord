import type { GovernanceEvaluation, User } from '@concord/shared';
import { ArrowRight, CircleCheck, CircleX, Clock, Hourglass, ShieldAlert, Vote as VoteIcon } from 'lucide-react';
import { duration, formatDate, pct, roleLabel } from '../lib/format';
import { useSession } from '../lib/session';
import { useTick } from '../lib/hooks';
import { LevelBadge } from './badges';
import { Badge, ProgressBar, cx } from './ui';

export function GovernancePanel({ g, userById }: { g: GovernanceEvaluation; userById?: (id: string) => User | undefined }) {
  const { now } = useSession();
  useTick(30_000);
  const t = now();
  const reviewEnds = Date.parse(g.reviewPeriodEndsAt);
  const rule = g.rule;
  const v = g.vote;
  const decided = v ? v.yes + v.no : 0;
  const yesShare = decided ? v!.yes / decided : 0;
  const turnout = v && v.eligible ? v.cast / v.eligible : 0;

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        Rules for a <LevelBadge level={g.level} /> change
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

      {/* Vote */}
      {v && rule.vote && (
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
          <p className="mt-2 text-xs text-muted">Voters: {rule.vote.voterRoles.map(roleLabel).join(', ')}</p>
        </div>
      )}

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

      <div className="flex items-center gap-2">
        {g.validationOk ? <CircleCheck className="size-4 text-ok" /> : <CircleX className="size-4 text-danger" />}
        <span>{g.validationOk ? 'Validation passes' : 'Validation must pass before approval'}</span>
      </div>

      {g.unmet.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Still needed</div>
          <ul className="space-y-1">
            {g.unmet.map((u, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warn" />
                {u}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="flex items-start gap-2 rounded-lg bg-accent-soft p-3 text-sm">
        <ArrowRight className="mt-0.5 size-4 shrink-0 text-accent" />
        <span>
          <strong className="font-medium">Next: </strong>
          {g.next}
        </span>
      </p>
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
