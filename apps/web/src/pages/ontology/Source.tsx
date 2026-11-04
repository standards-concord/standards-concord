import { useSearchParams } from 'react-router';
import type { OutputFormat } from '@concord/shared';
import { Download, Info } from 'lucide-react';
import { api } from '../../api';
import { useAsync } from '../../lib/hooks';
import { Button, Card, ErrorCard, Loading, Select, cx } from '../../components/ui';
import { CodeView } from '../../components/code/CodeView';
import { FORMAT_LANGUAGE } from '../../components/code/languages';
import { useOntology } from './Layout';
import { publicPageUrl } from '../../lib/format';
import { datasetClassName } from '../../lib/classes-hint';

const FORMATS: { id: OutputFormat; label: string; ext: string; note: string }[] = [
  { id: 'turtle', label: 'Turtle', ext: 'ttl', note: 'The canonical, human-readable RDF serialisation. This is what’s stored in git.' },
  { id: 'rdfxml', label: 'RDF/XML', ext: 'owl', note: 'For Protégé and older OWL tools.' },
  { id: 'jsonld', label: 'JSON-LD', ext: 'jsonld', note: 'Linked data as JSON, convenient for web developers.' },
  { id: 'ntriples', label: 'N-Triples', ext: 'nt', note: 'One triple per line — ideal for diffs and bulk loading.' },
  { id: 'manchester', label: 'Manchester', ext: 'omn', note: 'OWL Manchester syntax: the most readable form of the logical axioms.' },
  { id: 'linkml', label: 'LinkML', ext: 'yaml', note: 'LinkML is used internally at the ODI to generate schemas, validators and docs from one model.' },
  { id: 'shacl', label: 'SHACL', ext: 'shacl.ttl', note: 'Shapes generated from the ontology to validate instance data.' },
  { id: 'shaclc', label: 'SHACLC', ext: 'shaclc', note: 'The same shapes in SHACL compact syntax, which is much easier to read.' },
  {
    id: 'typescript',
    label: 'Classes',
    ext: 'ts',
    note: 'A class for every SHACL shape, generated with the ODI SHACL converter over @rdfjs/wrapper, so apps can work with the data as objects.',
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
      {format === 'typescript' && <ImportHint slug={ontology.slug} version={ref === 'working' ? 'draft' : ref} code={source.data} />}
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

/** How to use the generated classes: import from the version's URL, or install it as an npm package. */
function ImportHint({ slug, version, code }: { slug: string; version: string; code?: string }) {
  const base = `${window.location.origin}${publicPageUrl(slug, version)}`;
  const dataset = datasetClassName(code, slug);
  const lines = [
    `// In a browser, with no build step:`,
    `import { ${dataset} } from "${base}.js";`,
    ``,
    `// With npm and a bundler (the package is "${slug}-ontology"):`,
    `// npm install ${base}.tgz`,
  ].join('\n');
  return (
    <div className="space-y-1" data-testid="classes-import">
      <CodeView code={lines} language="javascript" ariaLabel="How to import the classes" maxHeight={160} />
      <p className="text-xs text-muted">
        The same URL also answers <code>Accept: text/javascript</code>. TypeScript declarations are at{' '}
        <a className="text-accent hover:underline" href={`${base}.d.ts`} target="_blank" rel="noreferrer">
          {version}.d.ts
        </a>
        .
      </p>
    </div>
  );
}
