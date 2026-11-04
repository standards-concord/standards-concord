import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { OntologyGraph, toShacl, toShaclc } from '../src/index.js';

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
});
