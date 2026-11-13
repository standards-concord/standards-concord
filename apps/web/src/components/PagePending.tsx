import { useEffect, useState, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router';
import { dismissPageWaits, pagePending } from '../lib/routeChunks';

/** Transitions keep the current page visible while the next page's code downloads. */
export function PagePending() {
  const { chunks, fallbacks } = useSyncExternalStore(pagePending.subscribe, pagePending.get, pagePending.get);
  // A page has opened (this one, or another chosen meanwhile): what was awaited before it no longer counts.
  const { key } = useLocation();
  useEffect(() => dismissPageWaits(), [key]);
  const waiting = chunks > 0 && fallbacks === 0;
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!waiting) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), 150);
    return () => clearTimeout(timer);
  }, [waiting]);
  if (!waiting || !visible) return null;
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="pointer-events-none fixed inset-x-0 top-0 z-50 h-1 bg-accent motion-safe:animate-pulse">
      <span className="sr-only">Loading…</span>
    </div>
  );
}
