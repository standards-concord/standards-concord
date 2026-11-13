import { lazy } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { ArrowLeft, ArrowRight, Check, Compass, X } from 'lucide-react';
import { STEPS, showWalkthroughDock, useWalkthrough } from '../lib/walkthrough';
import { pageChunk } from '../lib/routeChunks';
import { Button, cx } from './ui';
import { Popover } from './Disclosure';
import { RouteBoundary } from './RouteBoundary';

const StepBody = lazy(pageChunk('walkthrough', () => import('./Walkthrough').then((m) => ({ default: m.StepBody }))));

/* --------------------------------------------------------------- floating pill + panel */

export function WalkthroughDock() {
  const w = useWalkthrough();
  const loc = useLocation();
  const nav = useNavigate();
  if (!showWalkthroughDock(loc.pathname)) return null;
  return (
    <>
      {!w.open && (
        <button
          onClick={() => w.setOpen(true)}
          aria-label={`Walkthrough, step ${w.step + 1} of ${STEPS.length}`}
          className="fixed right-4 bottom-4 z-40 inline-flex size-11 items-center justify-center rounded-full border border-line-strong bg-surface text-sm font-medium shadow-lg hover:bg-surface-2 md:w-auto md:gap-2 md:rounded-pill md:px-4"
        >
          <Compass className="size-4 shrink-0 text-accent" aria-hidden />
          <span className="hidden md:inline">Step {w.step + 1} of {STEPS.length}</span>
          <span aria-hidden className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-accent text-[10px] text-accent-fg md:hidden">{w.step + 1}</span>
        </button>
      )}
      {w.open && (
        <aside className="fixed right-0 bottom-0 z-40 flex max-h-[85vh] w-full flex-col border-t border-line bg-bg shadow-2xl sm:right-4 sm:bottom-4 sm:w-[380px] sm:rounded-2xl sm:border">
          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Compass className="size-4 text-accent" /> Alpha walkthrough
            </div>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" onClick={() => nav('/alpha')}>
                Full view
              </Button>
              <button className="rounded-md p-1 text-muted hover:bg-surface-2" onClick={() => w.setOpen(false)} aria-label="Close walkthrough">
                <X className="size-4" />
              </button>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 px-4 pt-3">
            <div className="text-sm font-medium text-muted">
              Step {w.step + 1}: {STEPS[w.step].title}
            </div>
            <Popover label="All walkthrough steps" align="right" className="px-2 py-0.5 text-xs text-muted hover:bg-surface-2 hover:text-fg" trigger={<>Steps</>}>
              {(close) => (
                <ol className="space-y-1">
                  {STEPS.map((st, i) => (
                    <li key={st.id}>
                      <button
                        className={cx('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-2', i === w.step && 'font-medium text-accent')}
                        aria-current={i === w.step ? 'step' : undefined}
                        onClick={() => {
                          w.setStep(i);
                          close();
                        }}
                      >
                        <span className={cx('flex size-5 shrink-0 items-center justify-center rounded-full border text-[0.65rem]', i < w.step ? 'border-accent bg-accent text-accent-fg' : 'border-line-strong')}>
                          {i < w.step ? <Check className="size-3" /> : i + 1}
                        </span>
                        {st.title}
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </Popover>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <RouteBoundary><StepBody step={w.step} compact onNavigate={() => w.setOpen(false)} /></RouteBoundary>
          </div>
          <div className="flex justify-between border-t border-line px-4 py-2">
            <Button size="sm" variant="ghost" icon={ArrowLeft} disabled={w.step === 0} onClick={w.prev}>
              Back
            </Button>
            <Button size="sm" variant="ghost" disabled={w.step === STEPS.length - 1} onClick={w.next}>
              Skip <ArrowRight className="size-3.5" />
            </Button>
          </div>
        </aside>
      )}
    </>
  );
}

