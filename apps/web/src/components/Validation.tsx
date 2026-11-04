import { useState, type ReactNode } from 'react';
import type { ValidationReport } from '@concord/shared';
import type { IssueSeverity, ReasonerResult as ReasonerReport } from '@concord/core/types';
import { Brain, ChevronDown, ChevronRight, CircleCheck, CircleX, Cpu, Info, TriangleAlert } from 'lucide-react';
import type { Labeler } from '../lib/ontology';
import { pct, plural } from '../lib/format';
import { checkedOf, compareWithServer } from '../lib/reasonerCompare';
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
      <SummaryTile
        ok={checkedOf(r) === 'complete' && r.consistent && !r.unsatisfiable.length}
        title={checkedOf(r) === 'consistency' && r.consistent ? 'Partly checked' : !r.available ? 'Not run' : r.consistent ? 'Consistent' : 'Inconsistent'}
        sub={`Reasoner (${r.engine})`}
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
        );
        // Suggestions stay one click away when there are errors or warnings to deal with first.
        if (sev === 'info' && serious)
          return (
            <Disclosure key={sev} tone="muted" heading={4} title={<span className={cx('inline-flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase', cls)}><Icon className="size-3.5" /> {l} ({items.length})</span>}>
              {list}
            </Disclosure>
          );
        return (
          <div key={sev}>
            <h4 className={cx('mb-1.5 flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase', cls)}>
              <Icon className="size-3.5" /> {l} ({items.length})
            </h4>
            {list}
          </div>
        );
      })}
    </div>
  );
}

/** "sparq · reasoning 1.2 ms (14 ms in all)", or "structural · 3 ms". */
function timing(r: ReasonerReport) {
  return r.checkMs !== undefined ? `${r.engine} · reasoning ${r.checkMs} ms (${r.durationMs} ms in all)` : `${r.engine} · ${r.durationMs} ms`;
}

/** The working draft's Turtle and the revision it is. */
export type DraftLoader = () => Promise<{ turtle: string; revision?: string }>;

/**
 * Runs the same OWL reasoner (sparq, WebAssembly) on this device, in a Web Worker, over the
 * draft's Turtle, and compares the result with the server's when both are for the same revision.
 */
function BrowserCheck({ server, revision, load, label }: { server: ReasonerReport; revision?: string; load: DraftLoader; label: Labeler }) {
  // The revision the browser checked is kept, not a "same revision" flag, so the comparison
  // stays right when the server's report is reloaded for a newer revision.
  const [state, setState] = useState<{ status: 'idle' | 'running' | 'done' | 'error'; r?: ReasonerReport; checkedRevision?: string; error?: string }>({ status: 'idle' });
  const run = async () => {
    setState({ status: 'running' });
    try {
      const draft = await load();
      const { reasonInBrowser } = await import('../lib/reasonInBrowser');
      const r = await reasonInBrowser(draft.turtle);
      setState({ status: 'done', r, checkedRevision: draft.revision });
    } catch (e) {
      setState({ status: 'error', error: (e as Error).message });
    }
  };
  const r = state.r;
  const comparison = r && compareWithServer(r, state.checkedRevision, server, revision);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <button type="button" onClick={run} disabled={state.status === 'running'} className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 hover:bg-surface-2 disabled:opacity-60">
        <Cpu className="size-3.5" aria-hidden /> {state.status === 'running' ? 'Checking in this browser…' : 'Check again in this browser'}
      </button>
      <span role="status" className="text-muted">
        {state.status === 'error' && <span className="text-danger">The in-browser check failed: {state.error}</span>}
        {state.status === 'done' && r && (
          <>
            This browser:{' '}
            <strong className={checkedOf(r) !== 'complete' ? 'text-warn' : r.consistent && !r.unsatisfiable.length ? 'text-ok' : 'text-danger'}>
              {checkedOf(r) === 'none'
                ? 'no verdict'
                : !r.consistent
                  ? 'inconsistent'
                  : checkedOf(r) === 'consistency'
                    ? 'consistent, but not every class could be checked'
                    : r.unsatisfiable.length
                      ? `unsatisfiable: ${r.unsatisfiable.map(label).join(', ')}`
                      : 'consistent, all classes satisfiable'}
            </strong>{' '}
            ({timing(r)}).{' '}
            {comparison === 'other-revision' ? (
              <span className="text-warn">This check and the server's result are for different revisions of the draft, so they can't be compared. Reload the page to compare.</span>
            ) : comparison === 'same' ? (
              'Same result as the server.'
            ) : (
              <span className="text-warn">The server's result for the same revision differs.</span>
            )}
          </>
        )}
      </span>
    </div>
  );
}

