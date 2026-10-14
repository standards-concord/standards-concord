import { useState } from 'react';
import type { ChangeOp, OntologyDiff } from '@concord/shared';
import { Minus, Pencil, Plus, Archive } from 'lucide-react';
import { describeOp, type Labeler } from '../lib/ontology';
import { cx, EmptyState } from './ui';

const TONE = {
  add: { cls: 'border-l-ok', icon: Plus, iconCls: 'text-ok bg-ok-soft' },
  remove: { cls: 'border-l-danger', icon: Minus, iconCls: 'text-danger bg-danger-soft' },
  modify: { cls: 'border-l-accent', icon: Pencil, iconCls: 'text-accent bg-accent-soft' },
  deprecate: { cls: 'border-l-warn', icon: Archive, iconCls: 'text-warn bg-warn-soft' },
};

export function OpCards({ ops, label }: { ops: ChangeOp[]; label: Labeler }) {
  if (!ops.length) return <EmptyState title="No changes proposed yet">The author, or the AI, still needs to draft the actual ontology changes.</EmptyState>;
  return (
    <ul className="space-y-2">
      {ops.map((op, i) => {
        const d = describeOp(op, label);
        const t = TONE[d.tone];
        const Icon = t.icon;
        return (
          <li key={i} className={cx('flex gap-3 rounded-lg border border-l-4 border-line bg-surface p-3', t.cls)}>
            <span className={cx('mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md', t.iconCls)}>
              <Icon className="size-3.5" />
            </span>
            <div className="min-w-0">
              <div className="text-sm">
                <span className="text-muted">{d.verb}</span> {d.title && <strong className="font-semibold">{d.title}</strong>}
              </div>
              {d.lines.map((l, j) => (
                <p key={j} className={cx('mt-0.5 text-sm', l.startsWith('“') ? 'text-fg/85' : 'text-muted')}>
                  {l}
                </p>
              ))}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function TripleDiff({ diff }: { diff?: OntologyDiff }) {
  const [max, setMax] = useState(300);
  if (!diff) return <p className="text-sm text-muted">The triple-level diff appears once the change has been triaged.</p>;
  const lines = [...diff.removedNTriples.map((l) => ['-', l] as const), ...diff.addedNTriples.map((l) => ['+', l] as const)];
  return (
    <div>
      <p className="mb-2 text-xs text-muted">
        <span className="text-ok">+{diff.addedTriples}</span> / <span className="text-danger">−{diff.removedTriples}</span> triples (N-Triples, sorted)
      </p>
      <div className="max-h-[480px] overflow-auto rounded-lg border border-line bg-surface-2 font-mono text-[0.72rem] leading-relaxed">
        {lines.slice(0, max).map(([sign, l], i) => (
          <div key={i} className={cx('px-3 whitespace-pre', sign === '+' ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger')}>
            {sign} {l}
          </div>
        ))}
        {!lines.length && <div className="p-3 text-muted">No triple changes.</div>}
      </div>
      {lines.length > max && (
        <button className="mt-2 text-xs text-accent" onClick={() => setMax((m) => m + 500)}>
          Show more ({lines.length - max} remaining)
        </button>
      )}
    </div>
  );
}

export function TermChanges({ diff }: { diff?: OntologyDiff }) {
  if (!diff?.terms.length) return null;
  return (
    <ul className="space-y-1 text-sm">
      {diff.terms.map((t, i) => (
        <li key={i}>
          <span className={cx('mr-1.5 text-xs font-semibold uppercase', t.change === 'added' ? 'text-ok' : t.change === 'removed' ? 'text-danger' : t.change === 'deprecated' ? 'text-warn' : 'text-accent')}>{t.change}</span>
          {t.label ?? t.iri}
          {t.details.length > 0 && <span className="text-xs text-muted"> — {t.details.join('; ')}</span>}
        </li>
      ))}
    </ul>
  );
}
