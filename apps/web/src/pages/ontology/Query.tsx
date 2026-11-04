import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { BookOpen, Code2, Cpu, Download, Pencil, Play, ShieldCheck, Workflow } from 'lucide-react';
import type { SparqStore } from '@sparq-org/sparq';
import type { Completion } from '@codemirror/autocomplete';
import { api } from '../../api';
import { useAsync } from '../../lib/hooks';
import { allTerms, makeLabeler } from '../../lib/ontology';
import { buildSparql, newStep, type BuilderModel } from '../../lib/sparql-builder';
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

type Result =
  | { kind: 'rows'; vars: string[]; rows: Record<string, string>[] }
  | { kind: 'ask'; answer: boolean }
  | { kind: 'graph'; text: string; count: number };

type Mode = 'builder' | 'sparql';
type Target = 'ontology' | 'data';

const EXAMPLE_DATA = (ns: string, prefix: string) => `@prefix ${prefix}: <${ns}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ex: <https://example.org/data/> .

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

function short(v: string, prefixes: Record<string, string>) {
  for (const [p, ns] of Object.entries(prefixes)) if (v.startsWith(ns)) return `${p}:${v.slice(ns.length)}`;
  return v;
}

function csv(result: Extract<Result, { kind: 'rows' }>) {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [result.vars.join(','), ...result.rows.map((r) => result.vars.map((v) => esc(r[v] ?? '')).join(','))].join('\n');
}

function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { id: T; label: string; icon: typeof Code2 }[]; label: string }) {
  return (
    <div className="flex gap-1 rounded-lg border border-line-strong p-0.5" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          role="tab"
          aria-selected={o.id === value}
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

export function QueryTab() {
  const { id, ontology } = useOntology();
  const [params, setParams] = useSearchParams();
  const mode: Mode = params.get('mode') === 'sparql' ? 'sparql' : 'builder';
  const setMode = (m: Mode) => {
    setResult(null);
    setQueryError(undefined);
    const n = new URLSearchParams(params);
    n.set('mode', m);
    setParams(n, { replace: true });
  };

  const turtle = useAsync(() => api.source(id, 'turtle'), [id]);
  const shapes = useAsync(() => api.source(id, 'shacl'), [id]);
  const view = useAsync(() => api.view(id), [id]);
  const storeRef = useRef<SparqStore | null>(null);
  const dataStoreRef = useRef<{ key: string; store: SparqStore } | null>(null);
  const [ready, setReady] = useState<{ ms: number; triples: number } | null>(null);
  const [loadError, setLoadError] = useState<unknown>();

  const examples = useMemo(() => sparqlExamples(ontology.prefix, ontology.namespace), [ontology.prefix, ontology.namespace]);
  const [query, setQuery] = useState(examples[0].query);
  const [target, setTarget] = useState<Target>('ontology');
  const [result, setResult] = useState<Result | null>(null);
  const [queryError, setQueryError] = useState<unknown>();
  const [queryMs, setQueryMs] = useState<number>();
  const [data, setData] = useState(() => EXAMPLE_DATA(ontology.namespace, ontology.prefix));
  const [report, setReport] = useState<{ conforms: boolean; results: { focusNode?: string; path?: string; severity?: string; message?: string }[] } | null>(null);
  const [checkError, setCheckError] = useState<unknown>();

  const label = useMemo(() => makeLabeler(view.data), [view.data]);
  const prefixes = view.data?.prefixes ?? { [ontology.prefix]: ontology.namespace };

  // Builder state: start from the first class that has instances in the sample data.
  const [model, setModel] = useState<BuilderModel | null>(null);
  useEffect(() => {
    if (!view.data || model) return;
    const preferred = view.data.classes.find((c) => c.iri === `${ontology.namespace}VolunteeringOpportunity`) ?? view.data.classes.find((c) => !c.deprecated);
    if (!preferred) return;
    // Start with the class's first attribute (e.g. its title) as a column, so the first run shows something readable.
    const attrs = propertyOptions(view.data, preferred.iri, makeLabeler(view.data)).filter((o) => o.group === 'suggested' && o.kind === 'data');
    const first = attrs.find((o) => /title|name/i.test(o.label)) ?? attrs[0];
    const steps = first ? [newStep(first.iri)] : [];
    setModel({ rootClass: preferred.iri, includeSubclasses: true, steps, distinct: true, countOnly: false, descending: false, orderBy: steps[0]?.id, limit: 100 });
  }, [view.data, model, ontology.namespace]);
  const allOptions = useMemo(() => (view.data ? propertyOptions(view.data, undefined, label) : []), [view.data, label]);
  const optionFor = useCallback((iri: string): PropertyOption | undefined => allOptions.find((o) => o.iri === iri), [allOptions]);
  const built = useMemo(() => (model ? buildSparql(model, { prefixes: { ...prefixes, rdfs: 'http://www.w3.org/2000/01/rdf-schema#', skos: 'http://www.w3.org/2004/02/skos/core#' } }) : null), [model, prefixes]);

  // Autocomplete: every term as a prefixed name, with its label.
  const completions = useMemo<Completion[]>(() => {
    if (!view.data) return [];
    return allTerms(view.data).flatMap((t) => {
      const c = short(t.iri, view.data!.prefixes);
      if (c === t.iri) return [];
      return [{ label: c, detail: t.label, type: t.kind === 'class' ? 'class' : t.kind === 'individual' ? 'constant' : 'property', info: t.definition }];
    });
  }, [view.data]);

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

  const run = async () => {
    if (!storeRef.current) return;
    setQueryError(undefined);
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
        setResult({ kind: 'rows', vars: json.head.vars, rows: json.results.bindings.map((b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.value]))) });
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
    try {
      // The ontology goes in the data graph too, so sh:class sees subclass relationships.
      const r = s.validate(`${turtle.data ?? ''}\n${data}`, shapes.data, 'turtle');
      setReport({ conforms: r.conforms, results: r.results.map((x) => ({ focusNode: x.focusNode as string | undefined, path: x.path as string | undefined, severity: x.severity as string | undefined, message: x.message as string | undefined })) });
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

      <Card>
        <CardHeader
          title="Query the ontology"
          subtitle={mode === 'builder' ? 'Build a query by picking classes and properties; it runs over the ontology plus your sample data' : 'SPARQL 1.1, with autocomplete for this ontology’s terms (Ctrl/⌘-Space) and Ctrl/⌘-Enter to run'}
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
              <CodeEditor value={query} onChange={setQuery} language="sparql" onRun={run} completions={completions} ariaLabel="SPARQL query" minHeight={200} maxHeight={420} testId="sparql-editor" />
            </>
          ) : !view.data || !model || !built ? (
            view.error ? <InlineError error={view.error} /> : <Loading label="Reading the ontology’s classes…" />
          ) : (
            <div className="space-y-4">
              <QueryBuilder view={view.data} label={label} model={model} onChange={setModel} variables={built.variables} optionFor={optionFor} />
              <QueryDiagram model={model} variables={built.variables} label={label} optionFor={optionFor} />
              <details className="group" open>
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
                <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(csv(result))}`} download="query-results.csv" className="inline-flex items-center gap-1 hover:text-fg">
                  <Download className="size-3" /> CSV
                </a>
              </div>
              <table className="w-full text-left text-xs">
                <thead>
                  <tr>
                    {result.vars.map((v) => (
                      <th key={v} className="px-3 py-1.5 font-medium font-mono text-[var(--syn-variable)]">
                        ?{v}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.slice(0, 500).map((r, i) => (
                    <tr key={i} className="border-t border-line align-top">
                      {result.vars.map((v) => (
                        <td key={v} className="px-3 py-1.5 font-mono" title={r[v]}>
                          {r[v] ? short(r[v], prefixes) : ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Sample data"
          subtitle="Turtle instance data: queried by the builder, and checked against SHACL shapes generated from the ontology"
          icon={ShieldCheck}
          actions={
            <Button variant="primary" icon={ShieldCheck} onClick={check} disabled={!ready || !shapes.data}>
              Check
            </Button>
          }
        />
        <div className="space-y-3 p-4">
          <CodeEditor value={data} onChange={setData} language="turtle" completions={completions} ariaLabel="Instance data (Turtle)" minHeight={220} maxHeight={420} testId="data-editor" />
          {checkError ? <InlineError error={checkError} /> : null}
          {report && (
            <div className="space-y-2" data-testid="shacl-report">
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
                {report.results.slice(0, 100).map((r, i) => (
                  <li key={i} className="rounded-md border border-line px-3 py-2">
                    <span className="font-mono text-xs">{r.focusNode ? short(r.focusNode, prefixes) : ''}</span>
                    {r.path ? <span className="font-mono text-xs text-muted"> · {short(r.path, prefixes)}</span> : null}
                    <div>{r.message}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