export function ReasonerResult({ report, label, checkInBrowser }: { report: ValidationReport; label: Labeler; /** Loads the working draft, to re-run the reasoner in this browser. */ checkInBrowser?: DraftLoader }) {
  const r = report.reasoner;
  const checked = checkedOf(r);
  const problem = !r.consistent || r.unsatisfiable.length > 0;
  const hasDetail = r.unsatisfiable.length > 0 || !!r.explanation || r.inferredSubClassOf.length > 0 || !!r.profile?.length;
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
  const detail = (
    <div className="space-y-2">
      {checked !== 'complete' && r.error && <p className="text-xs text-muted">Why: {r.error}</p>}
      {r.unsatisfiable.length > 0 && <p className="text-danger">Unsatisfiable: {r.unsatisfiable.map(label).join(', ')}</p>}
      {r.explanation && <p className="rounded-lg bg-surface-2 p-2 text-xs whitespace-pre-line">{r.explanation}</p>}
      {!!r.profile?.length && (
        <div>
          <p className="text-xs text-muted">OWL 2 DL profile notes (reasoning still ran):</p>
          <ul className="mt-1 text-xs">
            {r.profile.map((n, i) => (
              <li key={i}>{n.detail}</li>
            ))}
          </ul>
        </div>
      )}
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
  return (
    <div className="space-y-2 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <Brain className="size-4 text-muted" />
        {verdict}
        <span className="text-xs text-subtle">{timing(r)}</span>
      </p>
      {(hasDetail || (checked !== 'complete' && r.error)) &&
        (problem ? (
          detail
        ) : (
          <Disclosure tone="muted" title={<span className="text-xs">Reasoner details</span>} summary={r.inferredSubClassOf.length ? plural(r.inferredSubClassOf.length, 'inferred relation') : undefined}>
            {detail}
          </Disclosure>
        ))}
      {checkInBrowser && <BrowserCheck server={r} revision={report.revision} load={checkInBrowser} label={label} />}
    </div>
  );
}

const PRINCIPLES = [
  { key: 'F', name: 'Findable' },
  { key: 'A', name: 'Accessible' },
  { key: 'I', name: 'Interoperable' },
  { key: 'R', name: 'Reusable' },
] as const;

/** `showAll` lists every check (failing first) with no inner toggle, for use inside a disclosure. */
export function FairChecks({ report, showAll }: { report: ValidationReport; showAll?: boolean }) {
  const [expanded, setOpen] = useState(false);
  const open = showAll || expanded;
  const { checks, byPrinciple } = report.fair;
  const status = (c: (typeof checks)[number]) => c.status ?? (c.passed ? 'pass' : 'fail');
  const failed = checks.filter((c) => status(c) === 'fail');
  const order = { fail: 0, 'not-checked': 1, pass: 2 } as const;
  const shown = open ? [...checks].sort((a, b) => order[status(a)] - order[status(b)]) : failed.slice(0, 4);
  const skipped = checks.filter((c) => status(c) === 'not-checked').length;
  return (
    <div className="text-sm">
      {/* Reports saved before per-principle scoring have no breakdown. */}
      {byPrinciple && <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {PRINCIPLES.map(({ key, name }) => {
          const p = byPrinciple[key];
          return (
            <div key={key} className="rounded-lg border border-line p-2">
              <div className="flex items-baseline justify-between gap-1">
                <span className="text-xs font-medium">{name}</span>
                <span className="text-xs tabular-nums text-muted">
                  {p.passed}/{p.total}
                </span>
              </div>
              <ProgressBar className="mt-1.5" value={p.score} tone={p.score >= 0.8 ? 'ok' : p.score >= 0.5 ? 'warn' : 'danger'} />
            </div>
          );
        })}
      </div>}
      <p className="mb-3 text-xs text-muted">
        The FAIR score is the average of these four, so each principle counts equally. Each check follows a FOOPS! test (Garijo, Corcho and Poveda-Villalón, 2021).
        {skipped > 0 && ` ${plural(skipped, 'check')} could not be run here and ${skipped === 1 ? 'is' : 'are'} left out.`}
      </p>
      <ul className="space-y-1.5">
        {shown.map((c) => (
          <li key={c.id} className="flex items-start gap-2">
            {status(c) === 'pass' ? (
              <CircleCheck className="mt-0.5 size-4 shrink-0 text-ok" />
            ) : status(c) === 'fail' ? (
              <CircleX className="mt-0.5 size-4 shrink-0 text-danger" />
            ) : (
              <Info className="mt-0.5 size-4 shrink-0 text-muted" />
            )}
            <span className="min-w-0">
              <span className="mr-1.5 rounded bg-surface-2 px-1 font-mono text-[0.7rem]">{c.principle}</span>
              <span className="font-medium">{c.title}</span>
              <span className="block text-xs text-muted">
                {c.message}
                {c.reference && <span className="text-subtle"> · {c.reference}</span>}
              </span>
            </span>
          </li>
        ))}
        {!shown.length && <li className="text-muted">All {checks.length - skipped} FAIR checks that could be run pass.</li>}
      </ul>
      {!showAll && (checks.length > shown.length || open) ? (
        <button onClick={() => setOpen((o) => !o)} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent">
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
export function ValidationDetails({ report, label, openLintKey, lintNote, checkInBrowser }: { report: ValidationReport; label: Labeler; /** Opens the lint findings whenever this changes to a new value, e.g. when a link to the report is followed. */ openLintKey?: unknown; lintNote?: ReactNode; /** Loads the working draft, to re-run the reasoner in this browser. */ checkInBrowser?: DraftLoader }) {
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
      <ReasonerResult report={report} label={label} checkInBrowser={checkInBrowser} />
      <div className="divide-y divide-line rounded-lg border border-line">
        <Disclosure className="px-4 py-3" heading={4} title="Lint findings" summary={lintSummary} defaultOpen={errors > 0 || warnings > 0} openKey={openLintKey} keepMounted>
          <LintIssues report={report} label={label} />
          {lintNote && <p className="mt-3 text-xs text-muted">{lintNote}</p>}
        </Disclosure>
        <Disclosure className="px-4 py-3" heading={4} title="FAIR checks" summary={`${fairPassed} of ${report.fair.checks.length} pass`} defaultOpen={fairPassed < report.fair.checks.length} keepMounted>
          <FairChecks report={report} showAll />
        </Disclosure>
        <Disclosure
          className="px-4 py-3"
          heading={4}
          title="Competency questions"
          summary={report.competencyQuestions.length ? `${cqOk} of ${report.competencyQuestions.length} answerable` : 'none yet'}
          defaultOpen={cqOk < report.competencyQuestions.length}
          keepMounted
        >
          <CqResults report={report} />
        </Disclosure>
      </div>
    </div>
  );
}
