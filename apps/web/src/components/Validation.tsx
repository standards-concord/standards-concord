import { useState, type ReactNode } from 'react';
import type { ValidationReport } from '@concord/shared';
import type { IssueSeverity } from '@concord/core/types';
import { Link } from 'react-router';
import { Brain, ChevronDown, ChevronRight, CircleCheck, CircleX, Info, TriangleAlert } from 'lucide-react';
import type { Labeler } from '../lib/ontology';
import { localName, pct, plural } from '../lib/format';
import { checkedOf } from '../lib/reasonerCompare';
import { useAdvancedFeatures } from '../lib/advanced';
import { ProgressBar, cx } from './ui';
import { HighlightedCode } from './code/HighlightedCode';
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
      <SummaryTile ok={errors === 0} warn={errors === 0 && warnings > 0} title={errors ? plural(errors, 'error') : warnings ? plural(warnings, 'warning') : 'Clean'} sub="Quality checks" />
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

/**
 * Errors and warnings. Suggestions (style nits that never block anything) show only with Advanced
 * features on (Settings), so a healthy standard doesn't look noisy.
 */
export function LintIssues({ report, label }: { report: ValidationReport; label: Labeler }) {
  const [advanced] = useAdvancedFeatures();
  const shown = advanced ? report.lint : report.lint.filter((i) => i.severity !== 'info');
  if (!shown.length) return <p className="text-sm text-muted">No problems: the ontology follows OWL best practice.</p>;
  const serious = shown.some((i) => i.severity !== 'info');
  return (
    <div className="space-y-4">
      {(['error', 'warning', 'info'] as IssueSeverity[]).map((sev) => {
        const items = shown.filter((i) => i.severity === sev);
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

/**
 * Whether each question can be answered. Editors can open one to see its SPARQL test and results.
 * Hiding them from everyone else only keeps the list short (reviewers need "answerable or not"); it is
 * not an access rule. Who may receive the SPARQL at all is decided on the server (useCases.ts: group
 * members, since a group's use cases are shared working material).
 */
export function CqResults({ report, showQueries = false }: { report: ValidationReport; showQueries?: boolean }) {
  const [openIdx, setOpenIdx] = useState<number>();
  if (!report.competencyQuestions.length) return <p className="text-sm text-muted">No competency questions with tests yet. They come from use cases.</p>;
  if (!showQueries)
    return (
      <ul className="divide-y divide-line rounded-lg border border-line text-sm">
        {report.competencyQuestions.map((q, i) => (
          <li key={i} className="flex items-start gap-2 px-3 py-2">
            {q.satisfied ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-ok" aria-label="Answerable" role="img" /> : <CircleX className="mt-0.5 size-4 shrink-0 text-danger" aria-label="Not answerable" role="img" />}
            <span className="flex-1">{q.question}</span>
          </li>
        ))}
      </ul>
    );
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

type ImportCheck = NonNullable<ValidationReport['imports']>;

const NOT_CHECKED: Record<ImportCheck['unresolved'][number]['reason'], string> = {
  'not-hosted': 'not hosted on Concord, so it was not loaded',
  held: 'being reviewed before it is published, so it was not loaded',
  limit: 'more imports than Concord loads at once',
};

/** Plain words for the axiom predicates foreign-axiom findings name. */
const SAYS: Record<string, string> = {
  subClassOf: 'is a kind of',
  equivalentClass: 'is the same as',
  disjointWith: 'never overlaps with',
  domain: 'is used on',
  range: 'has values of type',
  subPropertyOf: 'is a narrower form of',
  equivalentProperty: 'is the same as',
  inverseOf: 'is the inverse of',
  propertyDisjointWith: 'never overlaps with',
  type: 'is a',
};

export const importsSummary = (c: ImportCheck) =>
  c.passed
    ? `${plural(c.imports.length, 'ontology', 'ontologies')}, consistent${c.unresolved.length ? `, ${c.unresolved.length} not checked` : ''}`
    : c.checked === 'none'
      ? 'not checked'
      : 'conflicts';

/**
 * The ontology checked together with every ontology it imports: whether the combination still makes sense,
 * which import a problem comes from, and what couldn't be loaded.
 */
export function ImportResults({ check, label }: { check: ImportCheck; label: Labeler }) {
  const name = (iri: string) => label(iri) || localName(iri);
  const verdict = check.checked === 'none' ? (
    <span className="text-warn">It couldn't be checked together with what it imports, so validation can't pass.</span>
  ) : !check.consistent ? (
    <strong className="text-danger">Together with what it imports, no data could ever conform to it.</strong>
  ) : check.unsatisfiable.length ? (
    <span>
      <strong className="text-danger">Together with what it imports, {plural(check.unsatisfiable.length, 'class', 'classes')} can never have members:</strong> {check.unsatisfiable.map(name).join(', ')}.
    </span>
  ) : (
    <span>
      <strong className="text-ok">Consistent with everything it imports.</strong>
    </span>
  );
  return (
    <div className="space-y-3 text-sm">
      <p>{verdict}</p>
      {check.checked === 'none' && check.error && <p className="text-xs text-muted">Why: {check.error}</p>}
      {check.blame.length > 0 && (
        <ul className="space-y-1" aria-label="Where the problem comes from">
          {check.blame.map((b) => (
            <li key={b.import ?? 'self'} className="flex items-start gap-2">
              <CircleX className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
              <span>
                {b.import === null ? 'The problem is in this ontology itself, not its imports.' : <>Comes from <strong>{b.title}</strong>{b.inconsistent ? ': together they contradict each other.' : b.unsatisfiable.length ? `: it makes ${b.unsatisfiable.map(name).join(', ')} impossible.` : '.'}</>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {check.imports.length > 0 && (
        <div>
          <h5 className="mb-1 text-xs font-semibold text-muted">Checked with</h5>
          <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Imported ontologies checked">
            {check.imports.map((i) => (
              <li key={`${i.iri}@${i.version}`} className="flex flex-wrap items-baseline gap-x-2 px-3 py-1.5">
                {i.ontologyId ? <Link to={`/o/${i.ontologyId}`} className="font-medium text-accent hover:underline">{i.title}</Link> : <span className="font-medium">{i.title}</span>}
                <span className="text-xs text-muted">{i.version === 'draft' ? 'working draft (not released yet)' : `version ${i.version}`}</span>
                <span className="w-full truncate font-mono text-xs text-muted">{i.iri}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {check.unresolved.length > 0 && (
        <div>
          <h5 className="mb-1 text-xs font-semibold text-muted">Not checked</h5>
          <ul className="space-y-1" aria-label="Imports not checked">
            {check.unresolved.map((u) => (
              <li key={u.iri} className="flex items-start gap-2">
                <Info className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                <span className="min-w-0">
                  <span className="break-all font-mono text-xs">{u.iri}</span> <span className="text-muted">— {NOT_CHECKED[u.reason]}.</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {check.foreignAxioms.length > 0 && (
        <div>
          <h5 className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-warn">
            <TriangleAlert className="size-3.5" /> Changes the meaning of terms it imports ({check.foreignAxioms.length})
          </h5>
          <ul className="space-y-1" aria-label="Statements about imported terms">
            {check.foreignAxioms.map((f, i) => (
              <li key={i}>
                <strong>{name(f.subject)}</strong> {SAYS[localName(f.predicate)] ?? localName(f.predicate)} <strong>{f.object.startsWith('(') ? 'a class expression' : name(f.object)}</strong>{' '}
                <span className="text-muted">({f.subject.replace(/[#/][^#/]*$/, '')} belongs to {f.owner})</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-muted">Everyone who imports {check.foreignAxioms.length === 1 ? 'that ontology' : 'those ontologies'} with this one gets these too. Define your own term, or propose the change to its owners.</p>
        </div>
      )}
      {check.inheritedUnsatisfiable.length > 0 && <p className="text-xs text-muted">Already impossible in an imported ontology (not this one's to fix): {check.inheritedUnsatisfiable.map(name).join(', ')}.</p>}
      {check.versionClashes.map((v) => (
        <p key={v.ontologyId} className="text-xs text-warn">
          {v.title} is imported at more than one version ({v.versions.join(', ')}), so both are checked together.
        </p>
      ))}
    </div>
  );
}

type Impact = NonNullable<ValidationReport['federations']>[number];
const broke = (i: Impact) => (i.passedBefore && !i.passedAfter) || i.newlyUnsatisfiable.length > 0 || i.becomesInconsistent;

export const federationsSummary = (fs: Impact[]) => {
  const broken = fs.filter(broke).length;
  return broken ? `breaks ${broken} of ${fs.length}` : `${plural(fs.length, 'federation')}, none broken`;
};

/** What a proposed change does to each federation that follows its ontology's working draft. */
export function FederationImpacts({ impacts, label }: { impacts: Impact[]; label: Labeler }) {
  const name = (iri: string) => label(iri) || localName(iri);
  return (
    <div className="space-y-2 text-sm">
      <ul className="space-y-1.5" aria-label="Federations this change affects">
        {impacts.map((i) => (
          <li key={i.federationId} className="flex items-start gap-2">
            {i.error ? <Info className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden /> : broke(i) ? <CircleX className={cx('mt-0.5 size-4 shrink-0', i.committed ? 'text-danger' : 'text-warn')} aria-hidden /> : <CircleCheck className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />}
            <span className="min-w-0">
              <Link to={`/f/${i.slug}`} className="font-medium text-accent hover:underline">{i.title}</Link>{' '}
              <span className="text-muted">({i.committed ? 'committed: breaking it fails this change' : 'advice only'})</span>
              <span className="block">
                {i.error
                  ? `Couldn't be checked: ${i.error}.`
                  : i.becomesInconsistent
                    ? 'With this change, its ontologies contradict each other.'
                    : i.newlyUnsatisfiable.length
                      ? `With this change, ${i.newlyUnsatisfiable.map(name).join(', ')} can never have members there.`
                      : !i.passedBefore && !i.passedAfter
                        ? 'It already had problems; this change adds none.'
                        : 'Still works with this change.'}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Stable identity of a lint finding, so a new finding can be told apart from ones already seen. */
const issueKey = (i: ValidationReport['lint'][number]) => [i.severity, i.code, i.iri ?? '', i.message].join('|');

export function ValidationDetails({
  report,
  label,
  openLintKey,
  lintNote,
  headingLevel = 4,
  showQueries = false,
  questionCount,
}: {
  report: ValidationReport;
  label: Labeler;
  /** Opens the lint findings whenever this changes to a new value, e.g. when a link to the report is followed. */
  openLintKey?: unknown;
  lintNote?: ReactNode;
  /** Level of the quality / FAIR / competency question headings: one below the section that holds them. */
  headingLevel?: 3 | 4;
  /** Editors: each competency question opens to its SPARQL test and results. */
  showQueries?: boolean;
  /** All questions the viewer can see, including those without an executable test. */
  questionCount?: number;
}) {
  const [advanced] = useAdvancedFeatures();
  const errors = report.lint.filter((i) => i.severity === 'error').length;
  const warnings = report.lint.filter((i) => i.severity === 'warning').length;
  const infos = advanced ? report.lint.length - errors - warnings : 0;
  const lintSummary = [errors && plural(errors, 'error'), warnings && plural(warnings, 'warning'), infos && plural(infos, 'suggestion')].filter(Boolean).join(', ') || 'none';
  const fairPassed = report.fair.checks.filter((c) => c.passed).length;
  const fairTotal = report.fair.checks.filter((c) => c.status !== 'not-checked').length;
  const cqOk = report.competencyQuestions.filter((q) => q.satisfied).length;
  return (
    <div className="space-y-5">
      <ValidationSummary report={report} />
      <ReasonerResult report={report} label={label} />
      <div className="divide-y divide-line rounded-lg border border-line">
        <Disclosure className="px-4 py-3" heading={headingLevel} title="Quality checks" summary={lintSummary} defaultOpen={errors > 0 || warnings > 0} openKey={openLintKey} failures={report.lint.filter((i) => i.severity !== 'info').map(issueKey)} keepMounted>
          <LintIssues report={report} label={label} />
          {lintNote && <p className="mt-3 text-xs text-muted">{lintNote}</p>}
        </Disclosure>
        <Disclosure className="px-4 py-3" heading={headingLevel} title="FAIR checks" summary={`${fairPassed} of ${fairTotal} pass`} defaultOpen={fairPassed < fairTotal} failures={report.fair.checks.filter((c) => c.status !== 'not-checked' && !c.passed).map((c) => c.id)} keepMounted>
          <FairChecks report={report} />
        </Disclosure>
        {report.imports && (
          <Disclosure
            className="px-4 py-3"
            heading={headingLevel}
            title="Imported ontologies"
            summary={importsSummary(report.imports)}
            defaultOpen={!report.imports.passed || report.imports.foreignAxioms.length > 0}
            failures={[...report.imports.unsatisfiable, ...(report.imports.consistent ? [] : ['inconsistent'])]}
            keepMounted
          >
            <ImportResults check={report.imports} label={label} />
          </Disclosure>
        )}
        {report.federations && report.federations.length > 0 && (
          <Disclosure
            className="px-4 py-3"
            heading={headingLevel}
            title="Across federations"
            summary={federationsSummary(report.federations)}
            defaultOpen={report.federations.some((i) => broke(i) || i.error)}
            failures={report.federations.filter(broke).map((i) => i.federationId)}
            keepMounted
          >
            <FederationImpacts impacts={report.federations} label={label} />
          </Disclosure>
        )}
        <Disclosure
          className="px-4 py-3"
          heading={headingLevel}
          title="Competency questions"
          summary={questionCount === undefined
            ? report.competencyQuestions.length ? `${cqOk} of ${report.competencyQuestions.length} answerable` : 'none yet'
            : !questionCount ? 'none yet'
              : !report.competencyQuestions.length ? `${plural(questionCount, 'question')}, none tested yet`
                : `${report.competencyQuestions.length} of ${questionCount} tested, ${cqOk === report.competencyQuestions.length ? 'all pass' : `${report.competencyQuestions.length - cqOk} fail`}`}
          defaultOpen={cqOk < report.competencyQuestions.length}
          failures={report.competencyQuestions.filter((q) => !q.satisfied).map((q) => q.question)}
          keepMounted
        >
          {questionCount !== undefined && questionCount > report.competencyQuestions.length && <p className="mb-3 text-sm text-muted">Questions without a SPARQL test have not been tested. Only public use cases run in these checks.</p>}
          <CqResults report={report} showQueries={showQueries} />
        </Disclosure>
      </div>
    </div>
  );
}
