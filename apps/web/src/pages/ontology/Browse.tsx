import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import type { OntologyView, TermView } from '@concord/shared';
import { Bug, ChevronDown, ChevronRight, LayoutTemplate, Network, ListTree, Search, X } from 'lucide-react';
import { api, type TermDetail } from '../../api';
import { useAsync } from '../../lib/hooks';
import { KIND_LABEL, restrictionText, type Labeler } from '../../lib/ontology';
import { compactIri } from '../../lib/format';
import { OntologyGraph } from '../../components/OntologyGraph';
import { buildModel, type OntologyModel } from '../../lib/ontologyModel';
import { ClassTree } from '../../components/ontology-viz/ClassTree';
import { ClassDiagram, DEFAULT_DIAGRAM_OPTIONS, neighbourhood, type DiagramOptions } from '../../components/ontology-viz/ClassDiagram';
import { HierarchyPath, IncomingList, Neighbourhood, PropertyTable, SubclassList } from '../../components/ontology-viz/ClassPanels';
import { BugReportDialog } from '../../components/BugReport';
import { Badge, Button, Card, Chip, CopyButton, EmptyState, ErrorCard, Input, Loading, Select, cx } from '../../components/ui';
import { useOntology } from './Layout';

function TermLink({ iri, label, onSelect }: { iri: string; label: Labeler; onSelect: (iri: string) => void }) {
  return (
    <button className="text-accent hover:underline" onClick={() => onSelect(iri)}>
      {label(iri)}
    </button>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-2.5 sm:grid-cols-[160px_1fr] sm:gap-4">
      <dt className="text-xs font-medium text-muted">{k}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function IriList({ iris, label, onSelect, empty = '—' }: { iris: string[]; label: Labeler; onSelect: (i: string) => void; empty?: string }) {
  if (!iris.length) return <span className="text-muted">{empty}</span>;
  return (
    <span className="flex flex-wrap gap-x-2 gap-y-1">
      {iris.map((i, idx) => (
        <span key={i}>
          <TermLink iri={i} label={label} onSelect={onSelect} />
          {idx < iris.length - 1 && <span className="text-muted">,</span>}
        </span>
      ))}
    </span>
  );
}

function Section({ title, children, defaultOpen = true }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} className="group mt-5 border-t border-line pt-4">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-sm font-semibold [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 text-muted transition-transform group-open:rotate-90" aria-hidden />
        {title}
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

function TermDetailPanel({ iri, onSelect, model, showNeighbourhood }: { iri: string; onSelect: (i: string) => void; model: OntologyModel; showNeighbourhood: boolean }) {
  const { id, label, view } = useOntology();
  const term = useAsync(() => api.term(id, iri), [id, iri]);
  const [bugOpen, setBugOpen] = useState(false);
  if (term.error && !term.data) return <ErrorCard error={term.error} onRetry={term.reload} />;
  if (!term.data) return <Loading />;
  const t: TermDetail = term.data;
  const prefixes = view.data?.prefixes;
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className={cx('text-lg font-semibold', t.deprecated && 'text-muted line-through')}>{t.label ?? label(t.iri)}</h2>
            <Badge tone="outline">{KIND_LABEL[t.kind]}</Badge>
            {t.deprecated && <Badge tone="warn">Deprecated</Badge>}
          </div>
          {t.kind === 'class' && model.classes.has(t.iri) && (
            <div className="mt-1">
              <HierarchyPath iri={t.iri} model={model} label={label} onSelect={onSelect} />
            </div>
          )}
          <div className="mt-1 flex items-center gap-1.5">
            <code className="truncate font-mono text-xs text-muted" title={t.iri}>
              {compactIri(t.iri, prefixes)}
            </code>
            <CopyButton text={t.iri} variant="ghost" />
          </div>
        </div>
        <Button size="sm" variant="ghost" icon={Bug} onClick={() => setBugOpen(true)}>
          Report a problem with this term
        </Button>
      </div>

      {t.deprecated && t.replacedBy && (
        <p className="mt-3 rounded-lg bg-warn-soft px-3 py-2 text-sm">
          Deprecated — use <TermLink iri={t.replacedBy} label={label} onSelect={onSelect} /> instead.
        </p>
      )}

      {t.definition ? (
        <p className="mt-4 text-[0.95rem] leading-relaxed">{t.definition}</p>
      ) : (
        <p className="mt-4 text-sm text-warn">No definition yet — strict OWL practice expects a genus–differentia definition.</p>
      )}
      {t.comment && <p className="mt-2 text-sm text-muted">{t.comment}</p>}

      <dl className="mt-4 divide-y divide-line border-t border-line">
        {t.altLabels?.length ? <Row k="Also known as">{t.altLabels.join(', ')}</Row> : null}
        {t.kind === 'class' && (
          <>
            <Row k="Subclass of">
              <IriList iris={t.superClasses} label={label} onSelect={onSelect} empty="owl:Thing (top level)" />
            </Row>
            <Row k="Subclasses">
              <SubclassList iri={t.iri} model={model} label={label} onSelect={onSelect} />
            </Row>
            {t.restrictions.length > 0 && (
              <Row k="Restrictions">
                <ul className="space-y-1 font-mono text-[0.8rem]">
                  {t.restrictions.map((r, i) => (
                    <li key={i}>
                      <button className="text-left hover:text-accent" onClick={() => onSelect(r.property)}>
                        {restrictionText(r, label)}
                      </button>
                    </li>
                  ))}
                </ul>
              </Row>
            )}
            {t.equivalentClasses.length > 0 && (
              <Row k="Equivalent to">
                <IriList iris={t.equivalentClasses} label={label} onSelect={onSelect} />
              </Row>
            )}
            {t.disjointWith.length > 0 && (
              <Row k="Disjoint with">
                <IriList iris={t.disjointWith} label={label} onSelect={onSelect} />
              </Row>
            )}
          </>
        )}
        {(t.kind === 'objectProperty' || t.kind === 'datatypeProperty' || t.kind === 'annotationProperty') && (
          <>
            <Row k="Domain">
              <IriList iris={t.domain} label={label} onSelect={onSelect} empty="Any (unconstrained)" />
            </Row>
            <Row k="Range">
              <IriList iris={t.range} label={label} onSelect={onSelect} empty="Any (unconstrained)" />
            </Row>
            {t.superProperties.length > 0 && (
              <Row k="Sub-property of">
                <IriList iris={t.superProperties} label={label} onSelect={onSelect} />
              </Row>
            )}
            {t.inverseOf && (
              <Row k="Inverse of">
                <TermLink iri={t.inverseOf} label={label} onSelect={onSelect} />
              </Row>
            )}
            {t.characteristics.length > 0 && (
              <Row k="Characteristics">
                <span className="flex flex-wrap gap-1">
                  {t.characteristics.map((c) => (
                    <Badge key={c}>{c}</Badge>
                  ))}
                </span>
              </Row>
            )}
          </>
        )}
        {t.kind === 'individual' && (
          <>
            <Row k="Instance of">
              <IriList iris={t.types} label={label} onSelect={onSelect} />
            </Row>
            {Object.entries(t.facts).map(([p, vs]) => (
              <Row key={p} k={label(p)}>
                {vs.map((v) => (v.startsWith('http') ? label(v) : v)).join(', ')}
              </Row>
            ))}
          </>
        )}
        {t.examples?.length ? (
          <Row k="Examples">
            <ul className="list-disc pl-4">
              {t.examples.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </Row>
        ) : null}
        {t.source?.length ? <Row k="Source">{t.source.join(', ')}</Row> : null}
        {t.editorialNote && <Row k="Editorial note">{t.editorialNote}</Row>}
        <Row k="Used by">
          {t.usedBy?.length ? (
            <ul className="space-y-1">
              {t.usedBy.map((u, i) => (
                <li key={i}>
                  <TermLink iri={u.iri} label={(x) => u.label ?? label(x)} onSelect={onSelect} /> <span className="text-xs text-muted">via {u.via}</span>
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-muted">Not referenced by other terms.</span>
          )}
        </Row>
      </dl>
      {t.kind === 'class' && model.classes.has(t.iri) && view.data && (
        <>
          <Section title="Properties">
            <PropertyTable iri={t.iri} model={model} label={label} onSelect={onSelect} />
          </Section>
          <Section title="Relationships pointing here">
            <IncomingList iri={t.iri} model={model} label={label} onSelect={onSelect} />
          </Section>
          {showNeighbourhood && (
            <Section title="Neighbourhood diagram">
              <Neighbourhood iri={t.iri} view={view.data} model={model} label={label} onSelect={onSelect} />
            </Section>
          )}
        </>
      )}
      <BugReportDialog open={bugOpen} onClose={() => setBugOpen(false)} ontologyId={id} termIri={t.iri} termLabel={t.label ?? label(t.iri)} />
    </Card>
  );
}

function PropList({ title, items, selected, onSelect, label }: { title: string; items: TermView[]; selected?: string; onSelect: (i: string) => void; label: Labeler }) {
  const [open, setOpen] = useState(true);
  if (!items.length) return null;
  return (
    <div className="mt-4">
      <button className="mb-1 flex w-full items-center gap-1 text-xs font-semibold tracking-wide text-muted uppercase" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />} {title} ({items.length})
      </button>
      {open && (
        <ul>
          {[...items]
            .sort((a, b) => (a.label ?? a.iri).localeCompare(b.label ?? b.iri))
            .map((p) => (
              <li key={p.iri}>
                <button
                  onClick={() => onSelect(p.iri)}
                  className={cx('block w-full truncate rounded-md px-2 py-1 text-left text-sm', selected === p.iri ? 'bg-accent-soft font-medium text-accent' : 'hover:bg-surface-2', p.deprecated && 'line-through opacity-70')}
                >
                  {p.label ?? label(p.iri)}
                </button>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

type Mode = 'tree' | 'diagram' | 'graph';
const MODES: { key: Mode; label: string; icon: typeof ListTree; hint: string }[] = [
  { key: 'tree', label: 'Classes', icon: ListTree, hint: 'Hierarchy and term pages' },
  { key: 'diagram', label: 'Diagram', icon: LayoutTemplate, hint: 'UML-style class diagram' },
  { key: 'graph', label: 'Graph', icon: Network, hint: 'Network overview' },
];

function DiagramView({ model, selected, onSelect }: { model: OntologyModel; selected?: string; onSelect: (iri: string) => void }) {
  const { view, label } = useOntology();
  const [params, setParams] = useSearchParams();
  const [opts, setOpts] = useState<DiagramOptions>(DEFAULT_DIAGRAM_OPTIONS);
  const focusable = !!selected && model.classes.has(selected);
  const hops = Number(params.get('hops') ?? '0');
  const focus = focusable && hops > 0 ? selected : undefined;
  const scope = useMemo(() => (focus ? neighbourhood(model, focus, hops, opts) : new Set(model.classes.keys())), [model, focus, hops, opts]);
  const setHops = (h: number) => {
    const next = new URLSearchParams(params);
    if (h) next.set('hops', String(h));
    else next.delete('hops');
    setParams(next, { replace: true });
  };
  const toggle = (k: keyof DiagramOptions) => setOpts((o) => ({ ...o, [k]: !o[k] }));
  if (!view.data) return null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Diagram options">
        <label className="flex items-center gap-2 text-xs text-muted">
          Show
          <Select value={focus ? String(hops) : '0'} onChange={(e) => setHops(Number(e.target.value))} className="h-8 w-56 text-sm" aria-label="Diagram scope">
            <option value="0">Whole ontology</option>
            <option value="1" disabled={!focusable}>
              {focusable ? `${label(selected!)} and direct links` : 'Around a class (pick one first)'}
            </option>
            <option value="2" disabled={!focusable}>
              {focusable ? `${label(selected!)}, two links out` : 'Two links out (pick a class)'}
            </option>
          </Select>
        </label>
        <Chip active={opts.attributes} onClick={() => toggle('attributes')}>Attributes</Chip>
        <Chip active={opts.inherited} onClick={() => toggle('inherited')} disabled={!opts.attributes}>Inherited attributes</Chip>
        <Chip active={opts.associations} onClick={() => toggle('associations')}>Relationships</Chip>
        <Chip active={opts.subclasses} onClick={() => toggle('subclasses')}>Subclasses</Chip>
      </div>
      <ClassDiagram view={view.data} model={model} label={label} scope={scope} options={opts} selected={selected} focus={focus} onSelect={onSelect} height={selected ? 520 : 680} />
    </div>
  );
}

export function BrowseTab() {
  const { id, view, label } = useOntology();
  const [params, setParams] = useSearchParams();
  const selected = params.get('term') ?? undefined;
  const raw = params.get('view');
  const mode: Mode = raw === 'graph' || raw === 'diagram' ? raw : 'tree';
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const results = useAsync(async () => (debounced ? api.search(id, debounced) : undefined), [id, debounced]);
  const model = useMemo(() => (view.data ? buildModel(view.data) : undefined), [view.data]);

  const select = (iri: string) => {
    const next = new URLSearchParams(params);
    next.set('term', iri);
    setParams(next, { replace: false });
  };
  const setMode = (m: Mode) => {
    const next = new URLSearchParams(params);
    if (m === 'tree') next.delete('view');
    else next.set('view', m);
    setParams(next, { replace: true });
  };

  if (view.error && !view.data) return <ErrorCard error={view.error} onRetry={view.reload} />;
  if (!view.data || !model) return <Loading label="Loading ontology…" />;
  const v = view.data;
  const empty = !v.classes.length && !v.objectProperties.length && !v.datatypeProperties.length;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search terms, definitions…" className="pl-9" aria-label="Search terms" />
          {q && (
            <button className="absolute top-2.5 right-3 text-muted" onClick={() => setQ('')} aria-label="Clear search">
              <X className="size-4" />
            </button>
          )}
        </div>
        <div className="inline-flex rounded-lg border border-line-strong p-0.5" role="radiogroup" aria-label="View">
          {MODES.map((m) => (
            <button
              key={m.key}
              role="radio"
              aria-checked={mode === m.key}
              title={m.hint}
              onClick={() => setMode(m.key)}
              className={cx('inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-sm', mode === m.key ? 'bg-surface-2 font-medium' : 'text-muted hover:text-fg')}
            >
              <m.icon className="size-4" aria-hidden /> {m.label}
            </button>
          ))}
        </div>
      </div>

      {empty ? (
        <EmptyState icon={ListTree} title="This ontology has no terms yet">
          Describe a use case or upload a meeting, then synthesise a change request — approved changes appear here.
        </EmptyState>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
          <Card className="max-h-[75vh] overflow-y-auto p-3 lg:sticky lg:top-20">
            {debounced ? (
              <div>
                <div className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Search results</div>
                {results.loading && !results.data ? (
                  <Loading />
                ) : results.error ? (
                  <ErrorCard error={results.error} />
                ) : results.data?.length ? (
                  <ul>
                    {results.data.map((t) => (
                      <li key={t.iri}>
                        <button onClick={() => select(t.iri)} className={cx('w-full rounded-md px-2 py-1.5 text-left hover:bg-surface-2', selected === t.iri && 'bg-accent-soft')}>
                          <div className="text-sm font-medium">{t.label ?? label(t.iri)}</div>
                          <div className="text-xs text-muted">
                            {KIND_LABEL[t.kind]}
                            {t.definition && ` · ${t.definition.slice(0, 70)}${t.definition.length > 70 ? '…' : ''}`}
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="px-2 py-4 text-sm text-muted">No terms match “{debounced}”.</p>
                )}
              </div>
            ) : (
              <>
                <ClassTree model={model} label={label} selected={selected} onSelect={select} />
                <PropList title="Object properties" items={v.objectProperties} selected={selected} onSelect={select} label={label} />
                <PropList title="Datatype properties" items={v.datatypeProperties} selected={selected} onSelect={select} label={label} />
                <PropList title="Individuals" items={v.individuals} selected={selected} onSelect={select} label={label} />
              </>
            )}
          </Card>
          <div className="min-w-0 space-y-4">
            {mode === 'graph' && <OntologyGraph view={v} selected={selected} onSelect={select} height={selected ? 440 : 620} />}
            {mode === 'diagram' && <DiagramView model={model} selected={selected} onSelect={select} />}
            {selected ? (
              <TermDetailPanel iri={selected} onSelect={select} model={model} showNeighbourhood={mode === 'tree'} />
            ) : (
              mode === 'tree' && (
                <EmptyState icon={ListTree} title="Pick a term">
                  Choose a class or property on the left to see its definition, properties, axioms and a diagram of what it connects to. Or switch to the Diagram or Graph view above to see the whole ontology.
                </EmptyState>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}
