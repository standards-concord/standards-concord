import { useEffect, useRef, useState } from 'react';
import type { OntologyView } from '@concord/shared';
import type { Core } from 'cytoscape';
import { makeLabeler } from '../lib/ontology';
import { Loading } from './ui';

function cssVar(name: string, fallback: string) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Cytoscape graph of classes: subClassOf edges and object property domain→range edges. */
export function OntologyGraph({ view, selected, onSelect, height = 560 }: { view: OntologyView; selected?: string; onSelect?: (iri: string) => void; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const [ready, setReady] = useState(false);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    let disposed = false;
    void import('cytoscape').then(({ default: cytoscape }) => {
      if (disposed || !ref.current) return;
      const label = makeLabeler(view);
      const classIris = new Set(view.classes.map((c) => c.iri));
      const nodes = view.classes.map((c) => ({ data: { id: c.iri, label: label(c.iri), deprecated: c.deprecated ? 1 : 0 } }));
      const edges: { data: { id: string; source: string; target: string; label: string; kind: string } }[] = [];
      for (const c of view.classes)
        for (const s of c.superClasses) if (classIris.has(s)) edges.push({ data: { id: `sub:${c.iri}:${s}`, source: c.iri, target: s, label: 'subClassOf', kind: 'sub' } });
      for (const p of view.objectProperties)
        for (const d of p.domain) for (const r of p.range) if (classIris.has(d) && classIris.has(r)) edges.push({ data: { id: `p:${p.iri}:${d}:${r}`, source: d, target: r, label: label(p.iri), kind: 'prop' } });

      const fg = cssVar('--fg', '#141414');
      const muted = cssVar('--muted', '#5f6368');
      const accent = cssVar('--accent', '#1f4fe0');
      const surface = cssVar('--surface', '#fff');
      const line = cssVar('--line-strong', '#ccc');

      cyRef.current = cytoscape({
        container: ref.current,
        elements: { nodes, edges },
        wheelSensitivity: 0.3,
        minZoom: 0.2,
        maxZoom: 1.4,
        style: [
          {
            selector: 'node',
            style: {
              label: 'data(label)',
              'background-color': surface,
              'border-color': accent,
              'border-width': 1.5,
              color: fg,
              'font-size': 11,
              'font-family': 'Inter, system-ui, sans-serif',
              'text-valign': 'center',
              'text-halign': 'center',
              shape: 'round-rectangle',
              width: 'label',
              height: 26,
              padding: '8px',
            },
          },
          { selector: 'node[deprecated = 1]', style: { 'border-style': 'dashed', color: muted, 'border-color': muted } },
          { selector: 'node:selected', style: { 'background-color': accent, color: surface } },
          {
            selector: 'edge',
            style: { width: 1.2, 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'line-color': line, 'target-arrow-color': line, 'arrow-scale': 0.8 },
          },
          { selector: 'edge[kind = "sub"]', style: { 'target-arrow-shape': 'triangle-backcurve', 'target-arrow-fill': 'hollow' } },
          {
            selector: 'edge[kind = "prop"]',
            style: { 'line-style': 'dashed', 'line-color': accent, 'target-arrow-color': accent, label: 'data(label)', 'font-size': 9, color: muted, 'text-rotation': 'autorotate', 'text-background-color': surface, 'text-background-opacity': 1, 'text-background-padding': '2px' },
          },
        ],
        layout: { name: 'breadthfirst', directed: true, spacingFactor: 1.15, padding: 20 } as never,
      });
      cyRef.current.on('tap', 'node', (e) => onSelectRef.current?.(e.target.id()));
      setReady(true);
    });
    return () => {
      disposed = true;
      cyRef.current?.destroy();
      cyRef.current = null;
    };
  }, [view]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !selected) return;
    cy.$(':selected').unselect();
    const n = cy.getElementById(selected);
    if (n.nonempty()) n.select();
  }, [selected, ready]);

  return (
    <div className="relative overflow-hidden rounded-lg border border-line bg-surface" style={{ height }}>
      {!ready && <Loading className="absolute inset-0" label="Laying out graph…" />}
      <div ref={ref} className="size-full" />
      <div className="absolute bottom-2 left-2 rounded-md bg-surface/90 px-2 py-1 text-[0.7rem] text-muted">
        Solid arrow: subclass of · Dashed: object property (domain → range)
      </div>
    </div>
  );
}
