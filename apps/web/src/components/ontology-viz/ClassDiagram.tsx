import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import dagre from '@dagrejs/dagre';
import type { OntologyView } from '@concord/shared';
import type { Labeler } from '../../lib/ontology';
import { cardText, isDatatype, slotCard, type OntologyModel, type Slot } from '../../lib/ontologyModel';
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
  /** The text wrapped to the box width. */
  rows: string[];
  inherited?: boolean;
  conflict?: boolean;
  iri: string;
}

interface DNode {
  iri: string;
  title: string;
  titleRows: string[];
  head: number;
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
  conflict?: boolean;
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
const TITLE_ROW = 16;
const ROW = 18;
const PADX = 12;
const MAX_ATTRS = 12;
const MAX_WIDTH = 340;
// Text measured on a canvas can render a little wider in SVG, so wrapping leaves some slack.
const SLACK = 4;
const UP = '↑ ';

/**
 * Greedy word wrap to `max` pixels, breaking words too long for a line, and ending with an
 * ellipsis if more than `maxRows` rows would be needed (the full text stays in the title and
 * accessible name).
 */
export function wrapText(text: string, font: string, max: number, maxRows: number): string[] {
  const fits = (t: string) => textWidth(t, font) <= max;
  const rows: string[] = [];
  let cur = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${word}` : word;
    if (fits(next)) {
      cur = next;
      continue;
    }
    if (cur) rows.push(cur);
    cur = word;
    while (cur.length > 1 && !fits(cur)) {
      let lo = 1;
      let hi = cur.length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fits(cur.slice(0, mid))) lo = mid;
        else hi = mid - 1;
      }
      rows.push(cur.slice(0, lo));
      cur = cur.slice(lo);
    }
  }
  if (cur) rows.push(cur);
  if (rows.length <= maxRows) return rows;
  const kept = rows.slice(0, maxRows);
  let last = kept[maxRows - 1];
  while (last.length > 0 && !fits(`${last}…`)) last = last.slice(0, -1);
  kept[maxRows - 1] = `${last.trimEnd()}…`;
  return kept;
}

function typeName(iris: string[], exprs: string[], label: Labeler) {
  const parts = [...iris.map((i) => (isDatatype(i) ? i.replace(/^.*[#/]/, '') : label(i))), ...exprs];
  return parts.length ? parts.join(' and ') : 'Literal';
}

function slotLine(s: Slot, label: Labeler) {
  return `${s.property.label ?? label(s.property.iri)} : ${typeName(s.range, s.rangeExpressions, label)} [${s.conflict ? '⚠ conflict' : slotCard(s)}]`;
}

/**
 * The classes an object property slot links to, each with its own bounds: the range classes,
 * plus any class named in a qualified restriction (e.g. "0..1 Cat" and "1..* Dog"). If the
 * property's constraints contradict each other, every edge shows the conflict.
 */
export function slotTargets(model: OntologyModel, s: Slot): { target: string; card: string }[] {
  if (s.property.kind !== 'objectProperty') return [];
  return s.targets.filter((t) => model.classes.has(t.filler)).map((t) => ({ target: t.filler, card: s.conflict || t.conflict ? 'conflict' : cardText(t.min, t.max) }));
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
            lines.push({ text: slotLine(s, label), rows: [], inherited: grp.from !== iri, conflict: !!s.conflict, iri: s.property.iri });
    }
    const shown = lines.slice(0, MAX_ATTRS);
    if (lines.length > MAX_ATTRS) shown.push({ text: `+ ${lines.length - MAX_ATTRS} more`, rows: [], iri: '' });
    const title = c.label ?? label(iri);
    const indent = textWidth(UP, ATTR_FONT);
    const inset = (l: BoxLine) => PADX * 2 + SLACK + (l.inherited ? indent : 0);
    // As wide as the longest line, up to MAX_WIDTH; longer text wraps onto more rows.
    const width = Math.ceil(Math.min(MAX_WIDTH, Math.max(120, textWidth(title, TITLE_FONT) + PADX * 2 + SLACK, ...shown.map((l) => textWidth(l.text, ATTR_FONT) + inset(l)))));
    const titleRows = wrapText(title, TITLE_FONT, width - PADX * 2 - SLACK, 3);
    for (const l of shown) l.rows = wrapText(l.text, ATTR_FONT, width - inset(l), 3);
    const head = HEAD + (titleRows.length - 1) * TITLE_ROW;
    const rowCount = shown.reduce((n, l) => n + l.rows.length, 0);
    const height = head + (shown.length ? rowCount * ROW + 10 : 0);
    nodes.set(iri, { iri, title, titleRows, head, lines: shown, deprecated: c.deprecated, width, height, x: 0, y: 0 });
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
          const e: DEdge = { id, kind: 'assoc', source: iri, target: r, label: text, property: s.property.iri, conflict: card === 'conflict', points: [] };
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
  // The drawing's bounds (used to fit and export it) cover every box, edge and label.
  const gl = g.graph();
  let width = gl.width ?? 0;
  let height = gl.height ?? 0;
  for (const n of nodes.values()) (width = Math.max(width, n.x + n.width)), (height = Math.max(height, n.y + n.height));
  for (const e of [...edges, ...loops]) {
    for (const pt of e.points) (width = Math.max(width, pt.x)), (height = Math.max(height, pt.y));
    if (e.lx !== undefined && e.ly !== undefined) (width = Math.max(width, e.lx + (e.lw ?? 0) / 2)), (height = Math.max(height, e.ly + 8));
  }
  return { nodes: [...nodes.values()], edges: [...edges, ...loops], width: width || 400, height: height || 300 };
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
  detailsId,
  textList = true,
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
  /** The id of the element holding the selected term's details, for a "go to details" link. */
  detailsId?: string;
  /** Show the relationships as a text list under the drawing. */
  textList?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  // Safe in url(#…) references and ids.
  const uid = `cd${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [hover, setHover] = useState<string>();
  const [focused, setFocused] = useState<string>();
  const [current, setCurrent] = useState<string>();
  // Text is measured to size the boxes, so lay out again once the web font has loaded.
  const [fonts, setFonts] = useState(0);
  useEffect(() => {
    let live = true;
    document.fonts?.ready.then(() => live && setFonts((n) => n + 1));
    return () => {
      live = false;
    };
  }, []);
  const layout = useMemo(() => layoutDiagram(model, scope, options, label), [model, scope, options, label, fonts]);
  const colours = useMemo(() => themeColours(), [view]);
  const pz = usePanZoom(box, layout, layout);
  const nodeRefs = useRef(new Map<string, SVGGElement>());
  const byIri = useMemo(() => new Map(layout.nodes.map((n) => [n.iri, n])), [layout]);

  // One tab stop for all the classes (roving tabindex); arrow keys move between them.
  const tabStop = byIri.get(current ?? '') ?? byIri.get(selected ?? '') ?? byIri.get(focus ?? '') ?? layout.nodes[0];

  // The class being pointed at, focused or selected, and its directly linked classes, are
  // emphasised with borders and heavier lines. Nothing is faded, so all text keeps its contrast.
  const active = hover ?? focused ?? selected;
  const touches = (e: DEdge) => !!active && (e.source === active || e.target === active);
  const near = useMemo(() => {
    const out = new Set<string>();
    if (active) for (const e of layout.edges) if (e.source === active) out.add(e.target);
      else if (e.target === active) out.add(e.source);
    return out;
  }, [active, layout]);
  const c = colours;

  const onNodeKey = (n: DNode) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect?.(n.iri);
    } else if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      const next = nearestInDirection(n, layout.nodes, e.key);
      if (next) nodeRefs.current.get(next.iri)?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const next = e.key === 'Home' ? layout.nodes[0] : layout.nodes[layout.nodes.length - 1];
      if (next) nodeRefs.current.get(next.iri)?.focus();
    }
  };

  const subs = layout.edges.filter((e) => e.kind === 'sub');
  const assocs = layout.edges.filter((e) => e.kind === 'assoc');
  const name = (iri: string) => byIri.get(iri)?.title ?? label(iri);
  const summaryId = `${uid}-summary`;
  const listId = `${uid}-list`;
  const summary = `${layout.nodes.length} classes, ${subs.length} subclass links and ${assocs.length} relationships. Press Tab to reach the classes, the arrow keys to move between them and Enter to open one.${textList && layout.edges.length ? ' The same relationships are listed as text after the diagram.' : ''}`;

  const nodeLabel = (n: DNode) => {
    const parents = model.parents.get(n.iri)?.filter((p) => model.classes.has(p)).map(label) ?? [];
    const attrs = n.lines.filter((l) => l.iri).map((l) => l.text);
    const rels = assocs.filter((e) => e.source === n.iri).map((e) => `${e.label} ${name(e.target)}`);
    return [
      `${n.title}${n.deprecated ? ' (deprecated)' : ''}`,
      parents.length ? `subclass of ${parents.join(' and ')}` : '',
      attrs.length ? `attributes: ${attrs.join('; ')}` : '',
      rels.length ? `relationships: ${rels.join('; ')}` : '',
    ]
      .filter(Boolean)
      .join('. ');
  };

  return (
    <div className="space-y-2">
      <div
        ref={box}
        className="relative overflow-hidden rounded-lg border border-line bg-surface select-none focus-visible:outline-2 focus-visible:outline-accent"
        // The dot grid turns into a grey wash when zoomed far out, so it goes below 35%.
        style={{ height, ...(pz.t.k >= 0.35 && { backgroundImage: `radial-gradient(${c.line} 1px, transparent 1px)`, backgroundSize: `${20 * pz.t.k}px ${20 * pz.t.k}px`, backgroundPosition: `${pz.t.x}px ${pz.t.y}px` }) }}
        tabIndex={0}
        role="group"
        aria-roledescription="class diagram"
        aria-label={title}
        aria-describedby={summaryId}
        data-testid="class-diagram"
        {...pz.handlers}
      >
        <p id={summaryId} className="sr-only">
          {summary}
        </p>
        {detailsId && selected && (
          <a
            href={`#${detailsId}`}
            className="absolute top-2 left-2 z-20 -translate-y-16 rounded-md bg-accent px-3 py-1.5 text-sm text-accent-fg focus:translate-y-0"
            onClick={(e) => {
              e.preventDefault();
              document.getElementById(detailsId)?.focus();
            }}
          >
            Go to details of {name(selected)}
          </a>
        )}
        <ZoomControls k={pz.t.k} onIn={pz.zoomIn} onOut={pz.zoomOut} onFit={pz.fit} onExport={() => downloadSvg(svg.current, `${title.toLowerCase().replace(/\W+/g, '-')}.svg`, c.surface)}>
          {toolbar}
        </ZoomControls>
        <svg ref={svg} className="size-full cursor-grab active:cursor-grabbing" data-width={Math.ceil(layout.width)} data-height={Math.ceil(layout.height)}>
          <defs>
            <marker id={`${uid}-tri`} viewBox="0 0 12 12" refX="11" refY="6" markerWidth="12" markerHeight="12" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
              <path d="M1,1 L11,6 L1,11 z" fill={c.surface} stroke={c.muted} strokeWidth="1.3" />
            </marker>
            <marker id={`${uid}-tri-on`} viewBox="0 0 12 12" refX="11" refY="6" markerWidth="12" markerHeight="12" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
              <path d="M1,1 L11,6 L1,11 z" fill={c.surface} stroke={c.fg} strokeWidth="1.6" />
            </marker>
            <marker id={`${uid}-arrow`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto" markerUnits="userSpaceOnUse">
              <path d="M1,1 L9,5 L1,9" fill="none" stroke={c.accent} strokeWidth="1.4" />
            </marker>
          </defs>
          <g data-viewport transform={`translate(${pz.t.x},${pz.t.y}) scale(${pz.t.k})`} fontFamily={FONT} aria-hidden={false}>
            {layout.edges.map((e) => {
              const on = touches(e);
              const sub = e.kind === 'sub';
              return (
                <g key={e.id} data-edge={e.kind} data-source={e.source} data-target={e.target} data-on={on || undefined} aria-hidden>
                  <path
                    d={curve(e.points)}
                    fill="none"
                    stroke={sub ? (on ? c.fg : c.muted) : c.accent}
                    strokeWidth={on ? 2.5 : 1.3}
                    strokeDasharray={sub ? undefined : on ? '7 3' : '5 4'}
                    markerEnd={sub ? `url(#${uid}-${on ? 'tri-on' : 'tri'})` : `url(#${uid}-arrow)`}
                  />
                  {e.label && e.lx !== undefined && (
                    <g transform={`translate(${e.lx},${e.ly})`}>
                      <rect x={-(e.lw ?? 0) / 2} y={-9} width={e.lw} height={18} rx={4} fill={on ? c.accentSoft : c.surface} stroke={on ? c.accent : c.line} strokeWidth={on ? 1.5 : 1} />
                      <text textAnchor="middle" dy="4" fontSize="11" fill={e.conflict ? c.danger : on ? c.fg : c.muted} fontWeight={on ? 600 : 400}>
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
              const isActive = n.iri === active;
              const isNear = near.has(n.iri);
              const filled = isFocus || isSel;
              const border = isSel || isActive ? c.accent : isNear ? c.accent : c.lineStrong;
              const bw = isSel || isActive ? 2.5 : isNear ? 1.8 : 1.2;
              return (
                <g
                  key={n.iri}
                  ref={(el) => {
                    if (el) nodeRefs.current.set(n.iri, el);
                    else nodeRefs.current.delete(n.iri);
                  }}
                  data-node={n.iri}
                  data-near={isNear || undefined}
                  transform={`translate(${n.x},${n.y})`}
                  role="button"
                  tabIndex={n === tabStop ? 0 : -1}
                  aria-pressed={isSel}
                  aria-label={nodeLabel(n)}
                  className="cursor-pointer outline-none"
                  onClick={() => onSelect?.(n.iri)}
                  onKeyDown={onNodeKey(n)}
                  onMouseEnter={() => setHover(n.iri)}
                  onMouseLeave={() => setHover(undefined)}
                  onFocus={() => {
                    setFocused(n.iri);
                    setCurrent(n.iri);
                    pz.reveal({ x: n.x - 8, y: n.y - 8, width: n.width + 16, height: n.height + 16 });
                  }}
                  onBlur={() => setFocused(undefined)}
                >
                  <title>{n.title}</title>
                  {focused === n.iri && <rect data-focus-ring x={-5} y={-5} width={n.width + 10} height={n.height + 10} rx={11} fill="none" stroke={c.accent} strokeWidth={2.5} />}
                  <rect width={n.width} height={n.height} rx={8} fill={c.surface} stroke={border} strokeWidth={bw} strokeDasharray={n.deprecated ? '5 3' : undefined} />
                  {n.lines.length ? (
                    <path d={`M0,8 a8,8 0 0 1 8,-8 h${n.width - 16} a8,8 0 0 1 8,8 v${n.head - 8} h${-n.width} z`} fill={filled ? c.accent : c.accentSoft} />
                  ) : (
                    <rect width={n.width} height={n.height} rx={8} fill={filled ? c.accent : c.accentSoft} />
                  )}
                  {!n.lines.length && <rect width={n.width} height={n.height} rx={8} fill="none" stroke={border} strokeWidth={bw} strokeDasharray={n.deprecated ? '5 3' : undefined} />}
                  <text data-title textAnchor="middle" fontSize="13" fontWeight="600" fill={filled ? c.accentFg : c.fg} textDecoration={n.deprecated ? 'line-through' : undefined}>
                    {n.titleRows.map((t, i) => (
                      <tspan key={i} x={n.width / 2} y={19.5 + i * TITLE_ROW}>
                        {t}
                      </tspan>
                    ))}
                  </text>
                  {n.lines.length > 0 && <line x1={0} x2={n.width} y1={n.head} y2={n.head} stroke={c.line} />}
                  {n.lines.map((l, i) => {
                    const first = n.lines.slice(0, i).reduce((k, x) => k + x.rows.length, 0);
                    const x0 = PADX + (l.inherited ? textWidth(UP, ATTR_FONT) : 0);
                    return (
                      <text key={i} data-attr fontSize="12" fill={l.conflict ? c.danger : l.inherited ? c.subtle : c.fg} fontStyle={l.iri ? undefined : 'italic'}>
                        {l.rows.length > 1 || l.rows[0] !== l.text ? <title>{l.text}</title> : null}
                        {l.inherited && (
                          <tspan x={PADX} y={n.head + 18 + first * ROW} fill={c.subtle}>
                            {UP}
                          </tspan>
                        )}
                        {l.rows.map((t, j) => (
                          <tspan key={j} x={x0} y={n.head + 18 + (first + j) * ROW}>
                            {t}
                          </tspan>
                        ))}
                      </text>
                    );
                  })}
                </g>
              );
            })}
          </g>
        </svg>
        <Legend />
        {!layout.nodes.length && <p className="absolute inset-0 flex items-center justify-center text-sm text-muted">Nothing to draw with these settings.</p>}
      </div>
      {textList && layout.edges.length > 0 && (
        <details className="group rounded-lg border border-line px-3 py-2 text-sm" data-testid="diagram-text">
          <summary className="cursor-pointer text-sm font-medium text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">
            Relationships as text ({assocs.length + subs.length})
          </summary>
          <div id={listId} className="mt-2 grid gap-4 md:grid-cols-2">
            {assocs.length > 0 && (
              <div>
                <h4 className="mb-1 text-xs font-semibold text-muted">Relationships</h4>
                <ul className="space-y-1">
                  {assocs.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-baseline gap-x-1.5">
                      <TextTerm iri={e.source} name={name} onSelect={onSelect} />
                      <span className="text-muted">→</span>
                      {e.property ? <TextTerm iri={e.property} name={(i) => model.properties.get(i)?.label ?? label(i)} onSelect={onSelect} /> : null}
                      <span className={e.conflict ? 'text-xs text-danger' : 'font-mono text-xs text-muted'}>[{e.label?.split('  ').pop()}]</span>
                      <span className="text-muted">→</span>
                      <TextTerm iri={e.target} name={name} onSelect={onSelect} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {subs.length > 0 && (
              <div>
                <h4 className="mb-1 text-xs font-semibold text-muted">Subclasses</h4>
                <ul className="space-y-1">
                  {subs.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-baseline gap-x-1.5">
                      <TextTerm iri={e.source} name={name} onSelect={onSelect} />
                      <span className="text-muted">is a kind of</span>
                      <TextTerm iri={e.target} name={name} onSelect={onSelect} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

function TextTerm({ iri, name, onSelect }: { iri: string; name: (iri: string) => string; onSelect?: (iri: string) => void }) {
  if (!onSelect) return <span>{name(iri)}</span>;
  return (
    <button type="button" className="text-accent hover:underline" onClick={() => onSelect(iri)}>
      {name(iri)}
    </button>
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
