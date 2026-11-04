import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import dagre from '@dagrejs/dagre';
import type { OntologyView } from '@concord/shared';
import type { Labeler } from '../../lib/ontology';
import { isDatatype, slotCard, type OntologyModel, type Slot } from '../../lib/ontologyModel';
import { cx } from '../ui';
import { curve, downloadSvg, textWidth, themeColours, usePanZoom, ZoomControls } from './PanZoom';

/**
 * A UML-style class diagram, the notation data modellers already read (and the one LinkML
 * and OWLGrEd draw): each class is a box listing its datatype attributes with their types
 * and cardinalities, object properties are labelled associations between boxes, and
 * subclasses point to their parent with a hollow triangle.
 */

export interface DiagramOptions {
  attributes: boolean;
  inherited: boolean;
  associations: boolean;
  subclasses: boolean;
}

export const DEFAULT_DIAGRAM_OPTIONS: DiagramOptions = { attributes: true, inherited: false, associations: true, subclasses: true };

interface BoxLine {
  text: string;
  inherited?: boolean;
  iri: string;
}

interface DNode {
  iri: string;
  title: string;
  lines: BoxLine[];
  deprecated?: boolean;
  width: number;
  height: number;
  x: number;
  y: number;
}

interface DEdge {
  id: string;
  kind: 'sub' | 'assoc';
  source: string;
  target: string;
  label?: string;
  property?: string;
  points: { x: number; y: number }[];
  lx?: number;
  ly?: number;
  lw?: number;
}

const FONT = 'Inter, ui-sans-serif, system-ui, sans-serif';
const TITLE_FONT = `600 13px ${FONT}`;
const ATTR_FONT = `12px ${FONT}`;
const LABEL_FONT = `11px ${FONT}`;
const HEAD = 30;
const ROW = 18;
const PADX = 12;
const MAX_ATTRS = 12;

