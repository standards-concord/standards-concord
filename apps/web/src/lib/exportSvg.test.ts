import { describe, expect, it } from 'vitest';
import { facesOf, parseUnicodeRange, pngScale, PNG_MAX_PIXELS, PNG_MAX_SIDE } from './exportSvg';

describe('parseUnicodeRange', () => {
  it('reads single code points, ranges and wildcards', () => {
    expect(parseUnicodeRange('U+0000-00FF, U+0131,u+04??')).toEqual([
      [0, 0xff],
      [0x131, 0x131],
      [0x400, 0x4ff],
    ]);
  });
});

describe('facesOf', () => {
  it('finds the weight and style of each font shorthand', () => {
    expect([...facesOf(['600 13px Inter, sans-serif', '12px Inter', 'italic 12px Inter'])]).toEqual(['600|normal', '400|normal', '400|italic']);
  });
});

describe('pngScale', () => {
  it('is twice the size where that fits', () => {
    expect(pngScale(800, 600)).toBe(2);
  });
  it('keeps a very wide drawing within the side limit', () => {
    const k = pngScale(20_000, 100);
    expect(20_000 * k).toBeLessThanOrEqual(PNG_MAX_SIDE);
  });
  it('keeps a large square drawing within the pixel budget (not a 16,000 px square canvas)', () => {
    const k = pngScale(8_000, 8_000);
    expect(8_000 * k * 8_000 * k).toBeLessThanOrEqual(PNG_MAX_PIXELS * 1.0001);
    expect(8_000 * k).toBeLessThan(16_000);
  });
});
