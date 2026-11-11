import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { CheckCircle2, Download, FileUp, ListChecks, LoaderCircle, RotateCcw, ShieldCheck, Terminal, TriangleAlert, WandSparkles } from 'lucide-react';
import { DATA_FORMATS, dataFormatForFile, sniffDataFormat, type DataFormat } from '@concord/core/data-formats';
import { DATA_CHECK_LIMITS, DEFAULT_DATA_BASE } from '@concord/core/data-check';
import { DataCheckError, checkDataInBrowser, resetDataCheck, warmDataCheck } from '../../lib/checkDataInBrowser';
import { accountToken, onAccountChange, stillCurrent } from '../../lib/session';
import { api, type DataValidation } from '../../api';
import { useAsync } from '../../lib/hooks';
import { Badge, Button, Card, CardHeader, CodeBlock, InlineError, Select, cx } from '../../components/ui';
import { CollapsibleCard } from '../../components/Disclosure';
import { CodeEditor, type CodeEditorHandle } from '../../components/code/CodeEditor';
import { Pager, ProblemItem, listLabel, usePage, useTurtleChecks } from '../../components/check/turtleChecks';
import type { Finding, RawFinding } from '../../lib/shaclFindings';
import { defaultSampleData, useSampleData } from '../../lib/sampleData';
import { termCompletions } from '../../lib/termCompletions';
import type { CodeLanguage } from '../../components/code/languages';
import { useOntology } from './Layout';

/**
 * Validate instance data against the ontology: edit the sample data (the same
 * records Query runs over), paste or upload RDF, pick a version, and get its
 * SHACL report plus checks on the terms it uses, again each time the data
 * changes. The check runs in this browser (sparq, in a Web Worker), so the
 * data never leaves the device. Turtle gets more help: syntax errors as you
 * type, problems underlined in the editor and listed with their line, term
 * autocomplete and Format. It is the same check as the POST to the ontology
 * IRI that other tools call, so the page also shows how to call that.
 */

type Sources = { key: string; turtle: string; shapes: string };
/**
 * A version's ontology and shapes. A release never changes, so it is fetched once. The working
 * draft can change at any time, so each check fetches it again, except that a check made soon
 * after the page prefetched it uses that copy. What is kept is what this account could read: it
 * is forgotten as soon as the account changes (signing in, out, here or in another tab), along with
 * what the checker parsed and the checks under way, so the next account goes through the server's
 * access check again.
 */
const sources = new Map<string, { at: number; sources: Promise<Sources> }>();
const DRAFT_FRESH_MS = 30_000;
let cachedFor = accountToken();
function forgetSources() {
  sources.clear();
  resetDataCheck();
}
onAccountChange(forgetSources);

/** The draft's Turtle and shapes from the same revision: read again if a merge landed between the two downloads. */
async function draftSources(id: string): Promise<{ turtle: string; shapes: string }> {
  for (let attempt = 0; ; attempt++) {
    const [turtle, shapes] = await Promise.all([api.sourceWithRevision(id, 'turtle'), api.sourceWithRevision(id, 'shacl')]);
    if (turtle.revision === shapes.revision || attempt >= 3) {
      if (turtle.revision !== shapes.revision) throw new DataCheckError('The working draft kept changing while it was downloaded. Try again in a moment.');
      return { turtle: turtle.text, shapes: shapes.text };
    }
  }
}

function versionSources(id: string, version: string, prefetch = false): Promise<Sources> {
  const token = accountToken();
  if (!token.account || !stillCurrent(cachedFor, token.account)) {
    forgetSources();
    cachedFor = token;
  }
  const ref = version === 'draft' ? 'working' : version;
  const key = `${token.account ?? ''}|${id}|${ref}`;
  const draft = ref === 'working';
  const hit = sources.get(key);
  if (hit && (!draft || (!prefetch && Date.now() - hit.at < DRAFT_FRESH_MS))) {
    // A prefetched draft serves one check only.
    if (draft) sources.delete(key);
    return hit.sources;
  }
  const fetched = (draft ? draftSources(id) : Promise.all([api.source(id, 'turtle', ref), api.source(id, 'shacl', ref)]).then(([turtle, shapes]) => ({ turtle, shapes }))).then(({ turtle, shapes }) => {
    // Downloaded for an account that has since signed out or changed: not for this session's eyes.
    if (!token.account || !stillCurrent(token, token.account)) throw new DOMException('Cancelled', 'AbortError');
    return {
      // The worker reuses a parsed version only for exactly the same text.
      key: draft ? `${key}|${hash(turtle)}|${hash(shapes)}` : key,
      turtle,
      shapes,
    };
  });
  if (!draft || prefetch) {
    sources.set(key, { at: Date.now(), sources: fetched });
    fetched.catch(() => sources.get(key)?.sources === fetched && sources.delete(key));
  }
  return fetched;
}

