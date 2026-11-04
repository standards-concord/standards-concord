/**
 * Saving a drawn diagram as an SVG or PNG file.
 *
 * The SVG keeps plain text (searchable, selectable, readable by assistive technology) with the
 * diagram's font stack, and embeds every subset of Inter the labels use, taken from the page's
 * own @font-face rules, so a browser draws it as the page does. Text is fitted to its boxes by
 * measuring and wrapping on the page; nothing stretches it. A viewer that ignores embedded fonts
 * substitutes its own and may draw text wider (librsvg and Inkscape do). Characters Inter lacks
 * (CJK, Arabic, emoji) use the viewer's fonts. The PNG is rasterised here from the same SVG, once
 * its fonts have loaded, so it looks the same wherever it is opened.
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
  const text = textAreas(live);
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
  return { svg: new XMLSerializer().serializeToString(clone), width: w + 40, height: h + 40, text };
}

/** Where each run of text is drawn, in the exported file's coordinates (with its margin). */
function textAreas(live: SVGSVGElement) {
  const vp = live.querySelector<SVGGElement>('[data-viewport]');
  const m = vp?.getScreenCTM()?.inverse();
  if (!m) return [];
  return [...live.querySelectorAll('text')]
    .flatMap((t) => (t.querySelector('tspan') ? [...t.querySelectorAll('tspan')] : [t]))
    .filter((t) => t.textContent?.trim())
    .map((t) => {
      const r = t.getBoundingClientRect();
      const a = new DOMPoint(r.left, r.top).matrixTransform(m);
      const b = new DOMPoint(r.right, r.bottom).matrixTransform(m);
      return { x: a.x + 20, y: a.y + 20, w: b.x - a.x, h: b.y - a.y, ascii: /^[\x20-\x7e]*$/.test(t.textContent ?? '') };
    })
    .filter((a) => a.w > 1 && a.h > 1);
}

type Area = ReturnType<typeof textAreas>[number];

/** Whether a sample of the text areas has ink in them (anything unlike its first pixel). */
function drawn(ctx: CanvasRenderingContext2D, areas: Area[], k: number) {
  // Labels in other scripts first (their fonts load separately), then an even spread of the rest.
  const other = areas.filter((a) => !a.ascii).slice(0, 32);
  const ascii = areas.filter((a) => a.ascii);
  const sample = [...other, ...ascii.filter((_, i) => i % Math.ceil(ascii.length / (48 - other.length)) === 0)];
  return sample.every((a) => {
    const px = ctx.getImageData(Math.floor(a.x * k), Math.floor(a.y * k), Math.max(1, Math.ceil(a.w * k)), Math.max(1, Math.ceil(a.h * k))).data;
    for (let i = 4; i < px.length; i += 4) if (Math.abs(px[i] - px[0]) + Math.abs(px[i + 1] - px[1]) + Math.abs(px[i + 2] - px[2]) > 150) return true;
    return false;
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Draws the SVG image once its text is drawn. An SVG image loads its embedded fonts after it
 * has decoded, drawing text blank until then, and nothing reports when they arrive, so this
 * draws, checks the text areas for ink, and draws again until they have it.
 */
async function drawWhenReady(ctx: CanvasRenderingContext2D, img: HTMLImageElement, bg: string, k: number, areas: Area[], timeout = 5000) {
  const until = performance.now() + timeout;
  for (;;) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.drawImage(img, 0, 0, ctx.canvas.width, ctx.canvas.height);
    if (drawn(ctx, areas, k)) return;
    if (performance.now() > until) throw new Error("The diagram's fonts didn't load in time. Try again.");
    await sleep(50);
  }
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
 * The same drawing as a PNG, drawn once its fonts have loaded. If the browser can't allocate or
 * encode a canvas that large, it tries again at half the scale, a few times, and then throws.
 */
export async function downloadPng(live: SVGSVGElement | null, filename: string, bg: string, fonts: string[] = []) {
  if (!live) return;
  const { svg, width, height, text } = await exportableSvg(live, bg, fonts);
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    img.src = url;
    await img.decode();
    let scale = pngScale(width, height);
    for (let attempt = 0; attempt < 4; attempt++, scale /= 2) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(width * scale));
      canvas.height = Math.max(1, Math.floor(height * scale));
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        await drawWhenReady(ctx, img, bg, canvas.width / width, text);
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
