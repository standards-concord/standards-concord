import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { ChangeRequestStatus, LifecycleStage, OntologySummary } from '@concord/shared';
import { Check, CircleAlert, CircleCheck, CircleDashed } from 'lucide-react';
import { pct, plural } from '../lib/format';
import { Popover } from './Disclosure';
import { cx } from './ui';

/**
 * "Where are we?" bubbles: a short label (e.g. Maintenance) that opens the full process
 * with the current step highlighted. They replace always-visible steppers and badge rows.
 */

export interface PhaseStep {
  id: string;
  label: string;
  hint: string;
}

type BubbleTone = 'accent' | 'ok' | 'warn' | 'danger' | 'neutral';
const BUBBLE: Record<BubbleTone, string> = {
  accent: 'bg-accent-soft text-accent hover:brightness-95',
  ok: 'bg-ok-soft text-ok hover:brightness-95',
  warn: 'bg-warn-soft text-warn hover:brightness-95',
  danger: 'bg-danger-soft text-danger hover:brightness-95',
  neutral: 'bg-surface-2 text-muted hover:text-fg',
};

export function PhaseBubble({
  label,
  title,
  steps,
  current,
  tone = 'accent',
  note,
  footer,
  ariaLabel,
  align,
}: {
  label: ReactNode;
  /** Heading inside the panel. */
  title: string;
  steps: PhaseStep[];
  /** Index of the current step; -1 when the process ended outside the normal flow. */
  current: number;
  tone?: BubbleTone;
  note?: ReactNode;
  footer?: ReactNode;
  ariaLabel: string;
  align?: 'left' | 'right';
}) {
  return (
    <Popover
      label={ariaLabel}
      align={align}
      className={cx('ui-badge px-2.5 py-0.5 text-xs font-medium', BUBBLE[tone])}
      trigger={
        <>
          <span className={cx('size-1.5 rounded-full', tone === 'neutral' ? 'bg-muted' : 'bg-current')} aria-hidden />
          {label}
        </>
      }
    >
      <h4 className="mb-3 text-xs font-semibold tracking-wide text-muted uppercase">{title}</h4>
      <ol className="relative space-y-3">
        {steps.map((s, i) => {
          const done = i < current;
          const here = i === current;
          return (
            <li key={s.id} className="flex gap-3" aria-current={here ? 'step' : undefined}>
              <span
                className={cx(
                  'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[0.65rem] font-semibold',
                  done ? 'border-accent bg-accent text-accent-fg' : here ? 'border-accent bg-accent-soft text-accent ring-2 ring-accent/25' : 'border-line-strong text-subtle',
                )}
              >
                {done ? <Check className="size-3" /> : i + 1}
              </span>
              <div className="min-w-0">
                <div className={cx('text-sm', here ? 'font-semibold' : done ? 'text-fg' : 'text-muted')}>
                  <span>{s.label}</span>
                  {here && <span className="ml-2 rounded bg-accent-soft px-1.5 py-0.5 text-[0.65rem] font-semibold text-accent">Now</span>}
                </div>
                <div className="text-xs text-muted">{s.hint}</div>
              </div>
            </li>
          );
        })}
      </ol>
      {note && <div className="mt-3 rounded-lg bg-surface-2 p-2.5 text-xs">{note}</div>}
      {footer && <div className="mt-3 border-t border-line pt-3 text-xs">{footer}</div>}
    </Popover>
  );
}

/* ------------------------------------------------------------ Ontology lifecycle */

export const LIFECYCLE: (PhaseStep & { id: LifecycleStage })[] = [
  { id: 'discovery', label: 'Discovery', hint: 'Gathering use cases and competency questions' },
  { id: 'drafting', label: 'Drafting', hint: 'Turning requirements into classes and properties' },
  { id: 'review', label: 'Review', hint: 'Community review of the first version' },
  { id: 'released', label: 'Released', hint: 'A published version exists' },
  { id: 'maintenance', label: 'Maintenance', hint: 'Governed changes and periodic releases' },
];

