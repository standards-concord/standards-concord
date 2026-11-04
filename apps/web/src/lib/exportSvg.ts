/**
 * Saving a drawn diagram as an SVG or PNG file.
 *
 * The SVG keeps plain text (searchable, selectable, readable by assistive technology) with the
 * diagram's font stack, and embeds every subset of Inter the labels use, taken from the page's
 * own @font-face rules, so a browser draws it as the page does. Text is fitted to its boxes by
 * measuring and wrapping on the page; nothing stretches it. A viewer that ignores embedded fonts
 * substitutes its own and may draw text wider (librsvg and Inkscape do). Characters Inter lacks
 * (CJK, Arabic, emoji) use the viewer's fonts. The PNG draws the same shapes, and the text with
 * the page's own loaded fonts, so it matches the screen and looks the same wherever it is opened.
 */

/** "U+0000-00FF,U+0131,U+04??" as [from, to] pairs. */
export function parseUnicodeRange(range: string): [number, number][] {
  return range
    .split(',')
    .map((r) => r.trim().replace(/^u\+/i, ''))
    .filter(Boolean)
    .map((r) => {
      const [a, b] = r.split('-');
      if (b !== undefined) return [parseInt(a, 16), parseInt(b, 16)];
      return [parseInt(a.replace(/\?/g, '0'), 16), parseInt(a.replace(/\?/g, 'F'), 16)];
    });
}

/** The weight and style each CSS font shorthand ("italic 600 12px Inter, …") draws with. */
export function facesOf(fonts: string[]) {
  return new Set(fonts.map((f) => `${/\b([1-9]00)\b/.exec(f)?.[1] ?? '400'}|${/\b(italic|oblique)\b/.test(f) ? 'italic' : 'normal'}`));
}

type Face = { weight: string; style: string; range: string; url: string };

/** The page's own @font-face rules for `family`, with each one's (first, preferably WOFF2) file. */
function pageFaces(family: string): Face[] {
  const out: Face[] = [];
  const visit = (rules: CSSRuleList, base: string) => {
    for (const rule of rules) {
      if (rule instanceof CSSImportRule && rule.styleSheet) {
        try {
          visit(rule.styleSheet.cssRules, rule.styleSheet.href ?? base);
        } catch {
          /* cross-origin */
        }
      } else if (rule instanceof CSSFontFaceRule) {
        const st = rule.style;
        if (st.getPropertyValue('font-family').replace(/["']/g, '').trim() !== family) continue;
        const src = st.getPropertyValue('src');
        const urls = [...src.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)\s*(?:format\(\s*["']?([\w-]+))?/g)];
        const pick = urls.find((u) => u[3] === 'woff2' || /\.woff2(\?|$)/.test(u[2])) ?? urls[0];
        if (!pick) continue;
        out.push({
          weight: st.getPropertyValue('font-weight').trim() || '400',
          style: st.getPropertyValue('font-style').trim() || 'normal',
          range: st.getPropertyValue('unicode-range').trim() || 'U+0-10FFFF',
          url: new URL(pick[2], base).href,
        });
      }
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      visit(sheet.cssRules, sheet.href ?? document.baseURI);
    } catch {
      /* cross-origin stylesheet (e.g. a font service): not readable */
    }
  }
  return out;
}

const dataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

const files = new Map<string, Promise<string>>();
function inlined(url: string) {
  let p = files.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`${r.status} ${url}`))))
      .then(dataUrl);
    files.set(url, p);
    p.catch(() => files.delete(url));
  }
  return p;
}

/**
 * @font-face rules carrying, inline, every subset of Inter that `text` needs in the given faces,
 * exactly as the page declares them.
 */
export async function embeddedFonts(text: string, fonts: string[], family = 'Inter') {
  const wanted = facesOf(fonts);
  const points = [...new Set(Array.from(text, (ch) => ch.codePointAt(0)!))];
  const needed = pageFaces(family).filter((f) => wanted.has(`${f.weight}|${f.style}`) && parseUnicodeRange(f.range).some(([a, b]) => points.some((p) => p >= a && p <= b)));
  const rules = await Promise.all(
    needed.map(async (f) => {
      const src = (await inlined(f.url)).replace(/^data:[^;,]*/, f.url.includes('.woff2') ? 'data:font/woff2' : 'data:font/woff');
      return `@font-face{font-family:${family};font-weight:${f.weight};font-style:${f.style};unicode-range:${f.range};src:url(${src})}`;
    }),
  );
  return rules.join('');
}

const frame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));

