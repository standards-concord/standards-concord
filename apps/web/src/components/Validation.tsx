import { useState, type ReactNode } from 'react';
import type { ValidationReport } from '@concord/shared';
import type { IssueSeverity } from '@concord/core/types';
import { Brain, ChevronDown, ChevronRight, CircleCheck, CircleX, Info, TriangleAlert } from 'lucide-react';
import type { Labeler } from '../lib/ontology';
import { pct, plural } from '../lib/format';
import { Badge, ProgressBar, cx } from './ui';
import { HighlightedCode } from './code/CodeView';
import { Disclosure } from './Disclosure';

const SEV: Record<IssueSeverity, { icon: typeof Info; cls: string; label: string }> = {
  error: { icon: CircleX, cls: 'text-danger', label: 'Errors' },
  warning: { icon: TriangleAlert, cls: 'text-warn', label: 'Warnings' },
  info: { icon: Info, cls: 'text-muted', label: 'Suggestions' },
};

export function ValidationSummary({ report }: { report: ValidationReport }) {
  const errors = report.lint.filter((i) => i.severity === 'error').length;
  const warnings = report.lint.filter((i) => i.severity === 'warning').length;
  const infos = report.lint.filter((i) => i.severity === 'info').length;
  const r = report.reasoner;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <SummaryTile ok={report.passed} title={report.passed ? 'Passed' : 'Failing'} sub="Overall validation" />
      <SummaryTile ok={r.consistent && !r.unsatisfiable.length} title={!r.available ? 'Not run' : r.consistent ? 'Consistent' : 'Inconsistent'} sub={`Reasoner (${r.engine})`} warn={!r.available} />
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
  return (
    <div className="space-y-4">
      {(['error', 'warning', 'info'] as IssueSeverity[]).map((sev) => {
        const items = report.lint.filter((i) => i.severity === sev);
        if (!items.length) return null;
        const { icon: Icon, cls, label: l } = SEV[sev];
        return (
          <div key={sev}>
            <h4 className={cx('mb-1.5 flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase', cls)}>
              <Icon className="size-3.5" /> {l} ({items.length})
            </h4>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {items.map((i, idx) => (
                <li key={idx} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p>{i.message}</p>
                    <p className="mt-0.5 text-xs text-muted">
                      <code className="font-mono">{i.code}</code>
                      {i.iri && <> · {label(i.iri)}</>}
                    </p>
                  </div>
                  {i.reference && <Badge tone="outline">{i.reference}</Badge>}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

export function ReasonerResult({ report, label }: { report: ValidationReport; label: Labeler }) {
  const r = report.reasoner;
  return (
    <div className="space-y-2 text-sm">
      <p className="flex items-center gap-2">
        <Brain className="size-4 text-muted" />
        {!r.available ? (
          <span className="text-warn">The {r.engine} reasoner is not available; only structural checks ran.{r.error && ` (${r.error})`}</span>
        ) : r.consistent ? (
          <span>
            <strong className="text-ok">Consistent.</strong> {r.unsatisfiable.length ? `${plural(r.unsatisfiable.length, 'unsatisfiable class', 'unsatisfiable classes')}.` : 'All classes are satisfiable.'}
          </span>
        ) : (
          <strong className="text-danger">Inconsistent — no data could ever conform to this ontology.</strong>
        )}
        <span className="text-xs text-subtle">
          {r.engine} · {r.durationMs} ms
        </span>
      </p>
      {r.unsatisfiable.length > 0 && <p className="text-danger">Unsatisfiable: {r.unsatisfiable.map(label).join(', ')}</p>}
      {r.explanation && <p className="rounded-lg bg-surface-2 p-2 text-xs">{r.explanation}</p>}
      {r.inferredSubClassOf.length > 0 && (
        <div>
          <p className="text-xs text-muted">Inferred (not asserted) subclass relations:</p>
          <ul className="mt-1 text-xs">
            {r.inferredSubClassOf.map(([a, b], i) => (
              <li key={i}>
                {label(a)} ⊑ {label(b)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function FairChecks({ report }: { report: ValidationReport }) {
  const [open, setOpen] = useState(false);
  const failed = report.fair.checks.filter((c) => !c.passed);
  const shown = open ? report.fair.checks : failed.slice(0, 4);
  return (
    <div className="text-sm">
      <ul className="space-y-1.5">
        {shown.map((c) => (
          <li key={c.id} className="flex items-start gap-2">
            {c.passed ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-ok" /> : <CircleX className="mt-0.5 size-4 shrink-0 text-danger" />}
            <span className="min-w-0">
              <span className="mr-1.5 rounded bg-surface-2 px-1 font-mono text-[0.7rem]">{c.principle}</span>
              <span className="font-medium">{c.title}</span>
              <span className="block text-xs text-muted">{c.message}</span>
            </span>
          </li>
        ))}
        {!shown.length && <li className="text-muted">All {report.fair.checks.length} FAIR checks pass.</li>}
      </ul>
      {report.fair.checks.length > shown.length || open ? (
        <button onClick={() => setOpen((o) => !o)} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          {open ? 'Show failing only' : `Show all ${report.fair.checks.length} checks`}
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
export function ValidationDetails({ report, label, openLint, lintNote }: { report: ValidationReport; label: Labeler; openLint?: boolean; lintNote?: ReactNode }) {
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
        <Disclosure className="px-4 py-3" title="Lint findings" summary={lintSummary} defaultOpen={openLint || errors > 0 || warnings > 0}>
          <LintIssues report={report} label={label} />
          {lintNote && <p className="mt-3 text-xs text-muted">{lintNote}</p>}
        </Disclosure>
        <Disclosure className="px-4 py-3" title="FAIR checks" summary={`${fairPassed} of ${report.fair.checks.length} pass`} defaultOpen={fairPassed < report.fair.checks.length}>
          <FairChecks report={report} />
        </Disclosure>
        <Disclosure
          className="px-4 py-3"
          title="Competency questions"
          summary={report.competencyQuestions.length ? `${cqOk} of ${report.competencyQuestions.length} answerable` : 'none yet'}
          defaultOpen={cqOk < report.competencyQuestions.length}
        >
          <CqResults report={report} />
        </Disclosure>
      </div>
    </div>
  );
}
