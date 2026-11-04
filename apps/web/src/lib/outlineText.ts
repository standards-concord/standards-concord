/**
 * Turns the text of an exported SVG into outlines, so the file looks the same in any viewer,
 * whether or not it has the font (SVG files name fonts but don't carry them, and viewers such
 * as Inkscape and librsvg ignore textLength on tspans). Each character is drawn where the
 * browser laid it out, at the width it has on screen, using Inter's own glyphs.
 *
 * Characters Inter doesn't have (CJK, emoji, combining sequences) stay as text, one element per
 * character at its on-screen position and width, so a substitute font can only misplace a
 * single character rather than a whole line.
 */
import type { Font } from 'opentype.js';

import latin400 from '@fontsource/inter/files/inter-latin-400-normal.woff?url';
import latin600 from '@fontsource/inter/files/inter-latin-600-normal.woff?url';
import latinExt400 from '@fontsource/inter/files/inter-latin-ext-400-normal.woff?url';
import latinExt600 from '@fontsource/inter/files/inter-latin-ext-600-normal.woff?url';
import greek400 from '@fontsource/inter/files/inter-greek-400-normal.woff?url';
import greek600 from '@fontsource/inter/files/inter-greek-600-normal.woff?url';
import greekExt400 from '@fontsource/inter/files/inter-greek-ext-400-normal.woff?url';
import greekExt600 from '@fontsource/inter/files/inter-greek-ext-600-normal.woff?url';
import cyrillic400 from '@fontsource/inter/files/inter-cyrillic-400-normal.woff?url';
import cyrillic600 from '@fontsource/inter/files/inter-cyrillic-600-normal.woff?url';
import cyrillicExt400 from '@fontsource/inter/files/inter-cyrillic-ext-400-normal.woff?url';
import cyrillicExt600 from '@fontsource/inter/files/inter-cyrillic-ext-600-normal.woff?url';
import vietnamese400 from '@fontsource/inter/files/inter-vietnamese-400-normal.woff?url';
import vietnamese600 from '@fontsource/inter/files/inter-vietnamese-600-normal.woff?url';

// The font files are only fetched when someone exports.
const FILES = {
  400: [latin400, latinExt400, greek400, greekExt400, cyrillic400, cyrillicExt400, vietnamese400],
  600: [latin600, latinExt600, greek600, greekExt600, cyrillic600, cyrillicExt600, vietnamese600],
};
const WEIGHTS = [400, 600] as const;
type Weight = (typeof WEIGHTS)[number];
// Scripts whose letters change shape with their neighbours can't be drawn a character at a
// time, so text in them is left as it is.
const SHAPED = /[\u0600-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u0900-\u0DFF\u0F00-\u0FFF\u1000-\u109F\u1780-\u17FF]/;

let loading: Promise<Map<Weight, Font[]>> | undefined;
function loadFonts() {
  loading ??= (async () => {
    const { parse } = await import('opentype.js');
    const out = new Map<Weight, Font[]>();
    for (const w of WEIGHTS) {
      out.set(w, await Promise.all(FILES[w].map(async (url) => parse(await (await fetch(url)).arrayBuffer()))));
    }
    return out;
  })();
  loading.catch(() => (loading = undefined));
  return loading;
}

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : undefined;
const graphemes = (s: string) => (segmenter ? [...segmenter.segment(s)].map((x) => x.segment) : Array.from(s));

const SVG = 'http://www.w3.org/2000/svg';
const n2 = (v: number) => Math.round(v * 100) / 100;

/** The runs of one text element: its tspans, or the element itself if it has none. */
function runs(t: SVGTextElement) {
  const spans = [...t.querySelectorAll('tspan')];
  return (spans.length ? spans : [t]) as SVGTextContentElement[];
}

/**
 * The characters of a run as the SVG DOM numbers them, which is after white space collapsing
 * (two spaces count as one), or undefined if that can't be matched up.
 */
export function addressable(run: Pick<SVGTextContentElement, 'textContent' | 'getNumberOfChars'>) {
  const collapsed = (run.textContent ?? '')
    .replace(/[\n\r]/g, '')
    .replace(/\t/g, ' ')
    .replace(/ {2,}/g, ' ');
  const n = run.getNumberOfChars();
  return [collapsed, collapsed.trimStart(), collapsed.trimEnd(), collapsed.trim()].find((t) => t.length === n);
}

function glyphFor(fonts: Font[], ch: string) {
  const cp = ch.codePointAt(0)!;
  if (ch.length !== String.fromCodePoint(cp).length) return undefined; // more than one code point
  for (const f of fonts) {
    const g = f.charToGlyph(ch);
    if (g.index > 0 && g.unicodes?.includes(cp)) return { font: f, glyph: g };
  }
  return undefined;
}

