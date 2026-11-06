import { describe, expect, it } from 'vitest';
import { diffLines, hunks } from './lineDiff';

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
      // Never worse than deleting everything and adding everything.
      expect(d.filter((l) => l.kind !== 'same').length).toBeLessThanOrEqual(a.length + b.length);
    }
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
