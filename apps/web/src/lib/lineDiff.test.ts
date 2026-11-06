import { describe, expect, it } from 'vitest';
import { diffLines, hunks, splitLines } from './lineDiff';

const apply = (a: string[], d: ReturnType<typeof diffLines>) => {
  // Rebuilding both sides from the script proves it is a valid edit of a into b.
  const old = d.filter((l) => l.kind !== 'add').map((l) => l.text);
  const neu = d.filter((l) => l.kind !== 'del').map((l) => l.text);
  return { old, neu, same: old.join('\n') === a.join('\n') };
};

describe('diffLines', () => {
  it('marks an added line, keeping the rest', () => {
    const a = ['a', 'b', 'c'];
    const b = ['a', 'b', 'x', 'c'];
    const d = diffLines(a, b);
    expect(d.map((l) => l.kind)).toEqual(['same', 'same', 'add', 'same']);
    expect(d[2]).toMatchObject({ text: 'x', newNo: 3 });
    expect(d[3]).toMatchObject({ oldNo: 3, newNo: 4 });
  });

  it('marks a changed line as one removal and one addition', () => {
    const d = diffLines(['a', 'b', 'c'], ['a', 'B', 'c']);
    expect(d.map((l) => `${l.kind}:${l.text}`)).toEqual(['same:a', 'del:b', 'add:B', 'same:c']);
  });

  it('handles empty sides', () => {
    expect(diffLines([], ['a']).map((l) => l.kind)).toEqual(['add']);
    expect(diffLines(['a'], []).map((l) => l.kind)).toEqual(['del']);
    expect(diffLines([], [])).toEqual([]);
  });

  it('always produces a valid, shortest-looking edit on random input', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 5).toString();
    for (let t = 0; t < 200; t++) {
      const a = Array.from({ length: (t % 13) + 1 }, rnd);
      const b = Array.from({ length: ((t * 7) % 11) + 1 }, rnd);
      const d = diffLines(a, b);
      const r = apply(a, d);
      expect(r.old).toEqual(a);
      expect(r.neu).toEqual(b);
      // Shortest: as many kept lines as the longest common subsequence.
      expect(d.filter((l) => l.kind === 'same').length).toBe(lcs(a, b));
    }
  });

  // Two big unrelated files used to keep a copy of the whole frontier per edit step (gigabytes for
  // 10,000 lines each side). Past the budget it now gives up on the shortest diff and replaces the lot.
  it('falls back to remove-all, add-all past its memory budget, and is still a valid diff', () => {
    const a = Array.from({ length: 10_000 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 10_000 }, (_, i) => `b${i}`);
    const d = diffLines(['head', ...a, 'tail'], ['head', ...b, 'tail']);
    const r = apply(['head', ...a, 'tail'], d);
    expect(r.old).toEqual(['head', ...a, 'tail']);
    expect(r.neu).toEqual(['head', ...b, 'tail']);
    expect(d.map((l) => l.kind).join('')).toBe(`same${'del'.repeat(10_000)}${'add'.repeat(10_000)}same`);
    // A small budget forces the fallback even on a tiny diff.
    expect(diffLines(['x', 'y'], ['y', 'z'], 1).map((l) => l.kind)).toEqual(['del', 'del', 'add', 'add']);
  });
});

function lcs(a: string[], b: string[]) {
  const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) t[i][j] = a[i - 1] === b[j - 1] ? t[i - 1][j - 1] + 1 : Math.max(t[i - 1][j], t[i][j - 1]);
  return t[a.length][b.length];
}

// "a\n".split('\n') is ['a', ''], which showed a phantom unchanged empty last line and two-line hunks for one-line files.
describe('splitLines', () => {
  it("doesn't count the final line break as a line", () => {
    expect(splitLines('a\n')).toEqual({ lines: ['a'], finalNewline: true });
    expect(splitLines('a')).toEqual({ lines: ['a'], finalNewline: false });
    expect(splitLines('')).toEqual({ lines: [], finalNewline: false });
    expect(splitLines('\n')).toEqual({ lines: [''], finalNewline: true });
    expect(splitLines('a\n\nb\n')).toEqual({ lines: ['a', '', 'b'], finalNewline: true });
  });

  it('gives a one-line hunk for a one-line file that changes', () => {
    const hs = hunks(diffLines(splitLines('a\n').lines, splitLines('b\n').lines));
    expect(hs).toHaveLength(1);
    expect(hs[0]).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 });
  });
});

describe('hunks', () => {
  it('keeps three lines of context and merges nearby changes', () => {
    const a = Array.from({ length: 30 }, (_, i) => `l${i + 1}`);
    const b = [...a];
    b[4] = 'changed5';
    b[8] = 'changed9';
    b.splice(25, 0, 'new');
    const hs = hunks(diffLines(a, b));
    expect(hs).toHaveLength(2);
    expect(hs[0]).toMatchObject({ oldStart: 2, newStart: 2, oldLines: 11, newLines: 11 });
    expect(hs[1]).toMatchObject({ oldStart: 23, newStart: 23, oldLines: 6, newLines: 7 });
  });

  it('has no hunks when nothing changed', () => {
    expect(hunks(diffLines(['a'], ['a']))).toEqual([]);
  });
});
