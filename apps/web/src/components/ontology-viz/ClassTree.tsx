import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import type { Labeler } from '../../lib/ontology';
import type { OntologyModel } from '../../lib/ontologyModel';
import { cx } from '../ui';

const ROW_LIMIT = 400;
const EXPAND_BUDGET = 1500;

interface Row {
  key: string;
  iri: string;
  level: number;
  hasKids: boolean;
  expanded: boolean;
  count: number;
  parentKey?: string;
}

/**
 * The class hierarchy as an ARIA tree (WAI-ARIA authoring practices): one tab stop,
 * arrow keys to move and expand, Home/End, type-ahead, Enter to open. A class with
 * several parents appears under each of them. Ancestors of the selected class open
 * automatically so the selection is always visible.
 */
export function ClassTree({ model, label, selected, onSelect, filter }: { model: OntologyModel; label: Labeler; selected?: string; onSelect: (iri: string) => void; filter?: string }) {
  // Start with just the top-level classes; branches open on request or to reveal the selection.
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [active, setActive] = useState<string>();
  const refs = useRef(new Map<string, HTMLLIElement>());
  const typed = useRef({ text: '', at: 0 });

  const name = (iri: string) => model.classes.get(iri)?.label ?? label(iri);
  const f = filter?.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!f) return undefined;
    const hit = new Set<string>();
    for (const c of model.classes.values()) {
      if (`${c.label ?? ''} ${label(c.iri)} ${(c.altLabels ?? []).join(' ')}`.toLowerCase().includes(f)) {
        hit.add(c.iri);
        for (const a of model.ancestors(c.iri)) hit.add(a);
      }
    }
    return hit;
  }, [f, model, label]);

  // Open the path to the selection.
  useEffect(() => {
    if (!selected || !model.classes.has(selected)) return;
    setOpen((prev) => {
      const next = new Set(prev);
      for (const path of model.paths(selected).paths) {
        let key = '';
        for (const iri of path.slice(0, -1)) {
          key = key ? `${key}/${iri}` : iri;
          next.add(key);
        }
      }
      return next;
    });
  }, [selected, model]);

  // Multiple inheritance can make a fully expanded tree far longer than the class count,
  // so only this many rows are rendered at a time, with a button for more.
  const [limit, setLimit] = useState(ROW_LIMIT);
  // Rows on the path to the selection are always rendered, whatever the budget.
  const keep = useMemo(() => {
    const out = new Set<string>();
    const path = selected && model.classes.has(selected) ? model.paths(selected, 1).paths[0] : undefined;
    let key = '';
    for (const iri of path ?? []) out.add((key = key ? `${key}/${iri}` : iri));
    return out;
  }, [model, selected]);
  const { rows, truncated } = useMemo(() => {
    const out: Row[] = [];
    let truncated = false;
    const visit = (iri: string, level: number, parentKey: string | undefined, seen: Set<string>) => {
      if (matches && !matches.has(iri)) return;
      if (out.length >= limit && !keep.has(parentKey ? `${parentKey}/${iri}` : iri)) {
        truncated = true;
        return;
      }
      const key = parentKey ? `${parentKey}/${iri}` : iri;
      const kids = seen.has(iri) ? [] : (model.children.get(iri) ?? []).filter((k) => !matches || matches.has(k));
      const expanded = kids.length > 0 && (!!matches || open.has(key));
      out.push({ key, iri, level, hasKids: kids.length > 0, expanded, count: kids.length, parentKey });
      if (expanded) for (const k of kids) visit(k, level + 1, key, new Set([...seen, iri]));
    };
    for (const r of model.roots) visit(r, 1, undefined, new Set());
    return { rows: out, truncated };
  }, [model, open, matches, limit, keep]);

  const activeKey = rows.find((r) => r.key === active)?.key ?? rows.find((r) => r.iri === selected)?.key ?? rows[0]?.key;

  const focusRow = (key: string | undefined) => {
    if (!key) return;
    setActive(key);
    refs.current.get(key)?.focus();
  };
  const setExpanded = (key: string, v: boolean) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (v) next.add(key);
      else next.delete(key);
      return next;
    });

  const onKeyDown = (e: KeyboardEvent, row: Row, i: number) => {
    const k = e.key;
    let handled = true;
    if (k === 'ArrowDown') focusRow(rows[i + 1]?.key);
    else if (k === 'ArrowUp') focusRow(rows[i - 1]?.key);
    else if (k === 'Home') focusRow(rows[0]?.key);
    else if (k === 'End') focusRow(rows[rows.length - 1]?.key);
    else if (k === 'ArrowRight') {
      if (row.hasKids && !row.expanded) setExpanded(row.key, true);
      else if (row.expanded) focusRow(rows[i + 1]?.key);
    } else if (k === 'ArrowLeft') {
      if (row.expanded) setExpanded(row.key, false);
      else focusRow(row.parentKey);
    } else if (k === 'Enter' || k === ' ') onSelect(row.iri);
    else if (k === '*') setOpen((prev) => new Set([...prev, ...rows.filter((r) => r.level === row.level && r.hasKids).map((r) => r.key)]));
    else if (k.length === 1 && /\S/.test(k)) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : '') + k.toLowerCase(), at: now };
      const t = typed.current.text;
      const order = [...rows.slice(i + (t.length === 1 ? 1 : 0)), ...rows.slice(0, i + 1)];
      focusRow(order.find((r) => name(r.iri).toLowerCase().startsWith(t))?.key);
    } else handled = false;
    if (handled) e.preventDefault();
  };

  // Expand breadth first, stopping once the expanded tree would pass EXPAND_BUDGET rows.
  const expandAll = () => {
    const keys = new Set<string>();
    let rowsSoFar = model.roots.length;
    let level: { iri: string; key: string; seen: Set<string> }[] = model.roots.map((r) => ({ iri: r, key: r, seen: new Set<string>() }));
    while (level.length && rowsSoFar < EXPAND_BUDGET) {
      const next: typeof level = [];
      for (const n of level) {
        const kids = n.seen.has(n.iri) ? [] : (model.children.get(n.iri) ?? []);
        if (!kids.length) continue;
        if (rowsSoFar + kids.length > EXPAND_BUDGET) break;
        keys.add(n.key);
        rowsSoFar += kids.length;
        const seen = new Set([...n.seen, n.iri]);
        for (const k of kids) next.push({ iri: k, key: `${n.key}/${k}`, seen });
      }
      level = next;
    }
    setOpen(keys);
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <div id="class-tree-label" className="text-sm font-semibold">
          Classes ({model.classes.size})
        </div>
        <div className="flex">
          <button type="button" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg" onClick={expandAll} aria-label="Expand all classes" title="Expand all">
            <ChevronsUpDown className="size-3.5" />
          </button>
          <button type="button" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg" onClick={() => setOpen(new Set())} aria-label="Collapse all classes" title="Collapse all">
            <ChevronsDownUp className="size-3.5" />
          </button>
        </div>
      </div>
      {!rows.length && <p className="px-2 py-3 text-sm text-muted">No classes match.</p>}
      <ul role="tree" aria-labelledby="class-tree-label" className="text-sm">
        {rows.map((r, i) => {
          const c = model.classes.get(r.iri)!;
          const isSel = r.iri === selected;
          return (
            <li
              key={r.key}
              ref={(el) => {
                if (el) refs.current.set(r.key, el);
                else refs.current.delete(r.key);
              }}
              role="treeitem"
              aria-level={r.level}
              aria-expanded={r.hasKids ? r.expanded : undefined}
              aria-selected={isSel}
              tabIndex={r.key === activeKey ? 0 : -1}
              onKeyDown={(e) => onKeyDown(e, r, i)}
              onFocus={() => setActive(r.key)}
              onClick={() => {
                setActive(r.key);
                onSelect(r.iri);
              }}
              className={cx(
                'flex cursor-pointer items-center rounded-md pr-2 outline-none focus-visible:ring-2 focus-visible:ring-accent',
                isSel ? 'bg-accent-soft font-medium text-accent' : 'hover:bg-surface-2',
              )}
              style={{ paddingLeft: (r.level - 1) * 14 }}
            >
              <span
                className="flex size-6 shrink-0 items-center justify-center text-muted"
                onClick={(e) => {
                  if (!r.hasKids) return;
                  e.stopPropagation();
                  setExpanded(r.key, !r.expanded);
                }}
                aria-hidden
              >
                {r.hasKids ? r.expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" /> : <span className="size-1.5 rounded-full bg-current opacity-40" />}
              </span>
              <span className={cx('min-w-0 flex-1 py-1 leading-snug break-words', c.deprecated && 'text-muted line-through')}>{name(r.iri)}</span>
              {r.count > 0 && (
                <span className="text-[0.65rem] text-subtle" aria-label={`${r.count} subclasses`}>
                  {r.count}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {truncated && (
        <button type="button" className="mt-1 w-full rounded-md px-2 py-1 text-left text-xs text-accent hover:bg-surface-2" onClick={() => setLimit((n) => n + ROW_LIMIT)}>
          Show more classes (first {rows.length} rows shown)
        </button>
      )}
    </div>
  );
}
