import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, CircleX, Info, ShieldCheck, TriangleAlert, WandSparkles } from 'lucide-react';
import type { SparqStore } from '@sparq-org/sparq';
import type { Completion } from '@codemirror/autocomplete';
import { Badge, Button, Card, CardHeader, InlineError, cx } from '../ui';
import { CodeEditor, type CodeEditorHandle, type EditorDiagnostic } from '../code/CodeEditor';
import { highlightSegments } from '../code/highlight';
import { formatTurtle, parseTurtle, termKey } from '../../lib/turtleDoc';
import { ShapesIndex, describeFindings, displayPrefixes, lineFinder, parseSyntaxError, unknownTerms, type Finding, type Part, type RawFinding, type Severity } from '../../lib/shaclFindings';

/** How long after typing stops the Turtle is read again for underlines. */
const ANALYSE_DELAY = 250;

const sparqModule = () => import('@sparq-org/sparq');

/** Problems shown per page, so a very broken file never renders thousands of rows at once. */
const PAGE_SIZE = 50;

/** The page of a list to show, kept in range as the list shrinks or grows. */
function usePage<T>(items: T[]) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  return { start: current * PAGE_SIZE, items: items.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE), page: current, pages, setPage, total: items.length };
}

function Pager({ label, pager }: { label: string; pager: ReturnType<typeof usePage> }) {
  if (pager.pages < 2) return null;
  const { start, page, pages, setPage, total } = pager;
  return (
    <nav aria-label={label} className="flex items-center gap-2 text-xs text-muted">
      <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>
        Previous
      </Button>
      <span>
        {(start + 1).toLocaleString()}–{Math.min(start + PAGE_SIZE, total).toLocaleString()} of {total.toLocaleString()}
      </span>
      <Button size="sm" variant="ghost" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
        Next
      </Button>
    </nav>
  );
}

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
      {parts.map((p, i) => (typeof p === 'string' ? <span key={i}>{p}</span> : 'code' in p ? <TermCode key={i} code={p.code} /> : <strong key={i}>{p.strong}</strong>))}
    </>
  );
}

const SEVERITY: Record<Severity, { icon: typeof CircleX; className: string; label: string }> = {
  error: { icon: CircleX, className: 'text-danger', label: 'Error' },
  warning: { icon: TriangleAlert, className: 'text-warn', label: 'Warning' },
  info: { icon: Info, className: 'text-muted', label: 'Note' },
};

