import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import type { OntologyView, TermView } from '@concord/shared';
import { Bug, ChevronDown, ChevronRight, Crosshair, LayoutTemplate, ListTree, Maximize, PanelLeftClose, PanelLeftOpen, PenLine, Plus, Search, X } from 'lucide-react';
import { CodeEditForm, CodeListContents, NewCodeListPanel } from '../../components/CodeLists';
import { useSession } from '../../lib/session';
import { api, type TermDetail } from '../../api';
import { useAsync } from '../../lib/hooks';
import { KIND_LABEL, allTerms, restrictionText, type Labeler } from '../../lib/ontology';
import { searchTerms, termDetail } from '@concord/core/terms';
import { compactIri, datatypeName } from '../../lib/format';
import { buildModel, type OntologyModel } from '../../lib/ontologyModel';
import { ClassTree } from '../../components/ontology-viz/ClassTree';
import { ClassDiagram, DEFAULT_DIAGRAM_OPTIONS, neighbourhood, type DiagramOptions } from '../../components/ontology-viz/ClassDiagram';
import { HierarchyPath, IncomingList, Neighbourhood, PropertyTable, SubclassList } from '../../components/ontology-viz/ClassPanels';
import { BugReportDialog } from '../../components/BugReport';
import { ProposedEditNotice, TermEditForm } from '../../components/TermEdit';
import type { ChangeRequestDetail } from '@concord/shared';
import { Badge, Button, Card, Chip, CopyButton, EmptyState, ErrorCard, Input, Loading, Select, cx } from '../../components/ui';
import { useOntology } from './Layout';
import { DiagramProposals, type ProposalRenderState } from '../../components/ontology-viz/DiagramProposals';

