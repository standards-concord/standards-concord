/**
 * Measures text the way an SVG <text> element draws it: same engine, same font fallback for
 * characters the web font lacks, same shaping. (A canvas can pick a different fallback font for
 * CJK, emoji and the like, so boxes sized from it can come out a little too small.)
 */
let host: SVGTextElement | undefined;
let hostFont = '';
const cache = new Map<string, number>();

function element() {
  if (host?.isConnected) return host;
  hostFont = '';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  // Measured as the diagram draws it: unhinted, so the width is the same at every zoom level.
  svg.setAttribute('text-rendering', 'geometricPrecision');
  svg.style.cssText = 'position:absolute;left:-10000px;top:0;visibility:hidden;overflow:hidden';
  host = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  // Spaces count (an indent can end in one); collapsing would only ever make text narrower.
  host.style.whiteSpace = 'pre';
  svg.append(host);
  document.body.append(svg);
  return host;
}

let canvas: HTMLCanvasElement | undefined;
function canvasWidth(s: string, font: string) {
  canvas ??= document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return s.length * 7;
  ctx.font = font;
  return ctx.measureText(s).width;
}

/** Width in px of `s` drawn as SVG text in the CSS font shorthand `font`. */
export function svgTextWidth(s: string, font: string) {
  if (typeof document === 'undefined') return s.length * 7;
  const key = `${font}\u0000${s}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let w: number;
  try {
    const el = element();
    if (hostFont !== font) {
      el.style.font = font;
      hostFont = font;
    }
    el.textContent = s;
    w = el.getComputedTextLength();
  } catch {
    w = canvasWidth(s, font);
  }
  if (cache.size > 100_000) cache.clear();
  cache.set(key, w);
  return w;
}

/** Forget measurements, e.g. once more of a web font has loaded. */
export function clearTextWidths() {
  cache.clear();
}