/**
 * A standalone copy of a diagram's SVG. It waits for the fonts (and for a diagram laid out again
 * once they load to be drawn), then copies the drawing in one go, so the file is one consistent
 * state. `fonts` are the CSS font shorthands the diagram draws with.
 */
export async function exportableSvg(live: SVGSVGElement, bg: string, fonts: string[] = []) {
  // Load every face and script subset the labels need (fonts load lazily), let them settle, and
  // give a diagram that lays itself out again once they arrive two frames to draw.
  const before = live.textContent ?? '';
  await Promise.all(fonts.map((f) => document.fonts.load(f, before).catch(() => [])));
  await document.fonts.ready;
  await frame();
  await frame();

  const clone = live.cloneNode(true) as SVGSVGElement;
  const text = textRuns(live);
  const css = await embeddedFonts(clone.textContent ?? '', fonts).catch((err) => {
    console.warn('Could not embed the diagram font', err);
    return '';
  });
  if (css) {
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = css;
    clone.insertBefore(style, clone.firstChild);
  }
  clone.querySelector('[data-viewport]')?.removeAttribute('transform');
  const w = Number(clone.dataset.width ?? 800);
  const h = Number(clone.dataset.height ?? 600);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(w + 40));
  clone.setAttribute('height', String(h + 40));
  clone.setAttribute('viewBox', `-20 -20 ${w + 40} ${h + 40}`);
  clone.removeAttribute('class');
  clone.style.background = bg;
  const svg = new XMLSerializer().serializeToString(clone);
  // The same drawing without its text, for the PNG to draw the text over.
  for (const t of clone.querySelectorAll('text, style')) t.remove();
  return { svg, shapes: new XMLSerializer().serializeToString(clone), width: w + 40, height: h + 40, text };
}

/** Letters of right-to-left scripts, whose first character isn't at the run's left edge. */
const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;

/**
 * Each run of text as the page draws it: the characters (after SVG's whitespace collapsing),
 * font, colour, and where its left end sits on the baseline, in its own coordinates, with the
 * matrix to the exported file's coordinates (with its margin).
 */
function textRuns(live: SVGSVGElement) {
  const vp = live.querySelector<SVGGElement>('[data-viewport]');
  const inv = vp?.getScreenCTM()?.inverse();
  if (!inv) return [];
  const out: { text: string; font: string; size: number; fill: string; alpha: number; strike: boolean; m: DOMMatrix; x: number; y: number }[] = [];
  for (const t of live.querySelectorAll('text')) {
    const ctm = t.getScreenCTM();
    if (!ctm) continue;
    const m = DOMMatrix.fromMatrix(inv.multiply(ctm)).preMultiplySelf(new DOMMatrix().translateSelf(20, 20));
    const struck = getComputedStyle(t).textDecorationLine.includes('line-through');
    for (const run of t.querySelector('tspan') ? [...t.querySelectorAll('tspan')] : [t]) {
      const n = run.getNumberOfChars();
      if (!n) continue;
      const cs = getComputedStyle(run);
      if (cs.fill === 'none' || cs.visibility !== 'visible' || cs.display === 'none') continue;
      let text = (run.textContent ?? '').replace(/[\t\n\r ]+/g, ' ');
      if (text.length > n) text = text.trimStart();
      if (text.length > n) text = text.trimEnd();
      const start = run.getStartPositionOfChar(0);
      let x = start.x;
      // A right-to-left run's first character is drawn at its right; find its left edge.
      if (RTL.test(text)) for (let i = 0; i < n; i++) x = Math.min(x, run.getExtentOfChar(i).x);
      out.push({
        text,
        font: `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`,
        size: parseFloat(cs.fontSize),
        fill: cs.fill,
        alpha: Number(cs.fillOpacity) * Number(cs.opacity),
        strike: struck || cs.textDecorationLine.includes('line-through'),
        m,
        x,
        y: start.y,
      });
    }
  }
  return out;
}

