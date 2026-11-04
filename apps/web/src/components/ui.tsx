import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { CircleAlert, Check, Copy, LoaderCircle, RefreshCw, X, type LucideIcon } from 'lucide-react';
import { errorMessage, ApiError } from '../api';
import { initials } from '../lib/format';

export function cx(...xs: (string | false | null | undefined)[]) {
  return xs.filter(Boolean).join(' ');
}

/* ---------------------------------------------------------------- Button */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover border border-transparent shadow-sm',
  secondary: 'bg-surface text-fg border border-line-strong hover:bg-surface-2',
  ghost: 'text-fg hover:bg-surface-2 border border-transparent',
  subtle: 'bg-accent-soft text-accent hover:brightness-95 border border-transparent',
  danger: 'bg-danger text-danger-fg hover:brightness-110 border border-transparent',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; icon?: LucideIcon; loading?: boolean }) {
  const sizes = { sm: 'h-8 px-2.5 text-xs gap-1.5', md: 'h-9 px-3.5 text-sm gap-2', lg: 'h-11 px-5 text-sm gap-2' };
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        sizes[size],
        className,
      )}
    >
      {loading ? <LoaderCircle className="size-4 animate-spin" /> : Icon ? <Icon className={size === 'sm' ? 'size-3.5' : 'size-4'} /> : null}
      {children}
    </button>
  );
}

/* ---------------------------------------------------------------- Layout */

export function Card({ className, children, as: As = 'div' }: { className?: string; children: ReactNode; as?: 'div' | 'section' | 'article' }) {
  return <As className={cx('ui-card rounded-xl border border-line bg-surface', className)}>{children}</As>;
}

export function CardHeader({ title, subtitle, actions, icon: Icon, level = 3 }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; icon?: LucideIcon; level?: 2 | 3 | 4 }) {
  const H = `h${level}` as const;
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
      <div className="min-w-0">
        <H className="ui-card-title flex items-center gap-2 text-sm font-semibold">
          {Icon && <Icon className="size-4 text-muted" />}
          {title}
        </H>
        {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, eyebrow }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <div className="page-eyebrow mb-1 text-xs font-medium tracking-wide text-muted uppercase">{eyebrow}</div>}
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------- States */

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle className={cx('size-4 animate-spin text-muted', className)} />;
}

export function Loading({ label = 'Loading…', className }: { label?: string; className?: string }) {
  return (
    <div role="status" aria-busy="true" className={cx('flex items-center justify-center gap-2 py-12 text-sm text-muted', className)}>
      <Spinner /> {label}
    </div>
  );
}

export function ErrorCard({ error, onRetry, title, className }: { error: unknown; onRetry?: () => void; title?: string; className?: string }) {
  const offline = error instanceof ApiError && error.offline;
  return (
    <div role="alert" className={cx('rounded-xl border border-danger/30 bg-danger-soft px-5 py-4', className)}>
      <div className="flex items-start gap-3">
        <CircleAlert className="mt-0.5 size-5 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-danger">{title ?? (offline ? 'Server unavailable' : 'Something went wrong')}</div>
          <p className="mt-0.5 text-sm break-words">{errorMessage(error)}</p>
        </div>
        {onRetry && (
          <Button size="sm" icon={RefreshCw} onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
    </div>
  );
}

export function InlineError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="flex items-start gap-1.5 text-sm text-danger">
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      {errorMessage(error)}
    </p>
  );
}

