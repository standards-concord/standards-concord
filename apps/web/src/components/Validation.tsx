import { useState, type ReactNode } from 'react';
import type { ValidationReport } from '@concord/shared';
import type { IssueSeverity } from '@concord/core/types';
import { Brain, ChevronDown, ChevronRight, CircleCheck, CircleX, Info, TriangleAlert } from 'lucide-react';
import type { Labeler } from '../lib/ontology';
import { pct, plural } from '../lib/format';
import { checkedOf } from '../lib/reasonerCompare';
import { ProgressBar, cx } from './ui';
import { HighlightedCode } from './code/CodeView';
import { Disclosure } from './Disclosure';

const SEV: Record<IssueSeverity, { icon: typeof Info; cls: string; label: string }> = {
  error: { icon: CircleX, cls: 'text-danger', label: 'Errors' },
  warning: { icon: TriangleAlert, cls: 'text-warn', label: 'Warnings' },
  info: { icon: Info, cls: 'text-muted', label: 'Suggestions' },
};

const SEV_ONE: Record<IssueSeverity, string> = { error: 'Error', warning: 'Warning', info: 'Suggestion' };

/** One-word-ish verdict that never claims more than was checked: without the reasoner, a pass covers only the checks that ran. */
export function validationVerdict(report: Pick<ValidationReport, 'passed' | 'reasoner'>, style: 'title' | 'inline' = 'title'): string {
  if (!report.passed) return style === 'title' ? 'Failing' : 'failing';
  if (!report.reasoner.available) return style === 'title' ? 'Available checks passed, reasoning incomplete' : 'passing, reasoner not run';
  return style === 'title' ? 'Passed' : 'passing';
}

export function ValidationSummary({ report }: { report: ValidationReport }) {
  const errors = report.lint.filter((i) => i.severity === 'error').length;
  const warnings = report.lint.filter((i) => i.severity === 'warning').length;
  const infos = report.lint.filter((i) => i.severity === 'info').length;
  const r = report.reasoner;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" role="group" aria-label="Health summary">
      <SummaryTile ok={report.passed} warn={report.passed && !r.available} title={validationVerdict(report)} sub="Overall validation" />
      <SummaryTile
        ok={checkedOf(r) === 'complete' && r.consistent && !r.unsatisfiable.length}
        title={checkedOf(r) === 'consistency' && r.consistent ? 'Partly checked' : !r.available ? 'Not run' : r.consistent ? 'Consistent' : 'Inconsistent'}
        sub="Reasoner"
        warn={checkedOf(r) !== 'complete' && !(r.available && !r.consistent)}
      />
      <SummaryTile ok={errors === 0} warn={errors === 0 && warnings > 0} title={errors ? plural(errors, 'error') : warnings ? plural(warnings, 'warning') : 'Clean'} sub={infos ? `Lint · ${plural(infos, 'suggestion')}` : 'Lint (OWL best practice)'} />
      <div className="rounded-lg border border-line p-3">
        <div className="text-lg font-semibold tabular-nums">{pct(report.fair.score)}</div>
        <div className="text-xs text-muted">FAIR score</div>
        <ProgressBar className="mt-2" value={report.fair.score} tone={report.fair.score >= 0.8 ? 'ok' : report.fair.score >= 0.5 ? 'warn' : 'danger'} />
      </div>
    </div>
  );
}

function SummaryTile({ ok, warn, title, sub }: { ok: boolean; warn?: boolean; title: string; sub: string }) {
  const Icon = ok && !warn ? CircleCheck : warn ? TriangleAlert : CircleX;
  return (
    <div className="rounded-lg border border-line p-3">
      <div className={cx('flex items-center gap-1.5 text-sm font-semibold', ok && !warn ? 'text-ok' : warn ? 'text-warn' : 'text-danger')}>
        <Icon className="size-4" /> {title}
      </div>
      <div className="mt-1 text-xs text-muted">{sub}</div>
    </div>
  );
}

