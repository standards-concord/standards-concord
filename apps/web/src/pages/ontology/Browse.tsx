import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import type { OntologyView, TermView } from '@concord/shared';
import type { ClassView } from '@concord/core/types';
import { Bug, ChevronDown, ChevronRight, Circle, Network, ListTree, Search, X } from 'lucide-react';
import { api, type TermDetail } from '../../api';
import { useAsync } from '../../lib/hooks';
import { KIND_LABEL, restrictionText, type Labeler } from '../../lib/ontology';
import { compactIri } from '../../lib/format';
import { OntologyGraph } from '../../components/OntologyGraph';
import { BugReportDialog } from '../../components/BugReport';
import { Badge, Button, Card, CopyButton, EmptyState, ErrorCard, Input, Loading, cx } from '../../components/ui';
import { useOntology } from './Layout';

function buildTree(view: OntologyView) {
  const iris = new Set(view.classes.map((c) => c.iri));
  const children = new Map<string, ClassView[]>();
  const roots: ClassView[] = [];
  for (const c of view.classes) {
    const parents = c.superClasses.filter((s) => iris.has(s) && s !== c.iri);
    if (!parents.length) roots.push(c);
    for (const p of parents) children.set(p, [...(children.get(p) ?? []), c]);
  }
  const byLabel = (a: ClassView, b: ClassView) => (a.label ?? a.iri).localeCompare(b.label ?? b.iri);
  roots.sort(byLabel);
  for (const v of children.values()) v.sort(byLabel);
  return { roots, children };
}

function TreeNode({ c, children, depth, selected, onSelect, label, seen }: { c: ClassView; children: Map<string, ClassView[]>; depth: number; selected?: string; onSelect: (iri: string) => void; label: Labeler; seen: Set<string> }) {
  const kids = seen.has(c.iri) ? [] : (children.get(c.iri) ?? []);
  const [open, setOpen] = useState(depth < 2);
  const nextSeen = useMemo(() => new Set([...seen, c.iri]), [seen, c.iri]);
  return (
    <li>
      <div className={cx('flex items-center rounded-md pr-2 text-sm', selected === c.iri ? 'bg-accent-soft font-medium text-accent' : 'hover:bg-surface-2')} style={{ paddingLeft: depth * 14 }}>
        <button className="flex size-6 shrink-0 items-center justify-center text-muted" onClick={() => setOpen((o) => !o)} aria-label={open ? 'Collapse' : 'Expand'} disabled={!kids.length}>
          {kids.length ? open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" /> : <Circle className="size-1.5 fill-current opacity-40" />}
        </button>
        <button className={cx('min-w-0 flex-1 truncate py-1 text-left', c.deprecated && 'text-muted line-through')} onClick={() => onSelect(c.iri)}>
          {c.label ?? label(c.iri)}
        </button>
        {kids.length > 0 && <span className="text-[0.65rem] text-subtle">{kids.length}</span>}
      </div>
      {open && kids.length > 0 && (
        <ul>
          {kids.map((k) => (
            <TreeNode key={k.iri} c={k} children={children} depth={depth + 1} selected={selected} onSelect={onSelect} label={label} seen={nextSeen} />
          ))}
        </ul>
      )}
    </li>
  );
}

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

function TermDetailPanel({ iri, onSelect }: { iri: string; onSelect: (i: string) => void }) {
  const { id, label, view } = useOntology();
  const term = useAsync(() => api.term(id, iri), [id, iri]);
  const [bugOpen, setBugOpen] = useState(false);
  // Members arriving from "Report a problem" on the public page (?report=1) land with the form open.
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    if (params.get('report') !== '1') return;
    setBugOpen(true);
    const next = new URLSearchParams(params);
    next.delete('report');
    setParams(next, { replace: true });
  }, [params, setParams]);
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

export function BrowseTab() {
  const { id, view, label } = useOntology();
  const [params, setParams] = useSearchParams();
  const selected = params.get('term') ?? undefined;
  const mode = params.get('view') === 'graph' ? 'graph' : 'tree';
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const results = useAsync(async () => (debounced ? api.search(id, debounced) : undefined), [id, debounced]);
  const tree = useMemo(() => (view.data ? buildTree(view.data) : undefined), [view.data]);

  const select = (iri: string) => {
    const next = new URLSearchParams(params);
    next.set('term', iri);
    setParams(next, { replace: false });
  };
  const setMode = (m: 'tree' | 'graph') => {
    const next = new URLSearchParams(params);
    if (m === 'graph') next.set('view', 'graph');
    else next.delete('view');
    setParams(next, { replace: true });
  };

  if (view.error && !view.data) return <ErrorCard error={view.error} onRetry={view.reload} />;
  if (!view.data || !tree) return <Loading label="Loading ontology…" />;
  const v = view.data;
  const empty = !v.classes.length && !v.objectProperties.length && !v.datatypeProperties.length;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search terms, definitions…" className="pl-9" />
          {q && (
            <button className="absolute top-2.5 right-3 text-muted" onClick={() => setQ('')} aria-label="Clear search">
              <X className="size-4" />
            </button>
          )}
        </div>
        <div className="inline-flex rounded-lg border border-line-strong p-0.5">
          <button onClick={() => setMode('tree')} className={cx('inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-sm', mode === 'tree' ? 'bg-surface-2 font-medium' : 'text-muted')}>
            <ListTree className="size-4" /> Tree
          </button>
          <button onClick={() => setMode('graph')} className={cx('inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-sm', mode === 'graph' ? 'bg-surface-2 font-medium' : 'text-muted')}>
            <Network className="size-4" /> Graph
          </button>
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
                <div className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Classes ({v.classes.length})</div>
                <ul>
                  {tree.roots.map((c) => (
                    <TreeNode key={c.iri} c={c} children={tree.children} depth={0} selected={selected} onSelect={select} label={label} seen={new Set()} />
                  ))}
                </ul>
                <PropList title="Object properties" items={v.objectProperties} selected={selected} onSelect={select} label={label} />
                <PropList title="Datatype properties" items={v.datatypeProperties} selected={selected} onSelect={select} label={label} />
                <PropList title="Individuals" items={v.individuals} selected={selected} onSelect={select} label={label} />
              </>
            )}
          </Card>
          <div className="min-w-0 space-y-4">
            {mode === 'graph' && <OntologyGraph view={v} selected={selected} onSelect={select} height={selected ? 420 : 600} />}
            {selected ? (
              <TermDetailPanel iri={selected} onSelect={select} />
            ) : (
              mode === 'tree' && (
                <EmptyState icon={ListTree} title="Pick a term">
                  Choose a class or property on the left to see its definition, axioms and where it’s used.
                </EmptyState>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}