/** A quick string hash (FNV-1a), to tell one draft's text from another's. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

const FORMAT_IDS = Object.keys(DATA_FORMATS) as DataFormat[];
const LANGUAGE: Record<DataFormat, CodeLanguage> = { turtle: 'turtle', trig: 'turtle', ntriples: 'ntriples', nquads: 'ntriples', jsonld: 'json', rdfxml: 'xml' };
/** Larger files are checked but not shown in the editor, which would be slow. */
const EDITOR_LIMIT = 512 * 1024;
const MAX_BYTES = 5 * 1024 * 1024;
/**
 * How long a pause in typing starts a check. A check takes a few milliseconds, so ordinary data is
 * checked almost as you type; a large file waits for a longer pause, so typing in it stays smooth.
 */
const autoCheckDelay = (chars: number) => (chars < 100_000 ? 80 : 400);

type Picked = DataFormat | 'auto';

function short(v: string, prefixes: Record<string, string>) {
  const iri = v.startsWith('<') && v.endsWith('>') ? v.slice(1, -1) : v;
  // Longest namespace first, so vol: wins over a shorter overlapping one.
  for (const [p, ns] of Object.entries(prefixes).sort((a, b) => b[1].length - a[1].length)) if (ns && iri.startsWith(ns)) return `${p}:${iri.slice(ns.length)}`;
  return v;
}

