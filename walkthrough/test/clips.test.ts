import { describe, expect, it } from 'vitest';
import { isTheTurtleReport } from '../clips.ts';

/** The validate clip's Turtle download must be the sample's SHACL report, parsed, not just text that looks like one. */
const report = (body: string) => `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix vol: <https://w3id.org/odi/volunteering#> .
@prefix ex: <https://example.org/data/> .
${body}`;
const good = report(`[] a sh:ValidationReport ; sh:conforms false ; sh:result [
  a sh:ValidationResult ; sh:resultSeverity sh:Violation ; sh:focusNode ex:saturday-shift ; sh:resultPath vol:minimumAge ] .`);

describe('the validate clip’s Turtle report check', () => {
  it('accepts the sample’s report', () => {
    expect(isTheTurtleReport(good)).toBe(true);
  });

  it('refuses malformed Turtle, even with the right words in it', () => {
    expect(isTheTurtleReport(`${good} this is not turtle sh:ValidationReport sh:conforms false minimumAge`)).toBe(false);
    expect(isTheTurtleReport(undefined)).toBe(false);
  });

  it('refuses a report whose minimum-age result isn’t linked to it, or isn’t a violation', () => {
    // The words are all there, but the result hangs off nothing.
    expect(isTheTurtleReport(report(`[] a sh:ValidationReport ; sh:conforms false .
[] a sh:ValidationResult ; sh:resultSeverity sh:Violation ; sh:focusNode ex:saturday-shift ; sh:resultPath vol:minimumAge .`))).toBe(false);
    expect(isTheTurtleReport(good.replace('sh:Violation', 'sh:Warning'))).toBe(false);
    expect(isTheTurtleReport(good.replace('vol:minimumAge', 'vol:title'))).toBe(false);
    expect(isTheTurtleReport(good.replace('conforms false', 'conforms true'))).toBe(false);
  });
});
