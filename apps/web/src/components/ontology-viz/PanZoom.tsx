import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Download, Maximize2, Minus, Plus } from 'lucide-react';
import { cx } from '../ui';

export interface Transform {
  x: number;
  y: number;
  k: number;
}

// Low enough that a diagram of a few hundred classes (often a very wide bottom rank) still fits.
const MIN = 0.02;
const MAX = 2.5;
const clamp = (k: number) => Math.max(MIN, Math.min(MAX, k));

/**
 * Pan and zoom for an SVG drawing, with the conventions of modern canvas tools:
 * drag the background or scroll to pan, pinch or ctrl/⌘-scroll to zoom, and from the
 * keyboard, arrow keys pan, + and − zoom and 0 fits the drawing to the view.
 */
export function usePanZoom(box: RefObject<HTMLDivElement | null>, size: { width: number; height: number }, fitKey: unknown) {
  const [t, setT] = useState<Transform>({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);
  // Once the person pans or zooms, resizes stop refitting the drawing under them.
  const touched = useRef(false);
  const move = useCallback((f: (p: Transform) => Transform) => {
    touched.current = true;
    setT(f);
  }, []);

  const fit = useCallback(() => {
    const el = box.current;
    if (!el || !size.width || !size.height || !el.clientWidth || !el.clientHeight) return;
    touched.current = false;
    const pad = 24;
    const w = el.clientWidth - pad * 2;
    const h = el.clientHeight - pad * 2;
    const k = clamp(Math.min(w / size.width, h / size.height, 1.1));
    setT({ k, x: (el.clientWidth - size.width * k) / 2, y: Math.max(pad, (el.clientHeight - size.height * k) / 2) });
  }, [box, size.width, size.height]);

  useEffect(() => fit(), [fit, fitKey]);

  // Fit once the container becomes measurable (e.g. inside a <details> that opens later)
  // and whenever it is resized, unless the person has moved the view themselves.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let last = '';
    const ro = new ResizeObserver(() => {
      const key = `${el.clientWidth}x${el.clientHeight}`;
      if (key === last) return;
      last = key;
      if (!touched.current) fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [box, fit]);

  /** Pan the least distance that brings a rectangle (in drawing coordinates) into view. */
  const reveal = useCallback(
    (r: { x: number; y: number; width: number; height: number }) => {
      const el = box.current;
      if (!el) return;
      const pad = 16;
      setT((p) => {
        const left = r.x * p.k + p.x;
        const top = r.y * p.k + p.y;
        const right = left + r.width * p.k;
        const bottom = top + r.height * p.k;
        let dx = 0;
        let dy = 0;
        if (right > el.clientWidth - pad) dx = el.clientWidth - pad - right;
        if (left + dx < pad) dx = pad - left;
        if (bottom > el.clientHeight - pad) dy = el.clientHeight - pad - bottom;
        if (top + dy < pad) dy = pad - top;
        return dx || dy ? { ...p, x: p.x + dx, y: p.y + dy } : p;
      });
    },
    [box],
  );

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    move((p) => {
      const el = box.current;
      const px = cx ?? (el ? el.clientWidth / 2 : 0);
      const py = cy ?? (el ? el.clientHeight / 2 : 0);
      const k = clamp(p.k * factor);
      return { k, x: px - ((px - p.x) * k) / p.k, y: py - ((py - p.y) * k) / p.k };
    });
  }, [box, move]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
      else move((p) => ({ ...p, x: p.x - e.deltaX, y: p.y - e.deltaY }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [box, zoomAt, move]);

  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0 || (e.target as Element).closest('[data-node], button, a, select, input')) return;
      drag.current = { x: e.clientX, y: e.clientY, tx: t.x, ty: t.y, moved: false };
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      move((p) => ({ ...p, x: d.tx + dx, y: d.ty + dy }));
    },
    onPointerUp: () => {
      drag.current = null;
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if ((e.target as Element).closest('[data-node]') && e.key.startsWith('Arrow')) return;
      const step = 60;
      const keys: Record<string, () => void> = {
        ArrowLeft: () => move((p) => ({ ...p, x: p.x + step })),
        ArrowRight: () => move((p) => ({ ...p, x: p.x - step })),
        ArrowUp: () => move((p) => ({ ...p, y: p.y + step })),
        ArrowDown: () => move((p) => ({ ...p, y: p.y - step })),
        '+': () => zoomAt(1.2),
        '=': () => zoomAt(1.2),
        '-': () => zoomAt(1 / 1.2),
        '0': fit,
      };
      const f = keys[e.key];
      if (f) {
        e.preventDefault();
        f();
      }
    },
  };
  return { t, fit, reveal, zoomIn: () => zoomAt(1.2), zoomOut: () => zoomAt(1 / 1.2), handlers };
}

