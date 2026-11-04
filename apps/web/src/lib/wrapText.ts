/**
 * Greedy word wrap to `max` pixels (as given by `measure`), breaking words too long for a
 * line, and ending with an ellipsis if more than `maxRows` rows would be needed (the full text
 * stays in the title and accessible name). Work stops once the shown rows are known, so a huge
 * label costs no more than a few rows' worth of measuring.
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
    while (cur.length > 1 && !fits(cur)) {
      // The longest prefix that fits: gallop out from one character until a prefix doesn't fit,
      // then binary search, so the work depends on how much fits rather than the word's length
      // (and zero-width characters can't cut a row short).
      let lo = 1;
      let hi = 2;
      while (hi < cur.length && fits(cur.slice(0, hi))) (lo = hi), (hi *= 2);
      hi = Math.min(hi, cur.length) - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fits(cur.slice(0, mid))) lo = mid;
        else hi = mid - 1;
      }
      if (addRow(cur.slice(0, lo))) break words;
      cur = cur.slice(lo);
    }
  }
  if (!more && cur) addRow(cur);
  if (!more) return rows;
  let last = rows[maxRows - 1];
  while (last.length > 0 && !fits(`${last}…`)) last = last.slice(0, -1);
  rows[maxRows - 1] = `${last.trimEnd()}…`;
  return rows;
}
