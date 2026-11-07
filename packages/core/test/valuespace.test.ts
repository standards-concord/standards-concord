import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { OntologyGraph, toShacl, toShaclc } from '../src/index.js';
import { compare, intersect, xsdToXPathPattern } from '../src/valuespace.js';
import { datatypeDefinitions } from '../src/valuespace.js';

/**
 * Several datatypes on one property, checked by an independent SHACL engine
 * (sparq's), against what OWL allows: the values in every datatype's value
 * space, whatever datatype IRI a literal is written with.
 */

const require = createRequire(import.meta.url);
const { Store: Sparq } = require('@sparq-org/sparq/wasm-node') as { Store: new () => { validate(data: string, shapes: string, format: string): string } };
const engine = new Sparq();

const PREFIXES = `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix e: <https://example.org/e#> .
`;

/** An ontology where every e:C's e:p values must be in each of `fillers`, plus any extra Turtle. */
async function shapesFor(fillers: string[], extra = '') {
  const restrictions = fillers.map((f) => `[ a owl:Restriction ; owl:onProperty e:p ; owl:allValuesFrom ${f} ]`).join(' , ');
  const g = await OntologyGraph.fromTurtle(`${PREFIXES}<https://example.org/e> a owl:Ontology .
e:C a owl:Class ; rdfs:subClassOf ${restrictions} .
e:p a owl:DatatypeProperty .
e:Thing a owl:Class .
${extra}`);
  // SHACLC is checked against the Turtle shapes as it is written: this throws if it couldn't say the same.
  await toShaclc(g);
  return toShacl(g);
}

/** Whether an e:C with these e:p values conforms. */
function conforms(shapes: string, ...values: string[]): boolean {
  const data = `${PREFIXES}<https://example.org/x> a e:C${values.length ? ` ; e:p ${values.join(' , ')}` : ''} .`;
  return (JSON.parse(engine.validate(data, shapes, 'turtle')) as { conforms: boolean }).conforms;
}

function expectValues(shapes: string, allowed: string[], rejected: string[]) {
  expect(conforms(shapes), 'no value').toBe(true);
  for (const v of allowed) expect(conforms(shapes, v), v).toBe(true);
  for (const v of rejected) expect(conforms(shapes, v), v).toBe(false);
}

