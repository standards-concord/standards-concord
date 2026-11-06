import { useMemo } from 'react';
import { diffLines, hunks, splitLines, type DiffLine } from '../../lib/lineDiff';
import { highlightSegments } from './highlight';
import { cx } from '../ui';

/**
 * A change request's edits as a diff of the ontology's Turtle, like a pull request on GitHub:
 * removed lines in red, added in green, with three lines of context around each change.
 */
export function TurtleDiff({ before, after }: { before: string; after: string }) {
  const { hs, newlineNote } = useMemo(() => {
    const a = splitLines(before);
    const b = splitLines(after);
    // The line break at the very end isn't a line of its own: say so if only that changes, as git does.
    const note = a.finalNewline === b.finalNewline ? undefined : b.finalNewline ? 'Adds a line break at the end of the file.' : 'Removes the line break at the end of the file.';
    return { hs: hunks(diffLines(a.lines, b.lines)), newlineNote: note };
  }, [before, after]);
  const added = hs.reduce((n, h) => n + h.lines.filter((l) => l.kind === 'add').length, 0);
  const removed = hs.reduce((n, h) => n + h.lines.filter((l) => l.kind === 'del').length, 0);
  if (!hs.length && !newlineNote) return <p className="text-sm text-muted">This change doesn’t alter the Turtle.</p>;
  if (!hs.length) return <p className="text-sm text-muted">{newlineNote}</p>;
  return (
    <div className="space-y-2">
      {newlineNote && <p className="text-xs text-muted">{newlineNote}</p>}
      <p className="text-xs text-muted" data-testid="turtle-diff-summary">
        <span className="font-medium text-ok">+{added}</span> <span className="font-medium text-danger">−{removed}</span> lines
      </p>
      <div className="overflow-x-auto rounded-lg border border-line font-mono text-xs" role="table" aria-label="Turtle diff">
        {hs.map((h, hi) => (
          <div key={hi} role="rowgroup">
            <div role="row" className="border-y border-line bg-surface-2 px-3 py-1 text-subtle first:border-t-0">
              <span role="cell">
                @@ −{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
              </span>
            </div>
            {h.lines.map((l, i) => (
              <Line key={i} l={l} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function Line({ l }: { l: DiffLine }) {
  const segments = useMemo(() => highlightSegments(l.text, 'turtle'), [l.text]);
  const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ';
  return (
    <div role="row" data-diff={l.kind} className={cx('flex min-w-max', l.kind === 'add' && 'bg-ok-soft', l.kind === 'del' && 'bg-danger-soft')}>
      <span role="cell" className="w-10 shrink-0 select-none px-2 text-right text-subtle tabular-nums">{l.oldNo ?? ''}</span>
      <span role="cell" className="w-10 shrink-0 select-none px-2 text-right text-subtle tabular-nums">{l.newNo ?? ''}</span>
      <span role="cell" className={cx('w-5 shrink-0 select-none text-center', l.kind === 'add' ? 'text-ok' : l.kind === 'del' ? 'text-danger' : 'text-subtle')} aria-label={l.kind === 'add' ? 'added' : l.kind === 'del' ? 'removed' : undefined}>
        {sign}
      </span>
      <span role="cell" className="whitespace-pre pr-3">
        {segments.map((s, i) =>
          s.cls ? (
            <span key={i} className={s.cls}>
              {s.text}
            </span>
          ) : (
            s.text
          ),
        )}
      </span>
    </div>
  );
}
