import { useEffect, useState } from 'react';
import { Check, Palette } from 'lucide-react';
import { chooseLook, currentLook, LOOKS, type LookId } from '../lib/look';
import { Card, CardHeader, cx } from './ui';

/** Hook for the active look; updates when it changes anywhere in the app. */
export function useLook(): [LookId, (id: LookId) => void] {
  const [look, setLook] = useState<LookId>(currentLook);
  useEffect(() => {
    const on = () => setLook(currentLook());
    window.addEventListener('concord-look', on);
    return () => window.removeEventListener('concord-look', on);
  }, []);
  return [look, chooseLook];
}

/** Choose the app's visual style. Each option previews itself in its own look. */
export function LookPicker({ level = 3 }: { level?: 2 | 3 | 4 }) {
  const [look, setLook] = useLook();
  return (
    <Card>
      <CardHeader level={level} icon={Palette} title="Visual style" subtitle="You can also add ?look=spec, civic, workbench or classic to any link." />
      <div role="radiogroup" aria-label="Visual style" className="grid gap-3 p-5 sm:grid-cols-2">
        {LOOKS.map((l) => {
          const active = l.id === look;
          return (
            <button
              key={l.id}
              type="button"
              role="radio"
              aria-checked={active}
              data-testid={`look-${l.id}`}
              tabIndex={active ? 0 : -1}
              onClick={() => setLook(l.id)}
              onKeyDown={(e) => {
                const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
                if (!step) return;
                e.preventDefault();
                const i = (LOOKS.findIndex((x) => x.id === look) + step + LOOKS.length) % LOOKS.length;
                setLook(LOOKS[i].id);
                (e.currentTarget.parentElement?.children[i] as HTMLElement | undefined)?.focus();
              }}
              className={cx('rounded-lg border p-3 text-left transition-colors', active ? 'border-accent ring-1 ring-accent' : 'border-line-strong hover:bg-surface-2')}
            >
              <LookSample id={l.id} />
              <span className="mt-3 flex items-center gap-1.5 text-sm font-medium">
                {active && <Check className="size-4 text-accent" aria-hidden />}
                {l.name}
              </span>
              <span className="mt-0.5 block text-xs text-muted">{l.blurb}</span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

/** A tiny rendering of a look, using that look's own tokens. */
function LookSample({ id }: { id: LookId }) {
  return (
    <span data-look={id} aria-hidden className="block overflow-hidden border border-line" style={{ background: 'var(--bg)', color: 'var(--fg)', borderRadius: 'var(--r-lg)' }}>
      <span className="block h-2" style={{ background: 'var(--header-bg)', borderTop: 'calc(var(--header-rule) / 2) solid var(--accent)' }} />
      <span className="flex items-end justify-between gap-2 px-3 py-2.5">
        <span className="min-w-0">
          <span className="block text-lg leading-tight" style={{ fontFamily: 'var(--font-heading)', fontWeight: 'var(--heading-weight)' as unknown as number }}>
            Volunteering
          </span>
          <span className="block text-[0.7rem] text-muted" style={{ fontFamily: 'var(--font-body)' }}>
            Shared vocabulary · <span style={{ fontFamily: 'var(--font-code)' }}>v1.0.0</span>
          </span>
        </span>
        <span className="flex shrink-0 gap-1">
          {['--accent', '--ok', '--warn', '--danger'].map((v) => (
            <span key={v} className="size-3" style={{ background: `var(${v})`, borderRadius: 'var(--r-pill)' }} />
          ))}
        </span>
      </span>
    </span>
  );
}
