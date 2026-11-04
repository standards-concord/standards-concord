import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, type LucideIcon } from 'lucide-react';
import { cx } from './ui';

/**
 * Progressive disclosure primitives. The site shows a short summary first and keeps
 * the detail one click away, so nothing is removed but less is on screen at once.
 */

/** A button that opens a small floating panel. Closes on outside click and Escape. */
export function Popover({
  trigger,
  children,
  label,
  align = 'left',
  className,
  panelClassName,
}: {
  /** Content of the trigger button. */
  trigger: ReactNode;
  children: ReactNode;
  /** Accessible name of the trigger, and of the panel. */
  label: string;
  align?: 'left' | 'right';
  className?: string;
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className={cx('inline-flex items-center gap-1 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-accent', className)}
      >
        {trigger}
        <ChevronDown className={cx('size-3 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div
          id={id}
          role="dialog"
          aria-label={label}
          className={cx(
            'absolute z-40 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-4 text-sm shadow-xl',
            align === 'right' ? 'right-0' : 'left-0',
            panelClassName,
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** A section whose body is hidden until its heading is clicked. */
export function Disclosure({
  title,
  summary,
  children,
  defaultOpen = false,
  className,
  tone,
}: {
  title: ReactNode;
  /** Shown next to the title, e.g. a count or a one-line verdict. */
  summary?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  tone?: 'muted';
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className={cx('flex w-full items-center gap-1.5 text-left text-sm', tone === 'muted' ? 'text-muted hover:text-fg' : 'font-medium hover:text-accent')}
      >
        {open ? <ChevronDown className="size-4 shrink-0 text-muted" /> : <ChevronRight className="size-4 shrink-0 text-muted" />}
        <span className="min-w-0 flex-1">{title}</span>
        {summary !== undefined && <span className="shrink-0 text-xs font-normal text-muted">{summary}</span>}
      </button>
      {open && (
        <div id={id} className="mt-3">
          {children}
        </div>
      )}
    </div>
  );
}

/** A card whose body is collapsed behind its header; the header can show a one-line summary. */
export function CollapsibleCard({
  title,
  subtitle,
  summary,
  icon: Icon,
  children,
  defaultOpen = false,
  id,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  summary?: ReactNode;
  icon?: LucideIcon;
  children: ReactNode;
  defaultOpen?: boolean;
  id?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <section id={id} className="scroll-mt-20 rounded-xl border border-line bg-surface">
      <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)} className="flex w-full items-start gap-3 px-5 py-4 text-left">
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            {Icon && <Icon className="size-4 text-muted" />}
            {title}
          </h3>
          {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          {summary && !open && <div className="mt-1.5 text-sm text-fg/85">{summary}</div>}
        </div>
        {open ? <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted" /> : <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted" />}
      </button>
      {open && (
        <div id={bodyId} className="border-t border-line">
          {children}
        </div>
      )}
    </section>
  );
}