export function LintIssues({ report, label }: { report: ValidationReport; label: Labeler }) {
  if (!report.lint.length) return <p className="text-sm text-muted">No lint issues — the ontology follows the strict OWL profile’s best-practice rules.</p>;
  const serious = report.lint.some((i) => i.severity !== 'info');
  return (
    <div className="space-y-4">
      {(['error', 'warning', 'info'] as IssueSeverity[]).map((sev) => {
        const items = report.lint.filter((i) => i.severity === sev);
        if (!items.length) return null;
        const { icon: Icon, cls, label: l } = SEV[sev];
        const list = (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {items.map((i, idx) => (
              <li key={idx} className="flex items-start gap-2 px-3 py-2 text-sm">
                <StatusIcon icon={Icon} cls={cls} status={SEV_ONE[sev]} note={[i.code, i.reference].filter(Boolean).join(' · ')} />
                <div className="min-w-0">
                  <p>{i.message}</p>
                  {i.iri && <p className="mt-0.5 text-xs text-muted">{label(i.iri)}</p>}
                </div>
              </li>
            ))}
          </ul>
        );
        // Suggestions stay one click away when there are errors or warnings to deal with first.
        if (sev === 'info' && serious)
          return (
            <Disclosure key={sev} tone="muted" heading={4} title={<span className={cx('inline-flex items-center gap-1.5 text-sm font-semibold', cls)}><Icon className="size-3.5" /> {l} ({items.length})</span>}>
              {list}
            </Disclosure>
          );
        return (
          <div key={sev}>
            <h4 className={cx('mb-1.5 flex items-center gap-1.5 text-sm font-semibold', cls)}>
              <Icon className="size-3.5" /> {l} ({items.length})
            </h4>
            {list}
          </div>
        );
      })}
    </div>
  );
}

export function ReasonerResult({ report, label }: { report: ValidationReport; label: Labeler }) {
  const r = report.reasoner;
  const checked = checkedOf(r);
  const verdict = checked === 'consistency' && r.consistent ? (
    <span>
      <strong className="text-warn">Consistent, but not every class could be checked.</strong> Validation doesn't pass until the reasoner can check them all.
    </span>
  ) : !r.available ? (
    <span className="text-warn">The OWL reasoner gave no verdict, so validation can't pass.</span>
  ) : r.consistent ? (
    <span>
      <strong className="text-ok">Consistent.</strong> {r.unsatisfiable.length ? `${plural(r.unsatisfiable.length, 'unsatisfiable class', 'unsatisfiable classes')}.` : 'All classes are satisfiable.'}
    </span>
  ) : (
    <strong className="text-danger">Inconsistent — no data could ever conform to this ontology.</strong>
  );
  // Only what needs fixing is shown. Which engine ran, how long it took, inferred relations and
  // profile notes are under-the-hood detail, so they aren't (Jesse, 6 Nov 2026).
  return (
    <div className="space-y-2 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <Brain className="size-4 text-muted" />
        {verdict}
      </p>
      {checked !== 'complete' && r.error && <p className="text-xs text-muted">Why: {r.error}</p>}
      {r.unsatisfiable.length > 0 && <p className="text-danger">Unsatisfiable: {r.unsatisfiable.map(label).join(', ')}</p>}
      {r.explanation && <p className="rounded-lg bg-surface-2 p-2 text-xs whitespace-pre-line">{r.explanation}</p>}
    </div>
  );
}

/**
 * A pass/fail icon whose technical reference (a FOOPS! test, a lint rule) shows on hover or
 * focus, so the list itself reads in plain words.
 */
function StatusIcon({ icon: Icon, cls, status, note }: { icon: typeof Info; cls: string; status: string; note?: string }) {
  if (!note) return <Icon className={cx('mt-0.5 size-4 shrink-0', cls)} aria-label={status} role="img" />;
  return (
    <span tabIndex={0} role="img" aria-label={`${status}. ${note}`} title={note} className="mt-0.5 shrink-0 cursor-help rounded-full focus-visible:outline-2 focus-visible:outline-accent" data-testid="status-note">
      <Icon className={cx('size-4', cls)} aria-hidden />
    </span>
  );
}

/** Only the failing checks, unless expanded: then every check, failing first. Each check's FOOPS!/FAIR reference is on its icon's hover. */
export function FairChecks({ report }: { report: ValidationReport }) {
  const [open, setOpen] = useState(false);
  const { checks } = report.fair;
  const status = (c: (typeof checks)[number]) => c.status ?? (c.passed ? 'pass' : 'fail');
  const failed = checks.filter((c) => status(c) === 'fail');
  const order = { fail: 0, 'not-checked': 1, pass: 2 } as const;
  const shown = open ? [...checks].sort((a, b) => order[status(a)] - order[status(b)]) : failed;
  const skipped = checks.filter((c) => status(c) === 'not-checked').length;
  return (
    <div className="text-sm">
      <ul className="space-y-1.5">
        {shown.map((c) => (
          <li key={c.id} className="flex items-start gap-2">
            {status(c) === 'pass' ? (
              <StatusIcon icon={CircleCheck} cls="text-ok" status="Passes" note={c.reference} />
            ) : status(c) === 'fail' ? (
              <StatusIcon icon={CircleX} cls="text-danger" status="Fails" note={c.reference} />
            ) : (
              <StatusIcon icon={Info} cls="text-muted" status="Not checked" note={c.reference} />
            )}
            <span className="min-w-0">
              <span className="font-medium">{c.title}</span>
              <span className="block text-xs text-muted">{c.message}</span>
            </span>
          </li>
        ))}
        {!shown.length && <li className="text-muted">All {checks.length - skipped} FAIR checks that could be run pass.</li>}
      </ul>
      {open && skipped > 0 && <p className="mt-2 text-xs text-muted">{plural(skipped, 'check')} could not be run here and {skipped === 1 ? 'is' : 'are'} left out of the score.</p>}
      {checks.length > failed.length || open ? (
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          {open ? 'Show failing only' : `Show all ${checks.length} checks`}
        </button>
      ) : null}
    </div>
  );
}

