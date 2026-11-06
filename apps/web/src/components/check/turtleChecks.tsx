import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleX, Info, TriangleAlert } from 'lucide-react';
import { Button, cx } from '../ui';
import type { EditorDiagnostic } from '../code/CodeEditor';
import { highlightSegments } from '../code/highlight';
import { formatTurtle, parseTurtle, termKey, type Span } from '../../lib/turtleDoc';
import { ShapesIndex, describeFindings, displayPrefixes, lineFinder, parseSyntaxError, type Finding, type Part, type RawFinding, type Severity } from '../../lib/shaclFindings';

/** How long after typing stops the Turtle is read again for underlines. */
const ANALYSE_DELAY = 250;

const sparqModule = () => import('@sparq-org/sparq');

/** Problems shown per page, so a very broken file never renders thousands of rows at once. */
const PAGE_SIZE = 50;

/**
 * The page of a list to show. A list of a different length (an edit, a new
 * check) starts again at page 1, so an old page never comes back.
 */
export function usePage<T>(items: T[]) {
  const [state, setState] = useState({ page: 0, total: items.length });
  // Reset during render (React's pattern for state derived from props), so no stale page is ever drawn.
  if (state.total !== items.length) setState({ page: 0, total: items.length });
  const page = state.total === items.length ? state.page : 0;
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const listRef = useRef<HTMLOListElement>(null);
  const goTo = (p: number) => {
    setState({ page: p, total: items.length });
    // Keyboard and screen-reader users land on the new results, not on the button.
    requestAnimationFrame(() => listRef.current?.focus());
  };
  return { start: current * PAGE_SIZE, items: items.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE), page: current, pages, goTo, reset: () => setState({ page: 0, total: items.length }), total: items.length, listRef };
}

export type Paging = ReturnType<typeof usePage>;

/** "51–100 of 600", which a list's label carries too, so it's read out when focus moves to the new page. */
const rangeText = ({ start, total }: Paging) => `${(start + 1).toLocaleString()}–${Math.min(start + PAGE_SIZE, total).toLocaleString()} of ${total.toLocaleString()}`;
export const listLabel = (name: string, pager: Paging) => (pager.pages > 1 ? `${name}, ${rangeText(pager)}` : name);

