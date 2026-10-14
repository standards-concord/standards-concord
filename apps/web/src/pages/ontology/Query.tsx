import { useEffect, useRef, useState } from 'react';
import { Cpu, Play, ShieldCheck } from 'lucide-react';
import type { SparqStore } from '@sparq-org/sparq';
import { api } from '../../api';
import { useAsync } from '../../lib/hooks';
import { Badge, Button, Card, CardHeader, ErrorCard, InlineError, Loading, Textarea } from '../../components/ui';
import { useOntology } from './Layout';

/**
 * Query the ontology and check instance data entirely in the browser, using
 * the sparq SPARQL engine compiled to WebAssembly. Nothing is sent to the server.
 */

const sparqModule = () => import('@sparq-org/sparq');

type Rows = { vars: string[]; rows: Record<string, string>[] } | { ask: boolean };

const EXAMPLE_DATA = (ns: string, prefix: string) => `@prefix ${prefix}: <${ns}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix ex: <https://example.org/data/> .

ex:foodbank a ${prefix}:VolunteerInvolvingOrganisation ;
  ${prefix}:title "Northvale Food Bank" .

ex:saturday-shift a ${prefix}:VolunteeringOpportunity ;
  ${prefix}:title "Saturday food bank shift" ;
  ${prefix}:offeredBy ex:foodbank ;
  ${prefix}:minimumAge "sixteen" .
`;

function short(v: string, prefixes: Record<string, string>) {
  for (const [p, ns] of Object.entries(prefixes)) if (v.startsWith(ns)) return `${p}:${v.slice(ns.length)}`;
  return v;
}

export function QueryTab() {
  const { id, ontology } = useOntology();
  const turtle = useAsync(() => api.source(id, 'turtle'), [id]);
  const shapes = useAsync(() => api.source(id, 'shacl'), [id]);
  const view = useAsync(() => api.view(id), [id]);
  const storeRef = useRef<SparqStore | null>(null);
  const [ready, setReady] = useState<{ ms: number; triples: number } | null>(null);
  const [loadError, setLoadError] = useState<unknown>();
  const [query, setQuery] = useState(
    `PREFIX ${ontology.prefix}: <${ontology.namespace}>\nPREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>\nPREFIX skos: <http://www.w3.org/2004/02/skos/core#>\n\nSELECT ?class ?label ?definition WHERE {\n  ?class a <http://www.w3.org/2002/07/owl#Class> ; rdfs:label ?label .\n  OPTIONAL { ?class skos:definition ?definition }\n  FILTER(isIRI(?class))\n}\nORDER BY ?label`,
  );
  const [result, setResult] = useState<Rows | null>(null);
  const [queryError, setQueryError] = useState<unknown>();
  const [queryMs, setQueryMs] = useState<number>();
  const [data, setData] = useState(() => EXAMPLE_DATA(ontology.namespace, ontology.prefix));
  const [report, setReport] = useState<{ conforms: boolean; results: { focusNode?: string; path?: string; severity?: string; message?: string }[] } | null>(null);
  const [checkError, setCheckError] = useState<unknown>();

  useEffect(() => {
    if (!turtle.data) return;
    let cancelled = false;
    const t0 = performance.now();
    sparqModule()
      .then(({ SparqStore }) => SparqStore.fromString(turtle.data!, 'turtle'))
      .then((s) => {
        if (cancelled) return s.free();
        storeRef.current?.free();
        storeRef.current = s;
        setReady({ ms: Math.round(performance.now() - t0), triples: s.countQuads(null, null, null) });
      })
      .catch((e) => !cancelled && setLoadError(e));
    return () => {
      cancelled = true;
    };
  }, [turtle.data]);
  useEffect(() => () => storeRef.current?.free(), []);

  const run = () => {
    const s = storeRef.current;
    if (!s) return;
    setQueryError(undefined);
    const t0 = performance.now();
    try {
      if (/^\s*(PREFIX[^\n]*\n\s*)*ASK\b/i.test(query)) setResult({ ask: s.queryBoolean(query) });
      else {
        const json = JSON.parse(s.queryJson(query)) as { head: { vars: string[] }; results: { bindings: Record<string, { value: string }>[] } };
        setResult({ vars: json.head.vars, rows: json.results.bindings.map((b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.value]))) });
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

  const prefixes = view.data?.prefixes ?? { [ontology.prefix]: ontology.namespace };

  if (turtle.error) return <ErrorCard error={turtle.error} onRetry={turtle.reload} />;
  return (
    <div className="space-y-4">
      <p className="flex items-center gap-2 text-sm text-muted">
        <Cpu className="size-4" />
        Runs in your browser with the sparq engine (WebAssembly). Your queries and data never leave this page.
        {ready && (
          <Badge tone="ok">
            {ready.triples.toLocaleString()} triples loaded in {ready.ms} ms
          </Badge>
        )}
      </p>
      {loadError ? <InlineError error={loadError} /> : null}

      <Card>
        <CardHeader title="Query the ontology" subtitle="SPARQL 1.1 over the working draft" icon={Play} actions={<Button variant="primary" icon={Play} onClick={run} disabled={!ready}>Run</Button>} />
        <div className="space-y-3 p-4">
          <Textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') run();
            }}
            rows={9}
            spellCheck={false}
            className="font-mono text-xs"
            aria-label="SPARQL query"
          />
          {!ready && !loadError && <Loading label="Loading the ontology into sparq…" />}
          {queryError ? <InlineError error={queryError} /> : null}
          {result && 'ask' in result && (
            <p className="text-sm">
              Answer: <strong>{result.ask ? 'yes' : 'no'}</strong>
            </p>
          )}
          {result && 'rows' in result && (
            <div className="overflow-x-auto rounded-md border border-line">
              <p className="border-b border-line px-3 py-1.5 text-xs text-muted">
                {result.rows.length} row{result.rows.length === 1 ? '' : 's'}
                {queryMs !== undefined ? ` · ${queryMs} ms` : ''}
              </p>
              <table className="w-full text-left text-xs">
                <thead>
                  <tr>{result.vars.map((v) => <th key={v} className="px-3 py-1.5 font-medium">?{v}</th>)}</tr>
                </thead>
                <tbody>
                  {result.rows.slice(0, 500).map((r, i) => (
                    <tr key={i} className="border-t border-line align-top">
                      {result.vars.map((v) => <td key={v} className="px-3 py-1.5 font-mono">{r[v] ? short(r[v], prefixes) : ''}</td>)}
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
          title="Check your data"
          subtitle="Validates Turtle instance data against SHACL shapes generated from the ontology"
          icon={ShieldCheck}
          actions={<Button variant="primary" icon={ShieldCheck} onClick={check} disabled={!ready || !shapes.data}>Check</Button>}
        />
        <div className="space-y-3 p-4">
          <Textarea value={data} onChange={(e) => setData(e.target.value)} rows={12} spellCheck={false} className="font-mono text-xs" aria-label="Instance data (Turtle)" />
          {checkError ? <InlineError error={checkError} /> : null}
          {report && (
            <div className="space-y-2">
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