export function EmptyState({ icon: Icon, title, children, action }: { icon?: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-line-strong px-6 py-12 text-center">
      {Icon && (
        <div className="mb-3 rounded-pill bg-surface-2 p-3">
          <Icon className="size-5 text-muted" />
        </div>
      )}
      <h3 className="text-sm font-semibold">{title}</h3>
      {children && <p className="mt-1 max-w-md text-sm text-muted">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Render loading/error/children for an async state. */
export function Async<T>({ state, children, label }: { state: { data: T | undefined; error: unknown; loading: boolean; reload: () => unknown }; children: (d: T) => ReactNode; label?: string }) {
  if (state.error && state.data === undefined) return <ErrorCard error={state.error} onRetry={() => void state.reload()} />;
  if (state.data === undefined) return <Loading label={label} />;
  return <>{children(state.data)}</>;
}

/* ---------------------------------------------------------------- Badges */

type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'outline';
const TONES: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted',
  accent: 'bg-accent-soft text-accent',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
  outline: 'border border-line-strong text-muted',
};
export function Badge({ tone = 'neutral', children, className, icon: Icon, title }: { tone?: Tone; children: ReactNode; className?: string; icon?: LucideIcon; title?: string }) {
  return (
    <span title={title} className={cx('ui-badge inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-xs font-medium whitespace-nowrap', TONES[tone], className)}>
      {Icon && <Icon className="size-3" />}
      {children}
    </span>
  );
}

export function Avatar({ name, src, size = 28, simulated }: { name?: string; src?: string; size?: number; simulated?: boolean }) {
  const [broken, setBroken] = useState(false);
  const hue = [...(name ?? '?')].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  return (
    <span
      title={name + (simulated ? ' (simulated)' : '')}
      className={cx('relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[var(--r-avatar)] text-[0.65rem] font-semibold text-white', simulated && 'ring-2 ring-dashed ring-line-strong')}
      style={{ width: size, height: size, background: `hsl(${hue} var(--avatar-s) var(--avatar-l))`, fontSize: size * 0.38 }}
    >
      {src && !broken ? <img src={src} alt="" className="size-full object-cover" onError={() => setBroken(true)} /> : initials(name)}
    </span>
  );
}

export function ProgressBar({ value, tone = 'accent', className, marker }: { value: number; tone?: 'accent' | 'ok' | 'warn' | 'danger'; className?: string; marker?: number }) {
  const colors = { accent: 'bg-accent', ok: 'bg-ok', warn: 'bg-warn', danger: 'bg-danger' };
  const v = Math.max(0, Math.min(1, value || 0));
  return (
    <div className={cx('relative h-1.5 w-full overflow-hidden rounded-pill bg-surface-2', className)}>
      <div className={cx('h-full rounded-pill transition-all', colors[tone])} style={{ width: `${v * 100}%` }} />
      {marker !== undefined && <div className="absolute top-0 h-full w-0.5 bg-fg/60" style={{ left: `${Math.min(1, marker) * 100}%` }} />}
    </div>
  );
}

/* ---------------------------------------------------------------- Forms */

const inputCls =
  'w-full rounded-lg border border-control bg-surface px-3 py-2 text-sm text-fg placeholder:text-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:opacity-60';

export function Input(props: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input {...props} className={cx(inputCls, 'h-9', props.className)} />;
}
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(inputCls, 'min-h-20', props.className)} />;
}
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(inputCls, 'h-9 pr-8', props.className)} />;
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <span className="inline-flex items-center gap-2">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50', checked ? 'bg-accent' : 'bg-control')}
      >
        <span className={cx('inline-block size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-4.5' : 'translate-x-0.5')} />
      </button>
      {label && (
        <label htmlFor={id} className="cursor-pointer text-sm">
          {label}
        </label>
      )}
    </span>
  );
}

/* ---------------------------------------------------------------- Dialog */

export function Dialog({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input,textarea,select')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 backdrop-blur-[2px] sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal className={cx('flex max-h-[92vh] w-full flex-col rounded-t-2xl border border-line bg-surface shadow-2xl sm:rounded-2xl', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}>
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-surface-2" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Misc */

export function CopyButton({ text, label, size = 'sm', variant = 'secondary' }: { text: string; label?: string; size?: 'sm' | 'md'; variant?: Variant }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size={size}
      variant={variant}
      icon={copied ? Check : Copy}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      aria-label={label ?? 'Copy'}
    >
      {label !== undefined ? (copied ? 'Copied' : label) : null}
    </Button>
  );
}

export function CodeBlock({ code, className, maxHeight = 520 }: { code: string; className?: string; maxHeight?: number }) {
  return (
    <div className={cx('relative rounded-lg border border-line bg-surface-2', className)}>
      <div className="absolute top-2 right-2">
        <CopyButton text={code} />
      </div>
      <pre className="overflow-auto p-4 pr-14 font-mono text-[0.8rem] leading-relaxed" style={{ maxHeight }}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div>
      <div className="ui-stat-label text-xs text-muted">{label}</div>
      <div className="ui-stat-value mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function Chip({ active, onClick, children, className, disabled }: { active?: boolean; onClick?: () => void; children: ReactNode; className?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'inline-flex items-center gap-1 rounded-pill border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50',
        active ? 'border-accent bg-accent-soft text-accent' : 'border-line-strong bg-surface text-muted hover:text-fg',
        className,
      )}
    >
      {active && <Check className="size-3" />}
      {children}
    </button>
  );
}

export function SectionTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cx('mb-3 text-sm font-semibold', className)}>{children}</h2>;
}