type TextRun = ReturnType<typeof textRuns>[number];

/** Draws runs of text with the page's own (loaded) fonts, scaled by `k`. */
function drawText(ctx: CanvasRenderingContext2D, runs: TextRun[], k: number) {
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.direction = 'ltr';
  for (const r of runs) {
    ctx.setTransform(new DOMMatrix().scaleSelf(k, k).multiplySelf(r.m));
    ctx.font = r.font;
    ctx.fillStyle = r.fill;
    ctx.globalAlpha = r.alpha;
    ctx.fillText(r.text, r.x, r.y);
    if (r.strike) {
      // Where Chromium draws a line-through in Inter: centred on the font's strikeout position
      // (671/2048 em above the baseline), a tenth of the font size thick.
      const th = r.size / 10;
      ctx.fillRect(r.x, r.y - r.size * (671 / 2048) - th / 2, ctx.measureText(r.text).width, th);
    }
  }
  ctx.restore();
}

function save(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Saves a diagram as SVG. `fonts` are the CSS font shorthands it draws with. */
export async function downloadSvg(live: SVGSVGElement | null, filename: string, bg: string, fonts: string[] = []) {
  if (!live) return;
  const { svg } = await exportableSvg(live, bg, fonts);
  save(new Blob([svg], { type: 'image/svg+xml' }), filename);
}

/** Browsers refuse canvases beyond about this many pixels a side or in total (64 MP is 256 MB). */
export const PNG_MAX_SIDE = 16_384;
export const PNG_MAX_PIXELS = 64_000_000;

/** Twice the drawing's size, or the largest scale that keeps within the limits. */
export function pngScale(width: number, height: number) {
  return Math.min(2, PNG_MAX_SIDE / width, PNG_MAX_SIDE / height, Math.sqrt(PNG_MAX_PIXELS / (width * height)));
}

/**
 * The same drawing as a PNG. An SVG image loads its embedded fonts some time after it has
 * decoded, drawing its text blank until then, and nothing reports when they arrive. So the PNG
 * draws the shapes from the SVG without its text (complete once decoded), then the text itself
 * with the page's fonts, which have loaded. If the browser can't allocate or encode a canvas
 * that large, it tries again at half the scale, a few times, and then throws.
 */
export async function downloadPng(live: SVGSVGElement | null, filename: string, bg: string, fonts: string[] = []) {
  if (!live) return;
  const { shapes, width, height, text } = await exportableSvg(live, bg, fonts);
  const img = new Image();
  const url = URL.createObjectURL(new Blob([shapes], { type: 'image/svg+xml' }));
  try {
    img.src = url;
    await img.decode();
    let scale = pngScale(width, height);
    for (let attempt = 0; attempt < 4; attempt++, scale /= 2) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(width * scale));
      canvas.height = Math.max(1, Math.floor(height * scale));
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        drawText(ctx, text, canvas.width / width);
        const png = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
        if (png) return save(png, filename);
      }
      // Free the memory before trying smaller.
      canvas.width = canvas.height = 0;
    }
    throw new Error('This browser could not create an image this large. Try SVG, or draw fewer classes.');
  } finally {
    URL.revokeObjectURL(url);
  }
}
