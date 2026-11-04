/**
 * Prepares a diagram's SVG for export so it looks the same in any viewer, whether or not that
 * viewer has the font. SVG files name fonts but don't carry them, and renderers such as librsvg
 * ignore both embedded fonts and textLength, so text is drawn as outlines of Inter's glyphs.
 *
 * - Each glyph is defined once and reused, placed where the browser laid that character out
 *   (so kerning is kept) at its natural shape.
 * - The real text stays in the file, transparent, so it can still be searched, selected and
 *   read by assistive technology.
 * - Characters Inter doesn't have (CJK, Arabic, emoji, combining sequences) are drawn as text,
 *   each stretch fixed to its on-screen length (honoured by browsers and Inkscape); everything
 *   else in the same label is still outlined.
 *
 * The diagram turns off contextual alternates and ligatures, so what's on screen is exactly
 * one glyph per character, as drawn here.
 */
import type { Font, Glyph } from 'opentype.js';

import latin400 from '@fontsource/inter/files/inter-latin-400-normal.woff?url';
import latin600 from '@fontsource/inter/files/inter-latin-600-normal.woff?url';
import latin400i from '@fontsource/inter/files/inter-latin-400-italic.woff?url';
import latinExt400 from '@fontsource/inter/files/inter-latin-ext-400-normal.woff?url';
import latinExt600 from '@fontsource/inter/files/inter-latin-ext-600-normal.woff?url';
import latinExt400i from '@fontsource/inter/files/inter-latin-ext-400-italic.woff?url';
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

type Face = '400' | '600' | '400i';
// The font files are only fetched when someone exports.
const FILES: Record<Face, string[]> = {
  '400': [latin400, latinExt400, greek400, greekExt400, cyrillic400, cyrillicExt400, vietnamese400],
  '600': [latin600, latinExt600, greek600, greekExt600, cyrillic600, cyrillicExt600, vietnamese600],
  '400i': [latin400i, latinExt400i],
};

/** Styles for the live diagram so it draws one glyph per character, as the export does. */
export const OUTLINE_SAFE_TEXT = { fontVariantLigatures: 'none', fontFeatureSettings: '"calt" 0, "liga" 0' } as const;

// Scripts whose letters change shape with their neighbours, which can't be drawn a character
// at a time.
const SHAPED = /[֐-ࣿיִ-﷿ﹰ-﻿ऀ-෿ༀ-࿿က-႟ក-៿]/;

let loading: Promise<Map<Face, Font[]>> | undefined;
export function loadOutlineFonts() {
  loading ??= (async () => {
    const { parse } = await import('opentype.js');
    const out = new Map<Face, Font[]>();
    await Promise.all(
      (Object.keys(FILES) as Face[]).map(async (face) => {
        out.set(face, await Promise.all(FILES[face].map(async (url) => parse(await (await fetch(url)).arrayBuffer()))));
      }),
    );
    return out;
  })();
  loading.catch(() => (loading = undefined));
  return loading;
}

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : undefined;
const graphemes = (s: string) => (segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s));

const SVG = 'http://www.w3.org/2000/svg';
const n2 = (v: number) => Math.round(v * 100) / 100;
const n1 = (v: number) => Math.round(v * 10) / 10;

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

function glyphFor(fonts: Font[], ch: string): { font: number; glyph: Glyph } | undefined {
  if (SHAPED.test(ch)) return undefined;
  const cp = ch.codePointAt(0)!;
  if (ch.length !== String.fromCodePoint(cp).length) return undefined; // more than one code point
  for (let i = 0; i < fonts.length; i++) {
    const g = fonts[i].charToGlyph(ch);
    if (g.index > 0 && g.unicodes?.includes(cp)) return { font: i, glyph: g };
  }
  return undefined;
}

/**
 * A copy of `live` ready to save. Fonts are loaded first; the copy and everything read from the
 * page are then taken together, with nothing in between, so the file is one consistent state.
 */
