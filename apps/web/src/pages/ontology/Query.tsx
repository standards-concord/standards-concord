import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { BookOpen, ChevronLeft, ChevronRight, Code2, Cpu, Database, Download, Pencil, Play, Search, ShieldCheck, Workflow } from 'lucide-react';
import type { SparqStore } from '@sparq-org/sparq';
import type { Completion } from '@codemirror/autocomplete';
import { api } from '../../api';
import { useAsync, useLocalStorage } from '../../lib/hooks';
import { allTerms, makeLabeler } from '../../lib/ontology';
import { buildSparql, newStep, pathLabels, type BuilderModel } from '../../lib/sparql-builder';
import { insertTerm } from '../../lib/prefixes';
import { toCsv } from '../../lib/csv';
import { queryForm, sparqlExamples } from '../../lib/sparql-examples';
import { Badge, Button, Card, CardHeader, ErrorCard, InlineError, Loading, Select, cx } from '../../components/ui';
import { CodeEditor } from '../../components/code/CodeEditor';
import { CodeView, HighlightedCode } from '../../components/code/CodeView';
import { QueryBuilder } from '../../components/query/QueryBuilder';
import { QueryDiagram } from '../../components/query/QueryDiagram';
import { propertyOptions, type PropertyOption } from '../../components/query/schema';
import { useOntology } from './Layout';

/**
 * Query the ontology and check instance data entirely in the browser, using
 * the sparq SPARQL engine compiled to WebAssembly. Nothing is sent to the server.
 * Queries are written in a highlighted SPARQL editor (with autocomplete for the
 * ontology's terms) or built visually.
 */

const sparqModule = () => import('@sparq-org/sparq');

type ResultRows = { kind: 'rows'; vars: string[]; rows: Record<string, string>[]; labels?: Record<string, string>; limit?: number };
type Result = ResultRows | { kind: 'ask'; answer: boolean } | { kind: 'graph'; text: string; count: number };

type Mode = 'builder' | 'sparql';
type Target = 'ontology' | 'data';

/** Sample data for the demo (volunteering) ontology. Other ontologies start from an empty skeleton. */
const DEMO_DATA = (ns: string, prefix: string) => `@prefix ${prefix}: <${ns}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ex: <https://example.org/data/> .

# Example records. The Saturday shift's minimum age is deliberately written as
# text ("sixteen") so that "Check" has a problem to find.

ex:foodbank a ${prefix}:VolunteerInvolvingOrganisation ;
  rdfs:label "Northvale Food Bank" .

ex:saturday-shift a ${prefix}:VolunteeringOpportunity ;
  ${prefix}:title "Saturday food bank shift" ;
  ${prefix}:offeredBy ex:foodbank ;
  ${prefix}:minimumAge "sixteen" .

ex:park-clean-up a ${prefix}:VolunteeringOpportunity ;
  ${prefix}:title "Park clean-up" ;
  ${prefix}:offeredBy ex:foodbank ;
  ${prefix}:minimumAge "14"^^xsd:nonNegativeInteger .
`;

const EMPTY_DATA = (ns: string, prefix: string) => `@prefix ${prefix}: <${ns}> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ex: <https://example.org/data/> .

# Add example records that use this ontology, for example:
# ex:thing1 a ${prefix}:SomeClass ; rdfs:label "Thing one" .
`;

function short(v: string, prefixes: Record<string, string>) {
  for (const [p, ns] of Object.entries(prefixes)) if (v.startsWith(ns)) return `${p}:${v.slice(ns.length)}`;
  return v;
}


function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { id: T; label: string; icon: typeof Code2 }[]; label: string }) {
  return (
    <div className="inline-flex gap-1 rounded-lg border border-line-strong p-0.5" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={o.id === value}
          onClick={() => onChange(o.id)}
          className={cx('inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-sm', o.id === value ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg')}
        >
          <o.icon className="size-3.5" />
          {o.label}
        </button>
      ))}
    </div>
  );
}

