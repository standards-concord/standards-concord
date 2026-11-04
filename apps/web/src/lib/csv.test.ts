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
  it('neutralises spreadsheet formulas in headings and cells, but not plain numbers', () => {
    const out = toCsv(['a', 'b', 'c'], [{ a: '=cmd|"/c calc"!A1', b: '-5', c: '@SUM(1)' }, { a: '+1+1', b: '-x', c: '\tTAB' }], { a: '=HYPERLINK("x")' });
    expect(out.split('\n')).toEqual([`"'=HYPERLINK(""x"")",b,c`, `"'=cmd|""/c calc""!A1",-5,'@SUM(1)`, `'+1+1,'-x,'\tTAB`]);
  });
});
