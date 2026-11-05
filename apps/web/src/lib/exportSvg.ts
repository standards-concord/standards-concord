/**
 * Saving a drawn diagram as an SVG or PNG file.
 *
 * The SVG keeps plain text (searchable, selectable, readable by assistive technology) with the
 * diagram's font stack, and embeds every subset of Inter the labels use, taken from the page's
 * own @font-face rules, so a browser draws it as the page does. Text is fitted to its boxes by
 * measuring and wrapping on the page; nothing stretches it. A viewer that ignores embedded fonts
 * substitutes its own and may draw text wider (librsvg and Inkscape do). Characters Inter lacks
 * (CJK, Arabic, emoji) use the viewer's fonts. The PNG is that SVG drawn here once its fonts have
 * loaded, so it looks the same wherever it is opened.
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
  // For each face, a letter of the text that it draws (to check, later, that it has loaded).
  const probes = needed.flatMap((f) => {
    const ranges = parseUnicodeRange(f.range);
    const inFace = points.filter((c) => ranges.some(([a, b]) => c >= a && c <= b));
    // A letter if there is one; otherwise whatever visible character (an accent, say) it draws.
    const p = inFace.find((c) => /[\p{L}\p{N}]/u.test(String.fromCodePoint(c))) ?? inFace.find((c) => /[\p{M}\p{S}\p{P}]/u.test(String.fromCodePoint(c)));
    return p === undefined ? [] : [{ family, weight: f.weight, style: f.style, text: String.fromCodePoint(p) }];
  });
  return { css: rules.join(''), probes };
}

export type Probe = Awaited<ReturnType<typeof embeddedFonts>>['probes'][number];

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
  const { css, probes } = await embeddedFonts(clone.textContent ?? '', fonts).catch((err) => {
    console.warn('Could not embed the diagram font', err);
    return { css: '', probes: [] as Probe[] };
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
  return { svg: new XMLSerializer().serializeToString(clone), clone, probes, width: w + 40, height: h + 40 };
}

const PROBE_CELL = 70;
const PROBE_ROW = 60;

/**
 * The SVG with a strip below the drawing showing one large letter in each embedded face, black
 * on white, in that face alone. An SVG image draws text in a face that hasn't loaded yet as
 * blank, so once every letter has ink, every face the labels use has loaded.
 */
function withProbes(clone: SVGSVGElement, probes: Probe[], width: number, height: number) {
  const perRow = Math.max(1, Math.floor(width / PROBE_CELL));
  const rows = Math.ceil(probes.length / perRow);
  const svg = clone.cloneNode(true) as SVGSVGElement;
  const ns = 'http://www.w3.org/2000/svg';
  const strip = document.createElementNS(ns, 'g');
  const band = document.createElementNS(ns, 'rect');
  Object.entries({ x: -20, y: height - 20, width, height: rows * PROBE_ROW, fill: '#fff' }).forEach(([k, v]) => band.setAttribute(k, String(v)));
  strip.append(band);
  probes.forEach((p, i) => {
    const t = document.createElementNS(ns, 'text');
    const attrs = { x: -20 + 15 + (i % perRow) * PROBE_CELL, y: height - 20 + Math.floor(i / perRow) * PROBE_ROW + 45, fill: '#000', 'font-size': 36, 'font-family': p.family, 'font-weight': p.weight, 'font-style': p.style };
    Object.entries(attrs).forEach(([k, v]) => t.setAttribute(k, String(v)));
    t.textContent = p.text;
    strip.append(t);
  });
  svg.append(strip);
  svg.setAttribute('height', String(height + rows * PROBE_ROW));
  svg.setAttribute('viewBox', `-20 -20 ${width} ${height + rows * PROBE_ROW}`);
  return { markup: new XMLSerializer().serializeToString(svg), perRow, rows };
}

/** Whether every probe letter in the strip has been drawn. */
function probesDrawn(img: HTMLImageElement, count: number, perRow: number, rows: number, width: number, height: number) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = rows * PROBE_ROW;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return true;
  ctx.drawImage(img, 0, height, width, c.height, 0, 0, width, c.height);
  for (let i = 0; i < count; i++) {
    const px = ctx.getImageData((i % perRow) * PROBE_CELL, Math.floor(i / perRow) * PROBE_ROW, PROBE_CELL, PROBE_ROW).data;
    let ink = 0;
    for (let j = 0; j < px.length; j += 4) if (px[j] + px[j + 1] + px[j + 2] < 300) ink++;
    if (ink < 20) return false;
  }
  return true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
 * The same drawing as a PNG, drawn from the SVG. An SVG image loads its embedded fonts some time
 * after it has decoded, drawing their text blank until then, and nothing reports when they
 * arrive, so the image carries a probe letter for each face (see `withProbes`), and the PNG is
 * drawn once they all show. If the browser can't allocate or encode a canvas that large, it
 * tries again at half the scale, a few times, and then throws.
 */
export async function downloadPng(live: SVGSVGElement | null, filename: string, bg: string, fonts: string[] = []) {
  if (!live) return;
  const { clone, probes, width, height } = await exportableSvg(live, bg, fonts);
  const { markup, perRow, rows } = withProbes(clone, probes, width, height);
  const img = new Image();
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
  try {
    img.src = url;
    await img.decode();
    const until = performance.now() + 5000;
    while (!probesDrawn(img, probes.length, perRow, rows, width, height)) {
      if (performance.now() > until) throw new Error("The diagram's fonts didn't load in time. Try again, or save it as SVG.");
      await sleep(30);
    }
    let scale = pngScale(width, height);
    for (let attempt = 0; attempt < 4; attempt++, scale /= 2) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(width * scale));
      canvas.height = Math.max(1, Math.floor(height * scale));
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        // The drawing only, not the probe strip below it.
        ctx.drawImage(img, 0, 0, width, height, 0, 0, canvas.width, canvas.height);
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