export function ZoomControls({ onIn, onOut, onFit, onExport, exportLabel = 'Download as SVG', k, children }: { onIn: () => void; onOut: () => void; onFit: () => void; onExport?: () => void; exportLabel?: string; k: number; children?: ReactNode }) {
  const btn = 'flex size-8 items-center justify-center text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent';
  return (
    <div className="absolute top-2 right-2 z-10 flex items-center gap-2">
      {children}
      <div className="flex items-center overflow-hidden rounded-lg border border-line-strong bg-surface shadow-sm">
        <button type="button" className={btn} onClick={onOut} aria-label="Zoom out" title="Zoom out (−)">
          <Minus className="size-4" />
        </button>
        <span className="w-11 text-center text-xs text-muted tabular-nums" aria-live="polite" aria-label={`Zoom ${Math.round(k * 100)} percent`}>
          {Math.round(k * 100)}%
        </span>
        <button type="button" className={btn} onClick={onIn} aria-label="Zoom in" title="Zoom in (+)">
          <Plus className="size-4" />
        </button>
        <button type="button" className={cx(btn, 'border-l border-line')} onClick={onFit} aria-label="Fit to view" title="Fit to view (0)">
          <Maximize2 className="size-4" />
        </button>
        {onExport && (
          <button type="button" className={cx(btn, 'border-l border-line')} onClick={onExport} aria-label={exportLabel} title={exportLabel}>
            <Download className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}

export function cssVar(name: string, fallback: string) {
  if (typeof document === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** Resolved theme colours, so an exported SVG looks the same outside the page. */
export function themeColours() {
  return {
    fg: cssVar('--fg', '#141414'),
    muted: cssVar('--muted', '#5f6368'),
    subtle: cssVar('--subtle', '#6b7079'),
    accent: cssVar('--accent', '#1f4fe0'),
    accentSoft: cssVar('--accent-soft', '#eaf0ff'),
    accentFg: cssVar('--accent-fg', '#ffffff'),
    surface: cssVar('--surface', '#ffffff'),
    surface2: cssVar('--surface-2', '#f4f4f3'),
    line: cssVar('--line', '#e5e5e3'),
    lineStrong: cssVar('--line-strong', '#d4d4d1'),
    warn: cssVar('--warn', '#a35a00'),
    danger: cssVar('--danger', '#c0262d'),
    ok: cssVar('--ok', '#157f3c'),
  };
}
export type Colours = ReturnType<typeof themeColours>;

let canvas: HTMLCanvasElement | undefined;
/** Width of a string in the given CSS font, for sizing diagram boxes before layout. */
export function textWidth(s: string, font: string) {
  canvas ??= document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return s.length * 7;
  ctx.font = font;
  return ctx.measureText(s).width;
}

/** Smooth path through dagre's edge points. */
export function curve(points: { x: number; y: number }[]) {
  if (points.length < 2) return '';
  if (points.length === 2) return `M${points[0].x},${points[0].y}L${points[1].x},${points[1].y}`;
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const n = points[i + 1];
    const mx = (p.x + n.x) / 2;
    const my = (p.y + n.y) / 2;
    d += `Q${p.x},${p.y} ${i === points.length - 2 ? `${n.x},${n.y}` : `${mx},${my}`}`;
  }
  return d;
}

export async function downloadSvg(svg: SVGSVGElement | null, filename: string, bg: string) {
  if (!svg) return;
  // SVG files name their fonts but don't carry them, so text is exported as outlines (with the
  // real text kept underneath) and looks the same in any viewer. If that can't be done, each
  // run of text is instead fixed to its on-screen length, which browsers honour.
  let clone: SVGSVGElement;
  try {
    const { exportableSvg } = await import('../../lib/outlineText');
    clone = await exportableSvg(svg);
  } catch (err) {
    console.warn('Exporting text as outlines failed; exporting it as text', err);
    clone = svg.cloneNode(true) as SVGSVGElement;
    const runs = (root: Element) => [...root.querySelectorAll('text')].flatMap((t) => (t.querySelector('tspan') ? [...t.querySelectorAll('tspan')] : [t])) as SVGTextContentElement[];
    const live = runs(svg);
    runs(clone).forEach((el, i) => {
      const len = live[i]?.getComputedTextLength();
      if (len) (el.setAttribute('textLength', len.toFixed(2)), el.setAttribute('lengthAdjust', 'spacingAndGlyphs'));
    });
  }
  const vp = clone.querySelector('[data-viewport]');
  vp?.removeAttribute('transform');
  const w = clone.dataset.width ?? '800';
  const h = clone.dataset.height ?? '600';
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', w);
  clone.setAttribute('height', h);
  clone.setAttribute('viewBox', `-20 -20 ${Number(w) + 40} ${Number(h) + 40}`);
  clone.style.background = bg;
  const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
