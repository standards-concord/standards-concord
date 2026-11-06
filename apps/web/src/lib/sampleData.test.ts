import { describe, expect, it } from 'vitest';
import { DEMO_DATA, EMPTY_DATA, hasSampleRecords } from './sampleData';

describe('hasSampleRecords', () => {
  it('finds no records in the starting template, blank data or prefixes alone', () => {
    expect(hasSampleRecords(EMPTY_DATA('https://example.org/x#', 'x'))).toBe(false);
    expect(hasSampleRecords('')).toBe(false);
    expect(hasSampleRecords('PREFIX ex: <https://example.org/>\n@base <https://example.org/> .\n  # a note\n')).toBe(false);
  });

  it('finds records in the demo data and in any statement', () => {
    expect(hasSampleRecords(DEMO_DATA('https://w3id.org/odi/volunteering#', 'vol'))).toBe(true);
    expect(hasSampleRecords('@prefix ex: <https://example.org/> .\nex:a a ex:Thing .')).toBe(true);
  });

  // Reading line by line skipped any line that began with a declaration, so a one-line file looked empty.
  it('reads declarations and statements whatever the layout', () => {
    expect(hasSampleRecords('@prefix ex: <https://example.org/> . ex:a a ex:Thing .')).toBe(true);
    expect(hasSampleRecords('@prefix ex: <https://example.org/> . @prefix x: <https://example.org/x#> .')).toBe(false);
    expect(hasSampleRecords('PREFIX ex: <https://example.org/> ex:a a ex:Thing .')).toBe(true);
    expect(hasSampleRecords('PREFIX ex: <https://example.org/>   BASE <https://example.org/>')).toBe(false);
    // Names that start with "prefix" or "base" are statements.
    expect(hasSampleRecords('@prefix prefix: <https://example.org/p#> .\nprefix:a a prefix:Thing .')).toBe(true);
    expect(hasSampleRecords('@prefix base: <https://example.org/b#> .\nbase:a a base:Thing .')).toBe(true);
    // A "#" or "@prefix" inside an IRI or a string doesn't hide the statement around it.
    expect(hasSampleRecords('<https://example.org/a#x> <https://example.org/p> "@prefix # not a comment" .')).toBe(true);
  });

  // Strings used to be removed before comments, so quotes in two comments were read as one long string that
  // swallowed the statement between them.
  it('reads quotes inside comments as part of the comment', () => {
    expect(hasSampleRecords('# """\nex:a a ex:Thing .\n# """')).toBe(true);
    expect(hasSampleRecords("# '''\nex:a a ex:Thing .\n# '''")).toBe(true);
    expect(hasSampleRecords('# an unclosed " quote\nex:a a ex:Thing .\n# and " another')).toBe(true);
    expect(hasSampleRecords('# a "quoted" note\n@prefix ex: <https://example.org/> .\n# \'another\'')).toBe(false);
  });

  it('reads an IRI with a "#" whole, but a link inside a comment as part of the comment', () => {
    // Read as a comment, the "#" would leave "@prefix x: <https://example.org/x" behind, which looks like a statement.
    expect(hasSampleRecords('@prefix x: <https://example.org/x#> .')).toBe(false);
    expect(hasSampleRecords('# see <https://example.org/a#b> for more\n@prefix ex: <https://example.org/> .')).toBe(false);
    expect(hasSampleRecords('# unclosed <https://example.org/a\n@prefix ex: <https://example.org/> .')).toBe(false);
  });

  it('finds statements with long, single-quoted and escaped strings', () => {
    expect(hasSampleRecords('ex:a ex:note """one\n# two\n@prefix x: <https://example.org/y> .""" .')).toBe(true);
    expect(hasSampleRecords("ex:a ex:note 'it\\'s # fine' .")).toBe(true);
    expect(hasSampleRecords('ex:a ex:note "say \\"#\\" twice" .')).toBe(true);
  });
});