const ROWS_PER_PAGE = 50;
const FINDINGS_PER_PAGE = 20;

/** Previous / next paging for long results, so a big answer doesn't flood the page. */
function Pager({ page, pageSize, total, onPage, label }: { page: number; pageSize: number; total: number; onPage: (p: number) => void; label: string }) {
  const pages = Math.ceil(total / pageSize);
  if (pages <= 1) return null;
  return (
    <nav className="flex items-center justify-end gap-2 px-3 py-1.5 text-xs text-muted" aria-label={label}>
      <span>
        {page * pageSize + 1}–{Math.min(total, (page + 1) * pageSize)} of {total.toLocaleString()}
      </span>
      <Button size="sm" variant="ghost" icon={ChevronLeft} onClick={() => onPage(page - 1)} disabled={page === 0} aria-label="Previous page" />
      <span>
        Page {page + 1} of {pages}
      </span>
      <Button size="sm" variant="ghost" icon={ChevronRight} onClick={() => onPage(page + 1)} disabled={page >= pages - 1} aria-label="Next page" />
    </nav>
  );
}

type Workspace = 'query' | 'check';

/** One workspace per ontology: switching ontology starts fresh rather than carrying state across. */
export function QueryTab() {
  const { id } = useOntology();
  return <QueryWorkspace key={id} />;
}

/**
 * Records in the sample data: typed subjects, read by parsing the Turtle. Per
 * class for choosing where to start, and in total counting each subject once
 * even when it has several types.
 */
async function countRecords(data: string): Promise<{ byClass: Map<string, number>; total: number }> {
  const { SparqStore } = await sparqModule();
  const counts = new Map<string, number>();
  let total = 0;
  try {
    const s = await SparqStore.fromString(data, 'turtle');
    try {
      const json = JSON.parse(s.queryJson('SELECT ?c (COUNT(DISTINCT ?s) AS ?n) WHERE { ?s a ?c } GROUP BY ?c')) as { results: { bindings: { c: { value: string }; n: { value: string } }[] } };
      for (const b of json.results.bindings) counts.set(b.c.value, Number(b.n.value));
      const all = JSON.parse(s.queryJson('SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE { ?s a ?c }')) as { results: { bindings: { n: { value: string } }[] } };
      total = Number(all.results.bindings[0]?.n.value ?? 0);
    } finally {
      s.free();
    }
  } catch {
    /* Unparseable data counts as no records; Check data reports the error. */
  }
  return { byClass: counts, total };
}