export function LifecycleBubble({ stage, align }: { stage: LifecycleStage; align?: 'left' | 'right' }) {
  const retired = stage === 'retired';
  const idx = retired ? LIFECYCLE.length : LIFECYCLE.findIndex((s) => s.id === stage);
  const label = retired ? 'Retired' : (LIFECYCLE[idx]?.label ?? stage);
  return (
    <PhaseBubble
      label={label}
      ariaLabel={`Lifecycle stage: ${label}. Show the full process`}
      title="Where this ontology is in its lifecycle"
      steps={LIFECYCLE}
      current={idx}
      tone={retired ? 'neutral' : 'accent'}
      align={align}
      note={retired ? 'This ontology is retired: it is kept for reference and no longer changes.' : undefined}
    />
  );
}

/* ------------------------------------------------------------ Change request flow */

const CR_FLOW: (PhaseStep & { id: ChangeRequestStatus })[] = [
  { id: 'draft', label: 'Draft', hint: 'The author is still writing it' },
  { id: 'triage', label: 'Triage', hint: 'Classified as patch, minor or major, and validated' },
  { id: 'review', label: 'In review', hint: 'Open for comments and sign-offs during the review period' },
  { id: 'voting', label: 'Voting', hint: 'Voters say yes, no or abstain until the vote closes' },
  { id: 'approved', label: 'Approved', hint: 'Meets the governance policy and is ready to merge' },
  { id: 'merged', label: 'Merged', hint: 'Applied to the working draft' },
  { id: 'released', label: 'Released', hint: 'Included in a published version' },
];

const CR_TONE: Record<ChangeRequestStatus, BubbleTone> = {
  draft: 'neutral',
  triage: 'neutral',
  review: 'accent',
  voting: 'accent',
  approved: 'ok',
  merged: 'ok',
  released: 'ok',
  rejected: 'danger',
  withdrawn: 'neutral',
  'needs-work': 'warn',
};

const CR_LABEL: Record<ChangeRequestStatus, string> = {
  draft: 'Draft',
  triage: 'Triage',
  review: 'In review',
  voting: 'Voting',
  approved: 'Approved',
  merged: 'Merged',
  released: 'Released',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  'needs-work': 'Needs work',
};

export function ChangeStatusBubble({ status, hasVote }: { status: ChangeRequestStatus; hasVote: boolean }) {
  const steps = CR_FLOW.filter((s) => s.id !== 'voting' || hasVote || status === 'voting');
  const terminal = status === 'rejected' || status === 'withdrawn' || status === 'needs-work';
  const idx = status === 'needs-work' ? steps.findIndex((s) => s.id === 'review') : terminal ? -1 : steps.findIndex((s) => s.id === status);
  return (
    <PhaseBubble
      label={CR_LABEL[status] ?? status}
      ariaLabel={`Status: ${CR_LABEL[status] ?? status}. Show how change requests progress`}
      title="How a change request progresses"
      steps={steps}
      current={idx}
      tone={CR_TONE[status]}
      note={status === 'needs-work' ? 'Sent back for more work: revise and resubmit.' : terminal ? `This request was ${status}.` : undefined}
    />
  );
}

/* ------------------------------------------------------------ Health */

/**
 * One verdict for the working draft's health. A clean result only reads "Healthy" when every
 * required check ran; if the OWL reasoner could not run it says "Checks incomplete" instead.
 */
type Health = NonNullable<OntologySummary['health']>;

/** How far the OWL reasoner got (older summaries don't say, so it's inferred from which reasoner ran). */
const reasonerChecked = (h: Health) => h.reasonerChecked ?? (h.reasoner !== 'structural' && !(h.incomplete ?? []).some((m) => m.startsWith('OWL reasoner')) ? 'complete' : 'none');

/**
 * The popover's reasoner row, matching the health panel's detail: no verdict, inconsistent,
 * consistent but not every class checked, consistent with unsatisfiable classes, or consistent.
 */
export function reasonerRow(h: Health): { value: string; ok: boolean; warn: boolean } {
  const checked = reasonerChecked(h);
  const consistent = h.reasonerConsistent ?? h.consistent;
  const unsat = h.unsatisfiable ?? 0;
  if (checked === 'none') return { value: "No verdict, so validation can't pass", ok: false, warn: true };
  if (!consistent) return { value: 'Inconsistent', ok: false, warn: false };
  if (checked === 'consistency') return { value: 'Consistent, not every class checked', ok: false, warn: true };
  if (unsat || !h.consistent) return { value: unsat ? `Consistent, but ${plural(unsat, 'unsatisfiable class', 'unsatisfiable classes')}` : 'Consistent, but some classes are unsatisfiable', ok: false, warn: false };
  return { value: 'Consistent', ok: true, warn: false };
}

