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
});
