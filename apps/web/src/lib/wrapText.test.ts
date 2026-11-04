import { describe, expect, it } from 'vitest';
import { graphemes, wrapRows } from './wrapText';

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

  it('handles zero-width characters without blank rows or an early ellipsis', () => {
    const zw = '\u200b'.repeat(700);
    const measure = (t: string) => t.replace(/\u200b/g, '').length * 7;
    const rows = wrapRows(`A${zw}${'B'.repeat(45)}`, measure, 312, 3);
    expect(rows).toEqual([`A${zw}${'B'.repeat(43)}`, 'BB']);
  });

  it('never splits an emoji family or a flag', () => {
    // Whole emoji are 14 px, 'i' 7 px; a fragment of one (half a flag, part of a family, a lone
    // surrogate) is narrow, which tempted the previous search into splitting them.
    const measure = (t: string) => graphemes(t).reduce((w, g) => w + (g === 'i' ? 7 : ['👨‍👩‍👧‍👦', '🇨🇳', '🚀', '…'].includes(g) ? 14 : 2), 0);
    for (const unit of ['👨‍👩‍👧‍👦', '🇨🇳', '🚀']) {
      const rows = wrapRows(`ii${unit.repeat(80)}`, measure, 312, 3);
      expect(rows).toHaveLength(3);
      for (const row of rows) for (const g of graphemes(row)) expect(['i', unit, '…']).toContain(g);
    }
  });

  it('finds the ellipsis without remeasuring a long last row character by character', () => {
    const zw = (n: number) => {
      let chars = 0;
      const measure = (t: string) => ((chars += t.length), t.replace(/\u200b/g, '').length * 7);
      // The third row is 44 Ws and then the zero-width run, with no room left for the ellipsis.
      wrapRows('W'.repeat(132) + '\u200b'.repeat(n) + 'W'.repeat(10), measure, 312, 3);
      return chars;
    };
    // Doubling the hidden zero-width run should roughly double the work, not quadruple it.
    expect(zw(16_000) / zw(8_000)).toBeLessThan(2.6);
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