function TermLink({ iri, label, onSelect }: { iri: string; label: Labeler; onSelect: (iri: string) => void }) {
  // Datatypes (xsd:boolean and friends) aren't terms of this ontology, so there's nothing to open.
  if (datatypeName(iri)) return <span title={compactIri(iri)}>{label(iri)}</span>;
  return (
    <button type="button" className="text-left text-accent hover:underline" onClick={() => onSelect(iri)}>
      {label(iri)}
    </button>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-2.5 sm:grid-cols-[160px_1fr] sm:items-baseline sm:gap-4">
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

function Section({ title, count, children, defaultOpen = false }: { title: string; count?: number; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} className="group mt-4 border-t border-line pt-3">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded text-sm font-semibold focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 text-muted transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
        {title}
        {count !== undefined && <span className="rounded-full bg-surface-2 px-1.5 text-xs font-medium text-muted">{count}</span>}
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

function TermDetailPanel({
  iri,
  onSelect,
  model,
  showNeighbourhood,
  compact,
  onClose,
}: {
  iri: string;
  onSelect: (i: string) => void;
  model: OntologyModel;
  showNeighbourhood: boolean;
  compact?: boolean;
  onClose?: () => void;
}) {
  const { id, label, view } = useOntology();
  // The page already holds the whole ontology (its view), so a term's details, and what uses it,
  // come straight from there: following a link shows the term at once, with no request.
  const local = useMemo(() => (view.data ? termDetail(view.data, iri) : undefined), [view.data, iri]);
  // Only an IRI the view doesn't list is asked of the server. Each response remembers which term
  // it is for, so the editor never opens on a previous term's data while the selected one loads.
  const remote = useAsync(async () => (local ? undefined : { for: `${id}|${iri}`, detail: await api.term(id, iri) }), [id, iri, !local]);
  const term = local ? { data: { for: `${id}|${iri}`, detail: local }, loading: false, error: undefined, reload: remote.reload } : remote;
  const [bugOpen, setBugOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [proposed, setProposed] = useState<ChangeRequestDetail>();
  const editId = useId();
  const refocusEdit = useRef(false);
  useEffect(() => {
    setEditing(false);
    setProposed(undefined);
  }, [id, iri]);
  useEffect(() => {
    if (!editing && refocusEdit.current) document.getElementById(editId)?.focus();
    refocusEdit.current = false;
  }, [editing, editId]);
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
  const t: TermDetail = term.data.detail;
  const current = term.data.for === `${id}|${iri}` && !term.loading;
  const prefixes = view.data?.prefixes;
  if (editing && current) {
    const onCancel = () => {
      refocusEdit.current = true;
      setEditing(false);
    };
    const onProposed = (cr: ChangeRequestDetail) => {
      // Editors ignore a save finishing after their selected term has unmounted.
      if (cr.origin.type === 'term-edit' ? cr.origin.termIri !== t.iri : cr.origin.type !== 'code-list-edit') return;
      setEditing(false);
      setProposed(cr);
    };
    return (
      <Card className="p-5">
        {t.kind === 'concept' || t.kind === 'conceptScheme' ? (
          <CodeEditForm key={`${id}|${t.iri}`} term={t} onCancel={onCancel} onProposed={onProposed} />
        ) : (
          <TermEditForm key={`${id}|${t.iri}`} term={t} termLabel={t.label ?? label(t.iri)} onCancel={onCancel} onProposed={onProposed} />
        )}
      </Card>
    );
  }
  const isClass = t.kind === 'class' && model.classes.has(t.iri);
  const isProp = t.kind === 'objectProperty' || t.kind === 'datatypeProperty' || t.kind === 'annotationProperty';
  const slotCount = isClass ? model.allSlots(t.iri).reduce((n, g) => n + g.slots.length, 0) : 0;
  const rules =
    t.kind === 'class'
      ? t.restrictions.length + t.equivalentClasses.length + t.disjointWith.length + (t.superClassExpressions?.length ?? 0) + (t.equivalentExpressions?.length ?? 0)
      : isProp
        ? t.superProperties.length + (t.inverseOf ? 1 : 0) + t.characteristics.length
        : t.kind === 'individual'
          ? Object.keys(t.facts).length
          : 0;
  const usage = (t.usedBy?.length ?? 0) + (isClass ? model.incoming(t.iri).length : 0);
  const editorial = (t.altLabels?.length ? 1 : 0) + (t.source?.length ? 1 : 0) + (t.editorialNote ? 1 : 0);
  return (
    <Card className={cx('p-5', compact && 'p-4')}>
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
        <div className="flex flex-wrap items-center gap-1">
          <Button id={editId} size="sm" variant="ghost" icon={PenLine} disabled={!current} onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button size="sm" variant="ghost" icon={Bug} onClick={() => setBugOpen(true)}>
            {compact ? 'Report a problem' : 'Report a problem with this term'}
          </Button>
          {onClose && (
            <button type="button" className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-fg" onClick={onClose} aria-label="Close term details">
              <X className="size-4" />
            </button>
          )}
        </div>
      </div>
      {proposed && <ProposedEditNotice cr={proposed} onDismiss={() => setProposed(undefined)} />}

      {t.deprecated && (
        <p className="mt-3 rounded-lg bg-warn-soft px-3 py-2 text-sm">
          Deprecated{t.replacedBy && <> — use <TermLink iri={t.replacedBy} label={label} onSelect={onSelect} /> instead</>}.
        </p>
      )}

      {t.definition ? (
        <p className="mt-4 text-[0.95rem] leading-relaxed">{t.definition}</p>
      ) : (
        <p className="mt-4 text-sm text-warn">No definition yet — strict OWL practice expects a genus–differentia definition.</p>
      )}
      {t.comment && <p className="mt-2 text-sm text-muted">{t.comment}</p>}

      {/* Always visible: what it is and where it sits. Everything else is grouped below. */}
      <dl className={cx('mt-4 divide-y divide-line', t.kind !== 'conceptScheme' && 'border-t border-line')}>
        {t.kind === 'class' && (
          <>
            <Row k="Subclass of">
              <IriList iris={t.superClasses} label={label} onSelect={onSelect} empty="Thing (top level)" />
            </Row>
            {model.classes.has(t.iri) && (
              <Row k="Subclasses">
                <SubclassList iri={t.iri} model={model} label={label} onSelect={onSelect} />
              </Row>
            )}
          </>
        )}
        {isProp && (
          <>
            <Row k="Domain">
              <IriList iris={t.domain} label={label} onSelect={onSelect} empty="Any (unconstrained)" />
            </Row>
            <Row k="Range">
              {t.codeList ? <>Codes from <TermLink iri={t.codeList} label={label} onSelect={onSelect} /></> : <IriList iris={t.range} label={label} onSelect={onSelect} empty="Any (unconstrained)" />}
            </Row>
          </>
        )}
        {t.kind === 'concept' && <>
          <Row k="Code">{t.notation || '—'}</Row>
          <Row k="In list"><IriList iris={t.inScheme} label={label} onSelect={onSelect} /></Row>
          <Row k="Broader"><IriList iris={t.broader} label={label} onSelect={onSelect} empty="Top level" /></Row>
          <Row k="Narrower"><IriList iris={t.narrower} label={label} onSelect={onSelect} /></Row>
        </>}
        {t.kind === 'individual' && (
          <Row k="Instance of">
            <IriList iris={t.types} label={label} onSelect={onSelect} />
          </Row>
        )}
      </dl>

      {t.kind === 'conceptScheme' && <CodeListContents key={`${id}|${t.iri}`} scheme={t} onSelect={onSelect} onProposed={setProposed} refreshKey={proposed?.id} />}
      {isClass && (
        <Section title="Properties" count={slotCount} defaultOpen>
          <PropertyTable iri={t.iri} model={model} label={label} onSelect={onSelect} compact={compact} />
        </Section>
      )}

      {rules > 0 && (
        <Section title="Logical rules" count={rules}>
          <dl className="divide-y divide-line">
            {t.kind === 'class' && t.restrictions.length > 0 && (
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
            {t.kind === 'class' && !!t.superClassExpressions?.length && (
              <Row k="Also a subclass of">
                <ul className="space-y-1 font-mono text-[0.8rem]">
                  {t.superClassExpressions.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </Row>
            )}
            {t.kind === 'class' && !!t.equivalentExpressions?.length && (
              <Row k="Defined as">
                <ul className="space-y-1 font-mono text-[0.8rem]">
                  {t.equivalentExpressions.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </Row>
            )}
            {t.kind === 'class' && t.equivalentClasses.length > 0 && (
              <Row k="Equivalent to">
                <IriList iris={t.equivalentClasses} label={label} onSelect={onSelect} />
              </Row>
            )}
            {t.kind === 'class' && t.disjointWith.length > 0 && (
              <Row k="Disjoint with">
                <IriList iris={t.disjointWith} label={label} onSelect={onSelect} />
              </Row>
            )}
            {isProp && t.superProperties.length > 0 && (
              <Row k="Sub-property of">
                <IriList iris={t.superProperties} label={label} onSelect={onSelect} />
              </Row>
            )}
            {isProp && t.inverseOf && (
              <Row k="Inverse of">
                <TermLink iri={t.inverseOf} label={label} onSelect={onSelect} />
              </Row>
            )}
            {isProp && t.characteristics.length > 0 && (
              <Row k="Characteristics">
                <span className="flex flex-wrap gap-1">
                  {t.characteristics.map((c) => (
                    <Badge key={c}>{c}</Badge>
                  ))}
                </span>
              </Row>
            )}
            {t.kind === 'individual' &&
              Object.entries(t.facts).map(([p, vs]) => (
                <Row key={p} k={label(p)}>
                  {vs.map((v) => (v.startsWith('http') ? label(v) : v)).join(', ')}
                </Row>
              ))}
          </dl>
        </Section>
      )}

      <Section title="Usage" count={usage}>
        <dl className="divide-y divide-line">
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
          {isClass && (
            <Row k="Relationships pointing here">
              <IncomingList iri={t.iri} model={model} label={label} onSelect={onSelect} />
            </Row>
          )}
        </dl>
      </Section>

      {t.examples?.length ? (
        <Section title="Examples" count={t.examples.length}>
          <ul className="list-disc space-y-1 pl-4 text-sm">
            {t.examples.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      {editorial > 0 && (
        <Section title="Editorial details" count={editorial}>
          <dl className="divide-y divide-line">
            {t.altLabels?.length ? <Row k="Also known as">{t.altLabels.join(', ')}</Row> : null}
            {t.source?.length ? <Row k="Source">{t.source.join(', ')}</Row> : null}
            {t.editorialNote && <Row k="Editorial note">{t.editorialNote}</Row>}
          </dl>
        </Section>
      )}

      {isClass && showNeighbourhood && view.data && (
        <Section title="Neighbourhood diagram">
          <Neighbourhood iri={t.iri} view={view.data} model={model} label={label} onSelect={onSelect} />
        </Section>
      )}
      <BugReportDialog open={bugOpen} onClose={() => setBugOpen(false)} ontologyId={id} termIri={t.iri} termLabel={t.label ?? label(t.iri)} />
    </Card>
  );
}

function PropList({ title, items, selected, onSelect, label, counts }: { counts?: Map<string, number>; title: string; items: TermView[]; selected?: string; onSelect: (i: string) => void; label: Labeler }) {
  // Collapsed until asked for, or until the selected term is in this list.
  const has = !!selected && items.some((i) => i.iri === selected);
  const [open, setOpen] = useState(has);
  useEffect(() => {
    if (has) setOpen(true);
  }, [has]);
  if (!items.length) return null;
  return (
    <div className="mt-3">
      <button className="mb-1 flex w-full items-center gap-1 rounded text-sm font-semibold hover:text-fg" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
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
                  className={cx(
                    'block w-full rounded-md px-2 py-1 text-left text-sm leading-snug break-words',
                    selected === p.iri ? 'bg-accent-soft font-medium text-accent' : 'hover:bg-surface-2',
                    p.deprecated && 'line-through opacity-70',
                  )}
                >
                  {p.label ?? label(p.iri)}{counts && <span className="ml-2 text-xs text-muted">({counts.get(p.iri) ?? 0})</span>}
                </button>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

type Mode = 'tree' | 'diagram';
const MODES: {
  key: Mode;
  label: string;
  icon: typeof ListTree;
  task: string;
}[] = [
  {
    key: 'tree',
    label: 'List',
    icon: ListTree,
    task: 'Find a term and read its definition, properties and where it’s used.',
  },
  {
    key: 'diagram',
    label: 'Diagram',
    icon: LayoutTemplate,
    task: 'Check what data each class has: attributes, types and how many of each.',
  },
];

/** More classes than this and the diagram asks where to start rather than drawing everything. */
export const LARGE_DIAGRAM = 80;

/** Whole ontology, or a class and everything one or two links away. */
function ScopeControl({ hops, setHops, anchor, centreOn, onCentre }: { hops: number; setHops: (h: number) => void; anchor?: string; centreOn?: string; onCentre: (iri: string) => void }) {
  const { label } = useOntology();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2 text-xs text-muted">
        Show
        <Select value={anchor ? String(hops) : '0'} onChange={(e) => setHops(Number(e.target.value))} className="h-8 w-56 text-sm" aria-label="Scope">
          <option value="0">Whole ontology</option>
          <option value="1" disabled={!anchor}>
            {anchor ? `${label(anchor)} and direct links` : 'Around a class (pick one first)'}
          </option>
          <option value="2" disabled={!anchor}>
            {anchor ? `${label(anchor)}, two links out` : 'Two links out (pick a class)'}
          </option>
        </Select>
      </label>
      {centreOn && (
        <Button size="sm" variant="secondary" icon={Crosshair} onClick={() => onCentre(centreOn)}>
          Centre on {label(centreOn)}
        </Button>
      )}
      {anchor && hops > 0 && (
        <Button size="sm" variant="ghost" icon={Maximize} onClick={() => setHops(0)}>
          Show entire ontology
        </Button>
      )}
    </div>
  );
}

/** Classes with the most links, as starting points for a large ontology's diagram. */
function hubs(model: OntologyModel, n: number) {
  const degree = new Map<string, number>();
  const bump = (iri: string, by = 1) => model.classes.has(iri) && degree.set(iri, (degree.get(iri) ?? 0) + by);
  for (const [c, ps] of model.parents) for (const p of ps) (bump(c), bump(p));
  for (const c of model.classes.keys()) for (const s of model.ownSlots(c)) for (const r of s.range) if (model.classes.has(r)) (bump(c), bump(r));
  return [...degree]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([iri]) => iri);
}

function DiagramView({
  model,
  selected,
  focus,
  hops,
  onSelect,
  onCentre,
  proposals,
}: {
  model: OntologyModel;
  selected?: string;
  focus?: string;
  hops: number;
  onSelect: (iri: string) => void;
  onCentre: (iri: string) => void;
  proposals: ProposalRenderState;
}) {
  const { view, label } = useOntology();
  const { toggle: proposeToggle, notice, preview, onPick } = proposals;
  const [opts, setOpts] = useState<DiagramOptions>(DEFAULT_DIAGRAM_OPTIONS);
  const [drawAll, setDrawAll] = useState(false);
  const large = !focus && model.classes.size > LARGE_DIAGRAM && !drawAll;
  const scope = useMemo(() => (focus ? neighbourhood(model, focus, hops, opts) : new Set(model.classes.keys())), [model, focus, hops, opts]);
  const starts = useMemo(() => (large ? hubs(model, 8) : []), [large, model]);
  const toggle = (k: keyof DiagramOptions) => setOpts((o) => ({ ...o, [k]: !o[k] }));
  if (!view.data) return null;
  const diagramView = view.data;
  const largeDiagram = (
    <section data-testid="large-diagram" aria-labelledby="large-diagram-title">
      <Card className="p-6">
        <h3 id="large-diagram-title" className="font-semibold">
          Where would you like to start?
        </h3>
        <p className="mt-1 max-w-prose text-sm text-muted">
          This ontology has {model.classes.size} classes, too many to read in one diagram. Pick a class to see it and its direct links, or choose one from the Terms panel.
        </p>
        <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Start from a class">
          {starts.map((iri) => (
            <Button key={iri} size="sm" variant="secondary" onClick={() => onCentre(iri)}>
              {label(iri)}
            </Button>
          ))}
        </div>
        <Button size="sm" variant="ghost" className="mt-4" onClick={() => setDrawAll(true)}>
          Draw all {model.classes.size} classes anyway
        </Button>
      </Card>
    </section>
  );
  return (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Diagram options">
            <Chip active={opts.attributes} onClick={() => toggle('attributes')}>
              Attributes
            </Chip>
            <Chip active={opts.inherited} onClick={() => toggle('inherited')} disabled={!opts.attributes}>
              Inherited attributes
            </Chip>
            <Chip active={opts.associations} onClick={() => toggle('associations')}>
              Relationships
            </Chip>
            <Chip active={opts.subclasses} onClick={() => toggle('subclasses')}>
              Subclasses
            </Chip>
            {proposeToggle}
          </div>
          {notice}
          {large && !preview?.scope.size ? largeDiagram : (
            <ClassDiagram
              view={diagramView}
              model={model}
              preview={preview}
              onPick={onPick}
              label={label}
              scope={large && preview ? preview.scope : scope}
              options={opts}
              selected={selected}
              focus={focus}
              onSelect={onSelect}
              height={640}
              detailsId="term-details"
            />
          )}
        </div>
  );
}

export function BrowseTab() {
  const { id, ontology, view, label } = useOntology();
  const { session } = useSession();
  const [params, setParams] = useSearchParams();
  const selected = params.get('term') ?? undefined;
  const newCodeList = params.get('new') === 'code-list';
  const raw = params.get('view');
  // The Graph view was removed (the Diagram shows the same model, with each class's data): old links open the Diagram.
  const mode: Mode = raw === 'graph' || raw === 'diagram' ? 'diagram' : 'tree';
  const canvas = mode !== 'tree';
  const [q, setQ] = useState('');
  // Typing stays responsive on a large ontology: the results catch up with the box when React has time.
  const debounced = useDeferredValue(q.trim());
  const [navOpen, setNavOpen] = useState<boolean>();
  const model = useMemo(() => (view.data ? buildModel(view.data) : undefined), [view.data]);
  // Search runs over the loaded ontology too: results appear as you type, with no request.
  const terms = useMemo(() => (view.data ? allTerms(view.data) : []), [view.data]);
  const results = useMemo(() => (debounced ? searchTerms(terms, debounced, 30) : undefined), [terms, debounced]);

  // Canvas scope. The drawing is anchored on ?around= (a class), independently of the term
  // being inspected (?term=), so picking something shows its details without redrawing.
  // Arriving with only a class selected anchors on that class.
  const isClass = (iri?: string | null): iri is string => !!iri && !!model?.classes.has(iri);
  const aroundParam = params.get('around');
  const hopsParam = params.get('hops');
  const around = isClass(aroundParam) ? aroundParam : hopsParam === null && isClass(selected) ? selected : undefined;
  const hops = around ? (hopsParam !== null ? Math.max(0, Math.min(2, Number(hopsParam) || 0)) : 1) : 0;
  const focus = around && hops > 0 ? around : undefined;
  const scope = useMemo(() => (model && focus ? neighbourhood(model, focus, hops, DEFAULT_DIAGRAM_OPTIONS) : undefined), [model, focus, hops]);

  const update = (f: (p: URLSearchParams) => void, replace = false) => {
    const next = new URLSearchParams(params);
    f(next);
    setParams(next, { replace });
  };
  // Write the current scope into the URL so it survives a change of term.
  const pin = (p: URLSearchParams) => {
    if (focus) {
      p.set('around', focus);
      p.set('hops', String(hops));
    } else {
      p.delete('around');
      p.set('hops', '0');
    }
  };
  const centre = (iri: string) =>
    update((p) => {
      p.delete('new');
      p.set('term', iri);
      p.set('around', iri);
      p.set('hops', String(hops || 1));
    });
  // From the term list, search or links: in a canvas view, a class outside the drawing
  // recentres it; anything else keeps the current scope.
  const select = (iri: string) => {
    if (canvas && scope && isClass(iri) && !scope.has(iri)) return centre(iri);
    update((p) => {
      p.delete('new');
      p.set('term', iri);
      if (canvas) pin(p);
    });
  };
  // Picking on the canvas only changes the details.
  const selectOnCanvas = (iri: string) =>
    update((p) => {
      p.delete('new');
      p.set('term', iri);
      pin(p);
    });
  const setHops = (h: number) =>
    update((p) => {
      const anchor = around ?? (isClass(selected) ? selected : undefined);
      if (h > 0 && anchor) {
        p.set('around', anchor);
        p.set('hops', String(h));
      } else {
        p.delete('around');
        p.set('hops', '0');
      }
    }, true);
  const setMode = (m: Mode) =>
    update((p) => {
      if (m === 'tree') p.delete('view');
      else p.set('view', m);
    }, true);
  const clear = () =>
    update((p) => {
      p.delete('new');
      p.delete('term');
      if (canvas) pin(p);
    });
  const anchor = focus ?? (isClass(selected) ? selected : undefined);
  const centreOn = isClass(selected) && selected !== focus ? selected : undefined;

  if (view.error && !view.data) return <ErrorCard error={view.error} onRetry={view.reload} />;
  if (!view.data || !model) return <Loading label="Loading ontology…" />;
  const v = view.data;
  const empty = !v.classes.length && !v.objectProperties.length && !v.datatypeProperties.length && !v.conceptSchemes?.length && !session?.user;
  const codeCounts = new Map((v.conceptSchemes ?? []).map((s) => [s.iri, (v.concepts ?? []).filter((c) => c.inScheme.includes(s.iri)).length]));
  // In the canvas views the navigation folds away so the drawing gets the room.
  const showNav = navOpen ?? !canvas;

  const nav = (
    <Card className="max-h-[75vh] overflow-y-auto p-3 lg:sticky lg:top-20">
      {debounced ? (
        <div>
          <div className="mb-2 text-sm font-semibold">Search results</div>
          {results?.length ? (
            <ul>
              {results.map((t) => (
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
          <PropList title="Code lists" items={v.conceptSchemes ?? []} selected={selected} onSelect={select} label={label} counts={codeCounts} />
        </>
      )}
      {session?.user && <Button size="sm" variant="ghost" icon={Plus} className="mt-3" onClick={() => update((p) => { p.delete('term'); p.delete('view'); p.set('new', 'code-list'); })}>New code list</Button>}
    </Card>
  );

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex w-full max-w-md items-center gap-2">
          {canvas && (
            <Button
              size="sm"
              variant="secondary"
              icon={showNav ? PanelLeftClose : PanelLeftOpen}
              onClick={() => setNavOpen(!showNav)}
              aria-expanded={showNav}
              aria-controls="browse-nav"
              className="h-9 shrink-0"
            >
              {showNav ? 'Hide terms' : 'Terms'}
            </Button>
          )}
          <div className="relative w-full">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted" />
            <Input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                if (e.target.value) setNavOpen(true);
              }}
              placeholder="Search terms, definitions…"
              className="pl-9"
              aria-label="Search terms"
            />
            {q && (
              <button className="absolute top-2.5 right-3 text-muted" onClick={() => setQ('')} aria-label="Clear search">
                <X className="size-4" />
              </button>
            )}
          </div>
        </div>
        <div className="inline-flex rounded-lg border border-line-strong p-0.5" role="radiogroup" aria-label="View" aria-describedby="view-task">
          {MODES.map((m) => (
            <button
              key={m.key}
              role="radio"
              aria-checked={mode === m.key}
              title={m.task}
              onClick={() => setMode(m.key)}
              className={cx('inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-sm', mode === m.key ? 'bg-surface-2 font-medium' : 'text-muted hover:text-fg')}
            >
              <m.icon className="size-4" aria-hidden /> {m.label}
            </button>
          ))}
        </div>
      </div>
      <p id="view-task" className="-mt-2 mb-4 text-sm text-muted">
        {MODES.find((m) => m.key === mode)!.task}
      </p>

      {empty ? (
        <EmptyState icon={ListTree} title="This ontology has no terms yet">
          Describe a use case or upload a meeting, then synthesise a change request — approved changes appear here.
        </EmptyState>
      ) : !canvas ? (
        <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
          <div id="browse-nav">{nav}</div>
          <div className="min-w-0 space-y-4">
            {newCodeList ? <NewCodeListPanel key={id} onCancel={clear} /> : selected ? (
              <TermDetailPanel iri={selected} onSelect={select} model={model} showNeighbourhood />
            ) : (
              <EmptyState icon={ListTree} title="Pick a term">
                Choose a class, property or code list on the left to see its definition, properties and where it’s used. Use the Diagram to see what data each class has and how the classes connect.
              </EmptyState>
            )}
          </div>
        </div>
      ) : (
        <DiagramProposals key={`${session?.user?.id ?? 'guest'}:${id}`} userId={session?.user?.id} ontologyId={id} view={view.data!} label={label} selected={selected} onSelect={selectOnCanvas}>
          {(proposals) => (
            <div className={cx('grid gap-4', showNav ? 'lg:grid-cols-[280px_1fr]' : 'grid-cols-1')}>
              {showNav && <div id="browse-nav">{nav}</div>}
              <div className={cx('grid min-w-0 gap-4', (!!selected || !!proposals.panel) && 'xl:grid-cols-[1fr_380px]')}>
                <div className="min-w-0 space-y-2">
                  <ScopeControl hops={hops} setHops={setHops} anchor={anchor} centreOn={centreOn} onCentre={centre} />
                  <DiagramView model={model} selected={selected} focus={focus} hops={hops} onSelect={selectOnCanvas} onCentre={centre} proposals={proposals} />
                </div>
                {/* While proposing, the proposal panel takes the details column, so the diagram stays in view to click classes into the form. */}
                {proposals.panel ? (
                  <div className="min-w-0 xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:self-start xl:overflow-y-auto">{proposals.panel}</div>
                ) : (
                  selected && (
                    <aside
                      id="term-details"
                      tabIndex={-1}
                      className="min-w-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent xl:max-h-[calc(100vh-6rem)] xl:overflow-y-auto"
                      aria-label="Term details"
                    >
                      <TermDetailPanel iri={selected} onSelect={select} model={model} showNeighbourhood={false} compact onClose={clear} />
                    </aside>
                  )
                )}
              </div>
            </div>
          )}
        </DiagramProposals>
      )}
    </div>
  );
}
