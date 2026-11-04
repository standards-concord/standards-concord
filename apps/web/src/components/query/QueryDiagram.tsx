import type { BuilderModel, PathStep } from '../../lib/sparql-builder';
import { FILTER_LABELS, isRequired } from '../../lib/sparql-builder';
import type { Labeler } from '../../lib/ontology';
import type { PropertyOption } from './schema';

/**
 * The builder's graph pattern drawn as a left-to-right tree: the class you're
 * looking for on the left, each property as a labelled arrow, linked things
 * as boxes and values as pills. Dashed means optional; faded means not shown
 * as a column.
 */

const COL = 310;
const ROW = 62;
const NODE_W = 200;
const NODE_H = 38;
const PAD = 12;

interface Placed {
  id: string;
  parent?: string;
  x: number;
  y: number;
  title: string;
  subtitle?: string;
  kind: 'root' | 'object' | 'data';
  shown: boolean;
  edgeLabel?: string;
  optional?: boolean;
}

function clip(s: string, n = 24) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function QueryDiagram({
  model,
  variables,
  label,
  optionFor,
}: {
  model: BuilderModel;
  variables: Record<string, string>;
  label: Labeler;
  optionFor: (iri: string) => PropertyOption | undefined;
}) {
  // Pass 1: rows. Leaves take one row each; a parent sits centred on its children.
  const placed: Placed[] = [];
  let row = 0;
  const lay = (steps: PathStep[], depth: number, parent: string): void => {
    for (const s of steps) {
      const start = row;
      if (s.children.length) lay(s.children, depth + 1, s.id);
      else row += 1;
      const opt = optionFor(s.property);
      const isObject = opt?.kind === 'object';
      const v = `?${variables[s.id] ?? ''}`;
      const filter = s.filter?.value.trim() ? `${FILTER_LABELS[s.filter.op]} “${clip(s.filter.value, 14)}”` : undefined;
      placed.push({
        id: s.id,
        parent,
        x: PAD + depth * COL,
        y: PAD + ((start + row - 1) / 2) * ROW,
        title: isObject ? (opt?.range ? label(opt.range) : 'thing') : v,
        subtitle: isObject ? `${v}${filter ? ` · ${filter}` : ''}` : filter,
        kind: isObject ? 'object' : 'data',
        shown: s.show,
        edgeLabel: opt?.label ?? label(s.property),
        optional: s.optional && !isRequired(s),
      });
    }
  };
  lay(model.steps, 1, 'root');
  const rows = Math.max(1, row);
  const root: Placed = {
    id: 'root',
    x: PAD,
    y: PAD + ((rows - 1) / 2) * ROW,
    title: label(model.rootClass),
    subtitle: `?${variables.root ?? ''}${model.includeSubclasses ? ' + more specific' : ''}`,
    kind: 'root',
    shown: true,
  };
  const all = [root, ...placed];
  const byId = new Map(all.map((n) => [n.id, n]));
  const width = Math.max(...all.map((n) => n.x)) + NODE_W + PAD;
  const height = PAD * 2 + (rows - 1) * ROW + NODE_H;

  return (
    <div className="overflow-x-auto rounded-md border border-line bg-surface-2" data-testid="query-diagram">
      <svg width={width} height={height} role="img" aria-label="Diagram of the query pattern" className="block">
        <defs>
          <marker id="qd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--subtle)" />
          </marker>
        </defs>
        {placed.map((p) => {
          const parent = byId.get(p.parent ?? 'root')!;
          const from = { x: parent.x + NODE_W, y: parent.y + NODE_H / 2 };
          const to = { x: p.x, y: p.y + NODE_H / 2 };
          const mx = (from.x + to.x) / 2;
          return (
            <g key={`e-${p.id}`}>
              <path
                d={`M ${from.x} ${from.y} C ${mx} ${from.y}, ${mx} ${to.y}, ${to.x - 2} ${to.y}`}
                fill="none"
                stroke="var(--subtle)"
                strokeWidth={1.5}
                strokeDasharray={p.optional ? '5 4' : undefined}
                markerEnd="url(#qd-arrow)"
              />
              <text x={mx} y={(from.y + to.y) / 2 - 6} textAnchor="middle" fontSize={11} fill="var(--muted)" style={{ paintOrder: 'stroke' }} stroke="var(--surface-2)" strokeWidth={4}>
                {clip(p.edgeLabel ?? '', 28)}
              </text>
            </g>
          );
        })}
        {all.map((n) => (
          <g key={n.id} opacity={n.shown ? 1 : 0.55} data-node={n.kind}>
            <rect
              x={n.x}
              y={n.y}
              width={NODE_W}
              height={NODE_H}
              rx={n.kind === 'data' ? NODE_H / 2 : 8}
              fill={n.kind === 'root' ? 'var(--accent)' : n.kind === 'object' ? 'var(--accent-soft)' : 'var(--surface)'}
              stroke={n.kind === 'data' ? 'var(--line-strong)' : 'var(--accent)'}
              strokeWidth={1.2}
            />
            <text x={n.x + NODE_W / 2} y={n.y + (n.subtitle ? 16 : 23)} textAnchor="middle" fontSize={12} fontWeight={600} fill={n.kind === 'root' ? 'var(--accent-fg)' : 'var(--fg)'} fontFamily={n.kind === 'data' ? 'var(--font-mono)' : undefined}>
              {clip(n.title)}
            </text>
            {n.subtitle && (
              <text x={n.x + NODE_W / 2} y={n.y + 30} textAnchor="middle" fontSize={10} fill={n.kind === 'root' ? 'var(--accent-fg)' : 'var(--muted)'} fontFamily="var(--font-mono)">
                {clip(n.subtitle, 30)}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}
