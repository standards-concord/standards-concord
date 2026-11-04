import { describe, expect, it } from 'vitest';
import { toCsv } from './csv';

describe('toCsv', () => {
  it('escapes labelled headings as well as cells', () => {
    const out = toCsv(['a', 'b'], [{ a: 'x, y', b: 'say "hi"' }], { a: 'Name, preferred', b: 'line\nbreak' });
    expect(out).toBe('"Name, preferred","line\nbreak"\n"x, y","say ""hi"""');
  });
  it('falls back to variable names and leaves missing values empty', () => {
    expect(toCsv(['a', 'b'], [{ a: '1' }])).toBe('a,b\n1,');
  });
});