export async function exportableSvg(live: SVGSVGElement): Promise<SVGSVGElement> {
  const fonts = await loadOutlineFonts();
  const clone = live.cloneNode(true) as SVGSVGElement;
  const defs = document.createElementNS(SVG, 'defs');
  const ids = new Map<string, string>();
  const glyphId = (face: Face, font: number, glyph: Glyph, size: number) => {
    const key = `${face}/${font}/${glyph.index}/${size}`;
    let id = ids.get(key);
    if (!id) {
      id = `g${ids.size.toString(36)}`;
      ids.set(key, id);
      const p = document.createElementNS(SVG, 'path');
      p.setAttribute('id', id);
      p.setAttribute('d', glyph.getPath(0, 0, size).toPathData(2));
      defs.appendChild(p);
    }
    return id;
  };

  const liveTexts = [...live.querySelectorAll('text')];
  const cloneTexts = [...clone.querySelectorAll('text')];
  liveTexts.forEach((lt, ti) => {
    const ct = cloneTexts[ti];
    if (!ct) return;
    const liveRuns = runs(lt);
    const texts = liveRuns.map(addressable);
    if (texts.some((t) => t === undefined)) {
      // Can't match characters to positions: keep the text, fixed to its on-screen length.
      runs(ct).forEach((r, i) => {
        const len = liveRuns[i].getComputedTextLength();
        if (len) (r.setAttribute('textLength', String(n2(len))), r.setAttribute('lengthAdjust', 'spacingAndGlyphs'));
      });
      return;
    }
    const drawn = document.createElementNS(SVG, 'g');
    drawn.setAttribute('aria-hidden', 'true');
    drawn.setAttribute('data-outline', '');
    liveRuns.forEach((run, ri) => {
      const style = getComputedStyle(run);
      const size = parseFloat(style.fontSize) || 12;
      const bold = Number(style.fontWeight) >= 550;
      const italic = style.fontStyle === 'italic' || style.fontStyle.startsWith('oblique');
      const face: Face = italic ? '400i' : bold ? '600' : '400';
      const faceFonts = italic && bold ? [] : (fonts.get(face) ?? []);
      const fill = style.fill;
      const g = document.createElementNS(SVG, 'g');
      g.setAttribute('fill', fill);
      // Characters Inter lacks are collected into stretches and drawn as text.
      let stretch: { text: string; left: number; right: number; y: number } | undefined;
      const flush = () => {
        if (!stretch) return;
        const t = document.createElementNS(SVG, 'text');
        t.setAttribute('x', String(n2(stretch.left)));
        t.setAttribute('y', String(n2(stretch.y - (runY ?? 0))));
        t.setAttribute('font-size', String(size));
        t.setAttribute('font-weight', bold ? '600' : '400');
        if (italic) t.setAttribute('font-style', 'italic');
        t.setAttribute('font-family', style.fontFamily);
        t.setAttribute('textLength', String(n2(stretch.right - stretch.left)));
        t.setAttribute('lengthAdjust', 'spacingAndGlyphs');
        t.textContent = stretch.text;
        g.appendChild(t);
        stretch = undefined;
      };
      // Every glyph of a run shares its baseline, set once on the run's group.
      let runY: number | undefined;
      let i = 0;
      let left = Infinity;
      let right = -Infinity;
      let baseline = 0;
      for (const ch of graphemes(texts[ri]!)) {
        const at = i;
        i += ch.length;
        let box: DOMRect;
        let start: DOMPoint;
        try {
          box = run.getExtentOfChar(at);
          start = run.getStartPositionOfChar(at);
        } catch {
          continue;
        }
        baseline = start.y;
        if (runY === undefined) ((runY = n1(start.y)), g.setAttribute('transform', `translate(0 ${runY})`));
        if (!ch.trim()) {
          if (stretch) ((stretch.text += ch), (stretch.right = Math.max(stretch.right, box.x + box.width)));
          continue;
        }
        left = Math.min(left, box.x);
        right = Math.max(right, box.x + box.width);
        const hit = glyphFor(faceFonts, ch);
        if (hit) {
          flush();
          // The glyph at its natural shape, from the left of where the browser put it.
          const use = document.createElementNS(SVG, 'use');
          use.setAttribute('href', `#${glyphId(face, hit.font, hit.glyph, size)}`);
          use.setAttribute('x', String(n1(box.x)));
          if (Math.abs(start.y - runY) > 0.05) use.setAttribute('y', String(n1(start.y - runY)));
          g.appendChild(use);
        } else if (stretch) {
          stretch.text += ch;
          stretch.left = Math.min(stretch.left, box.x);
          stretch.right = Math.max(stretch.right, box.x + box.width);
        } else stretch = { text: ch, left: box.x, right: box.x + box.width, y: start.y };
      }
      flush();
      const deco = getComputedStyle(lt).textDecorationLine;
      if (deco.includes('line-through') && left < right) {
        const line = document.createElementNS(SVG, 'path');
        const y = n2(baseline - (runY ?? 0) - size * 0.3);
        line.setAttribute('d', `M${n2(left)} ${y}H${n2(right)}`);
        line.setAttribute('stroke', fill);
        g.appendChild(line);
      }
      if (g.childNodes.length) drawn.appendChild(g);
    });
    // The real text stays, invisible, for searching, selecting and assistive technology.
    ct.setAttribute('fill-opacity', '0');
    ct.setAttribute('data-text-layer', '');
    ct.before(drawn);
  });
  if (ids.size) clone.insertBefore(defs, clone.firstChild);
  return clone;
}
