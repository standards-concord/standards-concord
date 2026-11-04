/**
 * Saving a drawn diagram as an SVG or PNG file.
 *
 * The SVG keeps real text (searchable, selectable, readable by assistive technology) with the
 * diagram's font stack, and embeds Inter (Latin subsets) so browsers draw it exactly as on
 * screen. Each left-to-right run of text is also fixed to its on-screen length, which keeps it
 * inside its box in viewers that ignore embedded fonts but honour textLength (Inkscape does;
 * librsvg honours neither). The PNG is drawn from that same SVG, for output that is pixel-exact
 * anywhere.
 */
import latin400 from '@fontsource/inter/files/inter-latin-400-normal.woff2?url';
import latin600 from '@fontsource/inter/files/inter-latin-600-normal.woff2?url';
import latin400i from '@fontsource/inter/files/inter-latin-400-italic.woff2?url';
import latinExt400 from '@fontsource/inter/files/inter-latin-ext-400-normal.woff2?url';
import latinExt600 from '@fontsource/inter/files/inter-latin-ext-600-normal.woff2?url';
import latinExt400i from '@fontsource/inter/files/inter-latin-ext-400-italic.woff2?url';

// The unicode-range values from @fontsource/inter's CSS.
const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT = 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';

const FACES: { url: string; weight: number; style: string; range: string }[] = [
  { url: latin400, weight: 400, style: 'normal', range: LATIN },
  { url: latin600, weight: 600, style: 'normal', range: LATIN },
  { url: latin400i, weight: 400, style: 'italic', range: LATIN },
  { url: latinExt400, weight: 400, style: 'normal', range: LATIN_EXT },
  { url: latinExt600, weight: 600, style: 'normal', range: LATIN_EXT },
  { url: latinExt400i, weight: 400, style: 'italic', range: LATIN_EXT },
];

const dataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

let fontCss: Promise<string> | undefined;
/** @font-face rules carrying Inter's Latin subsets inline (fetched once, on first export). */
function embeddedFonts() {
  fontCss ??= Promise.all(
    FACES.map(async (f) => {
      const src = await dataUrl(await (await fetch(f.url)).blob());
      return `@font-face{font-family:Inter;font-weight:${f.weight};font-style:${f.style};unicode-range:${f.range};src:url(${src.replace(/^data:[^;,]*/, 'data:font/woff2')}) format('woff2')}`;
    }),
  ).then((rules) => rules.join(''));
  fontCss.catch(() => (fontCss = undefined));
  return fontCss;
}

/** Letters of right-to-left scripts (Hebrew, Arabic, Syriac, Thaana, N'Ko and others). */
const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;

const frame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));

/** The runs of text in an SVG: each text element's tspans, or the element itself. */
const runs = (root: Element) => [...root.querySelectorAll('text')].flatMap((t) => (t.querySelector('tspan') ? [...t.querySelectorAll('tspan')] : [t])) as SVGTextContentElement[];

/**
 * A standalone copy of a diagram's SVG. It waits for the fonts (and for a diagram laid out again
 * once they load to be drawn), then copies the drawing and reads every length from the page in
 * one go, so the file is a single consistent state.
 */
export async function exportableSvg(live: SVGSVGElement, bg: string, fonts: string[] = []) {
  const css = await embeddedFonts().catch(() => '');
  // Load every face and script subset the labels need (fonts load lazily), let them settle, and
  // give a diagram that lays itself out again once they arrive two frames to draw.
  const text = live.textContent ?? '';
  await Promise.all(fonts.map((f) => document.fonts.load(f, text).catch(() => [])));
  await document.fonts.ready;
  await frame();
  await frame();

  const clone = live.cloneNode(true) as SVGSVGElement;
  const liveRuns = runs(live);
  runs(clone).forEach((el, i) => {
    const len = liveRuns[i]?.getComputedTextLength();
    // Inkscape draws nothing at all for right-to-left text given a textLength, so that is left
    // to the wrapping alone.
    if (len && !RTL.test(el.textContent ?? '')) (el.setAttribute('textLength', len.toFixed(2)), el.setAttribute('lengthAdjust', 'spacingAndGlyphs'));
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
  return { svg: new XMLSerializer().serializeToString(clone), width: w + 40, height: h + 40 };
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

/** Canvases much larger than this fail in some browsers. */
const MAX_SIDE = 16000;

/** The same drawing as a PNG, at twice its size where that fits, for pixel-exact output. */
export async function downloadPng(live: SVGSVGElement | null, filename: string, bg: string, fonts: string[] = []) {
  if (!live) return;
  const { svg, width, height } = await exportableSvg(live, bg, fonts);
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    img.src = url;
    await img.decode();
    const scale = Math.min(2, MAX_SIDE / width, MAX_SIDE / height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    if (png) save(png, filename);
  } finally {
    URL.revokeObjectURL(url);
  }
}