describe('several datatypes on one property, checked by value', () => {
  it('allows only 0 for non-negative and non-positive integers, however 0 is written', async () => {
    const shapes = await shapesFor(['xsd:nonNegativeInteger', 'xsd:nonPositiveInteger']);
    expectValues(
      shapes,
      ['"0"^^xsd:nonNegativeInteger', '"0"^^xsd:nonPositiveInteger', '"0"^^xsd:integer', '"-0"^^xsd:integer', '"0.0"^^xsd:decimal', '"0"^^xsd:byte', '"+00"^^xsd:unsignedByte'],
      ['"1"^^xsd:nonNegativeInteger', '"-1"^^xsd:integer', '"0.5"^^xsd:decimal', '"0"^^xsd:double', '"0"^^xsd:float', '"0"', '<https://example.org/zero>'],
    );
    expect(shapes).not.toMatch(/# Note:/);
  });

  it('keeps every bound when a third type is added', async () => {
    const shapes = await shapesFor(['xsd:nonNegativeInteger', 'xsd:nonPositiveInteger', 'xsd:byte']);
    expectValues(shapes, ['"0"^^xsd:byte', '"0"^^xsd:integer'], ['"1"^^xsd:byte', '"-1"^^xsd:byte']);
  });

  it('works with the range too', async () => {
    const shapes = await shapesFor(['xsd:nonPositiveInteger'], 'e:p rdfs:domain e:C ; rdfs:range xsd:nonNegativeInteger .');
    expectValues(shapes, ['"0"^^xsd:integer'], ['"1"^^xsd:integer', '"-1"^^xsd:integer']);
  });

  it('uses the bounds of the built-in integer types', async () => {
    const shapes = await shapesFor(['xsd:unsignedByte', 'xsd:byte']);
    expectValues(shapes, ['"0"^^xsd:integer', '"127"^^xsd:unsignedByte', '"5"^^xsd:short'], ['"128"^^xsd:unsignedByte', '"-1"^^xsd:byte', '"300"^^xsd:integer']);
  });

  it('lets a datatype property have no values when the datatypes share none', async () => {
    for (const pair of [
      ['xsd:string', 'xsd:anyURI'],
      ['xsd:string', 'xsd:integer'],
      ['xsd:positiveInteger', 'xsd:nonPositiveInteger'],
      ['xsd:decimal', 'xsd:double'],
    ]) {
      const shapes = await shapesFor(pair);
      expectValues(shapes, [], ['"a"', '"https://example.org/"^^xsd:anyURI', '"1"^^xsd:integer', '"0"^^xsd:integer', '"1"^^xsd:double']);
      expect(shapes, pair.join(' ')).toMatch(/^# Note: .*which have no values in common, so it can have none\./m);
    }
  });

  it('lets a property have no values when it must be both a class and a datatype', async () => {
    const shapes = await shapesFor(['xsd:string', 'e:Thing']);
    expectValues(shapes, [], ['"a"', '<https://example.org/thing>']);
  });

  it('expands the facets of the ontology’s own datatypes', async () => {
    // Strings of at least 1 character, and of at most 3: OWL allows "a" to "abc", typed as any string type.
    const shapes = await shapesFor(
      ['e:AtLeastOne', 'e:AtMostThree'],
      `e:AtLeastOne a rdfs:Datatype ; owl:equivalentClass [ a rdfs:Datatype ; owl:onDatatype xsd:string ; owl:withRestrictions ( [ xsd:minLength 1 ] ) ] .
e:AtMostThree a rdfs:Datatype ; owl:equivalentClass [ a rdfs:Datatype ; owl:onDatatype xsd:string ; owl:withRestrictions ( [ xsd:maxLength 3 ] ) ] .`,
    );
    expectValues(shapes, ['"a"', '"abc"', '"ab"^^xsd:token'], ['""', '"abcd"', '"1"^^xsd:integer']);
    expect(shapes).not.toMatch(/# Note:/);
  });

  it('anchors patterns, as XML Schema does, and keeps each one', async () => {
    const shapes = await shapesFor(
      ['e:Lower', 'e:Short', 'e:NoX'],
      `e:Lower a rdfs:Datatype ; owl:equivalentClass [ a rdfs:Datatype ; owl:onDatatype xsd:string ; owl:withRestrictions ( [ xsd:pattern "[a-z]+" ] ) ] .
e:Short a rdfs:Datatype ; owl:equivalentClass [ a rdfs:Datatype ; owl:onDatatype xsd:string ; owl:withRestrictions ( [ xsd:maxLength 2 ] ) ] .
e:NoX a rdfs:Datatype ; owl:equivalentClass [ a rdfs:Datatype ; owl:onDatatype xsd:string ; owl:withRestrictions ( [ xsd:pattern "[^x]*" ] ) ] .`,
    );
    expectValues(shapes, ['"ab"', '"z"'], ['"AB"', '"abc"', '"a1"', '"1a"', '"ax"']);
  });

  it('handles exclusive bounds on decimals, and whole numbers between them', async () => {
    const positive = `e:Positive a rdfs:Datatype ; owl:equivalentClass [ a rdfs:Datatype ; owl:onDatatype xsd:decimal ; owl:withRestrictions ( [ xsd:minExclusive 0 ] ) ] .
e:UpToTen a rdfs:Datatype ; owl:equivalentClass [ a rdfs:Datatype ; owl:onDatatype xsd:decimal ; owl:withRestrictions ( [ xsd:maxInclusive 10 ] ) ] .
e:BelowOne a rdfs:Datatype ; owl:equivalentClass [ a rdfs:Datatype ; owl:onDatatype xsd:integer ; owl:withRestrictions ( [ xsd:maxExclusive 1 ] ) ] .`;
    expectValues(await shapesFor(['e:Positive', 'e:UpToTen'], positive), ['"0.5"^^xsd:decimal', '"10"^^xsd:integer'], ['"0"^^xsd:decimal', '"10.5"^^xsd:decimal']);
    // Whole numbers below 1 that are not negative: only 0.
    expectValues(await shapesFor(['e:BelowOne', 'xsd:nonNegativeInteger'], positive), ['"0"^^xsd:integer', '"0.0"^^xsd:decimal'], ['"1"^^xsd:integer', '"0.5"^^xsd:decimal']);
    // Whole numbers above 0 and below 1: none.
    const none = await shapesFor(['e:BelowOne', 'e:Positive'], positive);
    expectValues(none, [], ['"0"^^xsd:integer', '"1"^^xsd:integer']);
    expect(none).toMatch(/so it can have none/);
  });

  it('says what it can’t check, and never rejects a value OWL allows for it', async () => {
    const shapes = await shapesFor(
      ['e:TwoDigits', 'xsd:nonNegativeInteger'],
      'e:TwoDigits a rdfs:Datatype ; owl:equivalentClass [ a rdfs:Datatype ; owl:onDatatype xsd:decimal ; owl:withRestrictions ( [ xsd:totalDigits 2 ] ) ] .',
    );
    // 5 is allowed; 123 isn't, but xsd:totalDigits can't be checked, so it passes; -1 is still rejected.
    expectValues(shapes, ['"5"^^xsd:integer', '"123"^^xsd:integer'], ['"-1"^^xsd:integer']);
    expect(shapes).toMatch(/^# Note: <https:\/\/example\.org\/e#C> <https:\/\/example\.org\/e#p>: values must be all of .* but not the xsd:totalDigits facet/m);
  });

  it('keeps one exact check when one datatype is narrower', async () => {
    const shapes = await shapesFor(['xsd:integer', 'xsd:byte']);
    expect(shapes).toMatch(/sh:datatype xsd:byte/);
    expect(shapes).not.toMatch(/sh:or/);
  });

  it('compares decimal bounds exactly, however long', async () => {
    expect(compare('9007199254740992.0', '9007199254740993.0')).toBe(-1);
    expect(compare('1.00000000000000001', '1.00000000000000002')).toBe(-1);
    expect(compare('-0', '0.000')).toBe(0);
    expect(compare('-.5', '-0.49999999999999999999')).toBe(-1);
    const defs = `e:Above a rdfs:Datatype ; owl:equivalentClass [ a rdfs:Datatype ; owl:onDatatype xsd:decimal ; owl:withRestrictions ( [ xsd:minExclusive 9007199254740992.0 ] ) ] .
e:AtMost a rdfs:Datatype ; owl:equivalentClass [ a rdfs:Datatype ; owl:onDatatype xsd:decimal ; owl:withRestrictions ( [ xsd:maxInclusive 9007199254740993.0 ] ) ] .
e:Min1 a rdfs:Datatype ; owl:equivalentClass [ a rdfs:Datatype ; owl:onDatatype xsd:decimal ; owl:withRestrictions ( [ xsd:minInclusive 1.00000000000000001 ] ) ] .
e:Min2 a rdfs:Datatype ; owl:equivalentClass [ a rdfs:Datatype ; owl:onDatatype xsd:decimal ; owl:withRestrictions ( [ xsd:minInclusive 1.00000000000000002 ] ) ] .`;
    // Values above 2^53 and at most 2^53 + 1: not empty, and both bounds kept as written. (Checked as text:
    // sparq 0.1.5 compares decimals as doubles when validating, so it can't tell these values apart.)
    const big = await shapesFor(['e:Above', 'e:AtMost'], defs);
    expect(big).not.toMatch(/sh:maxCount 0/);
    expect(big).toMatch(/sh:minExclusive 9007199254740992\.0/);
    expect(big).toMatch(/sh:maxInclusive 9007199254740993\.0/);
    // The larger of two minimums that differ beyond a double's precision.
    const min = await shapesFor(['e:Min1', 'e:Min2'], defs);
    expect(min).toMatch(/sh:minInclusive 1\.00000000000000002/);
    expect(min).not.toMatch(/1\.00000000000000001/);
  });

  it('validates values at and around decimal bounds', async () => {
    const defs = `e:Above a rdfs:Datatype ; owl:equivalentClass [ a rdfs:Datatype ; owl:onDatatype xsd:decimal ; owl:withRestrictions ( [ xsd:minExclusive 2.5 ] ) ] .
e:AtMost a rdfs:Datatype ; owl:equivalentClass [ a rdfs:Datatype ; owl:onDatatype xsd:decimal ; owl:withRestrictions ( [ xsd:maxInclusive 3.75 ] ) ] .
e:AtLeast a rdfs:Datatype ; owl:equivalentClass [ a rdfs:Datatype ; owl:onDatatype xsd:decimal ; owl:withRestrictions ( [ xsd:minInclusive -0.125 ] ) ] .
e:Below a rdfs:Datatype ; owl:equivalentClass [ a rdfs:Datatype ; owl:onDatatype xsd:decimal ; owl:withRestrictions ( [ xsd:maxExclusive 0.5 ] ) ] .`;
    expectValues(
      await shapesFor(['e:Above', 'e:AtMost'], defs),
      ['"2.51"^^xsd:decimal', '"3.75"^^xsd:decimal', '"3.750"^^xsd:decimal', '"3"^^xsd:integer', '"3"^^xsd:byte'],
      ['"2.5"^^xsd:decimal', '"2.50"^^xsd:decimal', '"3.76"^^xsd:decimal', '"2"^^xsd:integer', '"4"^^xsd:integer', '"3.0"^^xsd:double'],
    );
    expectValues(
      await shapesFor(['e:AtLeast', 'e:Below'], defs),
      ['"-0.125"^^xsd:decimal', '"-0"^^xsd:integer', '"0.4999"^^xsd:decimal'],
      ['"-0.126"^^xsd:decimal', '"0.5"^^xsd:decimal', '"1"^^xsd:integer'],
    );
    // The same bounds with whole numbers: 3 only, and 0 only.
    expectValues(await shapesFor(['e:Above', 'e:AtMost', 'xsd:integer'], defs), ['"3"^^xsd:integer', '"3.0"^^xsd:decimal'], ['"2"^^xsd:integer', '"4"^^xsd:integer', '"3.5"^^xsd:decimal']);
    expectValues(await shapesFor(['e:AtLeast', 'e:Below', 'xsd:int'], defs), ['"0"^^xsd:int'], ['"-1"^^xsd:int', '"1"^^xsd:int']);
  });

  it('finds the whole numbers between bounds exactly', async () => {
    const tiny = `e:Tiny a rdfs:Datatype ; owl:equivalentClass [ a rdfs:Datatype ; owl:onDatatype xsd:decimal ; owl:withRestrictions ( [ xsd:maxExclusive 0.0000000001 ] ) ] .
e:Huge a rdfs:Datatype ; owl:equivalentClass [ a rdfs:Datatype ; owl:onDatatype xsd:decimal ; owl:withRestrictions ( [ xsd:minExclusive 18446744073709551614.5 ] ) ] .
e:NegHalf a rdfs:Datatype ; owl:equivalentClass [ a rdfs:Datatype ; owl:onDatatype xsd:decimal ; owl:withRestrictions ( [ xsd:minInclusive -1.5 ] ) ] .`;
    // Below 0.0000000001 and not negative: 0.
    const zero = await shapesFor(['e:Tiny', 'xsd:nonNegativeInteger'], tiny);
    expect(zero).toMatch(/sh:maxInclusive 0 ;/);
    expect(zero).toMatch(/sh:minInclusive 0 ;/);
    expectValues(zero, ['"0"^^xsd:integer', '"0.0"^^xsd:decimal'], ['"1"^^xsd:integer']);
    // Above 18446744073709551614.5 and an unsignedLong: only its maximum.
    const top = await shapesFor(['e:Huge', 'xsd:unsignedLong'], tiny);
    expect(top).toMatch(/sh:minInclusive 18446744073709551615 ;/);
    expect(top).toMatch(/sh:maxInclusive 18446744073709551615 ;/);
    // At least -1.5 and not positive: -1 and 0.
    expectValues(await shapesFor(['e:NegHalf', 'xsd:nonPositiveInteger'], tiny), ['"-1"^^xsd:integer', '"0"^^xsd:integer'], ['"-2"^^xsd:integer', '"1"^^xsd:integer']);
    const defs = datatypeDefinitions((await OntologyGraph.fromTurtle(`${PREFIXES}${tiny}`)).store);
    expect(intersect(['https://example.org/e#NegHalf', 'http://www.w3.org/2001/XMLSchema#negativeInteger'], defs)).toMatchObject({ min: { value: '-1' }, max: { value: '-1' } });
  });

  it('keeps the restrictions of the built-in string types', async () => {
    const defs = (base: string) => `e:NonEmpty a rdfs:Datatype ; owl:equivalentClass [ a rdfs:Datatype ; owl:onDatatype ${base} ; owl:withRestrictions ( [ xsd:minLength 1 ] ) ] .
e:UpToTen a rdfs:Datatype ; owl:equivalentClass [ a rdfs:Datatype ; owl:onDatatype xsd:string ; owl:withRestrictions ( [ xsd:maxLength 10 ] ) ] .`;
    expectValues(await shapesFor(['e:NonEmpty', 'e:UpToTen'], defs('xsd:token')), ['"a b"', '"a"^^xsd:token'], ['"a  b"', '" a "', '"a\\nb"', '"a\\tb"', '""']);
    expectValues(await shapesFor(['e:NonEmpty', 'e:UpToTen'], defs('xsd:normalizedString')), ['"a  b"', '" a "'], ['"a\\nb"', '"a\\rb"', '"a\\tb"']);
    expectValues(await shapesFor(['e:NonEmpty', 'e:UpToTen'], defs('xsd:language')), ['"en"', '"en-GB"'], ['"!!!"', '"en GB"', '"toolonglanguage"']);
    // XML name characters can't be checked, and the note says so.
    const ncname = await shapesFor(['e:NonEmpty', 'e:UpToTen'], defs('xsd:NCName'));
    expect(ncname).toMatch(/^# Note: .*but not the restrictions of xsd:NCName/m);
    expectValues(ncname, ['"abc"'], ['"a  b"', '" a"']); // still a token
  });

  it('keeps an XML Schema pattern’s meaning: ^ and $ are ordinary characters', async () => {
    expect(xsdToXPathPattern('^a$')).toBe('^(\\^a\\$)$');
    expect(xsdToXPathPattern('[^$]+')).toBe('^([^$]+)$');
    expect(xsdToXPathPattern('\\$[0-9]+')).toBe('^(\\$[0-9]+)$');
    const shapes = await shapesFor(
      ['e:Caret', 'e:Short'],
      `e:Caret a rdfs:Datatype ; owl:equivalentClass [ a rdfs:Datatype ; owl:onDatatype xsd:string ; owl:withRestrictions ( [ xsd:pattern "^a$" ] ) ] .
e:Short a rdfs:Datatype ; owl:equivalentClass [ a rdfs:Datatype ; owl:onDatatype xsd:string ; owl:withRestrictions ( [ xsd:maxLength 5 ] ) ] .`,
    );
    expectValues(shapes, ['"^a$"'], ['"a"', '"x^a$"']);
    expect(shapes).not.toMatch(/\(\?:/); // XPath 2.0 has no non-capturing groups
  });

  it('allows no values for dates and date-times together, or decimals and floats', async () => {
    for (const pair of [['xsd:dateTime', 'xsd:date'], ['xsd:decimal', 'xsd:float'], ['xsd:integer', 'xsd:double']]) {
      const shapes = await shapesFor(pair);
      expect(shapes, pair.join(' ')).toMatch(/sh:maxCount 0/);
      expectValues(shapes, [], ['"2020-01-01"^^xsd:date', '"2020-01-01T00:00:00Z"^^xsd:dateTime', '"1"^^xsd:float', '"1"^^xsd:integer']);
    }
  });

  it('checks the time zone of xsd:dateTimeStamp', async () => {
    const shapes = await shapesFor(
      ['xsd:dateTimeStamp', 'e:Since2000'],
      'e:Since2000 a rdfs:Datatype ; owl:equivalentClass [ a rdfs:Datatype ; owl:onDatatype xsd:dateTime ; owl:withRestrictions ( [ xsd:minInclusive "2000-01-01T00:00:00Z"^^xsd:dateTime ] ) ] .',
    );
    expectValues(shapes, ['"2020-01-01T00:00:00Z"^^xsd:dateTime', '"2020-01-01T00:00:00+01:00"^^xsd:dateTimeStamp'], ['"2020-01-01T00:00:00"^^xsd:dateTime']);
    // A date-time bound isn't checked by value yet, and the note says so.
    expect(shapes).toMatch(/^# Note: .*but not the xsd:minInclusive facet/m);
  });
});

/** An ontology where e:Parent's e:p values are `parent` and its subclass e:Child's are `child`, as SHACL shapes. */
async function parentChildShapes(parent: string, child: string) {
  const g = await OntologyGraph.fromTurtle(`${PREFIXES}<https://example.org/e> a owl:Ontology .
e:Parent a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty e:p ; owl:allValuesFrom ${parent} ] .
e:Child a owl:Class ; rdfs:subClassOf e:Parent , [ a owl:Restriction ; owl:onProperty e:p ; owl:allValuesFrom ${child} ] .
e:p a owl:DatatypeProperty .`);
  await toShaclc(g);
  return toShacl(g);
}

describe('one datatype on a property (#27)', () => {
  // Used to: one datatype was one sh:datatype, which checks the literal's datatype IRI exactly, so values OWL allows
  // were rejected: a byte where an integer was asked for, a timestamp for a date-time, and anything at all for a
  // datatype the ontology defines (no literal is written as one).
  it('takes values written as a built-in datatype derived from the one asked for', async () => {
    const shapes = await shapesFor(['xsd:integer']);
    expectValues(shapes, ['"1"^^xsd:integer', '"1"^^xsd:byte', '"7"^^xsd:positiveInteger', '"-3"^^xsd:long'], ['"1.5"^^xsd:decimal', '"1"^^xsd:string']);
    const nonNegative = await shapesFor(['xsd:nonNegativeInteger']);
    expectValues(nonNegative, ['"3"^^xsd:unsignedByte', '"3"^^xsd:positiveInteger'], ['"3"^^xsd:string']);
    const when = await shapesFor(['xsd:dateTime']);
    expectValues(when, ['"2026-11-07T10:00:00"^^xsd:dateTime', '"2026-11-07T10:00:00Z"^^xsd:dateTimeStamp'], ['"2026-11-07"^^xsd:date']);
  });

  it('keeps one exact check where nothing derives from the datatype, and for text', async () => {
    expect(await shapesFor(['xsd:boolean'])).toMatch(/sh:datatype xsd:boolean/);
    // Literals written as xsd:token or xsd:NCName are rare; ten alternatives on every text property would be hard to read.
    const text = await shapesFor(['xsd:string']);
    expect(text).toMatch(/sh:datatype xsd:string/);
    expect(text).not.toMatch(/sh:or/);
  });

  it('checks a datatype the ontology defines by the built-in it is based on, with its facets', async () => {
    const alias = await shapesFor(['e:Text'], 'e:Text a rdfs:Datatype ; owl:equivalentClass xsd:string .');
    expectValues(alias, ['"hello"^^xsd:string'], ['"5"^^xsd:integer']);
    expect(alias).not.toMatch(/e:Text/);
    const code = await shapesFor(['e:Code'], 'e:Code a rdfs:Datatype ; owl:equivalentClass [ a rdfs:Datatype ; owl:onDatatype xsd:string ; owl:withRestrictions ( [ xsd:pattern "[A-Z]{2}" ] ) ] .');
    expectValues(code, ['"GB"^^xsd:string'], ['"gb"^^xsd:string', '"GBR"^^xsd:string']);
    const age = await shapesFor(['e:Age'], 'e:Age a rdfs:Datatype ; owl:equivalentClass [ a rdfs:Datatype ; owl:onDatatype xsd:integer ; owl:withRestrictions ( [ xsd:minInclusive 0 ] [ xsd:maxInclusive 150 ] ) ] .');
    expectValues(age, ['"30"^^xsd:integer', '"30"^^xsd:byte'], ['"-1"^^xsd:integer', '"151"^^xsd:integer']);
  });

  // Review of #27: one the ontology defines on a datatype Concord can't check by value got no check at all.
  it('keeps the datatype an ontology’s own datatype comes down to, when its values can’t be checked by value', async () => {
    const shape = await shapesFor(['e:Shape'], 'e:Shape a rdfs:Datatype ; owl:equivalentClass <http://www.opengis.net/ont/geosparql#wktLiteral> .');
    expectValues(shape, ['"POINT(1 2)"^^<http://www.opengis.net/ont/geosparql#wktLiteral>'], ['"5"^^xsd:integer', '"POINT(1 2)"', '<https://example.org/x>']);
    expect(shape).not.toMatch(/# Note:/);
  });

  it('a parent asking for xsd:integer accepts a child whose values are xsd:byte', async () => {
    const shapes = await parentChildShapes('xsd:integer', 'xsd:byte');
    // An e:Child is an e:Parent too, so both node shapes apply to it.
    const data = `${PREFIXES}<https://example.org/x> a e:Child , e:Parent ; e:p "5"^^xsd:byte .`;
    expect((JSON.parse(engine.validate(data, shapes, 'turtle')) as { conforms: boolean }).conforms).toBe(true);
  });
});