/** Prefixes the data declares (Turtle @prefix / PREFIX, or a JSON-LD @context's string terms), to show results in its own terms. */
function dataPrefixes(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/(?:@prefix|PREFIX)\s+([A-Za-z][\w.-]*|):\s*<([^>\s]+)>/gi)) out[m[1]] = m[2];
  if (/^\s*[[{]/.test(text)) {
    try {
      const ctx = (JSON.parse(text) as { '@context'?: unknown })['@context'];
      if (ctx && typeof ctx === 'object' && !Array.isArray(ctx)) for (const [k, v] of Object.entries(ctx)) if (typeof v === 'string' && /[#/:]$/.test(v) && !k.startsWith('@')) out[k] = v;
    } catch {
      // Not JSON: no prefixes.
    }
  }
  return out;
}

/** The local name of a shape IRI, e.g. VolunteeringOpportunityShape. */
const shapeName = (iri: string) => iri.split(/[#/]/).pop() || iri;

/** Shortens <iri> inside an engine message. */
const shortMessage = (m: string, prefixes: Record<string, string>) => m.replace(/<([^<>\s]+)>/g, (_, iri: string) => short(iri, prefixes));

/** sh:MinCountConstraintComponent → "min count". */
const constraintName = (iri: string) =>
  (iri.split('#').pop() ?? iri)
    .replace(/ConstraintComponent$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();

/** A result of the check, in the words the Turtle helpers read (the engine's own form). */
const toRawFinding = (r: DataValidation['results'][number]): RawFinding => ({
  focusNode: r.focusNode,
  path: r.path ?? null,
  value: r.value ?? null,
  severity: `http://www.w3.org/ns/shacl#${r.severity}`,
  sourceConstraintComponent: r.constraint,
  message: r.message ?? null,
});

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ValidateTab() {
  const { id, ontology, view } = useOntology();
  const [params, setParams] = useSearchParams();
  const releases = useAsync(() => api.releases(id), [id], { keep: `releases|${id}` });
  const published = (releases.data ?? []).filter((r) => r.status === 'published');
  const latest = ontology.currentVersion !== '0.0.0' ? ontology.currentVersion : published[0]?.version;
  const version = params.get('version') ?? latest ?? 'draft';
  // The sample data, shared with Query, is there to start with.
  const [data, setData] = useSampleData(id, ontology);
  const editor = useRef<CodeEditorHandle>(null);
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [picked, setPicked] = useState<Picked>('auto');
  const [report, setReport] = useState<{ result: DataValidation; text: string; format: DataFormat; version: string; ms?: number } | null>(null);
  // The version's ontology and shapes, for describing problems in Turtle.
  const [src, setSrc] = useState<Sources & { version: string }>();
  const [error, setError] = useState<unknown>();
  // Why a chosen file wasn't taken: kept apart from the check's error, so a check finishing for the data already there doesn't clear it.
  const [uploadError, setUploadError] = useState<Error>();
  const [checking, setChecking] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // Bumped whenever the inputs change: a response for an older request is dropped.
  const request = useRef(0);
  // Bumped for each file chosen: a file that finishes reading after a newer one (or after the data was edited) is dropped.
  const loads = useRef(0);
  const [reading, setReading] = useState(false);
  // When the next automatic check runs: at once after a new version, format, file or example; after a pause in typing otherwise.
  const nextCheck = useRef<'now' | 'soon'>('now');
  // Bumped by every invalidation and by Ctrl/⌘-Enter, so a check is always scheduled after one (even when the inputs end up the same).
  const [generation, setGeneration] = useState(0);
  // Checks still running, so a superseded long one can be stopped.
  const inFlight = useRef(new Set<{ controller: AbortController; started: number }>());

  const text = file?.text ?? data;
  const format: DataFormat = picked === 'auto' ? (file && dataFormatForFile(file.name)) || sniffDataFormat(text) : picked;
  // The report shown is for other inputs while a new check runs.
  const stale = !!report && (report.text !== text || report.format !== format || report.version !== version);
  const prefixes = useMemo(() => ({ ...(view.data?.prefixes ?? {}), [ontology.prefix]: ontology.namespace }), [view.data, ontology.prefix, ontology.namespace]);
  const iri = `${window.location.origin}/def/${encodeURIComponent(ontology.slug)}/${version}`;

  // Turtle typed or pasted here gets the editor's help; other formats, and files too large to show, get the report alone.
  const turtleMode = !file && format === 'turtle';
  const turtleReport = report && report.format === 'turtle' && !file ? report : null;
  const raw = useMemo(() => (turtleReport ? { conforms: turtleReport.result.conforms, results: turtleReport.result.results.map(toRawFinding) } : null), [turtleReport]);
  const checks = useTurtleChecks({
    data: turtleMode ? data : '',
    onDataChange: (v) => {
      setData(v);
      invalidate(false, 'now');
    },
    report: raw,
    terms: turtleReport?.result.terms,
    checkedData: turtleReport?.text,
    ontologyTurtle: src?.version === version ? src.turtle : undefined,
    shapes: src?.version === version ? src.shapes : undefined,
    ontologyPrefixes: prefixes,
  });
  const completions = useMemo(() => termCompletions(view.data, 'turtle'), [view.data]);
  const reveal = (from: number, to: number) => editor.current?.reveal(from, to);
  // A syntax error is shown where it is, in the list below the editor, rather than as the check's error too.
  const parseError = (error as { status?: number } | undefined)?.status === 400;
  const showError = !!error && !(turtleMode && parseError && (checks.syntaxError || checks.syntaxPending));
  // Signing in or out (here or in another tab) drops what the last account's sources showed and checks again as the new one.
  const [accountEpoch, setAccountEpoch] = useState(0);
  const examples = useAsync(async () => {
    const res = await fetch(`${iri}/examples/data.ttl`, { cache: 'no-store' });
    return res.ok && !!(await res.text()).trim();
  }, [iri, accountEpoch]);

  useEffect(() => {
    const off = onAccountChange(() => {
      setSrc(undefined);
      setAccountEpoch((n) => n + 1);
      invalidate(true);
    });
    return () => {
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- invalidate only touches refs and setters
  }, []);
  // Fetch the version's ontology and shapes as soon as it is picked, so Validate answers at once.
  useEffect(() => {
    versionSources(id, version, true)
      .then((s) => {
        setSrc({ ...s, version });
        return warmDataCheck({ key: s.key, ontology: s.turtle, shapes: s.shapes, baseIRI: DEFAULT_DATA_BASE, maxTriples: DATA_CHECK_LIMITS.triples });
      })
      .catch(() => {
        /* reported by the check */
      });
  }, [id, version, accountEpoch]);

  const setVersion = (v: string) => {
    const n = new URLSearchParams(params);
    n.set('version', v);
    setParams(n, { replace: true });
    invalidate();
  };

  /**
   * The data, format or version changed: any answer still on its way is for the old inputs, and a file
   * still being read is dropped. `replaced`: the data is new altogether (a file, the example), so the
   * old report goes; otherwise it stays, marked out of date, until the new check answers.
   */
  const invalidate = (replaced = false, when: 'now' | 'soon' = 'now') => {
    request.current++;
    loads.current++;
    setReading(false);
    nextCheck.current = when;
    setGeneration((g) => g + 1);
    if (replaced) setReport(null);
    setUploadError(undefined);
  };

  // Check automatically, and again in the background whenever the data, format or version changes.
  useEffect(() => {
    if (reading) return;
    if (!text.trim()) {
      request.current++;
      setReport(null);
      setError(undefined);
      setChecking(false);
      return;
    }
    const delay = nextCheck.current === 'now' ? 0 : autoCheckDelay(text.length);
    nextCheck.current = 'soon';
    // Numbered now, not when it starts: an answer still on its way for the inputs before is dropped from
    // this moment, so it can't land in between and mark the new inputs as checked.
    const id = ++request.current;
    setChecking(true);
    const t = setTimeout(() => void run(id), delay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run reads this render's inputs
  }, [text, format, version, reading, generation]);

  const run = async (id: number) => {
    const snapshot = { text, format, version };
    // A check for older inputs is stopped once it has run 500 ms (a large file), now or later; a quick one
    // finishes first and its answer is dropped. Either way it never holds up this one for long.
    for (const previous of inFlight.current) setTimeout(() => previous.controller.abort(), Math.max(0, previous.started + 500 - Date.now()));
    const controller = new AbortController();
    const mine = { controller, started: Date.now() };
    inFlight.current.add(mine);
    try {
      const { ms, ...result } = await checkHere(snapshot, false, controller.signal);
      if (id !== request.current) return;
      setReport({ result, ...snapshot, ms });
      setError(undefined);
    } catch (e) {
      if (id !== request.current) return;
      setError(e);
      // Data that can't be read yet (half typed) keeps the last report, faded, rather than losing it.
      if ((e as { status?: number }).status !== 400) setReport(null);
    } finally {
      inFlight.current.delete(mine);
      if (id === request.current) setChecking(false);
    }
  };

  /** Checks data in this browser against a version's ontology and shapes (downloaded once per release). */
  const checkHere = async (s: { text: string; format: DataFormat; version: string }, turtle = false, signal?: AbortSignal): Promise<DataValidation & { turtle?: string; ms: number }> => {
    if (new Blob([s.text]).size > DATA_CHECK_LIMITS.bytes) throw new Error(`The data is larger than ${DATA_CHECK_LIMITS.bytes / 1024 / 1024} MB.`);
    const src = await versionSources(id, s.version);
    const outcome = await checkDataInBrowser({ key: src.key, ontology: src.turtle, shapes: src.shapes, text: s.text, format: s.format, baseIRI: DEFAULT_DATA_BASE, maxTriples: DATA_CHECK_LIMITS.triples, turtle }, { signal });
    return { ontology: ontology.ontologyIRI, version: s.version, ...outcome };
  };

  const load = async (f: File) => {
    // Refused before anything changes: the data already there, and its check, stay as they were.
    if (f.size > MAX_BYTES) return setUploadError(new Error(`${f.name} is larger than 5 MB, the most the validator accepts.`));
    setError(undefined);
    invalidate(true);
    const token = loads.current;
    setReading(true);
    let content: string;
    try {
      content = await f.text();
    } catch (e) {
      if (token === loads.current) {
        setReading(false);
        setUploadError(e instanceof Error ? e : new Error(`${f.name} couldn't be read.`));
      }
      return;
    }
    // Something newer happened while the file was read (another file, an edit, a new version): keep that.
    if (token !== loads.current) return;
    // The file's contents become the data now, so nothing reported or asked for before can stand.
    invalidate(true);
    if (content.length > EDITOR_LIMIT) {
      setFile({ name: f.name, text: content });
    } else {
      setFile(null);
      setData(content);
    }
    const byName = dataFormatForFile(f.name);
    setPicked(byName ?? 'auto');
  };

  const loadExamples = async () => {
    setError(undefined);
    invalidate(true);
    const mine = loads.current;
    const token = accountToken();
    setReading(true);
    try {
      const res = await fetch(`${iri}/examples/data.ttl`, { cache: 'no-store' });
      if (!res.ok) throw new Error('The example data could not be loaded. Try again.');
      const text = await res.text();
      if (mine !== loads.current || !token.account || !stillCurrent(token, token.account)) return;
      if (!text.trim()) throw new Error('This version has no example data.');
      setFile(null);
      setPicked('turtle');
      setData(text);
      invalidate(true);
    } catch (e) {
      if (mine === loads.current) setUploadError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      if (mine === loads.current) setReading(false);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void load(f);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Validate data"
          subtitle={`Check RDF data against ${ontology.title}: the SHACL shapes derived from it, and the terms it defines`}
          icon={ShieldCheck}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <CheckStatus checking={reading || (checking && !!text.trim())} done={!!report && !stale} ms={report?.ms} />
              {turtleMode && (
                <Button icon={WandSparkles} onClick={() => void checks.format()} loading={checks.formatting} disabled={!checks.canFormat} title={checks.canFormat ? 'Lay the Turtle out tidily, keeping your prefixes and comments' : checks.syntaxError ? 'Fix the syntax error first' : 'Reading the Turtle…'}>
                  Format
                </Button>
              )}
            </div>
          }
        />
        <div className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={version} onChange={(e) => setVersion(e.target.value)} className="max-w-64" aria-label="Version to validate against">
              {published.map((r) => (
                <option key={r.id} value={r.version}>
                  v{r.version}
                  {r.version === latest ? ' (latest release)' : ''}
                </option>
              ))}
              {latest && !published.some((r) => r.version === latest) && <option value={latest}>v{latest} (latest release)</option>}
              <option value="draft">Working draft</option>
            </Select>
            <Select value={picked} onChange={(e) => {
                setPicked(e.target.value as Picked);
                invalidate();
              }} className="max-w-64" aria-label="Data format">
              <option value="auto">{text.trim() ? `Detect format (${DATA_FORMATS[format].label})` : 'Detect format'}</option>
              {FORMAT_IDS.map((f) => (
                <option key={f} value={f}>
                  {DATA_FORMATS[f].label}
                </option>
              ))}
            </Select>
            <input
              ref={fileInput}
              type="file"
              className="sr-only"
              accept={FORMAT_IDS.flatMap((f) => DATA_FORMATS[f].extensions.map((x) => `.${x}`)).join(',')}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void load(f);
                e.target.value = '';
              }}
              data-testid="validate-file"
              aria-label="Upload a data file"
            />
            <Button icon={FileUp} onClick={() => fileInput.current?.click()}>
              Upload a file
            </Button>
            {examples.data && !examples.loading && (
              <a href={`${iri}/examples/data.ttl`} className="text-sm text-accent hover:underline" onClick={(e) => {
                e.preventDefault();
                void loadExamples();
              }}>
                Use example data
              </a>
            )}
            <Button
              variant="ghost"
              icon={RotateCcw}
              disabled={!file && data === defaultSampleData(ontology)}
              onClick={() => {
                setFile(null);
                setPicked('auto');
                invalidate(true);
                setData(defaultSampleData(ontology));
              }}
            >
              Reset to the sample
            </Button>
          </div>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cx('rounded-lg', dragging && 'ring-2 ring-accent')}
            data-testid="validate-drop"
          >
            {file ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface-2 px-4 py-3 text-sm" data-testid="validate-file-summary">
                <span>
                  <span className="font-medium">{file.name}</span> <span className="text-muted">({Math.round(file.text.length / 1024).toLocaleString()} KB, too large to show here)</span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setFile(null);
                    invalidate(true);
                  }}
                >
                  Remove
                </Button>
              </div>
            ) : (
              <CodeEditor
                ref={editor}
                value={data}
                onChange={(v) => {
                  // The editor also reports the text this page put in it: only an edit changes anything.
                  if (v === data) return;
                  setData(v);
                  invalidate(false, 'soon');
                }}
                language={LANGUAGE[format]}
                onRun={() => {
                  nextCheck.current = 'now';
                  setGeneration((g) => g + 1);
                }}
                ariaLabel="Data to validate"
                placeholder="Paste Turtle, JSON-LD, N-Triples, N-Quads, TriG or RDF/XML, or drop a file here"
                minHeight={220}
                maxHeight={420}
                testId="validate-editor"
                {...(turtleMode ? { completions, diagnostics: checks.diagnostics, diagnosticsFor: checks.settled } : {})}
              />
            )}
          </div>
          {turtleMode && (
            <p role="status" aria-live="polite" className="sr-only" data-testid="lint-announcement">
              {checks.announced}
            </p>
          )}
          {/* No standing line about limits: the error says what the limit is when data goes over it. */}
          {turtleMode && checks.formatNote && (
            <p role="status" className="text-xs">
              {checks.formatNote}
            </p>
          )}
          {turtleMode && checks.live.length > 0 && (
            <ol className="space-y-1" aria-label="Problems in the Turtle" data-testid="data-lint">
              {checks.live.map((l, i) => (
                <li key={i}>
                  <ProblemItem finding={l} onReveal={reveal} />
                </li>
              ))}
            </ol>
          )}
          {uploadError ? <InlineError error={uploadError} /> : null}
          {showError ? <InlineError error={error} /> : null}
        </div>
      </Card>

      {report && (
        <Report
          stale={stale}
          report={report.result}
          prefixes={{ ...dataPrefixes(report.text), ...prefixes }}
          onTurtle={async () => (await checkHere(report, true)).turtle ?? ''}
          name={`${ontology.slug}-${report.version}-report`}
          located={turtleReport ? { findings: checks.findings, terms: checks.termFindings, onReveal: stale ? undefined : reveal } : undefined}
        />
      )}

      <CollapsibleCard title="Validate from your own code" subtitle="The same check is an HTTP POST to the ontology’s address" icon={Terminal} id="validate-api">
        <ApiHelp iri={iri} />
      </CollapsibleCard>
    </div>
  );
}

/** "Checking…" while a check runs, "Checked" once the report matches the data. */
function CheckStatus({ checking, done, ms }: { checking: boolean; done: boolean; ms?: number }) {
  return (
    <span role="status" aria-live="polite" data-testid="validate-status" className="inline-flex min-h-8 items-center gap-1.5 text-sm text-muted">
      {checking ? (
        <>
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
          Checking…
        </>
      ) : done ? (
        <>
          <CheckCircle2 className="size-4 text-accent" aria-hidden />
          {ms === undefined ? 'Checked' : `Checked in ${ms < 1 ? '<1' : Math.round(ms)} ms`}
        </>
      ) : null}
    </span>
  );
}

/** Turtle's problems, as sentences with where each one is in the data. */
type Located = { findings: Finding[]; terms: Finding[]; onReveal?: (from: number, to: number) => void };

function Report({ report, prefixes, onTurtle, name, stale, located }: { report: DataValidation; prefixes: Record<string, string>; onTurtle: () => Promise<string>; name: string; stale: boolean; located?: Located }) {
  const [saving, setSaving] = useState(false);
  const shapesPage = usePage(located?.findings ?? []);
  const [saveError, setSaveError] = useState<unknown>();
  const byFocus = useMemo(() => {
    const groups = new Map<string, DataValidation['results']>();
    for (const r of report.results) groups.set(r.focusNode, [...(groups.get(r.focusNode) ?? []), r]);
    return [...groups.entries()];
  }, [report.results]);
  const { violations, warnings, infos, termErrors, termWarnings } = report.summary;
  const problems = violations + warnings + infos;
  // The lists may be cut short (see truncated); the summary counts everything.
  const termIssues = termErrors + termWarnings;
  return (
    // While the data is checked again, the old report stays (faded) rather than flashing away, and can't be downloaded.
    <Card className={cx('transition-opacity', stale && 'opacity-60')}>
      <CardHeader
        title="Report"
        subtitle={<span data-testid="validation-subtitle">{`${report.triples.toLocaleString()} triple${report.triples === 1 ? '' : 's'} checked against ${report.version === 'draft' ? 'the working draft' : `v${report.version}`}`}</span>}
        icon={ListChecks}
        actions={
          <div className="flex gap-2">
            <Button size="sm" icon={Download} disabled={stale} onClick={() => download(`${name}.json`, JSON.stringify(report, null, 2), 'application/json')}>
              JSON
            </Button>
            <Button
              size="sm"
              icon={Download}
              loading={saving}
              disabled={stale}
              onClick={async () => {
                setSaving(true);
                setSaveError(undefined);
                try {
                  download(`${name}.ttl`, await onTurtle(), 'text/turtle');
                } catch (e) {
                  setSaveError(e);
                } finally {
                  setSaving(false);
                }
              }}
            >
              SHACL report (Turtle)
            </Button>
          </div>
        }
      />
      <div className="space-y-4 p-4" data-testid="validation-report" aria-busy={stale}>
        {saveError ? <InlineError error={saveError} /> : null}
        <div className="flex flex-wrap items-center gap-2" data-testid="validation-verdict">
          {report.conforms ? (
            <Badge tone="ok" icon={CheckCircle2}>
              Conforms to the shapes
            </Badge>
          ) : (
            <Badge tone="danger" icon={TriangleAlert}>
              {[violations && `${violations.toLocaleString('en')} violation${violations === 1 ? '' : 's'}`, warnings && `${warnings.toLocaleString('en')} warning${warnings === 1 ? '' : 's'}`, infos && `${infos.toLocaleString('en')} note${infos === 1 ? '' : 's'}`].filter(Boolean).join(', ') || `${problems} problems`}
            </Badge>
          )}
          {termIssues > 0 ? (
            <Badge tone={termErrors ? 'danger' : 'warn'}>
              {termIssues.toLocaleString('en')} term issue{termIssues === 1 ? '' : 's'}
            </Badge>
          ) : (
            <Badge tone="ok">Every term is defined</Badge>
          )}
        </div>
        {report.truncated && (
          <p className="text-xs text-muted" data-testid="validation-truncated">
            The report lists the first 1,000 results and term issues. The counts above include them all.
          </p>
        )}

        {report.terms.length > 0 && (
          <section aria-labelledby="terms-heading" className="space-y-2">
            <h3 id="terms-heading" className="text-sm font-semibold">
              Terms
            </h3>
            {located ? (
              <ul className="space-y-1" data-testid="validation-terms">
                {located.terms.map((t, i) => (
                  <li key={i}>
                    <ProblemItem finding={t} onReveal={located.onReveal} />
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="space-y-1 text-sm" data-testid="validation-terms">
                {report.terms.map((t, i) => (
                  <li key={i} className="flex items-start gap-2 rounded-md border border-line px-3 py-2">
                    <Badge tone={t.severity === 'error' ? 'danger' : 'warn'}>{t.severity === 'error' ? 'Error' : 'Warning'}</Badge>
                    <span>{t.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {located && located.findings.length > 0 && (
          <section aria-labelledby="shacl-heading" className="space-y-2">
            <h3 id="shacl-heading" className="text-sm font-semibold">
              Shapes
            </h3>
            <ol ref={shapesPage.listRef} tabIndex={-1} className="space-y-1 outline-none" aria-label={listLabel('Problems found', shapesPage)} start={shapesPage.start + 1} data-testid="validation-results">
              {shapesPage.items.map((f, i) => (
                <li key={shapesPage.start + i}>
                  <ProblemItem finding={f} onReveal={located.onReveal} />
                </li>
              ))}
            </ol>
            <Pager label="Pages of problems found" pager={shapesPage} />
          </section>
        )}

        {!located && byFocus.length > 0 && (
          <section aria-labelledby="shacl-heading" className="space-y-2">
            <h3 id="shacl-heading" className="text-sm font-semibold">
              Shapes
            </h3>
            <ul className="space-y-2" data-testid="validation-results">
              {byFocus.slice(0, 200).map(([focus, results]) => (
                <li key={focus} className="rounded-md border border-line">
                  <div className="border-b border-line bg-surface-2 px-3 py-1.5 font-mono text-xs">{short(focus, prefixes)}</div>
                  <ul className="divide-y divide-line text-sm">
                    {results.map((r, i) => (
                      <li key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-3 py-2">
                        {r.severity !== 'Violation' && <Badge tone={r.severity === 'Warning' ? 'warn' : 'neutral'}>{r.severity}</Badge>}
                        {r.path && <span className="font-mono text-xs text-accent">{short(r.path, prefixes)}</span>}
                        <span className="min-w-[12rem] flex-1">{r.message ? shortMessage(r.message, prefixes) : constraintName(r.constraint)}</span>
                        {r.value && <span className="font-mono text-xs text-muted">value {short(r.value, prefixes)}</span>}
                        <span className="text-xs text-muted" title={r.constraint}>
                          {constraintName(r.constraint)}
                          {r.shape ? ` · ${shapeName(r.shape)}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            {byFocus.length > 200 && <p className="text-xs text-muted">Showing the first 200 nodes. Download the report for the rest.</p>}
          </section>
        )}
      </div>
    </Card>
  );
}

/** Inline code in the API notes: a quiet chip, so header names and values stand out from the prose. */
function C({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cx('rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.85em]', className)}>{children}</code>;
}

function ApiHelp({ iri }: { iri: string }) {
  const examples = [
    { label: 'Validate a file (JSON report)', code: `curl -X POST ${iri} \\\n  -H 'Content-Type: text/turtle' \\\n  --data-binary @data.ttl` },
    { label: 'Get a SHACL validation report in Turtle', code: `curl -X POST ${iri} \\\n  -H 'Content-Type: application/ld+json' \\\n  -H 'Accept: text/turtle' \\\n  --data-binary @data.jsonld` },
    { label: 'Get the SHACL shapes by content negotiation', code: `curl ${iri} \\\n  -H 'Accept-Profile: <http://www.w3.org/ns/shacl#>'` },
  ];
  const facts: [string, ReactNode][] = [
    ['Address', <C key="a" className="break-all">{iri}</C>],
    [
      'Body',
      <>
        Turtle, JSON-LD, N-Triples, N-Quads, TriG or RDF/XML, with a matching <C>Content-Type</C>
      </>,
    ],
    [
      'Answer',
      <>
        JSON by default, or a standard SHACL <C>sh:ValidationReport</C> with <C>Accept: text/turtle</C>
      </>,
    ],
    [
      'Status',
      <>
        <C>200</C> whether or not the data conforms, so read <C>conforms</C> and <C>valid</C>
      </>,
    ],
    ['Limits', 'Any site can call it, with no sign-in, up to 30 times a minute'],
  ];
  return (
    <div className="space-y-5 p-5 text-sm">
      <p>POST RDF to the ontology’s address, or to one version’s address, to validate it.</p>
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[max-content_minmax(0,1fr)]" data-testid="validate-api-facts">
        {facts.map(([term, detail]) => (
          <div key={term} className="contents">
            <dt className="font-medium text-muted">{term}</dt>
            <dd className="mb-1 sm:mb-0">{detail}</dd>
          </div>
        ))}
      </dl>
      {examples.map((x) => (
        <section key={x.label} className="space-y-2">
          <h4 className="text-sm font-medium">{x.label}</h4>
          <CodeBlock code={x.code} copyText={x.code.replace(/\\\n\s*/g, '')} language="shell" ariaLabel={x.label} />
        </section>
      ))}
      <p className="text-muted">
        Post to the address on this site rather than the persistent w3id.org IRI: the w3id redirect turns a POST into a GET. Coding agents can run the same check with the <C>validate_data</C> tool after{' '}
        <Link to="../connect" relative="path" className="text-accent hover:underline">
          connecting an agent
        </Link>
        .
      </p>
    </div>
  );
}
