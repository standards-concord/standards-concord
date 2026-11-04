import { useSearchParams } from 'react-router';
import type { OutputFormat } from '@concord/shared';
import { Download, Info } from 'lucide-react';
import { api } from '../../api';
import { useAsync } from '../../lib/hooks';
import { Button, Card, ErrorCard, Loading, Select } from '../../components/ui';
import { CodeView } from '../../components/code/CodeView';
import { FORMAT_LANGUAGE } from '../../components/code/languages';
import { useOntology } from './Layout';

const FORMATS: {
  id: OutputFormat;
  label: string;
  ext: string;
  note: string;
}[] = [
  {
    id: 'turtle',
    label: 'Turtle',
    ext: 'ttl',
    note: 'The canonical, human-readable RDF serialisation. This is what’s stored in git.',
  },
  {
    id: 'rdfxml',
    label: 'RDF/XML',
    ext: 'owl',
    note: 'For Protégé and older OWL tools.',
  },
  {
    id: 'jsonld',
    label: 'JSON-LD',
    ext: 'jsonld',
    note: 'Linked data as JSON, convenient for web developers.',
  },
  {
    id: 'ntriples',
    label: 'N-Triples',
    ext: 'nt',
    note: 'One triple per line — ideal for diffs and bulk loading.',
  },
  {
    id: 'manchester',
    label: 'Manchester',
    ext: 'omn',
    note: 'OWL Manchester syntax: the most readable form of the logical axioms.',
  },
  {
    id: 'linkml',
    label: 'LinkML',
    ext: 'yaml',
    note: 'LinkML describes the model as YAML, from which schemas, validators and documentation can be generated.',
  },
  {
    id: 'shacl',
    label: 'SHACL',
    ext: 'shacl.ttl',
    note: 'Shapes generated from the ontology to validate instance data.',
  },
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
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          <span className="font-medium">Format</span>
          <Select value={format} onChange={(e) => set('format', e.target.value)} className="w-auto!" aria-label="Format">
            {FORMATS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </Select>
        </label>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-sm">
            <span className="font-medium">Version</span>
            <Select value={ref} onChange={(e) => set('ref', e.target.value)} className="w-auto!" aria-label="Version">
              <option value="working">Working draft</option>
              {published.map((r) => (
                <option key={r.id} value={r.version}>
                  v{r.version}
                </option>
              ))}
            </Select>
          </label>
          <a href={api.sourceUrl(id, format, ref, true)} download={`${ontology.prefix}-${ref}.${meta.ext}`}>
            <Button icon={Download}>Download</Button>
          </a>
        </div>
      </div>
      <details className="text-sm text-muted" data-testid="format-about">
        <summary className="inline-flex cursor-pointer items-center gap-1.5 hover:text-fg">
          <Info className="size-4" /> About {meta.label}
        </summary>
        <p className="mt-1 pl-6">{meta.note}</p>
      </details>
      <Card className="p-0">
        {/* Loading first: a request for a new format or version never shows the previous one's text or error. */}
        {source.loading ? (
          <Loading label={`Serialising as ${meta.label}…`} />
        ) : source.error || source.data === undefined ? (
          <div className="p-4">
            <ErrorCard error={source.error ?? new Error('No content')} onRetry={source.reload} title={`Couldn’t load ${meta.label}${ref === 'working' ? '' : ` for v${ref}`}`} />
          </div>
        ) : (
          <CodeView code={source.data} language={FORMAT_LANGUAGE[format] ?? 'text'} ariaLabel={`${meta.label} source`} maxHeight={640} testId="source-code" />
        )}
      </Card>
    </div>
  );
}