/**
 * Replaces every `<text>` in `clone` (a copy of `live`, with the same text elements in the same
 * order) with outlines, keeping the full text as the group's accessible name. Text in scripts
 * that need shaping is left as text, with each run fixed to its on-screen length.
 */
export async function outlineText(live: SVGSVGElement, clone: SVGSVGElement) {
  const fonts = await loadFonts();
  const liveTexts = [...live.querySelectorAll('text')];
  const cloneTexts = [...clone.querySelectorAll('text')];
  liveTexts.forEach((lt, ti) => {
    const ct = cloneTexts[ti];
    if (!ct) return;
    if (SHAPED.test(lt.textContent ?? '') || runs(lt).some((r) => addressable(r) === undefined)) {
      const cr = runs(ct);
      runs(lt).forEach((r, i) => {
        const len = r.getComputedTextLength();
        if (len && cr[i]) (cr[i].setAttribute('textLength', String(n2(len))), cr[i].setAttribute('lengthAdjust', 'spacingAndGlyphs'));
      });
      return;
    }
    const g = document.createElementNS(SVG, 'g');
    const label = [...lt.childNodes]
      .filter((n) => n.nodeName !== 'title')
      .map((n) => n.textContent)
      .join('');
    g.setAttribute('aria-label', label);
    const title = ct.querySelector('title');
    if (title) g.appendChild(title);
    for (const run of runs(lt)) {
      const style = getComputedStyle(run);
      const size = parseFloat(style.fontSize) || 12;
      const weight: Weight = Number(style.fontWeight) >= 550 ? 600 : 400;
      const fill = style.fill;
      const text = addressable(run)!;
      let d = '';
      let i = 0;
      let left = Infinity;
      let right = -Infinity;
      let baseline = 0;
      for (const ch of graphemes(text)) {
        const at = i;
        i += ch.length;
        if (!ch.trim()) continue;
        let box: DOMRect;
        let start: DOMPoint;
        try {
          box = run.getExtentOfChar(at);
          start = run.getStartPositionOfChar(at);
        } catch {
          continue;
        }
        left = Math.min(left, box.x);
        right = Math.max(right, box.x + box.width);
        baseline = start.y;
        const hit = glyphFor(fonts.get(weight) ?? [], ch);
        if (hit) {
          // Draw the glyph from the left of its on-screen box, stretched to that box's width.
          const advance = ((hit.glyph.advanceWidth ?? hit.font.unitsPerEm) * size) / hit.font.unitsPerEm;
          const sx = advance > 0 ? box.width / advance : 1;
          const path = hit.glyph.getPath(0, 0, size);
          for (const c of path.commands) {
            const X = (x: number) => n2(box.x + x * sx);
            const Y = (y: number) => n2(start.y + y);
            if (c.type === 'M' || c.type === 'L') d += `${c.type}${X(c.x)} ${Y(c.y)}`;
            else if (c.type === 'Q') d += `Q${X(c.x1)} ${Y(c.y1)} ${X(c.x)} ${Y(c.y)}`;
            else if (c.type === 'C') d += `C${X(c.x1)} ${Y(c.y1)} ${X(c.x2)} ${Y(c.y2)} ${X(c.x)} ${Y(c.y)}`;
            else if (c.type === 'Z') d += 'Z';
          }
        } else {
          // No outline: the character as text, fixed to its on-screen width.
          const t = document.createElementNS(SVG, 'text');
          t.setAttribute('x', String(n2(box.x)));
          t.setAttribute('y', String(n2(start.y)));
          t.setAttribute('font-size', String(size));
          t.setAttribute('font-weight', String(weight));
          t.setAttribute('font-family', style.fontFamily);
          t.setAttribute('fill', fill);
          t.setAttribute('textLength', String(n2(box.width)));
          t.setAttribute('lengthAdjust', 'spacingAndGlyphs');
          t.setAttribute('aria-hidden', 'true');
          t.textContent = ch;
          g.appendChild(t);
        }
      }
      if (d) {
        const p = document.createElementNS(SVG, 'path');
        p.setAttribute('d', d);
        p.setAttribute('fill', fill);
        g.appendChild(p);
      }
      const deco = getComputedStyle(lt).textDecorationLine;
      if (deco.includes('line-through') && left < right) {
        const line = document.createElementNS(SVG, 'path');
        const y = n2(baseline - size * 0.3);
        line.setAttribute('d', `M${n2(left)} ${y}H${n2(right)}`);
        line.setAttribute('stroke', fill);
        line.setAttribute('stroke-width', '1');
        g.appendChild(line);
      }
    }
    ct.replaceWith(g);
  });
}