export function healthState(o: OntologySummary) {
  const h = o.health;
  const incomplete = h?.incomplete ?? [];
  // A logical problem counts only when the reasoner decided it; with no verdict the chip says
  // the checks are incomplete, as the health panel's detail does.
  const problem = h && (h.errors > 0 || (reasonerChecked(h) !== 'none' && !h.consistent));
  const caution = h && !problem && (h.warnings > 0 || h.fairScore < 0.8 || !h.passed);
  const tone: BubbleTone = !h ? 'neutral' : problem ? 'danger' : incomplete.length || caution ? 'warn' : 'ok';
  const label = !h ? 'Not validated yet' : problem ? 'Needs fixing' : incomplete.length ? 'Checks incomplete' : caution ? 'Healthy, with notes' : 'Healthy';
  const Icon = !h ? CircleDashed : problem || incomplete.length ? CircleAlert : CircleCheck;
  return { h, tone, label, Icon, incomplete };
}

/** Non-interactive version of the health bubble, for places that are already links (e.g. hub cards). */
export function HealthChip({ o }: { o: OntologySummary }) {
  const { tone, label, Icon } = healthState(o);
  return (
    <span className={cx('ui-badge inline-flex items-center gap-1 rounded-pill px-2.5 py-0.5 text-xs font-medium', BUBBLE[tone])}>
      <Icon className="size-3.5" aria-hidden />
      {label}
    </span>
  );
}

/** One chip for the working draft's health; the breakdown opens on click. */
export function HealthBubble({ o, detailsHref, align = 'right' }: { o: OntologySummary; detailsHref?: string; align?: 'left' | 'right' }) {
  const { h, tone, label, Icon, incomplete } = healthState(o);
  return (
    <Popover
      label={`Health: ${label}. Show details`}
      align={align}
      className={cx('px-2.5 py-0.5 text-xs font-medium', BUBBLE[tone])}
      trigger={
        <>
          <Icon className="size-3.5" aria-hidden />
          {label}
        </>
      }
    >
      {(close) => (
        <>
          <h4 className="mb-3 text-xs font-semibold tracking-wide text-muted uppercase">Health of the working draft</h4>
          {h ? (
            // A two-column grid, so every value starts in the same column whatever the label's length.
            <ul className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2">
              <HealthRow label="Reasoner" {...reasonerRow(h)} />
              <HealthRow ok={h.fairScore >= 0.8} warn={h.fairScore >= 0.5 && h.fairScore < 0.8} label="FAIR score" value={pct(h.fairScore)} />
              <HealthRow
                ok={h.errors === 0 && h.warnings === 0}
                warn={h.errors === 0 && h.warnings > 0}
                label="Lint (OWL best practice)"
                value={h.errors ? plural(h.errors, 'error') : h.warnings ? plural(h.warnings, 'warning') : 'No errors or warnings'}
              />
              <HealthRow ok={h.passed} label="Overall validation" value={h.passed ? 'Passed' : 'Failing'} />
            </ul>
          ) : (
            <p className="text-muted">Validation runs when the ontology changes.</p>
          )}
          {incomplete.length > 0 && (
            <div className="mt-3 rounded-lg bg-warn-soft p-2.5 text-xs text-warn" role="note">
              <strong className="font-medium">Not every check could run.</strong> {incomplete.join('. ')}. A clean result here is not a full guarantee.
            </div>
          )}
          {detailsHref && (
            <div className="mt-3 border-t border-line pt-3 text-xs">
              <Link to={detailsHref} onClick={close} className="font-medium text-accent hover:underline">
                See the full report, including every lint finding
              </Link>
            </div>
          )}
        </>
      )}
    </Popover>
  );
}

function HealthRow({ ok, warn, label, value }: { ok: boolean; warn?: boolean; label: string; value: string }) {
  const Icon = ok ? CircleCheck : CircleAlert;
  return (
    <li className="col-span-2 grid grid-cols-subgrid items-center">
      <span className="text-muted" data-health-label>
        {label}
      </span>
      <span className={cx('inline-flex items-center gap-1 justify-self-start font-medium', ok ? 'text-ok' : warn ? 'text-warn' : 'text-danger')} data-health-value>
        <Icon className="size-3.5 shrink-0" aria-hidden />
        {value}
      </span>
    </li>
  );
}