export function CqResults({ report }: { report: ValidationReport }) {
  const [openIdx, setOpenIdx] = useState<number>();
  if (!report.competencyQuestions.length) return <p className="text-sm text-muted">No competency questions with SPARQL tests yet. They come from use cases.</p>;
  return (
    <ul className="divide-y divide-line rounded-lg border border-line text-sm">
      {report.competencyQuestions.map((q, i) => (
        <li key={i} className="px-3 py-2">
          <button className="flex w-full items-start gap-2 text-left" onClick={() => setOpenIdx(openIdx === i ? undefined : i)}>
            {q.satisfied ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-ok" /> : <CircleX className="mt-0.5 size-4 shrink-0 text-danger" />}
            <span className="flex-1">{q.question}</span>
            <span className="text-xs text-muted">{q.ok ? plural(q.rows.length, 'row') : 'error'}</span>
          </button>
          {openIdx === i && (
            <div className="mt-2 space-y-2 pl-6">
              <HighlightedCode code={q.sparql} language="sparql" />
              {q.error && <p className="text-xs text-danger">{q.error}</p>}
              {q.rows.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="text-xs">
                    <thead>
                      <tr>
                        {Object.keys(q.rows[0]).map((k) => (
                          <th key={k} className="border-b border-line px-2 py-1 text-left font-medium">
                            ?{k}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {q.rows.slice(0, 10).map((r, ri) => (
                        <tr key={ri}>
                          {Object.values(r).map((v, vi) => (
                            <td key={vi} className="px-2 py-1 font-mono">
                              {v}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Summary tiles up front; lint, FAIR and competency-question detail one click away. */
/** Stable identity of a lint finding, so a new finding can be told apart from ones already seen. */
const issueKey = (i: ValidationReport['lint'][number]) => [i.severity, i.code, i.iri ?? '', i.message].join('|');

export function ValidationDetails({
  report,
  label,
  openLintKey,
  lintNote,
  headingLevel = 4,
}: {
  report: ValidationReport;
  label: Labeler;
  /** Opens the lint findings whenever this changes to a new value, e.g. when a link to the report is followed. */
  openLintKey?: unknown;
  lintNote?: ReactNode;
  /** Level of the Lint / FAIR / Competency question headings: one below the section that holds them. */
  headingLevel?: 3 | 4;
}) {
  const errors = report.lint.filter((i) => i.severity === 'error').length;
  const warnings = report.lint.filter((i) => i.severity === 'warning').length;
  const infos = report.lint.length - errors - warnings;
  const lintSummary = report.lint.length
    ? [errors && plural(errors, 'error'), warnings && plural(warnings, 'warning'), infos && plural(infos, 'suggestion')].filter(Boolean).join(', ')
    : 'none';
  const fairPassed = report.fair.checks.filter((c) => c.passed).length;
  const cqOk = report.competencyQuestions.filter((q) => q.satisfied).length;
  return (
    <div className="space-y-5">
      <ValidationSummary report={report} />
      <ReasonerResult report={report} label={label} />
      <div className="divide-y divide-line rounded-lg border border-line">
        <Disclosure className="px-4 py-3" heading={headingLevel} title="Lint findings" summary={lintSummary} defaultOpen={errors > 0 || warnings > 0} openKey={openLintKey} failures={report.lint.filter((i) => i.severity !== 'info').map(issueKey)} keepMounted>
          <LintIssues report={report} label={label} />
          {lintNote && <p className="mt-3 text-xs text-muted">{lintNote}</p>}
        </Disclosure>
        <Disclosure className="px-4 py-3" heading={headingLevel} title="FAIR checks" summary={`${fairPassed} of ${report.fair.checks.length} pass`} defaultOpen={fairPassed < report.fair.checks.length} failures={report.fair.checks.filter((c) => !c.passed).map((c) => c.id)} keepMounted>
          <FairChecks report={report} />
        </Disclosure>
        <Disclosure
          className="px-4 py-3"
          heading={headingLevel}
          title="Competency questions"
          summary={report.competencyQuestions.length ? `${cqOk} of ${report.competencyQuestions.length} answerable` : 'none yet'}
          defaultOpen={cqOk < report.competencyQuestions.length}
          failures={report.competencyQuestions.filter((q) => !q.satisfied).map((q) => q.question)}
          keepMounted
        >
          <CqResults report={report} />
        </Disclosure>
      </div>
    </div>
  );
}