/** One problem. Clicking it (or Enter on it) selects the place in the data it's about. */
function ProblemItem({ finding, onReveal }: { finding: Pick<Finding, 'severity' | 'focus' | 'path' | 'parts' | 'hint' | 'at' | 'unlocated'>; onReveal?: (from: number, to: number) => void }) {
  const sev = SEVERITY[finding.severity];
  // The record and property, unless the sentence already names them.
  const named = new Set(finding.parts.flatMap((p) => (typeof p !== 'string' && 'code' in p ? [p.code] : [])));
  const showContext = !!finding.focus && !named.has(finding.focus);
  const body = (
    <>
      <span className="flex items-start gap-2 text-sm">
        <sev.icon className={cx('mt-0.5 size-4 shrink-0', sev.className)} aria-label={sev.label} />
        <span className="min-w-0 flex-1">
          <Sentence parts={finding.parts} />
        </span>
        <span className="shrink-0 text-xs whitespace-nowrap text-muted">{finding.at ? `Line ${finding.at.line}` : 'Location unavailable'}</span>
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
      {!finding.at && finding.unlocated && <span className="mt-1 ml-6 block text-xs text-muted italic">{finding.unlocated}</span>}
      {finding.hint && (
        <span className="mt-1 ml-6 block text-xs text-muted">
          <Sentence parts={finding.hint} />
        </span>
      )}
    </>
  );
  const box = 'block w-full rounded-md border border-line px-3 py-2 text-left';
  if (!finding.at || !onReveal) return <div className={box}>{body}</div>;
  const { from, to } = finding.at;
  return (
    <button type="button" className={cx(box, 'hover:border-accent hover:bg-accent-soft/40 focus-visible:border-accent')} onClick={() => onReveal(from, to)} title="Show this in the data">
      {body}
    </button>
  );
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
  const [formatNote, setFormatNote] = useState<string>();
  const [formatting, setFormatting] = useState(false);
  const reportStale = !!report && checkedData !== data;

  // Everything below reads a settled copy of the text, a moment after typing stops, so big files stay quick to type in.
  const [settled, setSettled] = useState(data);
  useEffect(() => {
    if (settled === data) return;
    const t = setTimeout(() => setSettled(data), ANALYSE_DELAY);
    return () => clearTimeout(t);
  }, [data, settled]);
  const current = settled === data;

  // The data is read after the ontology, so the ontology's prefixes are in scope.
  const doc = useMemo(() => parseTurtle(settled, { prefixes: ontologyPrefixes }), [settled, ontologyPrefixes]);
  const prefixes = useMemo(() => displayPrefixes(doc, ontologyPrefixes), [doc, ontologyPrefixes]);

  // Syntax: sparq is the judge, reading the ontology's prefixes first.
  const header = useMemo(
    () =>
      Object.entries(ontologyPrefixes)
        .map(([p, ns]) => `@prefix ${p}: <${ns}> .\n`)
        .join(''),
    [ontologyPrefixes],
  );
  const [syntax, setSyntax] = useState<{ data: string; error?: { message: string; from: number } }>();
  useEffect(() => {
    let cancelled = false;
    const headerBytes = new TextEncoder().encode(header).length;
    void sparqModule().then(async ({ SparqStore }) => {
      let error: { message: string; from: number } | undefined;
      try {
        (await SparqStore.fromString(header + settled, 'turtle')).free();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        error = parseSyntaxError(message, settled, headerBytes) ?? (doc.error ? { message: doc.error.message, from: doc.error.from } : { message, from: 0 });
      }
      if (!cancelled) setSyntax({ data: settled, error });
    });
    return () => {
      cancelled = true;
    };
  }, [settled, header, doc]);
  const syntaxChecked = syntax?.data === settled;
  const syntaxError = syntaxChecked ? syntax.error : undefined;

  // The ontology is checked along with the data, so records it also describes can't be pinned to the data alone.
  const ontologyDoc = useMemo(() => (ontologyTurtle ? parseTurtle(ontologyTurtle) : undefined), [ontologyTurtle]);
  const ontologySubjects = useMemo(() => new Set(ontologyDoc?.triples.map((t) => termKey(t.s.term)) ?? []), [ontologyDoc]);

  // Findings belong to the data that was checked. Once it changes they're shown faded and no longer underlined or jumped to.
  const shapesIndex = useMemo(() => new ShapesIndex(shapes), [shapes]);
  const findings = useMemo(() => {
    if (!report || checkedData === undefined) return [];
    const checkedDoc = checkedData === settled ? doc : parseTurtle(checkedData, { prefixes: ontologyPrefixes });
    return describeFindings(report.results, { doc: checkedDoc, text: checkedData, prefixes: displayPrefixes(checkedDoc, ontologyPrefixes), shapes: shapesIndex, external: ontologySubjects });
  }, [report, checkedData, settled, doc, ontologyPrefixes, shapesIndex, ontologySubjects]);

  // Every IRI the ontology mentions counts as defined (terms, datatypes, the ontology itself).
  // If the ontology can't be read here, don't guess: no typo warnings.
  const knownTerms = useMemo(() => (!ontologyDoc || ontologyDoc.error ? undefined : new Set(ontologyDoc.iris.map((p) => p.term.value))), [ontologyDoc]);
  const termWarnings = useMemo(() => (knownTerms ? unknownTerms(doc, namespace, knownTerms, prefixes) : []), [doc, namespace, knownTerms, prefixes]);

  /** Live problems: the syntax error and misspelt terms, as list items too. */
  const live = useMemo(() => {
    const out: (Pick<Finding, 'severity' | 'parts' | 'at'> & { text: string; to: number })[] = [];
    const lineAt = lineFinder(settled);
    if (syntaxError) {
      const to = Math.min(settled.length, syntaxError.from + Math.max(1, /^\S*/.exec(settled.slice(syntaxError.from, syntaxError.from + 200))![0].length));
      out.push({ severity: 'error', parts: [`Syntax error: ${syntaxError.message}`], text: `Syntax error: ${syntaxError.message}`, at: { from: syntaxError.from, to, line: lineAt(syntaxError.from) }, to });
    }
    for (const w of termWarnings) out.push({ severity: 'warning', parts: [w.message], text: w.message, at: { from: w.from, to: w.to, line: lineAt(w.from) }, to: w.to });
    return out;
  }, [syntaxError, termWarnings, settled]);

  const livePage = usePage(live);

  const diagnostics = useMemo<EditorDiagnostic[]>(() => {
    const out: EditorDiagnostic[] = [];
    for (const l of live) out.push({ from: l.at!.from, to: l.to, severity: l.severity, message: l.text, source: l.severity === 'error' ? 'Turtle syntax' : 'Ontology terms' });
    if (checkedData === settled) for (const f of findings) for (const r of f.ranges) out.push({ from: r.from, to: r.to, severity: f.severity, message: f.text, source: 'Check against the ontology' });
    return out;
  }, [live, findings, checkedData, settled]);

  // For screen readers: a short, settled summary of what's underlined, announced when it changes.
  const announcement = useMemo(() => {
    if (!current || !syntaxChecked) return undefined;
    if (!live.length) return 'No syntax or term problems in the Turtle.';
    const errors = live.filter((l) => l.severity === 'error').length;
    const warnings = live.length - errors;
    const bits = [errors ? `${errors} syntax error${errors === 1 ? '' : 's'}` : '', warnings ? `${warnings} term warning${warnings === 1 ? '' : 's'}` : ''].filter(Boolean);
    return `${bits.join(' and ')} in the Turtle, listed below the editor.`;
  }, [current, syntaxChecked, live]);
  const [announced, setAnnounced] = useState<string>();
  useEffect(() => {
    if (announcement === undefined) return;
    const t = setTimeout(() => setAnnounced((prev) => (prev === undefined && announcement.startsWith('No ') ? prev : announcement)), 1000);
    return () => clearTimeout(t);
  }, [announcement]);

  const check = () => {
    const s = store();
    if (!s || !shapes) return;
    reportPage.setPage(0);
    // The analysis catches up at once, so the new underlines line up with what was checked.
    setSettled(data);
    try {
      // The ontology goes in the data graph too, so sh:class sees subclass relationships.
      const r = s.validate(`${ontologyTurtle ?? ''}\n${data}`, shapes, 'turtle');
      onResult({ report: { conforms: r.conforms, results: r.results as RawFinding[] }, checkedData: data });
    } catch (e) {
      onResult({ report: null, checkedData: data, error: e });
    }
  };

  // Format only once sparq has read this exact text without a syntax error.
  const canFormat = current && syntaxChecked && !syntaxError;
  const format = async () => {
    if (!canFormat || formatting) return;
    const original = data;
    setFormatting(true);
    try {
      const out = formatTurtle(original, ontologyPrefixes);
      if (out === undefined) {
        setFormatNote('Couldn’t tidy this safely, so it’s unchanged.');
        return;
      }
      if (out === original) {
        setFormatNote('Already tidy.');
        return;
      }
      // Belt and braces: sparq must read the result as the same number of triples.
      const { SparqStore } = await sparqModule();
      const count = async (t: string) => {
        const st = await SparqStore.fromString(header + t, 'turtle');
        try {
          return st.countQuads(null, null, null);
        } finally {
          st.free();
        }
      };
      const [a, b] = await Promise.all([count(original), count(out)]).catch(() => [NaN, NaN]);
      if (!(a === b)) {
        setFormatNote('Couldn’t tidy this safely, so it’s unchanged.');
        return;
      }
      if (latestData.current !== original) return; // edited meanwhile: leave the newer text alone
      onDataChange(out);
      setFormatNote('Tidied the layout. Ctrl/⌘-Z in the editor undoes it.');
    } finally {
      setFormatting(false);
    }
  };
  const latestData = useRef(data);
  latestData.current = data;
  useEffect(() => {
    if (!formatNote) return;
    const t = setTimeout(() => setFormatNote(undefined), 4000);
    return () => clearTimeout(t);
  }, [formatNote]);

  const reveal = (from: number, to: number) => editor.current?.reveal(from, to);
  const reportPage = usePage(findings);
  const errors = findings.filter((f) => f.severity === 'error').length;

  return (
    <Card>
      <CardHeader
        title="Check your data"
        subtitle="Validates Turtle instance data against SHACL shapes generated from the ontology. Problems are underlined in the editor: hover to read one, or click it in the list to jump there."
        icon={ShieldCheck}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button icon={WandSparkles} onClick={() => void format()} loading={formatting} disabled={!canFormat} title={canFormat ? 'Lay the Turtle out tidily, keeping your prefixes and comments' : syntaxError ? 'Fix the syntax error first' : 'Reading the Turtle…'}>
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
          diagnosticsFor={settled}
        />
        <p role="status" aria-live="polite" className="sr-only" data-testid="lint-announcement">
          {announced}
        </p>
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
            <ol className="space-y-1" aria-label="Problems in the Turtle" start={livePage.start + 1}>
              {livePage.items.map((l, i) => (
                <li key={livePage.start + i}>
                  <ProblemItem finding={l} onReveal={reveal} />
                </li>
              ))}
            </ol>
            <Pager label="Pages of problems in the Turtle" pager={livePage} />
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
              <ol className="space-y-1" aria-label="Problems found" start={reportPage.start + 1}>
                {reportPage.items.map((f, i) => (
                  <li key={reportPage.start + i}>
                    <ProblemItem finding={f} onReveal={reportStale ? undefined : reveal} />
                  </li>
                ))}
              </ol>
            )}
            <Pager label="Pages of problems found" pager={reportPage} />
          </div>
        )}
      </div>
    </Card>
  );
}
