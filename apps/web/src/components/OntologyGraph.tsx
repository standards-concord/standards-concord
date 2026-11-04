import { useEffect, useMemo, useRef, useState } from 'react';
import type { OntologyView } from '@concord/shared';
import type { Core, ElementDefinition } from 'cytoscape';
import dagre from '@dagrejs/dagre';
import { makeLabeler } from '../lib/ontology';
import { buildModel, isDatatype } from '../lib/ontologyModel';
import { DEFAULT_DIAGRAM_OPTIONS, neighbourhood } from './ontology-viz/ClassDiagram';
import { Chip, Loading, Select } from './ui';
import { textWidth, themeColours, ZoomControls } from './ontology-viz/PanZoom';

function nodeWidth(text: string, size = 11) {
  return Math.ceil(textWidth(text, `${size}px Inter, system-ui, sans-serif`) + 22);
}

export type GraphLayout = 'hierarchy' | 'force' | 'radial';
export interface GraphFilters {
  subclass: boolean;
  relations: boolean;
  datatypes: boolean;
  disjoint: boolean;
}
const DEFAULT_FILTERS: GraphFilters = { subclass: true, relations: true, datatypes: false, disjoint: false };

/**
 * Network overview of the whole ontology, in the spirit of WebVOWL and OntoGraf but with
 * a cleaner notation: classes are nodes (bigger when they have more subclasses), solid
 * arrows point from a subclass to its parent, dashed arrows are object properties from
 * domain to range. Datatype attributes and disjointness can be switched on. Selecting a
 * class highlights its neighbourhood and fades the rest.
 */
