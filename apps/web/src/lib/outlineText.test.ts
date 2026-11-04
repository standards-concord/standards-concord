import { describe, expect, it } from 'vitest';
import { addressable } from './outlineText';

const run = (textContent: string, chars: number) => ({ textContent, getNumberOfChars: () => chars });

describe('addressable', () => {
  it('numbers characters as the SVG DOM does, after white space collapses', () => {
    // A relationship label puts two spaces before its counts; SVG draws (and numbers) one.
    expect(addressable(run('hasPet  1..*', 11))).toBe('hasPet 1..*');
    expect(addressable(run('↑ ', 1))).toBe('↑');
    expect(addressable(run('plain', 5))).toBe('plain');
  });

  it("gives up when the numbering can't be matched", () => {
    expect(addressable(run('abc', 7))).toBeUndefined();
  });
});
