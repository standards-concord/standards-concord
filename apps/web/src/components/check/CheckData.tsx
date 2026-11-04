import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, CircleX, Info, ShieldCheck, TriangleAlert, WandSparkles } from 'lucide-react';
import type { SparqStore } from '@sparq-org/sparq';
import type { Completion } from '@codemirror/autocomplete';
import { Badge, Button, Card, CardHeader, InlineError, cx } from '../ui';
import { CodeEditor, type CodeEditorHandle, type EditorDiagnostic } from '../code/CodeEditor';
import { highlightSegments } from '../code/highlight';
import { formatTurtle, parseTurtle } from '../../lib/turtleDoc';
import { describeFindings, displayPrefixes, parseSyntaxError, unknownTerms, type Finding, type Part, type RawFinding, type Severity } from '../../lib/shaclFindings';

const sparqModule = () => import('@sparq-org/sparq');

/** Problems shown before "Show all", so a very broken file doesn't flood the page. */
const FIRST_FINDINGS = 50;

/** A term as code, coloured the way the editor colours Turtle. */
function TermCode({ code }: { code: string }) {
  const segments = useMemo(() => highlightSegments(code, 'turtle'), [code]);
  return (
    <code className="rounded bg-surface-2 px-1 py-px font-mono text-[0.8rem] break-all">
      {segments.map((s, i) =>
        s.cls ? (
          <span key={i} className={s.cls}>
            {s.text}
          </span>
        ) : (
          s.text
        ),
      )}
    </code>
  );
}

function Sentence({ parts }: { parts: Part[] }) {
  return (
    <>
      {parts.map((p, i) => (typeof p === 'string' ? <span key={i}>{p}</span> : <TermCode key={i} code={p.code} />))}
    </>
  );
}

const SEVERITY: Record<Severity, { icon: typeof CircleX; className: string; label: string }> = {
  error: { icon: CircleX, className: 'text-danger', label: 'Error' },
  warning: { icon: TriangleAlert, className: 'text-warn', label: 'Warning' },
  info: { icon: Info, className: 'text-muted', label: 'Note' },
};

/** One problem. Clicking it (or Enter on it) selects the place in the data it's about. */
function ProblemItem({ finding, onReveal }: { finding: Pick<Finding, 'severity' | 'focus' | 'path' | 'parts' | 'hint' | 'at'>; onReveal: (from: number, to: number) => void }) {
  const sev = SEVERITY[finding.severity];
  // The record and property, unless the sentence already names them.
  const named = new Set(finding.parts.flatMap((p) => (typeof p === 'string' ? [] : [p.code])));
  const showContext = !!finding.focus && !named.has(finding.focus);
  const body = (
    <>
      <span className="flex items-start gap-2 text-sm">
        <sev.icon className={cx('mt-0.5 size-4 shrink-0', sev.className)} aria-label={sev.label} />
        <span className="min-w-0 flex-1">
          <Sentence parts={finding.parts} />
        </span>
        <span className="shrink-0 text-xs whitespace-nowrap text-muted">{finding.at ? `Line ${finding.at.line}` : 'Not in your data'}</span>
      </span>
      {showContext && (
        <span className="mt-1 ml-6 flex flex-wrap items-center gap-1 text-xs text-muted">
          On <TermCode code={finding.focus!} />
          {finding.path && (
            <>
              <span aria-hidden>›</span>
              <TermCode code={finding.path} />
            </>
          )}
        </span>
      )}
      {finding.hint && (
        <span className="mt-1 ml-6 block text-xs text-muted">
          <Sentence parts={finding.hint} />
        </span>
      )}
    </>
  );
  const box = 'block w-full rounded-md border border-line px-3 py-2 text-left';
  if (!finding.at) return <div className={box}>{body}</div>;
  const { from, to } = finding.at;
  return (
    <button type="button" className={cx(box, 'hover:border-accent hover:bg-accent-soft/40 focus-visible:border-accent')} onClick={() => onReveal(from, to)} title="Show this in the data">
      {body}
    </button>
  );
}

function lineAt(text: string, offset: number) {
  return text.slice(0, offset).split('\n').length;
}

/** The last check: kept by the page, so it survives switching to the query workspace and back. */
export interface CheckResult {
  report: { conforms: boolean; results: RawFinding[] } | null;
  checkedData?: string;
  error?: unknown;
}