export function OntologyGraph({ view, selected, focus, hops = 1, onSelect, height = 560 }: { view: OntologyView; selected?: string; focus?: string; hops?: number; onSelect?: (iri: string) => void; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const [ready, setReady] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [layout, setLayout] = useState<GraphLayout>('hierarchy');
  const [filters, setFilters] = useState<GraphFilters>(DEFAULT_FILTERS);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const model = useMemo(() => buildModel(view), [view]);

  // With a focus class, only it and the classes within `hops` links are drawn.
  const scope = useMemo(
    () => (focus ? neighbourhood(model, focus, hops, { ...DEFAULT_DIAGRAM_OPTIONS, associations: filters.relations, subclasses: filters.subclass }) : undefined),
    [model, focus, hops, filters.relations, filters.subclass],
  );

  const elements = useMemo(() => {
    const label = makeLabeler(view);
    const els: ElementDefinition[] = [];
    const nodeIds = new Set<string>();
    const inScope = (iri: string) => !scope || scope.has(iri);
    for (const c of view.classes) {
      if (!inScope(c.iri)) continue;
      const kids = model.descendants(c.iri).length;
      els.push({ data: { id: c.iri, label: label(c.iri), kind: 'class', deprecated: c.deprecated ? 1 : 0, size: Math.min(28 + kids * 6, 64), w: nodeWidth(label(c.iri)) } });
      nodeIds.add(c.iri);
    }
    const external = (iri: string) => {
      if (nodeIds.has(iri)) return;
      nodeIds.add(iri);
      els.push({ data: { id: iri, label: label(iri), kind: 'external', size: 28, w: nodeWidth(label(iri)) } });
    };
    if (filters.subclass)
      for (const [c, ps] of model.parents) for (const p of ps) if (nodeIds.has(c) && nodeIds.has(p)) els.push({ data: { id: `sub:${c}:${p}`, source: c, target: p, kind: 'sub' } });
    if (filters.relations)
      for (const p of view.objectProperties)
        for (const d of p.domain)
          for (const r of p.range) {
            if (!nodeIds.has(d) || (model.classes.has(r) && !nodeIds.has(r))) continue;
            if (!model.classes.has(r)) external(r);
            els.push({ data: { id: `p:${p.iri}:${d}:${r}`, source: d, target: r, label: label(p.iri), kind: 'prop', property: p.iri } });
          }
    if (filters.datatypes)
      for (const p of view.datatypeProperties)
        for (const d of p.domain) {
          if (!nodeIds.has(d)) continue;
          const id = `lit:${p.iri}:${d}`;
          const r = p.range.find(isDatatype);
          const text = r ? r.replace(/^.*[#/]/, '') : 'Literal';
          els.push({ data: { id, label: text, kind: 'literal', size: 20, w: nodeWidth(text, 10) } });
          els.push({ data: { id: `dp:${id}`, source: d, target: id, label: label(p.iri), kind: 'dprop', property: p.iri } });
        }
    if (filters.disjoint) {
      const done = new Set<string>();
      for (const c of view.classes)
        for (const d of c.disjointWith) {
          const key = [c.iri, d].sort().join('|');
          if (done.has(key) || !nodeIds.has(d) || !nodeIds.has(c.iri)) continue;
          done.add(key);
          els.push({ data: { id: `dis:${key}`, source: c.iri, target: d, kind: 'disjoint' } });
        }
    }
    return els;
  }, [view, model, filters, scope]);

  // Hierarchy positions from dagre, parents above children.
  const positions = useMemo(() => {
    const g = new dagre.graphlib.Graph({ multigraph: true });
    g.setGraph({ rankdir: 'TB', nodesep: 30, ranksep: 70 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const e of elements) if (!e.data.source) g.setNode(e.data.id!, { width: e.data.w + 10, height: e.data.size + 6 });
    for (const e of elements) {
      const d = e.data;
      if (!d.source) continue;
      if (d.kind === 'sub') g.setEdge(d.target, d.source, { weight: 5 }, d.id);
      else if (d.kind === 'prop' || d.kind === 'dprop') g.setEdge(d.source, d.target, { weight: 1 }, d.id);
    }
    dagre.layout(g);
    return Object.fromEntries(g.nodes().map((n) => [n, { x: g.node(n).x, y: g.node(n).y }]));
  }, [elements]);

  useEffect(() => {
    let disposed = false;
    setReady(false);
    void import('cytoscape').then(({ default: cytoscape }) => {
      if (disposed || !ref.current) return;
      const c = themeColours();
      const literalFill = '#fdf3c4';
      const cy = cytoscape({
        container: ref.current,
        elements,
        minZoom: 0.05,
        maxZoom: 2.5,
        boxSelectionEnabled: false,
        style: [
          {
            selector: 'node',
            style: {
              label: 'data(label)',
              'background-color': c.accentSoft,
              'border-color': c.accent,
              'border-width': 1.5,
              color: c.fg,
              'font-size': 11,
              'font-family': 'Inter, system-ui, sans-serif',
              'text-valign': 'center',
              'text-halign': 'center',
              shape: 'round-rectangle',
              width: 'data(w)',
              height: 'data(size)',
            },
          },
          { selector: 'node[kind = "external"]', style: { 'background-color': c.surface2, 'border-color': c.muted, 'border-style': 'dotted', color: c.muted } },
          { selector: 'node[kind = "literal"]', style: { shape: 'rectangle', 'background-color': literalFill, 'border-color': '#b8920f', color: '#3d3000', 'font-size': 10, height: 20 } },
          { selector: 'node[deprecated = 1]', style: { 'border-style': 'dashed', color: c.muted, 'border-color': c.muted, 'background-color': c.surface2 } },
          { selector: 'node:selected', style: { 'background-color': c.accent, color: c.accentFg, 'border-width': 2.5 } },
          // The selection's neighbours get a heavier border. Nothing else is faded, so labels keep their contrast.
          { selector: 'node.near', style: { 'border-width': 3, 'border-color': c.accent } },
          { selector: 'edge', style: { width: 1.3, 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'line-color': c.lineStrong, 'target-arrow-color': c.lineStrong, 'arrow-scale': 0.9 } },
          { selector: 'edge[kind = "sub"]', style: { 'line-color': c.muted, 'target-arrow-color': c.muted, 'target-arrow-shape': 'triangle', 'target-arrow-fill': 'hollow', 'arrow-scale': 1.3 } },
          {
            selector: 'edge[kind = "prop"], edge[kind = "dprop"]',
            style: { 'line-style': 'dashed', 'line-color': c.accent, 'target-arrow-color': c.accent, 'font-size': 9.5, color: c.muted, 'text-rotation': 'autorotate', 'text-background-color': c.surface, 'text-background-opacity': 1, 'text-background-padding': '2px' },
          },
          { selector: 'edge[kind = "dprop"]', style: { 'line-color': '#b8920f', 'target-arrow-color': '#b8920f' } },
          { selector: 'edge[kind = "disjoint"]', style: { 'line-color': c.warn, 'line-style': 'dotted', 'target-arrow-shape': 'none', 'source-arrow-shape': 'none', opacity: 0.6 } },
          { selector: 'edge.hl', style: { width: 2.8, 'z-index': 10 } },
          { selector: 'edge.hl[kind = "sub"]', style: { 'line-color': c.fg, 'target-arrow-color': c.fg } },
          // Relationship names appear on the selection's links, or everywhere when the graph is small.
          { selector: 'edge.labelled[label], edge.hl[label]', style: { label: 'data(label)' } },
        ],
        layout: { name: 'preset', positions: (n: { id: () => string }) => positions[n.id()] ?? { x: 0, y: 0 }, padding: 30, fit: true } as never,
      });
      cy.on('tap', 'node', (e) => {
        const id = e.target.id() as string;
        if (e.target.data('kind') === 'class' || e.target.data('kind') === 'external') onSelectRef.current?.(id);
      });
      cy.on('tap', 'edge', (e) => {
        const p = e.target.data('property');
        if (p) onSelectRef.current?.(p);
      });
      cy.on('zoom', () => setZoom(cy.zoom()));
      // Tests watch the real viewport and node positions frame by frame to check whether changes
      // animate, rather than trusting what the code says it did.
      (ref.current as HTMLElement & { cy?: unknown }).cy = cy;
      // Fitting a handful of nodes would blow them up; keep text at a readable size.
      const clampFit = () => {
        if (cy.zoom() > 1.15) {
          cy.zoom(1.15);
          cy.center();
        }
      };
      clampFit();
      cy.on('layoutstop', clampFit);
      cyRef.current = cy;
      setZoom(cy.zoom());
      setReady(true);
    });
    return () => {
      disposed = true;
      cyRef.current?.destroy();
      cyRef.current = null;
    };
  }, [elements, positions]);

  // Re-run the chosen layout.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !ready) return;
    const reduce = prefersReducedMotion();
    const opts =
      layout === 'hierarchy'
        ? { name: 'preset', positions: (n: { id: () => string }) => positions[n.id()] ?? { x: 0, y: 0 }, padding: 30, animate: !reduce, animationDuration: 300 }
        : layout === 'force'
          ? { name: 'cose', padding: 30, animate: !reduce, animationDuration: 400, nodeRepulsion: () => 9000, idealEdgeLength: () => 110, randomize: false }
          : { name: 'concentric', padding: 30, animate: !reduce, animationDuration: 300, concentric: (n: { id: () => string }) => 10 - model.depth(n.id()), levelWidth: () => 1, minNodeSpacing: 30 };
    cy.layout(opts as never).run();
  }, [layout, ready, positions, model]);

  // Selection: highlight the neighbourhood and bring it into view.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !ready) return;
    cy.batch(() => {
      cy.elements().removeClass('near hl labelled');
      cy.$(':selected').unselect();
      if (cy.edges().length <= 40) cy.edges().addClass('labelled');
      if (!selected) return;
      const n = cy.getElementById(selected);
      if (n.empty() || !n.isNode()) return;
      n.select();
      const hood = n.closedNeighborhood();
      hood.nodes().not(n).addClass('near');
      hood.edges().addClass('hl');
    });
    const n = cy.getElementById(selected ?? '');
    if (n.nonempty() && n.isNode()) {
      const reduce = prefersReducedMotion();
      if (reduce) cy.center(n);
      else cy.animate({ center: { eles: n }, duration: 300 });
    }
  }, [selected, ready, elements]);

  const exportPng = () => {
    const cy = cyRef.current;
    if (!cy) return;
    const a = document.createElement('a');
    a.href = cy.png({ full: true, scale: 2, bg: themeColours().surface });
    a.download = 'ontology-graph.png';
    a.click();
  };
  const zoomBy = (f: number) => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.zoom({ level: cy.zoom() * f, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  };

  const toggle = (k: keyof GraphFilters) => setFilters((f) => ({ ...f, [k]: !f[k] }));
  const classCount = elements.filter((e) => e.data.kind === 'class').length;
  const edgeCount = elements.filter((e) => e.data.source).length;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Graph options">
        <label className="flex items-center gap-2 text-xs text-muted">
          Layout
          <Select value={layout} onChange={(e) => setLayout(e.target.value as GraphLayout)} className="h-8 w-36 text-sm" aria-label="Graph layout">
            <option value="hierarchy">Hierarchy</option>
            <option value="force">Force-directed</option>
            <option value="radial">Radial by depth</option>
          </Select>
        </label>
        <span className="text-xs text-muted">Include</span>
        <Chip active={filters.subclass} onClick={() => toggle('subclass')}>Subclasses</Chip>
        <Chip active={filters.relations} onClick={() => toggle('relations')}>Relationships</Chip>
        <Chip active={filters.datatypes} onClick={() => toggle('datatypes')}>Attributes</Chip>
        <Chip active={filters.disjoint} onClick={() => toggle('disjoint')}>Disjointness</Chip>
      </div>
      <div
        className="relative overflow-hidden rounded-lg border border-line bg-surface"
        style={{ height }}
        role="img"
        aria-label={`Graph of ${classCount} classes and ${edgeCount} links${focus ? ` around ${makeLabeler(view)(focus)}` : ''}. The Diagram view and each class's page give the same information as text.`}
        data-testid="ontology-graph"
        data-ready={ready ? 'true' : 'false'}
        data-motion={prefersReducedMotion() ? 'reduced' : 'full'}
      >
        {!ready && <Loading className="absolute inset-0" label="Laying out graph…" />}
        <div ref={ref} className="size-full" data-cy />
        {ready && <ZoomControls k={zoom} onIn={() => zoomBy(1.2)} onOut={() => zoomBy(1 / 1.2)} onFit={() => {
              const cy = cyRef.current;
              if (!cy) return;
              cy.fit(undefined, 30);
              if (cy.zoom() > 1.15) (cy.zoom(1.15), cy.center());
            }} onExport={exportPng} exportLabel="Download as PNG" />}
        <div className="pointer-events-none absolute bottom-2 left-2 flex flex-wrap gap-x-4 gap-y-1 rounded-md bg-surface/90 px-2.5 py-1.5 text-[0.7rem] text-muted">
          <span>Solid ▷ subclass of</span>
          <span className="text-accent">Dashed → relationship (domain → range)</span>
          {filters.datatypes && <span style={{ color: '#8a6d00' }}>Yellow: attribute value type</span>}
          {filters.disjoint && <span className="text-warn">Dotted: disjoint</span>}
          <span>Bigger nodes have more subclasses</span>
        </div>
      </div>
    </div>
  );
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
