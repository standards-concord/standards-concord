/**
 * A line diff, as on GitHub: Myers' algorithm over lines, grouped into hunks with a few
 * lines of context. Used for the Turtle diff of a change request.
 */

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string; oldNo?: number; newNo?: number };
export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

/** Every line of `a` and `b`, in order, marked as kept, removed or added (a shortest edit script). */
export function diffLines(a: string[], b: string[]): DiffLine[] {
  // Common prefix and suffix first: a change touches a few lines of a long file.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const mid = myers(a.slice(start, endA), b.slice(start, endB));
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  const same = (n: number) => {
    for (let k = 0; k < n; k++, i++, j++) out.push({ kind: 'same', text: a[i], oldNo: i + 1, newNo: j + 1 });
  };
  same(start);
  for (const op of mid) {
    if (op === 'same') same(1);
    else if (op === 'del') out.push({ kind: 'del', text: a[i], oldNo: ++i });
    else out.push({ kind: 'add', text: b[j], newNo: ++j });
  }
  same(a.length - endA);
  return out;
}

/** Myers' O(ND) diff: the edit script turning `a` into `b`. */
function myers(a: string[], b: string[]): ('same' | 'del' | 'add')[] {
  const n = a.length;
  const m = b.length;
  if (!n) return Array<'add'>(m).fill('add');
  if (!m) return Array<'del'>(n).fill('del');
  const max = n + m;
  const offset = max;
  let v: Int32Array = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice());
        break outer;
      }
    }
  }
  // Walk back through the saved frontiers to recover the path.
  const ops: ('same' | 'del' | 'add')[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 2; d >= 0 && (x > 0 || y > 0); d--) {
    v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push('same');
      x--;
      y--;
    }
    if (d === 0) break;
    if (x === prevX) {
      ops.push('add');
      y--;
    } else {
      ops.push('del');
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push('same');
    x--;
    y--;
  }
  return ops.reverse();
}

/** The changed lines with `context` unchanged lines around each, merged where they overlap. */
export function hunks(lines: DiffLine[], context = 3): Hunk[] {
  const changed = lines.map((l, i) => (l.kind === 'same' ? -1 : i)).filter((i) => i >= 0);
  const out: Hunk[] = [];
  let from = -1;
  let to = -1;
  const flush = () => {
    if (from < 0) return;
    const ls = lines.slice(from, to + 1);
    const firstOld = ls.find((l) => l.oldNo !== undefined)?.oldNo;
    const firstNew = ls.find((l) => l.newNo !== undefined)?.newNo;
    // An all-added hunk starts after the old line before it, as in a unified diff.
    const before = lines.slice(0, from).reverse();
    const oldStart = firstOld ?? (before.find((l) => l.oldNo !== undefined)?.oldNo ?? 0);
    const newStart = firstNew ?? (before.find((l) => l.newNo !== undefined)?.newNo ?? 0);
    out.push({ oldStart, newStart, oldLines: ls.filter((l) => l.kind !== 'add').length, newLines: ls.filter((l) => l.kind !== 'del').length, lines: ls });
  };
  for (const i of changed) {
    const lo = Math.max(0, i - context);
    const hi = Math.min(lines.length - 1, i + context);
    if (from >= 0 && lo <= to + 1) to = Math.max(to, hi);
    else {
      flush();
      from = lo;
      to = hi;
    }
  }
  flush();
  return out;
}