function typeName(iris: string[], exprs: string[], label: Labeler) {
  const parts = [...iris.map((i) => (isDatatype(i) ? i.replace(/^.*[#/]/, '') : label(i))), ...exprs];
  return parts.length ? parts.join(' and ') : 'Literal';
}

function slotLine(s: Slot, label: Labeler) {
  return `${s.property.label ?? label(s.property.iri)} : ${typeName(s.range, s.rangeExpressions, label)} [${s.conflict ? '⚠ conflict' : slotCard(s)}]`;
}

/**
 * The classes an object property slot links to, each with the cardinality to draw: every
 * named class in its (intersected) range at the slot's overall cardinality, plus each named
 * class in a qualified constraint the range doesn't already cover (e.g. "at least one Dog").
 */
export function slotTargets(model: OntologyModel, s: Slot): { target: string; card: string }[] {
  if (s.property.kind !== 'objectProperty') return [];
  const out = new Map<string, string>();
  for (const r of s.range) if (model.classes.has(r)) out.set(r, slotCard(s));
  for (const q of s.qualified) {
    if (q.implied || !q.filler || !model.classes.has(q.filler) || out.has(q.filler)) continue;
    const card = q.kind === 'some' || q.kind === 'value' ? '1..*' : q.kind === 'min' ? `${q.n}..*` : q.kind === 'max' ? `0..${q.n}` : String(q.n);
    out.set(q.filler, card);
  }
  return [...out].map(([target, card]) => ({ target, card }));
}

/** Classes within `hops` links of `focus`, following the relationships that are drawn. */
export function neighbourhood(model: OntologyModel, focus: string, hops: number, opts: DiagramOptions) {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!model.classes.has(a) || !model.classes.has(b)) return;
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
  };
  for (const [c, ps] of model.parents) for (const p of ps) link(c, p);
  if (opts.associations)
    for (const c of model.classes.keys()) for (const s of model.ownSlots(c)) for (const t of slotTargets(model, s)) link(c, t.target);
  const seen = new Set([focus]);
  let frontier = [focus];
  for (let i = 0; i < hops; i++) {
    const next: string[] = [];
    for (const f of frontier) for (const n of adj.get(f) ?? []) if (!seen.has(n)) (seen.add(n), next.push(n));
    frontier = next;
  }
  return seen;
}

export function layoutDiagram(model: OntologyModel, scope: Set<string>, opts: DiagramOptions, label: Labeler) {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: 'TB', nodesep: 48, ranksep: 64, edgesep: 16, marginx: 8, marginy: 8 });
  g.setDefaultEdgeLabel(() => ({}));

  const nodes = new Map<string, DNode>();
  for (const iri of scope) {
    const c = model.classes.get(iri);
    if (!c) continue;
    const lines: BoxLine[] = [];
    if (opts.attributes) {
      const groups = opts.inherited ? model.allSlots(iri) : [{ from: iri, slots: model.ownSlots(iri) }];
      for (const grp of groups)
        for (const s of grp.slots)
          if (s.property.kind === 'datatypeProperty' || s.range.every(isDatatype) && s.range.length)
            lines.push({ text: slotLine(s, label), inherited: grp.from !== iri, iri: s.property.iri });
    }
    const shown = lines.slice(0, MAX_ATTRS);
    if (lines.length > MAX_ATTRS) shown.push({ text: `+ ${lines.length - MAX_ATTRS} more`, iri: '' });
    const title = c.label ?? label(iri);
    const width = Math.ceil(Math.min(340, Math.max(120, textWidth(title, TITLE_FONT) + PADX * 2 + 4, ...shown.map((l) => textWidth(l.text, ATTR_FONT) + PADX * 2 + (l.inherited ? 12 : 0)))));
    const height = HEAD + (shown.length ? shown.length * ROW + 10 : 0);
    nodes.set(iri, { iri, title, lines: shown, deprecated: c.deprecated, width, height, x: 0, y: 0 });
    g.setNode(iri, { width, height });
  }

  const edges: DEdge[] = [];
  const loops: DEdge[] = [];
  if (opts.subclasses)
    for (const iri of nodes.keys())
      for (const p of model.parents.get(iri) ?? [])
        if (nodes.has(p)) {
          const id = `sub:${iri}:${p}`;
          edges.push({ id, kind: 'sub', source: iri, target: p, points: [] });
          // Parent above child: rank along parent → child, with a strong pull.
          g.setEdge(p, iri, { weight: 4, minlen: 1 }, id);
        }
  if (opts.associations)
    for (const iri of nodes.keys())
      for (const s of model.ownSlots(iri)) {
        for (const { target: r, card } of slotTargets(model, s)) {
          if (!nodes.has(r)) continue;
          const text = `${s.property.label ?? label(s.property.iri)}  ${card === 'conflict' ? '⚠ conflict' : card}`;
          const id = `assoc:${iri}:${s.property.iri}:${r}`;
          const e: DEdge = { id, kind: 'assoc', source: iri, target: r, label: text, property: s.property.iri, points: [] };
          if (r === iri) {
            loops.push(e);
            continue;
          }
          edges.push(e);
          g.setEdge(iri, r, { weight: 1, minlen: 1, width: textWidth(text, LABEL_FONT) + 10, height: 16, labelpos: 'c' }, id);
        }
      }

  dagre.layout(g);
  for (const [iri, n] of nodes) {
    const ln = g.node(iri);
    n.x = ln.x - n.width / 2;
    n.y = ln.y - n.height / 2;
  }
  for (const e of edges) {
    const [v, w] = e.kind === 'sub' ? [e.target, e.source] : [e.source, e.target];
    const le = g.edge(v, w, e.id) as { points: { x: number; y: number }[]; x?: number; y?: number; width?: number };
    e.points = le.points;
    if (e.kind === 'sub') e.points = [...le.points].reverse();
    if (e.label) {
      e.lx = le.x;
      e.ly = le.y;
      e.lw = le.width;
    }
  }
  for (const e of loops) {
    const n = nodes.get(e.source)!;
    const x = n.x + n.width;
    const y = n.y + Math.min(n.height / 2, 22);
    e.points = [
      { x, y: y - 8 },
      { x: x + 34, y: y - 22 },
      { x: x + 34, y: y + 22 },
      { x, y: y + 8 },
    ];
    e.lx = x + 40 + textWidth(e.label!, LABEL_FONT) / 2;
    e.ly = y;
    e.lw = textWidth(e.label!, LABEL_FONT) + 10;
  }
  const gl = g.graph();
  return { nodes: [...nodes.values()], edges: [...edges, ...loops], width: (gl.width ?? 400) + (loops.length ? 160 : 0), height: gl.height ?? 300 };
}

function nearestInDirection(from: DNode, all: DNode[], key: string) {
  const cx = from.x + from.width / 2;
  const cy = from.y + from.height / 2;
  let best: DNode | undefined;
  let bestScore = Infinity;
  for (const n of all) {
    if (n === from) continue;
    const dx = n.x + n.width / 2 - cx;
    const dy = n.y + n.height / 2 - cy;
    const along = key === 'ArrowRight' ? dx : key === 'ArrowLeft' ? -dx : key === 'ArrowDown' ? dy : -dy;
    const across = key === 'ArrowRight' || key === 'ArrowLeft' ? Math.abs(dy) : Math.abs(dx);
    if (along <= 4) continue;
    const score = along + across * 2;
    if (score < bestScore) (bestScore = score), (best = n);
  }
  return best;
}

export function ClassDiagram({
  view,
  model,
  label,
  scope,
  options,
  selected,
  focus,
  onSelect,
  height = 600,
  title = 'Class diagram',
  toolbar,
}: {
  view: OntologyView;
  model: OntologyModel;
  label: Labeler;
  scope: Set<string>;
  options: DiagramOptions;
  selected?: string;
  focus?: string;
  onSelect?: (iri: string) => void;
  height?: number;
  title?: string;
  toolbar?: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<string>();
  const layout = useMemo(() => layoutDiagram(model, scope, options, label), [model, scope, options, label]);
  const colours = useMemo(() => themeColours(), [view]);
  const pz = usePanZoom(box, layout, layout);
  const nodeRefs = useRef(new Map<string, SVGGElement>());

  const active = hover ?? selected;
  const touches = (e: DEdge) => !!active && (e.source === active || e.target === active);
  const c = colours;

  const onNodeKey = (n: DNode) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect?.(n.iri);
    } else if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      const next = nearestInDirection(n, layout.nodes, e.key);
      if (next) nodeRefs.current.get(next.iri)?.focus();
    }
  };

  const summary = `${title}: ${layout.nodes.length} classes, ${layout.edges.filter((e) => e.kind === 'sub').length} subclass links and ${layout.edges.filter((e) => e.kind === 'assoc').length} associations. Use Tab or the arrow keys to move between classes and Enter to open one.`;

  return (
    <div
      ref={box}
      className="relative overflow-hidden rounded-lg border border-line bg-surface select-none focus-visible:outline-2 focus-visible:outline-accent"
      style={{ height, backgroundImage: `radial-gradient(${c.line} 1px, transparent 1px)`, backgroundSize: `${20 * pz.t.k}px ${20 * pz.t.k}px`, backgroundPosition: `${pz.t.x}px ${pz.t.y}px` }}
      tabIndex={0}
      role="application"
      aria-roledescription="class diagram"
      aria-label={summary}
      data-testid="class-diagram"
      {...pz.handlers}
    >
      <ZoomControls k={pz.t.k} onIn={pz.zoomIn} onOut={pz.zoomOut} onFit={pz.fit} onExport={() => downloadSvg(svg.current, `${title.toLowerCase().replace(/\W+/g, '-')}.svg`, c.surface)}>
        {toolbar}
      </ZoomControls>
      <svg ref={svg} className="size-full cursor-grab active:cursor-grabbing" data-width={Math.ceil(layout.width)} data-height={Math.ceil(layout.height)} role="presentation">
        <defs>
          <marker id="cd-tri" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="12" markerHeight="12" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
            <path d="M1,1 L11,6 L1,11 z" fill={c.surface} stroke={c.muted} strokeWidth="1.3" />
          </marker>
          <marker id="cd-tri-on" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="12" markerHeight="12" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
            <path d="M1,1 L11,6 L1,11 z" fill={c.surface} stroke={c.fg} strokeWidth="1.5" />
          </marker>
          <marker id="cd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M1,1 L9,5 L1,9" fill="none" stroke={c.accent} strokeWidth="1.4" />
          </marker>
        </defs>
        <g data-viewport transform={`translate(${pz.t.x},${pz.t.y}) scale(${pz.t.k})`} fontFamily={FONT}>
          {layout.edges.map((e) => {
            const on = touches(e);
            const dim = !!active && !on;
            const sub = e.kind === 'sub';
            return (
              <g key={e.id} opacity={dim ? 0.25 : 1} data-edge={e.kind} data-source={e.source} data-target={e.target}>
                <path
                  d={curve(e.points)}
                  fill="none"
                  stroke={sub ? (on ? c.fg : c.muted) : c.accent}
                  strokeWidth={on ? 2 : 1.3}
                  strokeDasharray={sub ? undefined : '5 4'}
                  markerEnd={sub ? `url(#${on ? 'cd-tri-on' : 'cd-tri'})` : 'url(#cd-arrow)'}
                />
                {e.label && e.lx !== undefined && (
                  <g transform={`translate(${e.lx},${e.ly})`}>
                    <rect x={-(e.lw ?? 0) / 2} y={-9} width={e.lw} height={18} rx={4} fill={c.surface} stroke={on ? c.accent : c.line} />
                    <text textAnchor="middle" dy="4" fontSize="11" fill={on ? c.accent : c.muted} fontWeight={on ? 600 : 400}>
                      {e.label}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
          {layout.nodes.map((n) => {
            const isSel = n.iri === selected;
            const isFocus = n.iri === focus;
            const dim = !!active && n.iri !== active && !layout.edges.some((e) => touches(e) && (e.source === n.iri || e.target === n.iri));
            const sub = model.parents.get(n.iri)?.filter((p) => model.classes.has(p)).map(label) ?? [];
            return (
              <g
                key={n.iri}
                ref={(el) => {
                  if (el) nodeRefs.current.set(n.iri, el);
                  else nodeRefs.current.delete(n.iri);
                }}
                data-node={n.iri}
                transform={`translate(${n.x},${n.y})`}
                role="button"
                tabIndex={0}
                aria-pressed={isSel}
                aria-label={`${n.title}${n.deprecated ? ' (deprecated)' : ''}${sub.length ? `, subclass of ${sub.join(' and ')}` : ''}${n.lines.length ? `, ${n.lines.length} attributes` : ''}`}
                className="cursor-pointer outline-none [&:focus-visible>rect:first-child]:stroke-[3px]"
                opacity={dim ? 0.45 : 1}
                onClick={() => onSelect?.(n.iri)}
                onKeyDown={onNodeKey(n)}
                onMouseEnter={() => setHover(n.iri)}
                onMouseLeave={() => setHover(undefined)}
                onFocus={() => setHover(n.iri)}
                onBlur={() => setHover(undefined)}
              >
                <title>{n.title}</title>
                <rect width={n.width} height={n.height} rx={8} fill={c.surface} stroke={isSel ? c.accent : c.lineStrong} strokeWidth={isSel ? 2.5 : 1.2} strokeDasharray={n.deprecated ? '5 3' : undefined} />
                {n.lines.length ? (
                  <path d={`M0,8 a8,8 0 0 1 8,-8 h${n.width - 16} a8,8 0 0 1 8,8 v${HEAD - 8} h${-n.width} z`} fill={isFocus || isSel ? c.accent : c.accentSoft} />
                ) : (
                  <rect width={n.width} height={n.height} rx={8} fill={isFocus || isSel ? c.accent : c.accentSoft} />
                )}
                {!n.lines.length && <rect width={n.width} height={n.height} rx={8} fill="none" stroke={isSel ? c.accent : c.lineStrong} strokeWidth={isSel ? 2.5 : 1.2} strokeDasharray={n.deprecated ? '5 3' : undefined} />}
                <text x={n.width / 2} y={19.5} textAnchor="middle" fontSize="13" fontWeight="600" fill={isFocus || isSel ? c.accentFg : c.fg} textDecoration={n.deprecated ? 'line-through' : undefined}>
                  {n.title}
                </text>
                {n.lines.length > 0 && <line x1={0} x2={n.width} y1={HEAD} y2={HEAD} stroke={c.line} />}
                {n.lines.map((l, i) => (
                  <text key={i} x={PADX} y={HEAD + 18 + i * ROW} fontSize="12" fill={l.inherited ? c.subtle : c.fg} fontStyle={l.iri ? undefined : 'italic'}>
                    {l.inherited && <tspan fill={c.subtle}>↑ </tspan>}
                    {l.text}
                  </text>
                ))}
              </g>
            );
          })}
        </g>
      </svg>
      <Legend />
      {!layout.nodes.length && <p className="absolute inset-0 flex items-center justify-center text-sm text-muted">Nothing to draw with these settings.</p>}
    </div>
  );
}

function Legend() {
  return (
    <div className="pointer-events-none absolute bottom-2 left-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md bg-surface/90 px-2.5 py-1.5 text-[0.7rem] text-muted" aria-hidden>
      <span className="inline-flex items-center gap-1.5">
        <svg width="28" height="10">
          <line x1="0" y1="5" x2="20" y2="5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M18,1 L27,5 L18,9 z" fill="var(--surface)" stroke="currentColor" />
        </svg>
        subclass of
      </span>
      <span className="inline-flex items-center gap-1.5 text-accent">
        <svg width="28" height="10">
          <line x1="0" y1="5" x2="24" y2="5" stroke="currentColor" strokeWidth="1.3" strokeDasharray="5 4" />
          <path d="M20,1 L27,5 L20,9" fill="none" stroke="currentColor" />
        </svg>
        <span className="text-muted">relationship (min..max)</span>
      </span>
      <span>
        attribute : type [min..max]
      </span>
      <span className={cx('hidden sm:inline')}>Drag or scroll to pan · ctrl/⌘ + scroll to zoom</span>
    </div>
  );
}