export interface CheckDataProps {
  result: CheckResult;
  onResult: (r: CheckResult) => void;
  data: string;
  onDataChange: (data: string) => void;
  completions: Completion[];
  /** The ontology's Turtle: checked together with the data, so sh:class sees subclasses. */
  ontologyTurtle?: string;
  shapes?: string;
  /** The ontology's loaded sparq store (validation runs through it). */
  store: () => SparqStore | null;
  ready: boolean;
  /** Prefixes the ontology declares; the data can use them without declaring them again. */
  ontologyPrefixes: Record<string, string>;
  namespace: string;
}

/**
 * "Check your data": an editor for Turtle instance data and a SHACL check
 * against shapes generated from the ontology. Problems read as sentences with
 * the data's own prefixes, are underlined in the editor (hover for the
 * sentence), and clicking one selects the place it's about. Syntax errors and
 * misspelt ontology terms are underlined as you type.
 */
export function CheckData({ result, onResult, data, onDataChange, completions, ontologyTurtle, shapes, store, ready, ontologyPrefixes, namespace }: CheckDataProps) {
  const editor = useRef<CodeEditorHandle>(null);
  const { report, checkedData, error: checkError } = result;
  const [showAll, setShowAll] = useState(false);
  const [formatNote, setFormatNote] = useState<string>();
  const reportStale = !!report && checkedData !== data;

  // The data is read after the ontology, so the ontology's prefixes are in scope.
  const doc = useMemo(() => parseTurtle(data, { prefixes: ontologyPrefixes }), [data, ontologyPrefixes]);
  const prefixes = useMemo(() => displayPrefixes(doc, ontologyPrefixes), [doc, ontologyPrefixes]);

  // Syntax: sparq is the judge. Debounced, and read with the ontology's prefixes declared first.
  const [syntax, setSyntax] = useState<{ data: string; error?: { message: string; from: number } }>();
  useEffect(() => {
    let cancelled = false;
    const header = Object.entries(ontologyPrefixes)
      .map(([p, ns]) => `@prefix ${p}: <${ns}> .\n`)
      .join('');
    const headerBytes = new TextEncoder().encode(header).length;
    const t = setTimeout(() => {
      void sparqModule().then(async ({ SparqStore }) => {
        let error: { message: string; from: number } | undefined;
        try {
          (await SparqStore.fromString(header + data, 'turtle')).free();
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          error = parseSyntaxError(message, data, headerBytes) ?? (doc.error ? { message: doc.error.message, from: doc.error.from } : { message, from: 0 });
        }
        if (!cancelled) setSyntax({ data, error });
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [data, ontologyPrefixes, doc]);
  const syntaxError = syntax?.data === data ? syntax.error : undefined;

  const findings = useMemo(() => (report ? describeFindings(report.results, { doc, text: data, prefixes }) : []), [report, doc, data, prefixes]);
  // Every IRI the ontology mentions counts as defined (terms, datatypes, the ontology itself).
  // If the ontology can't be read here, don't guess: no typo warnings.
  const knownTerms = useMemo(() => {
    if (!ontologyTurtle) return undefined;
    const o = parseTurtle(ontologyTurtle);
    return o.error ? undefined : o.iris.map((p) => p.term.value);
  }, [ontologyTurtle]);
  const termWarnings = useMemo(() => (knownTerms ? unknownTerms(doc, namespace, knownTerms, prefixes) : []), [doc, namespace, knownTerms, prefixes]);

  /** Live problems: the syntax error and misspelt terms, as list items too. */
  const live = useMemo(() => {
    const out: (Pick<Finding, 'severity' | 'parts' | 'at'> & { text: string; to: number })[] = [];
    if (syntaxError) {
      const to = Math.min(data.length, syntaxError.from + Math.max(1, /^\S*/.exec(data.slice(syntaxError.from))![0].length));
      out.push({ severity: 'error', parts: [`Syntax error: ${syntaxError.message}`], text: `Syntax error: ${syntaxError.message}`, at: { from: syntaxError.from, to, line: lineAt(data, syntaxError.from) }, to });
    }
    for (const w of termWarnings) out.push({ severity: 'warning', parts: [w.message], text: w.message, at: { from: w.from, to: w.to, line: lineAt(data, w.from) }, to: w.to });
    return out;
  }, [syntaxError, termWarnings, data]);

  const diagnostics = useMemo<EditorDiagnostic[]>(() => {
    const out: EditorDiagnostic[] = [];
    for (const l of live) out.push({ from: l.at!.from, to: l.to, severity: l.severity, message: l.text, source: l.severity === 'error' ? 'Turtle syntax' : 'Ontology terms' });
    for (const f of findings) for (const r of f.ranges) out.push({ from: r.from, to: r.to, severity: f.severity, message: f.text, source: 'Check against the ontology' });
    return out;
  }, [live, findings]);

  const check = () => {
    const s = store();
    if (!s || !shapes) return;
    setShowAll(false);
    try {
      // The ontology goes in the data graph too, so sh:class sees subclass relationships.
      const r = s.validate(`${ontologyTurtle ?? ''}\n${data}`, shapes, 'turtle');
      onResult({ report: { conforms: r.conforms, results: r.results as RawFinding[] }, checkedData: data });
    } catch (e) {
      onResult({ report: null, checkedData: data, error: e });
    }
  };

  const formatted = useMemo(() => (syntaxError ? undefined : formatTurtle(data, ontologyPrefixes)), [data, ontologyPrefixes, syntaxError]);
  const format = () => {
    if (formatted === undefined) return;
    if (formatted === data) {
      setFormatNote('Already tidy.');
      return;
    }
    onDataChange(formatted);
    setFormatNote('Tidied the layout. Ctrl/⌘-Z in the editor undoes it.');
  };
  useEffect(() => {
    if (!formatNote) return;
    const t = setTimeout(() => setFormatNote(undefined), 4000);
    return () => clearTimeout(t);
  }, [formatNote]);

  const reveal = (from: number, to: number) => editor.current?.reveal(from, to);
  const shown = showAll ? findings : findings.slice(0, FIRST_FINDINGS);
  const errors = findings.filter((f) => f.severity === 'error').length;

  return (
    <Card>
      <CardHeader
        title="Check your data"
        subtitle="Validates Turtle instance data against SHACL shapes generated from the ontology. Problems are underlined in the editor: hover to read one, or click it in the list to jump there."
        icon={ShieldCheck}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button icon={WandSparkles} onClick={format} disabled={formatted === undefined} title={formatted === undefined ? 'Fix the syntax error first' : 'Lay the Turtle out tidily, keeping your prefixes and comments'}>
              Format
            </Button>
            <Button variant="primary" icon={ShieldCheck} onClick={check} disabled={!ready || !shapes}>
              Check
            </Button>
          </div>
        }
      />
      <div className="space-y-3 p-4">
        <CodeEditor
          ref={editor}
          value={data}
          onChange={onDataChange}
          language="turtle"
          completions={completions}
          ariaLabel="Instance data (Turtle)"
          minHeight={220}
          maxHeight={420}
          testId="data-editor"
          diagnostics={diagnostics}
        />
        <p className="flex flex-wrap items-center gap-x-3 text-xs text-muted">
          <span>Tab moves to the next control. Ctrl/⌘-] and Ctrl/⌘-[ indent.</span>
          {formatNote && (
            <span role="status" className="text-fg">
              {formatNote}
            </span>
          )}
        </p>
        {live.length > 0 && (
          <div className="space-y-1" data-testid="data-lint">
            <ol className="space-y-1" aria-label="Problems in the Turtle">
              {live.map((l, i) => (
                <li key={i}>
                  <ProblemItem finding={l} onReveal={reveal} />
                </li>
              ))}
            </ol>
          </div>
        )}
        {checkError && !syntaxError ? <InlineError error={checkError} /> : null}
        {reportStale && (
          <p role="status" className="flex items-center gap-2 rounded-md bg-warn-soft px-3 py-2 text-sm text-warn" data-testid="report-stale">
            The data changed since this check.
            <Button size="sm" icon={ShieldCheck} onClick={check}>
              Check again
            </Button>
          </p>
        )}
        {report && (
          <div className={cx('space-y-2', reportStale && 'opacity-60')} data-testid="shacl-report">
            <p className="flex flex-wrap items-center gap-2 text-sm">
              {report.conforms ? (
                <Badge tone="ok">Conforms</Badge>
              ) : (
                <>
                  <Badge tone="danger" icon={CircleAlert}>
                    {findings.length} problem{findings.length === 1 ? '' : 's'}
                  </Badge>
                  {errors < findings.length && <span className="text-xs text-muted">{errors} must be fixed, the rest are warnings or notes.</span>}
                </>
              )}
            </p>
            {findings.length > 0 && (
              <ol className="space-y-1" aria-label="Problems found">
                {shown.map((f, i) => (
                  <li key={i}>
                    <ProblemItem finding={f} onReveal={reveal} />
                  </li>
                ))}
              </ol>
            )}
            {shown.length < findings.length && (
              <Button size="sm" variant="ghost" onClick={() => setShowAll(true)}>
                Show all {findings.length.toLocaleString()} problems
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
