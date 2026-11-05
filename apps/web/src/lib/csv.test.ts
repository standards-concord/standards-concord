import { describe, expect, it } from 'vitest';
import { toCsv } from './csv';

describe('toCsv', () => {
  it('escapes labelled headings as well as cells', () => {
    const out = toCsv(['a', 'b'], [['x, y', 'say "hi"']], ['Name, preferred', 'line\nbreak']);
    expect(out).toBe('"Name, preferred","line\nbreak"\n"x, y","say ""hi"""');
  });
  it('falls back to variable names and leaves missing values empty', () => {
    expect(toCsv(['a', 'b'], [['1', null]])).toBe('a,b\n1,');
    // A variable named like a JavaScript built-in is just a name.
    expect(toCsv(['__proto__', 'constructor'], [['ok', null]], [undefined, undefined])).toBe('__proto__,constructor\nok,');
  });
  it('neutralises spreadsheet formulas in headings and cells, but not plain numbers', () => {
    const out = toCsv(['a', 'b', 'c'], [['=cmd|"/c calc"!A1', '-5', '@SUM(1)'], ['+1+1', '-x', '\tTAB']], ['=HYPERLINK("x")']);
    expect(out.split('\n')).toEqual([`"'=HYPERLINK(""x"")",b,c`, `"'=cmd|""/c calc""!A1",-5,'@SUM(1)`, `'+1+1,'-x,'\tTAB`]);
    // Leading spaces don't get past the guard (importers can trim them), and spaced numbers stay numbers.
    expect(toCsv([' =1+1', 'n'], [['  @x', ' -5']])).toBe(`' =1+1,n\n'  @x, -5`);
    // Nor do a BOM, non-breaking or zero-width spaces.
    for (const lead of ['\uFEFF', '\u00A0', '\u2003', '\u200B', '\u2060']) expect(toCsv(['col'], [], [`${lead}=3+3`])).toBe(`'${lead}=3+3`);
  });
});