function QueryWorkspace() {
  const { id, ontology } = useOntology();
  const [params, setParams] = useSearchParams();
  const mode: Mode = params.get('mode') === 'sparql' ? 'sparql' : 'builder';
  const setParam = (k: string, v: string) => {
    const n = new URLSearchParams(params);
    n.set(k, v);
    setParams(n, { replace: true });
  };
  const setMode = (m: Mode) => {
    setResult(null);
    setQueryError(undefined);
    setParam('mode', m);
  };
  // One workspace at a time; both keep their inputs and results when you switch.
  const workspace: Workspace = params.get('view') === 'check' ? 'check' : 'query';
  const setWorkspace = (w: Workspace) => setParam('view', w);
  const [rowPage, setRowPage] = useState(0);
  const [findingPage, setFindingPage] = useState(0);

  const turtle = useAsync(() => api.source(id, 'turtle'), [id]);
  const shapes = useAsync(() => api.source(id, 'shacl'), [id]);
  const view = useAsync(() => api.view(id), [id]);
  const storeRef = useRef<SparqStore | null>(null);
  const dataStoreRef = useRef<{ key: string; store: SparqStore } | null>(null);
  const [ready, setReady] = useState<{ ms: number; triples: number } | null>(null);
  const [loadError, setLoadError] = useState<unknown>();

  const examples = useMemo(() => sparqlExamples(ontology.prefix, ontology.namespace), [ontology.prefix, ontology.namespace]);
  // Drafts survive leaving the page, per ontology and per browser.
  const [query, setQuery] = useLocalStorage(`concord.query.${id}.sparql`, examples[0].query);
  // The dataset is part of the draft: a restored instance query must still run against the data.
  const [target, setTarget] = useLocalStorage<Target>(`concord.query.${id}.target`, 'ontology');
  const [result, setResultState] = useState<Result | null>(null);
  const [queryError, setQueryError] = useState<unknown>();
  const [queryMs, setQueryMs] = useState<number>();
  const [data, setData] = useLocalStorage(`concord.query.${id}.data`, (ontology.demo ? DEMO_DATA : EMPTY_DATA)(ontology.namespace, ontology.prefix));
  const [report, setReportState] = useState<{ conforms: boolean; results: { focusNode?: string; path?: string; severity?: string; message?: string }[] } | null>(null);
  const [checkError, setCheckError] = useState<unknown>();

  const setResult = (r: Result | null) => {
    setResultState(r);
    setRowPage(0);
  };
  const setReport = (r: typeof report) => {
    setReportState(r);
    setFindingPage(0);
  };
  const label = useMemo(() => makeLabeler(view.data), [view.data]);
  const prefixes = view.data?.prefixes ?? { [ontology.prefix]: ontology.namespace };

  // How many records of each class the sample data has, for the dataset summary and the starting class.
  const [recordCounts, setRecordCounts] = useState<{ byClass: Map<string, number>; total: number }>();
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => void countRecords(data).then((c) => !cancelled && setRecordCounts(c)), recordCounts ? 400 : 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recount when the data changes
  }, [data]);
  const recordTotal = recordCounts?.total;

  // Builder state: start from the first class that has instances in the sample data.
  const [model, setModel] = useLocalStorage<BuilderModel | null>(`concord.query.${id}.builder`, null);
  useEffect(() => {
    if (!view.data || !recordCounts) return;
    if (model && view.data.classes.some((c) => c.iri === model.rootClass)) return;
    // Prefer a class the sample data has records of, so the first run finds something.
    const live = view.data.classes.filter((c) => !c.deprecated);
    const records = (iri: string) => recordCounts.byClass.get(iri) ?? 0;
    const preferred = [...live].sort((a, b) => records(b.iri) - records(a.iri))[0];
    if (!preferred) return;
    // Start with the class's first attribute (e.g. its title) as a column, so the first run shows something readable.
    const attrs = propertyOptions(view.data, preferred.iri, makeLabeler(view.data)).filter((o) => o.group === 'suggested' && o.kind === 'data');
    const first = attrs.find((o) => /title|name/i.test(o.label)) ?? attrs[0];
    const steps = first ? [newStep(first.iri, first.valueType)] : [];
    setModel({ rootClass: preferred.iri, includeSubclasses: true, steps, distinct: true, countOnly: false, descending: false, orderBy: steps[0]?.id, limit: 100 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the ontology or a reset changes it
  }, [view.data, model, recordCounts]);
  const allOptions = useMemo(() => (view.data ? propertyOptions(view.data, undefined, label) : []), [view.data, label]);
  const optionFor = useCallback((iri: string): PropertyOption | undefined => allOptions.find((o) => o.iri === iri), [allOptions]);
  const built = useMemo(
    () => (model ? buildSparql(model, { prefixes: { ...prefixes, rdfs: 'http://www.w3.org/2000/01/rdf-schema#', skos: 'http://www.w3.org/2004/02/skos/core#' } }) : null),
    [model, prefixes],
  );

  // Autocomplete: every term as a prefixed name, findable by its label too. Accepting
  // one adds the PREFIX (or @prefix) declaration if the text doesn't have it yet.
  const completionsFor = useCallback(
    (lang: 'sparql' | 'turtle'): Completion[] => {
      if (!view.data) return [];
      const pfx = view.data.prefixes;
      return allTerms(view.data).flatMap((t) => {
        const c = short(t.iri, pfx);
        if (c === t.iri) return [];
        const p = c.slice(0, c.indexOf(':'));
        const apply: Completion['apply'] = (v, _completion, from, to) => {
          // Reuse a matching declaration, add one if the prefix is free, or use the full IRI if it's bound elsewhere.
          const { declaration, text } = insertTerm(v.state.doc.toString(), lang, p, pfx[p], t.iri, from);
          v.dispatch({
            changes: [...(declaration ? [{ from: 0, insert: declaration }] : []), { from, to, insert: text }],
            selection: { anchor: from + text.length + (declaration?.length ?? 0) },
          });
        };
        const type = t.kind === 'class' ? 'class' : t.kind === 'individual' ? 'constant' : 'property';
        const base = { detail: t.label, type, info: t.definition, apply };
        return [{ label: c, ...base }, ...(t.label ? [{ label: t.label, displayLabel: `${t.label} → ${c}`, ...base, detail: undefined, boost: -1 }] : [])];
      });
    },
    [view.data],
  );
  const sparqlCompletions = useMemo(() => completionsFor('sparql'), [completionsFor]);
  const turtleCompletions = useMemo(() => completionsFor('turtle'), [completionsFor]);

  useEffect(() => {
    if (!turtle.data) return;
    let cancelled = false;
    const t0 = performance.now();
    setLoadError(undefined);
    sparqModule()
      .then(({ SparqStore }) => SparqStore.fromString(turtle.data!, 'turtle'))
      .then((s) => {
        if (cancelled) return s.free();
        storeRef.current?.free();
        storeRef.current = s;
        dataStoreRef.current?.store.free();
        dataStoreRef.current = null;
        setReady({ ms: Math.round(performance.now() - t0), triples: s.countQuads(null, null, null) });
      })
      .catch((e) => !cancelled && setLoadError(e));
    return () => {
      cancelled = true;
    };
  }, [turtle.data]);
  useEffect(
    () => () => {
      storeRef.current?.free();
      dataStoreRef.current?.store.free();
    },
    [],
  );

  const storeFor = async (t: Target): Promise<SparqStore | null> => {
    if (t === 'ontology') return storeRef.current;
    const key = `${turtle.data ?? ''}\n${data}`;
    if (dataStoreRef.current?.key === key) return dataStoreRef.current.store;
    const { SparqStore } = await sparqModule();
    const store = SparqStore.fromStringSync(key, 'turtle');
    dataStoreRef.current?.store.free();
    dataStoreRef.current = { key, store };
    return store;
  };

  const activeQuery = mode === 'builder' ? (built?.query ?? '') : query;
  const effectiveTarget: Target = mode === 'builder' ? 'data' : target;
  // Each answer remembers the question and data it came from, so a changed question never sits above an old answer.
  const questionKey = `${mode}|${effectiveTarget}|${activeQuery}|${effectiveTarget === 'data' ? data : ''}`;
  const [ranKey, setRanKey] = useState<string>();
  const [checkedData, setCheckedData] = useState<string>();
  const resultStale = !!result && ranKey !== questionKey;
  const reportStale = !!report && checkedData !== data;

  const run = async () => {
    if (!storeRef.current) return;
    setQueryError(undefined);
    setRanKey(questionKey);
    const t0 = performance.now();
    try {
      const s = await storeFor(effectiveTarget);
      if (!s) return;
      const form = queryForm(activeQuery);
      if (form === 'ask') setResult({ kind: 'ask', answer: s.queryBoolean(activeQuery) });
      else if (form === 'construct' || form === 'describe') {
        const text = s.queryQuadsString(activeQuery);
        setResult({ kind: 'graph', text, count: text.split('\n').filter((l) => l.trim()).length });
      } else {
        const json = JSON.parse(s.queryJson(activeQuery)) as { head: { vars: string[] }; results: { bindings: Record<string, { value: string }>[] } };
        const rows = json.results.bindings.map((b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.value])));
        // Builder results get readable column headings: the class, or the property path.
        let labels: Record<string, string> | undefined;
        if (mode === 'builder' && built && model) {
          labels = { [built.variables.root]: label(model.rootClass), count: `Number of ${label(model.rootClass)} records` };
          for (const [stepId, path] of Object.entries(pathLabels(model.steps, (iri) => optionFor(iri)?.label ?? label(iri)))) labels[built.variables[stepId]] = path;
        }
        setResult({ kind: 'rows', vars: json.head.vars, rows, labels, limit: mode === 'builder' && !model?.countOnly ? model?.limit : undefined });
      }
    } catch (e) {
      setQueryError(e);
      setResult(null);
    }
    setQueryMs(Math.round(performance.now() - t0));
  };

  const check = () => {
    const s = storeRef.current;
    if (!s || !shapes.data) return;
    setCheckError(undefined);
    setCheckedData(data);
    try {
      // The ontology goes in the data graph too, so sh:class sees subclass relationships.
      const r = s.validate(`${turtle.data ?? ''}\n${data}`, shapes.data, 'turtle');
      setReport({
        conforms: r.conforms,
        results: r.results.map((x) => ({
          focusNode: x.focusNode as string | undefined,
          path: x.path as string | undefined,
          severity: x.severity as string | undefined,
          message: x.message as string | undefined,
        })),
      });
    } catch (e) {
      setCheckError(e);
      setReport(null);
    }
  };

  if (turtle.error) return <ErrorCard error={turtle.error} onRetry={turtle.reload} />;
  return (
    <div className="space-y-4">
      <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
        <Cpu className="size-4" />
        Runs in your browser with the sparq engine (WebAssembly). Your queries and data never leave this page.
        {ready && (
          <Badge tone="ok">
            <span data-testid="sparq-ready">
              {ready.triples.toLocaleString()} triples loaded in {ready.ms} ms
            </span>
          </Badge>
        )}
      </p>
      {loadError ? <InlineError error={loadError} /> : null}

      <Segmented
        label="Workspace"
        value={workspace}
        onChange={setWorkspace}
        options={[
          { id: 'query', label: 'Query ontology', icon: Search },
          { id: 'check', label: 'Check data', icon: ShieldCheck },
        ]}
      />

      {workspace === 'query' ? (
        <Card>
          <CardHeader
            title="Query the ontology"
            subtitle={
              mode === 'builder'
                ? 'Build a query by picking classes and properties.'
                : 'SPARQL 1.1, with autocomplete for this ontology’s terms (Ctrl/⌘-Space) and Ctrl/⌘-Enter to run'
            }
            icon={Play}
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <Segmented
                  label="Query mode"
                  value={mode}
                  onChange={setMode}
                  options={[
                    { id: 'builder', label: 'Visual builder', icon: Workflow },
                    { id: 'sparql', label: 'SPARQL', icon: Code2 },
                  ]}
                />
                <Button variant="primary" icon={Play} onClick={run} disabled={!ready || !activeQuery}>
                  Run
                </Button>
              </div>
            }
          />
          <div className="space-y-3 p-4">
            {(mode === 'builder' || target === 'data') && recordTotal !== undefined && (
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted" data-testid="dataset-summary">
                <Database className="size-3.5" />
                {recordTotal > 0 ? (
                  <span>
                    Runs over the ontology plus {recordTotal.toLocaleString()} sample {recordTotal === 1 ? 'record' : 'records'}.
                  </span>
                ) : (
                  <span>There is no sample data yet, so questions about records will find nothing.</span>
                )}
                <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={() => setWorkspace('check')}>
                  {recordTotal > 0 ? 'Edit sample data' : 'Add sample data'}
                </button>
              </p>
            )}
            {mode === 'sparql' ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value=""
                    onChange={(e) => {
                      const ex = examples.find((x) => x.id === e.target.value);
                      if (ex) {
                        setQuery(ex.query);
                        if (ex.id === 'instances') setTarget('data');
                      }
                    }}
                    aria-label="Example queries"
                    className="w-auto!"
                  >
                    <option value="">Examples…</option>
                    {examples.map((x) => (
                      <option key={x.id} value={x.id} title={x.description}>
                        {x.title}
                      </option>
                    ))}
                  </Select>
                  <label className="ml-auto flex items-center gap-2 text-sm">
                    <span className="text-muted">Run against</span>
                    <Select value={target} onChange={(e) => setTarget(e.target.value as Target)} aria-label="Run against" className="w-auto!">
                      <option value="ontology">The ontology</option>
                      <option value="data">The ontology + sample data</option>
                    </Select>
                  </label>
                </div>
                <CodeEditor
                  value={query}
                  onChange={setQuery}
                  language="sparql"
                  onRun={run}
                  completions={sparqlCompletions}
                  ariaLabel="SPARQL query"
                  minHeight={200}
                  maxHeight={420}
                  testId="sparql-editor"
                />
                <p className="text-xs text-muted">Tab moves to the next control. Ctrl/⌘-] and Ctrl/⌘-[ indent, Ctrl/⌘-Space suggests terms.</p>
              </>
            ) : !view.data || !model || !built ? (
              view.error ? (
                <InlineError error={view.error} />
              ) : view.data && !view.data.classes.some((c) => !c.deprecated) ? (
                <p className="rounded-md border border-dashed border-line-strong px-4 py-6 text-center text-sm text-muted" data-testid="builder-empty">
                  This ontology has no classes yet, so there is nothing to build a query from. Use the SPARQL editor, or add classes first.
                </p>
              ) : (
                <Loading label="Reading the ontology’s classes…" />
              )
            ) : (
              <div className="space-y-4">
                <QueryBuilder view={view.data} label={label} model={model} onChange={setModel} variables={built.variables} optionFor={optionFor} onReset={() => setModel(null)} />
                <QueryDiagram model={model} variables={built.variables} label={label} optionFor={optionFor} />
                <details className="group">
                  <summary className="flex cursor-pointer items-center gap-2 text-sm text-muted">
                    <BookOpen className="size-4" /> The SPARQL this builds
                  </summary>
                  <div className="mt-2 space-y-2">
                    <HighlightedCode code={built.query} language="sparql" className="text-[0.8rem] leading-relaxed" />
                    <Button
                      size="sm"
                      icon={Pencil}
                      onClick={() => {
                        setQuery(built.query);
                        setTarget('data');
                        setMode('sparql');
                      }}
                    >
                      Edit as SPARQL
                    </Button>
                  </div>
                </details>
              </div>
            )}

            {!ready && !loadError && <Loading label="Loading the ontology into sparq…" />}
            {queryError ? <InlineError error={queryError} /> : null}
            {resultStale && (
              <p role="status" className="flex items-center gap-2 rounded-md bg-warn-soft px-3 py-2 text-sm text-warn" data-testid="result-stale">
                The question or data changed since this ran.
                <Button size="sm" icon={Play} onClick={run}>
                  Run again
                </Button>
              </p>
            )}
            <div className={cx('space-y-3', resultStale && 'opacity-50')}>
              {result?.kind === 'ask' && (
                <p className="text-sm" data-testid="query-answer">
                  Answer: <strong>{result.answer ? 'yes' : 'no'}</strong>
                </p>
              )}
              {result?.kind === 'graph' && (
                <div className="space-y-1" data-testid="query-graph">
                  <p className="text-xs text-muted">
                    {result.count} triple{result.count === 1 ? '' : 's'}
                    {queryMs !== undefined ? ` · ${queryMs} ms` : ''}
                  </p>
                  <CodeView code={result.text} language="ntriples" ariaLabel="Query result triples" maxHeight={360} />
                </div>
              )}
              {result?.kind === 'rows' && (
                <div className="overflow-x-auto rounded-md border border-line" data-testid="query-results">
                  <div className="flex items-center justify-between border-b border-line px-3 py-1.5 text-xs text-muted">
                    <span>
                      {result.rows.length} row{result.rows.length === 1 ? '' : 's'}
                      {queryMs !== undefined ? ` · ${queryMs} ms` : ''}
                    </span>
                    <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(toCsv(result.vars, result.rows, result.labels))}`} download="query-results.csv" className="inline-flex items-center gap-1 hover:text-fg">
                      <Download className="size-3" /> CSV
                    </a>
                  </div>
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr>
                        {result.vars.map((v) => (
                          <th key={v} className={cx('px-3 py-1.5 font-medium', !result.labels?.[v] && 'font-mono text-[var(--syn-variable)]')} title={`?${v}`}>
                            {result.labels?.[v] ?? `?${v}`}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.slice(rowPage * ROWS_PER_PAGE, (rowPage + 1) * ROWS_PER_PAGE).map((r, i) => (
                        <tr key={i} className="border-t border-line align-top">
                          {result.vars.map((v) => (
                            <td key={v} className="px-3 py-1.5 font-mono" title={r[v] ?? 'No value'}>
                              {r[v] !== undefined ? (
                                short(r[v], prefixes)
                              ) : (
                                <span className="text-subtle" aria-label="No value">
                                  —
                                </span>
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <Pager page={rowPage} pageSize={ROWS_PER_PAGE} total={result.rows.length} onPage={setRowPage} label="Result pages" />
                </div>
              )}
              {result?.kind === 'rows' && result.limit && result.rows.length >= result.limit && (
                <p className="text-xs text-warn" data-testid="limit-reached">
                  Stopped at the limit of {result.limit} rows, so there may be more. Raise it under More options.
                </p>
              )}
            </div>
          </div>
        </Card>
      ) : (
        <Card>
          <CardHeader
            title="Check your data"
            subtitle="Validates Turtle instance data against SHACL shapes generated from the ontology. The visual builder queries this data too."
            icon={ShieldCheck}
            actions={
              <Button variant="primary" icon={ShieldCheck} onClick={check} disabled={!ready || !shapes.data}>
                Check
              </Button>
            }
          />
          <div className="space-y-3 p-4">
            <CodeEditor value={data} onChange={setData} language="turtle" completions={turtleCompletions} ariaLabel="Instance data (Turtle)" minHeight={220} maxHeight={420} testId="data-editor" />
            <p className="text-xs text-muted">Tab moves to the next control. Ctrl/⌘-] and Ctrl/⌘-[ indent.</p>
            <p className="text-sm text-muted" data-testid="validate-link">
              To upload a file in any RDF format, check against a release, or get a full report (with the terms check and a SHACL report to download), use{' '}
              <Link to="../validate" relative="path" className="text-accent hover:underline">
                Validate data
              </Link>
              .
            </p>
            {checkError ? <InlineError error={checkError} /> : null}
            {reportStale && (
              <p role="status" className="flex items-center gap-2 rounded-md bg-warn-soft px-3 py-2 text-sm text-warn" data-testid="report-stale">
                The data changed since this check.
                <Button size="sm" icon={ShieldCheck} onClick={check}>
                  Check again
                </Button>
              </p>
            )}
            {report && (
              <div className={cx('space-y-2', reportStale && 'opacity-50')} data-testid="shacl-report">
                <p className="text-sm">
                  {report.conforms ? (
                    <Badge tone="ok">Conforms</Badge>
                  ) : (
                    <Badge tone="danger">
                      {report.results.length} problem{report.results.length === 1 ? '' : 's'}
                    </Badge>
                  )}
                </p>
                <ul className="space-y-1 text-sm">
                  {report.results.slice(findingPage * FINDINGS_PER_PAGE, (findingPage + 1) * FINDINGS_PER_PAGE).map((r, i) => (
                    <li key={i} className="rounded-md border border-line px-3 py-2">
                      <span className="font-mono text-xs">{r.focusNode ? short(r.focusNode, prefixes) : ''}</span>
                      {r.path ? <span className="font-mono text-xs text-muted"> · {short(r.path, prefixes)}</span> : null}
                      <div>{r.message}</div>
                    </li>
                  ))}
                </ul>
                <Pager page={findingPage} pageSize={FINDINGS_PER_PAGE} total={report.results.length} onPage={setFindingPage} label="Finding pages" />
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
