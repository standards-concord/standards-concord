import { useSearchParams } from 'react-router';
import type { OutputFormat } from '@concord/shared';
import { Download, Info } from 'lucide-react';
import { api } from '../../api';
import { useAsync } from '../../lib/hooks';
import { Button, Card, ErrorCard, Loading, Select, cx } from '../../components/ui';
import { CodeView } from '../../components/code/CodeView';
import { FORMAT_LANGUAGE } from '../../components/code/languages';
import { useOntology } from './Layout';

const FORMATS: { id: OutputFormat; label: string; ext: string; note: string }[] = [
  { id: 'turtle', label: 'Turtle', ext: 'ttl', note: 'The canonical, human-readable RDF serialisation. This is what’s stored in git.' },
  { id: 'rdfxml', label: 'RDF/XML', ext: 'owl', note: 'For Protégé and older OWL tools.' },
  { id: 'jsonld', label: 'JSON-LD', ext: 'jsonld', note: 'Linked data as JSON, convenient for web developers.' },
  { id: 'ntriples', label: 'N-Triples', ext: 'nt', note: 'One triple per line — ideal for diffs and bulk loading.' },
  { id: 'manchester', label: 'Manchester', ext: 'omn', note: 'OWL Manchester syntax: the most readable form of the logical axioms.' },
  { id: 'linkml', label: 'LinkML', ext: 'yaml', note: 'LinkML describes the model as YAML, from which schemas, validators and documentation can be generated.' },
  { id: 'shacl', label: 'SHACL', ext: 'shacl.ttl', note: 'Shapes generated from the ontology to validate instance data.' },
];

export function SourceTab() {
  const { id, ontology } = useOntology();
  const [params, setParams] = useSearchParams();
  const format = (FORMATS.find((f) => f.id === params.get('format'))?.id ?? 'turtle') as OutputFormat;
  const ref = params.get('ref') ?? 'working';
  const releases = useAsync(() => api.releases(id), [id]);
  const source = useAsync(() => api.source(id, format, ref), [id, format, ref]);
  const meta = FORMATS.find((f) => f.id === format)!;

  const set = (k: string, v: string) => {
    const n = new URLSearchParams(params);
    n.set(k, v);
    setParams(n, { replace: true });
  };

  const published = (releases.data ?? []).filter((r) => r.status === 'published');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1 rounded-lg border border-line-strong p-0.5" role="tablist" aria-label="Format">
          {FORMATS.map((f) => (
            <button
              key={f.id}
              role="tab"
              aria-selected={f.id === format}
              onClick={() => set('format', f.id)}
              className={cx('rounded-md px-3 py-1 text-sm', f.id === format ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg')}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Select value={ref} onChange={(e) => set('ref', e.target.value)} className="w-auto" aria-label="Version">
            <option value="working">Working draft</option>
            {published.map((r) => (
              <option key={r.id} value={r.version}>
                v{r.version}
              </option>
            ))}
          </Select>
          <a href={api.sourceUrl(id, format, ref, true)} download={`${ontology.prefix}-${ref}.${meta.ext}`}>
            <Button icon={Download}>Download</Button>
          </a>
        </div>
      </div>
      <p className="flex items-start gap-2 text-sm text-muted">
        <Info className="mt-0.5 size-4 shrink-0" /> {meta.note}
      </p>
      <Card className="p-0">
        {source.error && source.data === undefined ? (
          <div className="p-4">
            <ErrorCard error={source.error} onRetry={source.reload} />
          </div>
        ) : source.data === undefined || source.loading ? (
          <Loading label={`Serialising as ${meta.label}…`} />
        ) : (
          <CodeView code={source.data} language={FORMAT_LANGUAGE[format] ?? 'text'} ariaLabel={`${meta.label} source`} maxHeight={640} testId="source-code" />
        )}
      </Card>
    </div>
  );
}
