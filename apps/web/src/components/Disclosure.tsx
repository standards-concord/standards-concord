import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, type LucideIcon } from 'lucide-react';
import { cx } from './ui';

/**
 * Progressive disclosure primitives. The site shows a short summary first and keeps
 * the detail one click away, so nothing is removed but less is on screen at once.
 */

/** Opens when `defaultOpen` turns true later (e.g. new failures arrive) or when `openKey` changes to a new truthy value (e.g. a link to this section is followed again). */
function useOpenState(defaultOpen: boolean, openKey: unknown) {
  const [open, setOpen] = useState(defaultOpen);
  const prevDefault = useRef(defaultOpen);
  useEffect(() => {
    if (defaultOpen && !prevDefault.current) setOpen(true);
    prevDefault.current = defaultOpen;
  }, [defaultOpen]);
  useEffect(() => {
    if (openKey !== undefined && openKey !== null && openKey !== false) setOpen(true);
  }, [openKey]);
  return [open, setOpen] as const;
}

/**
 * A button that opens a small non-modal floating panel. Focus moves into the panel when it opens;
 * Escape closes it and returns focus to the button; clicking outside or tabbing away closes it.
 * The panel is nudged sideways so it stays inside the viewport on narrow screens.
 */
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
  /** Panel content; a function receives `close`, e.g. to close the panel when one of its links is followed. */
  children: ReactNode | ((close: () => void) => ReactNode);
  /** Accessible name of the trigger, and of the panel. */
  label: string;
  align?: 'left' | 'right';
  className?: string;
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [shift, setShift] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close(ref.current?.contains(document.activeElement) ?? false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Keep the panel inside the viewport, and move focus into it so keyboard users land on its content.
  useLayoutEffect(() => {
    if (!open) {
      setShift(0);
      return;
    }
    const place = () => {
      const panel = panelRef.current;
      if (!panel) return;
      panel.style.transform = '';
      const r = panel.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const margin = 8;
      let dx = 0;
      if (r.right > vw - margin) dx = vw - margin - r.right;
      if (r.left + dx < margin) dx = margin - r.left;
      setShift(dx);
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);
  useEffect(() => {
    if (open) panelRef.current?.focus({ preventScroll: true });
  }, [open]);

  return (
    <div
      className="relative inline-block"
      ref={ref}
      onBlur={(e) => {
        // Tabbing out of the trigger and panel closes it, like a disclosure menu.
        if (open && e.relatedTarget && !ref.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        className={cx('inline-flex items-center gap-1 rounded-pill transition-colors focus-visible:outline-2 focus-visible:outline-accent', className)}
      >
        {trigger}
        <ChevronDown className={cx('size-3 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div
          ref={panelRef}
          id={id}
          role="dialog"
          aria-modal="false"
          aria-label={label}
          tabIndex={-1}
          style={shift ? { transform: `translateX(${shift}px)` } : undefined}
          className={cx(
            'absolute z-40 mt-2 max-h-[min(32rem,calc(100vh-8rem))] w-[min(22rem,calc(100vw-1rem))] overflow-y-auto rounded-xl border border-line bg-surface p-4 text-sm shadow-xl outline-none',
            align === 'right' ? 'right-0' : 'left-0',
            panelClassName,
          )}
        >
          {typeof children === 'function' ? children(() => close(false)) : children}
        </div>
      )}
    </div>
  );
}

type HeadingLevel = 2 | 3 | 4;

/** A section whose body is hidden until its heading is clicked. */
export function Disclosure({
  title,
  summary,
  summaryPlacement = 'inline',
  children,
  defaultOpen = false,
  openKey,
  keepMounted,
  heading,
  className,
  tone,
}: {
  title: ReactNode;
  /** Shown with the title, e.g. a count or a one-line verdict. */
  summary?: ReactNode;
  /** 'below' puts a long summary under the title so the title keeps its room in narrow columns. */
  summaryPlacement?: 'inline' | 'below';
  children: ReactNode;
  /** Open on first render; also opens later if this turns true (e.g. a new failure arrives). */
  defaultOpen?: boolean;
  /** Opens whenever this changes to a new truthy value, e.g. the location key of a link that points here. */
  openKey?: unknown;
  /** Keep the content mounted while closed, so state inside it (nested toggles, inputs) survives. */
  keepMounted?: boolean;
  /** Wrap the toggle in a heading of this level, so screen-reader heading navigation still finds the section. */
  heading?: HeadingLevel;
  className?: string;
  tone?: 'muted';
}) {
  const [open, setOpen] = useOpenState(defaultOpen, openKey);
  const id = useId();
  const button = (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={id}
      onClick={() => setOpen((o) => !o)}
      className={cx('flex w-full gap-1.5 text-left text-sm', summaryPlacement === 'below' ? 'items-start' : 'items-center', tone === 'muted' ? 'text-muted hover:text-fg' : 'font-medium hover:text-accent')}
    >
      {open ? <ChevronDown className={cx('size-4 shrink-0 text-muted', summaryPlacement === 'below' && 'mt-0.5')} /> : <ChevronRight className={cx('size-4 shrink-0 text-muted', summaryPlacement === 'below' && 'mt-0.5')} />}
      {summaryPlacement === 'below' ? (
        <span className="min-w-0 flex-1">
          <span className="block">{title}</span>
          {summary !== undefined && summary !== '' && <span className="mt-0.5 block text-xs font-normal text-muted">{summary}</span>}
        </span>
      ) : (
        <>
          <span className="min-w-[6rem] flex-1">{title}</span>
          {summary !== undefined && <span className="min-w-0 text-right text-xs font-normal text-muted">{summary}</span>}
        </>
      )}
    </button>
  );
  const H = heading ? (`h${heading}` as const) : undefined;
  return (
    <div className={className}>
      {H ? <H className="m-0">{button}</H> : button}
      {(open || keepMounted) && (
        <div id={id} className="mt-3" hidden={!open}>
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * A card whose body is collapsed behind its header. The toggle sits inside the heading (the accordion
 * pattern); the subtitle and the closed-state summary sit outside it and describe the toggle.
 */
export function CollapsibleCard({
  title,
  subtitle,
  summary,
  icon: Icon,
  children,
  defaultOpen = false,
  openKey,
  keepMounted,
  id,
  level = 3,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  summary?: ReactNode;
  icon?: LucideIcon;
  children: ReactNode;
  defaultOpen?: boolean;
  openKey?: unknown;
  keepMounted?: boolean;
  id?: string;
  /** Heading level, so cards follow the page's heading structure. */
  level?: HeadingLevel;
}) {
  const [open, setOpen] = useOpenState(defaultOpen, openKey);
  const bodyId = useId();
  const descId = useId();
  const H = `h${level}` as const;
  const hasDesc = !!subtitle || (!!summary && !open);
  return (
    <section id={id} className="ui-card scroll-mt-20 rounded-xl border border-line bg-surface">
      <div className="px-5 py-4">
        <H className="ui-card-title m-0 text-sm font-semibold">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            aria-describedby={hasDesc ? descId : undefined}
            onClick={() => setOpen((o) => !o)}
            className="flex w-full items-center gap-2 text-left"
          >
            {Icon && <Icon className="size-4 shrink-0 text-muted" />}
            <span className="min-w-0 flex-1">{title}</span>
            {open ? <ChevronDown className="size-4 shrink-0 text-muted" /> : <ChevronRight className="size-4 shrink-0 text-muted" />}
          </button>
        </H>
        {hasDesc && (
          <div id={descId}>
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
            {summary && !open && <div className="mt-1.5 text-sm text-fg/85">{summary}</div>}
          </div>
        )}
      </div>
      {(open || keepMounted) && (
        <div id={bodyId} className="border-t border-line" hidden={!open}>
          {children}
        </div>
      )}
    </section>
  );
}
