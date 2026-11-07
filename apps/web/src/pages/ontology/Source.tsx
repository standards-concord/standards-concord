import { useSearchParams } from 'react-router';
import type { OutputFormat } from '@concord/shared';
import { Download, Info } from 'lucide-react';
import { api } from '../../api';
import { useAsync } from '../../lib/hooks';
import { Card, ErrorCard, Loading, Select, AnchorButton } from '../../components/ui';
import { CodeView } from '../../components/code/CodeView';
import { FORMAT_LANGUAGE } from '../../components/code/languages';
import { useOntology } from './Layout';
import { publicPageUrl } from '../../lib/format';
import { datasetClassName } from '../../lib/classes-hint';

const FORMATS: {
  id: OutputFormat;
  label: string;
  ext: string;
  note: string;
  /** Listed under "More formats" rather than up front. */
  more?: true;
}[] = [
  {
    id: 'turtle',
    label: 'Turtle',
    ext: 'ttl',
    note: 'The canonical, human-readable RDF serialisation. This is what’s stored in git.',
  },
  {
    id: 'jsonld',
    label: 'JSON-LD',
    ext: 'jsonld',
    note: 'Linked data as JSON, convenient for web developers.',
  },
  {
    id: 'shacl',
    label: 'SHACL',
    ext: 'shacl.ttl',
    note: 'Shapes generated from the ontology to validate instance data.',
  },
  {
    id: 'rdfxml',
    label: 'RDF/XML',
    ext: 'owl',
    note: 'For Protégé and older OWL tools.',
    more: true,
  },
  {
    id: 'ntriples',
    label: 'N-Triples',
    ext: 'nt',
    note: 'One triple per line — ideal for diffs and bulk loading.',
    more: true,
  },
  {
    id: 'manchester',
    label: 'Manchester',
    ext: 'omn',
    note: 'OWL Manchester syntax: the most readable form of the logical axioms.',
    more: true,
  },
  {
    id: 'linkml',
    label: 'LinkML',
    ext: 'yaml',
    note: 'LinkML describes the model as YAML, from which schemas, validators and documentation can be generated.',
    more: true,
  },
  {
    id: 'shaclc',
    label: 'SHACLC',
    ext: 'shaclc',
    note: 'The same shapes in SHACL compact syntax, which is much easier to read.',
    more: true,
  },
  {
    id: 'typescript',
    label: 'Classes',
    ext: 'ts',
    note: 'A class for every SHACL shape, generated with the ODI SHACL converter over @rdfjs/wrapper, so apps can work with the data as objects.',
    more: true,
  },
];

export function SourceTab() {
  const { id, ontology } = useOntology();
  const [params, setParams] = useSearchParams();
  const format = (FORMATS.find((f) => f.id === params.get('format'))?.id ?? 'turtle') as OutputFormat;
  const ref = params.get('ref') ?? 'working';
  const releases = useAsync(() => api.releases(id), [id], { keep: `releases|${id}` });
  const source = useAsync(() => api.source(id, format, ref), [id, format, ref], { keep: `source|${id}|${format}|${ref}` });
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
            {FORMATS.filter((f) => !f.more).map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
            <optgroup label="More formats">
              {FORMATS.filter((f) => f.more).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </optgroup>
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
          <AnchorButton href={api.sourceUrl(id, format, ref, true)} download={`${ontology.prefix}-${ref}.${meta.ext}`} icon={Download}>Download</AnchorButton>
        </div>
      </div>
      <details className="text-sm text-muted" data-testid="format-about">
        <summary className="inline-flex cursor-pointer items-center gap-1.5 hover:text-fg">
          <Info className="size-4" /> About {meta.label}
        </summary>
        <p className="mt-1 pl-6">{meta.note}</p>
      </details>
      {format === 'typescript' && <ImportHint slug={ontology.slug} version={ref === 'working' ? 'draft' : ref} code={source.data} />}
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
