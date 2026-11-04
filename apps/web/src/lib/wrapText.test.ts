import { describe, expect, it } from 'vitest';
import { wrapRows } from './wrapText';

// Seven pixels a character, counting how many characters are measured in total.
function counter() {
  const c = { chars: 0, measure: (t: string) => ((c.chars += t.length), t.length * 7) };
  return c;
}

describe('wrapRows', () => {
  it('wraps at word boundaries', () => {
    const c = counter();
    expect(wrapRows('the quick brown fox jumps', c.measure, 70, 3)).toEqual(['the quick', 'brown fox', 'jumps']);
  });

  it('breaks a word too long for a row', () => {
    const c = counter();
    expect(wrapRows('abcdefghijklmnopqrstuvwxy', c.measure, 70, 3)).toEqual(['abcdefghij', 'klmnopqrst', 'uvwxy']);
  });

  it('ends with an ellipsis that fits when more rows would be needed', () => {
    const c = counter();
    const rows = wrapRows('one two three four five six seven eight', c.measure, 70, 2);
    expect(rows).toEqual(['one two', 'three fou…']);
    for (const r of rows) expect(c.measure(r)).toBeLessThanOrEqual(70);
  });

  it('stops measuring once the shown rows are known, however long the text', () => {
    for (const n of [8_000, 32_000]) {
      const word = counter();
      expect(wrapRows('W'.repeat(n), word.measure, 312, 3)).toHaveLength(3);
      // A few passes over the text at most; wrapping all of it before truncating measured
      // hundreds of times the text's length.
      expect(word.chars).toBeLessThan(8 * n);

      const words = counter();
      expect(wrapRows('word '.repeat(n / 5), words.measure, 312, 3)).toHaveLength(3);
      expect(words.chars).toBeLessThan(2_000);
    }
  });
});
