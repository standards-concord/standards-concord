const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : undefined;

/** User-perceived characters: an emoji family or a flag is one, however many code points it has. */
export const graphemes = (s: string) => (segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s));

/**
 * The largest k in [lo, hi] for which `ok(k)` holds, given that it holds for `lo`. Gallops out
 * from `lo` and then bisects, so the cost depends on the answer rather than on `hi`.
 */
function largest(lo: number, hi: number, ok: (k: number) => boolean) {
  let step = 1;
  while (lo + step <= hi && ok(lo + step)) ((lo += step), (step *= 2));
  hi = Math.min(hi, lo + step - 1);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ok(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Greedy word wrap to `max` pixels (as given by `measure`), breaking words too long for a line
 * between graphemes, and ending with an ellipsis if more than `maxRows` rows would be needed
 * (the full text stays in the title and accessible name). Work stops once the shown rows are
 * known, and every search is a gallop then bisection, so a huge label costs a few rows' worth
 * of measuring.
 */
export function wrapRows(text: string, measure: (t: string) => number, max: number, maxRows: number): string[] {
  const fits = (t: string) => measure(t) <= max;
  const rows: string[] = [];
  let cur = '';
  // Set once the text needs more rows than are shown; nothing after that is measured.
  let more = false;
  const addRow = (row: string) => {
    if (rows.length === maxRows) more = true;
    else rows.push(row);
    return more;
  };
  words: for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${word}` : word;
    if (fits(next)) {
      cur = next;
      continue;
    }
    if (cur && addRow(cur)) break;
    cur = word;
    if (fits(word)) continue;
    // Too long for a row on its own: break it between graphemes, as much on each row as fits
    // (at least one grapheme, so it always moves on).
    const g = graphemes(word);
    let at = 0;
    while (g.length - at > 1) {
      const take = largest(1, g.length - at - 1, (k) => fits(g.slice(at, at + k).join('')));
      if (addRow(g.slice(at, at + take).join(''))) break words;
      at += take;
      cur = g.slice(at).join('');
      if (fits(cur)) break;
    }
  }
  if (!more && cur) addRow(cur);
  if (!more) return rows;
  // As much of the last row as fits with an ellipsis.
  const g = graphemes(rows[maxRows - 1]);
  const ellipsed = (k: number) => `${g.slice(0, k).join('').trimEnd()}…`;
  rows[maxRows - 1] = ellipsed(largest(0, g.length, (k) => fits(ellipsed(k))));
  return rows;
}
