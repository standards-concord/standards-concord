import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { CheckCircle2, Download, FileUp, ListChecks, LoaderCircle, ShieldCheck, Terminal, TriangleAlert } from 'lucide-react';
import { DATA_FORMATS, dataFormatForFile, sniffDataFormat, type DataFormat } from '@concord/core/data-formats';
import { DATA_CHECK_LIMITS, DEFAULT_DATA_BASE } from '@concord/core/data-check';
import { checkDataInBrowser, warmDataCheck } from '../../lib/checkDataInBrowser';
import { api, type DataValidation } from '../../api';
import { useAsync } from '../../lib/hooks';
import { Badge, Button, Card, CardHeader, CopyButton, InlineError, Select, cx } from '../../components/ui';
import { CollapsibleCard } from '../../components/Disclosure';
import { CodeEditor } from '../../components/code/CodeEditor';
import { HighlightedCode } from '../../components/code/CodeView';
import type { CodeLanguage } from '../../components/code/languages';
import { useOntology } from './Layout';

/**
 * Validate instance data against the ontology: paste or upload RDF, pick a
 * version, and get its SHACL report plus checks on the terms it uses. The
 * check runs in this browser (sparq, in a Web Worker), so the data never
 * leaves the device. It is the same check as the POST to the ontology IRI
 * that other tools call, so the page also shows how to call that.
 */

type Sources = { key: string; turtle: string; shapes: string };
/**
 * A version's ontology and shapes. A release never changes, so it is fetched once. The working
 * draft can change at any time, so each check fetches it again, except that a check made soon
 * after the page prefetched it uses that copy.
 */
const sources = new Map<string, { at: number; sources: Promise<Sources> }>();
const DRAFT_FRESH_MS = 30_000;
function versionSources(id: string, version: string, prefetch = false): Promise<Sources> {
  const ref = version === 'draft' ? 'working' : version;
  const key = `${id}|${ref}`;
  const draft = ref === 'working';
  const hit = sources.get(key);
  if (hit && (!draft || (!prefetch && Date.now() - hit.at < DRAFT_FRESH_MS))) {
    // A prefetched draft serves one check only.
    if (draft) sources.delete(key);
    return hit.sources;
  }
  const fetched = Promise.all([api.source(id, 'turtle', ref), api.source(id, 'shacl', ref)]).then(([turtle, shapes]) => ({
    // The worker reuses a parsed version only for exactly the same text.
    key: draft ? `${key}|${hash(turtle)}|${hash(shapes)}` : key,
    turtle,
    shapes,
  }));
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

/** An example with something to find: a missing required value, a value of the wrong type, and a misspelt term. */
function exampleData(ns: string, prefix: string, classes: { iri: string; restrictions: unknown[] }[]): string {
  const head = `@prefix ${prefix}: <${ns}> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n@prefix ex: <https://example.org/data/> .\n\n`;
  if (classes.some((c) => c.iri === `${ns}VolunteeringOpportunity`)) {
    return `${head}ex:foodbank a ${prefix}:VolunteerInvolvingOrganisation ;
  rdfs:label "Northvale Food Bank" ;
  ${prefix}:offersOpportunity ex:saturday-shift .

ex:saturday-shift a ${prefix}:VolunteeringOpportunity ;
  ${prefix}:title "Saturday food bank shift" ;
  ${prefix}:offeredBy ex:foodbank ;
  ${prefix}:minimumAge "sixteen" ;
  ${prefix}:sumary "Sort and pack food parcels." .
`;
  }
  const picks = classes
    .filter((c) => c.iri.startsWith(ns))
    .sort((a, b) => b.restrictions.length - a.restrictions.length)
    .slice(0, 2);
  return head + picks.map((c, i) => `ex:example-${i + 1} a ${prefix}:${c.iri.slice(ns.length)} ;\n  rdfs:label "Example ${i + 1}" .\n`).join('\n');
}

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
  const releases = useAsync(() => api.releases(id), [id]);
  const published = (releases.data ?? []).filter((r) => r.status === 'published');
  const latest = ontology.currentVersion !== '0.0.0' ? ontology.currentVersion : published[0]?.version;
  const version = params.get('version') ?? latest ?? 'draft';
  const [data, setData] = useState('');
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [picked, setPicked] = useState<Picked>('auto');
  const [report, setReport] = useState<{ result: DataValidation; text: string; format: DataFormat; version: string; ms?: number } | null>(null);
  const [error, setError] = useState<unknown>();
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
  // Bumped by Ctrl/⌘-Enter to check straight away.
  const [checkNow, setCheckNow] = useState(0);
  const inFlight = useRef<{ controller: AbortController; started: number }>(undefined);

  const text = file?.text ?? data;
  const format: DataFormat = picked === 'auto' ? (file && dataFormatForFile(file.name)) || sniffDataFormat(text) : picked;
  // The report shown is for other inputs while a new check runs.
  const stale = !!report && (report.text !== text || report.format !== format || report.version !== version);
  const prefixes = useMemo(() => ({ ...(view.data?.prefixes ?? {}), [ontology.prefix]: ontology.namespace }), [view.data, ontology.prefix, ontology.namespace]);
  const iri = `${window.location.origin}/def/${encodeURIComponent(ontology.slug)}/${version}`;
  // Fetch the version's ontology and shapes as soon as it is picked, so Validate answers at once.
  useEffect(() => {
    versionSources(id, version, true)
      .then((src) => warmDataCheck({ key: src.key, ontology: src.turtle, shapes: src.shapes, baseIRI: DEFAULT_DATA_BASE, maxTriples: DATA_CHECK_LIMITS.triples }))
      .catch(() => {
        /* reported by the check */
      });
  }, [id, version]);

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
    if (replaced) setReport(null);
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
    setChecking(true);
    const t = setTimeout(() => void run(), delay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run reads this render's inputs
  }, [text, format, version, reading, checkNow]);

  const run = async () => {
    const id = ++request.current;
    const snapshot = { text, format, version };
    // A long check for older inputs (a large file) is stopped; a quick one finishes and its answer is dropped.
    const previous = inFlight.current;
    if (previous && Date.now() - previous.started > 500) previous.controller.abort();
    const controller = new AbortController();
    inFlight.current = { controller, started: Date.now() };
    try {
      const { ms, ...result } = await checkHere(snapshot, false, controller.signal);
      if (id !== request.current) return;
      setReport({ result, ...snapshot, ms });
      setError(undefined);
    } catch (e) {
      if (id !== request.current) return;
      setError(e);
      setReport(null);
    } finally {
      if (inFlight.current?.controller === controller) inFlight.current = undefined;
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
    setError(undefined);
    invalidate(true);
    if (f.size > MAX_BYTES) return setError(new Error(`${f.name} is larger than 5 MB, the most the validator accepts.`));
    const token = loads.current;
    setReading(true);
    let content: string;
    try {
      content = await f.text();
    } catch (e) {
      if (token === loads.current) {
        setReading(false);
        setError(e);
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
            <CheckStatus checking={reading || (checking && !!text.trim())} done={!!report && !stale} ms={report?.ms} />
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
            <Button
              variant="ghost"
              onClick={() => {
                setFile(null);
                setPicked('auto');
                invalidate(true);
                setData(exampleData(ontology.namespace, ontology.prefix, view.data?.classes ?? []));
              }}
            >
              Try an example
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
                  setCheckNow((n) => n + 1);
                }}
                ariaLabel="Data to validate"
                placeholder="Paste Turtle, JSON-LD, N-Triples, N-Quads, TriG or RDF/XML, or drop a file here"
                minHeight={220}
                maxHeight={420}
                testId="validate-editor"
              />
            )}
          </div>
          <p className="text-xs text-muted">Up to 5 MB (JSON-LD 2 MB) or 25,000 distinct triples. Your data is checked here in your browser as you type, and never leaves this device.</p>
          {error ? <InlineError error={error} /> : null}
        </div>
      </Card>

      {report && <Report stale={stale} report={report.result} prefixes={{ ...dataPrefixes(report.text), ...prefixes }} onTurtle={async () => (await checkHere(report, true)).turtle ?? ''} name={`${ontology.slug}-${report.version}-report`} />}

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