export function Pager({ label, pager }: { label: string; pager: Paging }) {
  if (pager.pages < 2) return null;
  const { page, pages, goTo } = pager;
  return (
    <nav aria-label={label} className="flex items-center gap-2 text-xs text-muted">
      <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => goTo(page - 1)}>
        Previous
      </Button>
      <span aria-live="polite">{rangeText(pager)}</span>
      <Button size="sm" variant="ghost" disabled={page >= pages - 1} onClick={() => goTo(page + 1)}>
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
export function ProblemItem({ finding, onReveal }: { finding: Pick<Finding, 'severity' | 'focus' | 'path' | 'parts' | 'hint' | 'at' | 'unlocated'>; onReveal?: (from: number, to: number) => void }) {
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

export interface TurtleChecksInput {
  /** The text in the editor now. */
  data: string;
  /** Called when Format rewrites the text. */
  onDataChange: (data: string) => void;
  /** The SHACL report for `checkedData`, as sparq words it, if there is one. */
  report: { conforms: boolean; results: RawFinding[] } | null;
  /** The terms check for `checkedData`: each issue about a term is underlined wherever the data uses it. */
  terms?: { severity: 'error' | 'warning'; message: string; term?: string }[];
  checkedData?: string;
  /** The ontology's Turtle: records it also describes can't be pinned to the data alone. */
  ontologyTurtle?: string;
  shapes?: string;
  /** Prefixes the ontology declares; the data can use them without declaring them again. */
  ontologyPrefixes: Record<string, string>;
}

/**
 * The Turtle editor's help, for Validate data: a syntax error found as you type (sparq is the
 * judge), the check's problems as sentences in the data's own prefixes with where each one is,
 * the underlines for all of these, a short summary for screen readers, and Format (tidy the
 * layout, keeping prefixes and comments).
 */
export function useTurtleChecks({ data, onDataChange, report, terms, checkedData, ontologyTurtle, shapes, ontologyPrefixes }: TurtleChecksInput) {
  const [formatNote, setFormatNote] = useState<string>();
  const [formatting, setFormatting] = useState(false);

  // Everything below reads a settled copy of the text, a moment after typing stops, so big files stay quick to type in.
  const [settled, setSettled] = useState(data);
  useEffect(() => {
    if (settled === data) return;
    const t = setTimeout(() => setSettled(data), ANALYSE_DELAY);
    return () => clearTimeout(t);
  }, [data, settled]);
  // A new report is for the text as it is now: catch up at once, so its underlines line up.
  useEffect(() => {
    if (checkedData !== undefined && checkedData === data) setSettled(data);
  }, [checkedData, data]);
  const current = settled === data;

  // The data is read after the ontology, so the ontology's prefixes are in scope.
  const doc = useMemo(() => parseTurtle(settled, { prefixes: ontologyPrefixes }), [settled, ontologyPrefixes]);

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
  const checkedDoc = useMemo(() => (checkedData === undefined ? undefined : checkedData === settled ? doc : parseTurtle(checkedData, { prefixes: ontologyPrefixes })), [checkedData, settled, doc, ontologyPrefixes]);
  const findings = useMemo(() => {
    if (!report || checkedData === undefined || !checkedDoc) return [];
    return describeFindings(report.results, { doc: checkedDoc, text: checkedData, prefixes: displayPrefixes(checkedDoc, ontologyPrefixes), shapes: shapesIndex, external: ontologySubjects });
  }, [report, checkedData, checkedDoc, ontologyPrefixes, shapesIndex, ontologySubjects]);

  // Term issues (an undefined or deprecated term) point at every place the data uses the term.
  const termFindings = useMemo<Finding[]>(() => {
    if (!terms || checkedData === undefined || !checkedDoc) return [];
    const lineAt = lineFinder(checkedData);
    const uses = new Map<string, Span[]>();
    for (const p of checkedDoc.iris) if (p.role !== 'directive') uses.set(p.term.value, [...(uses.get(p.term.value) ?? []), { from: p.from, to: p.to }]);
    return terms.map((t) => {
      const ranges = (t.term && uses.get(t.term)) || [];
      return { severity: t.severity, parts: [t.message], text: t.message, ranges, ...(ranges[0] ? { at: { ...ranges[0], line: lineAt(ranges[0].from) } } : {}) };
    });
  }, [terms, checkedData, checkedDoc]);

  /** Live problems: the syntax error, as a list item too. */
  const live = useMemo(() => {
    const out: (Pick<Finding, 'severity' | 'parts' | 'at'> & { text: string; to: number })[] = [];
    if (syntaxError) {
      const lineAt = lineFinder(settled);
      const to = Math.min(settled.length, syntaxError.from + Math.max(1, /^\S*/.exec(settled.slice(syntaxError.from, syntaxError.from + 200))![0].length));
      out.push({ severity: 'error', parts: [`Syntax error: ${syntaxError.message}`], text: `Syntax error: ${syntaxError.message}`, at: { from: syntaxError.from, to, line: lineAt(syntaxError.from) }, to });
    }
    return out;
  }, [syntaxError, settled]);

  const diagnostics = useMemo<EditorDiagnostic[]>(() => {
    const out: EditorDiagnostic[] = [];
    for (const l of live) out.push({ from: l.at!.from, to: l.to, severity: l.severity, message: l.text, source: 'Turtle syntax' });
    if (checkedData === settled) {
      for (const f of termFindings) for (const r of f.ranges) out.push({ from: r.from, to: r.to, severity: f.severity, message: f.text, source: 'Ontology terms' });
      for (const f of findings) for (const r of f.ranges) out.push({ from: r.from, to: r.to, severity: f.severity, message: f.text, source: 'Shapes' });
    }
    return out;
  }, [live, findings, termFindings, checkedData, settled]);

  // For screen readers: a short, settled summary of the syntax check, announced when it changes.
  const announcement = useMemo(() => {
    if (!current || !syntaxChecked) return undefined;
    return live.length ? 'A syntax error in the Turtle, shown below the editor.' : 'No syntax errors in the Turtle.';
  }, [current, syntaxChecked, live]);
  const [announced, setAnnounced] = useState<string>();
  useEffect(() => {
    if (announcement === undefined) return;
    const t = setTimeout(() => setAnnounced((prev) => (prev === undefined && announcement.startsWith('No ') ? prev : announcement)), 1000);
    return () => clearTimeout(t);
  }, [announcement]);

  // Format only once sparq has read this exact text without a syntax error.
  const canFormat = current && syntaxChecked && !syntaxError;
  const latestData = useRef(data);
  latestData.current = data;
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
  useEffect(() => {
    if (!formatNote) return;
    const t = setTimeout(() => setFormatNote(undefined), 4000);
    return () => clearTimeout(t);
  }, [formatNote]);

  return { settled, live, findings, termFindings, diagnostics, announced, syntaxError, syntaxPending: !current || !syntaxChecked, canFormat, format, formatting, formatNote };
}