function Report({ report, prefixes, onTurtle, name, stale }: { report: DataValidation; prefixes: Record<string, string>; onTurtle: () => Promise<string>; name: string; stale: boolean }) {
  const [saving, setSaving] = useState(false);
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
            <ul className="space-y-1 text-sm" data-testid="validation-terms">
              {report.terms.map((t, i) => (
                <li key={i} className="flex items-start gap-2 rounded-md border border-line px-3 py-2">
                  <Badge tone={t.severity === 'error' ? 'danger' : 'warn'}>{t.severity === 'error' ? 'Error' : 'Warning'}</Badge>
                  <span>{t.message}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {byFocus.length > 0 && (
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

function ApiHelp({ iri }: { iri: string }) {
  const examples = [
    { label: 'Validate a file (JSON report)', code: `curl -X POST ${iri} \\\n  -H 'Content-Type: text/turtle' \\\n  --data-binary @data.ttl` },
    { label: 'Get a SHACL validation report in Turtle', code: `curl -X POST ${iri} \\\n  -H 'Content-Type: application/ld+json' \\\n  -H 'Accept: text/turtle' \\\n  --data-binary @data.jsonld` },
    { label: 'Get the SHACL shapes by content negotiation', code: `curl ${iri} \\\n  -H 'Accept-Profile: <http://www.w3.org/ns/shacl#>'` },
  ];
  return (
    <div className="space-y-4 text-sm">
      <p>
        POST RDF to the ontology’s address (or a version’s address) to validate it. The body can be Turtle, JSON-LD, N-Triples, N-Quads, TriG or RDF/XML. The answer is JSON by default, or a standard SHACL{' '}
        <code>sh:ValidationReport</code> with <code>Accept: text/turtle</code>. It is <code>200</code> whether or not the data conforms; check <code>conforms</code> and <code>valid</code>. Any site can call it, with no sign-in, up to 30 times a
        minute.
      </p>
      {examples.map((x) => (
        <div key={x.label} className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{x.label}</span>
            <CopyButton text={x.code.replace(/\\\n\s*/g, '')} label="Copy" />
          </div>
          <pre className="overflow-x-auto rounded-md border border-line bg-surface-2 p-3 text-xs" data-testid="validate-api-example">
            <HighlightedCode code={x.code} language="text" />
          </pre>
        </div>
      ))}
      <p className="text-muted">
        Post to the address on this site rather than the persistent w3id.org IRI: the w3id redirect turns a POST into a GET. Coding agents can run the same check with the <code>validate_data</code> tool after{' '}
        <Link to="../connect" relative="path" className="text-accent hover:underline">
          connecting an agent
        </Link>
        .
      </p>
    </div>
  );
}
