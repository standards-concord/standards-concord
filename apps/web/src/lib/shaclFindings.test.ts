import { describe, expect, it } from 'vitest';
import { formatTurtle, parseTurtle, termKey } from './turtleDoc';
import { describeFindings, displayPrefixes, parseSyntaxError, shortIri, unknownTerms } from './shaclFindings';

const VOL = 'https://w3id.org/odi/volunteering#';
const DATA = `@prefix vol: <${VOL}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ex: <https://example.org/data/> .

# Example records.
ex:foodbank a vol:VolunteerInvolvingOrganisation ;
  rdfs:label "Northvale Food Bank" .

ex:saturday-shift a vol:VolunteeringOpportunity ;
  vol:title "Saturday food bank shift" ;
  vol:offeredBy ex:foodbank ;
  vol:minimumAge "sixteen" .
`;

// What sparq 0.1.5 reports for DATA against the volunteering shapes.
const REPORT = [
  {
    focusNode: '<https://example.org/data/foodbank>',
    path: `<${VOL}offersOpportunity>`,
    value: null,
    sourceConstraintComponent: 'http://www.w3.org/ns/shacl#MinCountConstraintComponent',
    severity: 'http://www.w3.org/ns/shacl#Violation',
    message: 'Fewer than 1 values',
  },
  {
    focusNode: '<https://example.org/data/saturday-shift>',
    path: `<${VOL}minimumAge>`,
    value: '"sixteen"',
    sourceConstraintComponent: 'http://www.w3.org/ns/shacl#DatatypeConstraintComponent',
    severity: 'http://www.w3.org/ns/shacl#Violation',
    message: 'Value does not have datatype <http://www.w3.org/2001/XMLSchema#nonNegativeInteger>',
  },
];

function ctx(text: string) {
  const doc = parseTurtle(text);
  return { doc, text, prefixes: displayPrefixes(doc, { vol: VOL }) };
}

describe('parseTurtle', () => {
  it('reads triples with where each term is', () => {
    const doc = parseTurtle(DATA);
    expect(doc.error).toBeUndefined();
    expect(doc.prefixes.get('ex')).toBe('https://example.org/data/');
    const age = doc.triples.find((t) => t.p.term.value === `${VOL}minimumAge`)!;
    expect(DATA.slice(age.o.from, age.o.to)).toBe('"sixteen"');
    expect(DATA.slice(age.s.from, age.s.to)).toBe('ex:saturday-shift');
  });

  it('reads literals, numbers, blank nodes and lists', () => {
    const doc = parseTurtle(`@prefix ex: <http://e/> .
ex:a ex:n 4, 2.5, -1e3, true, "x"@en-GB, "y"^^ex:t, """long
text""" ; ex:b [ ex:c ex:d ] ; ex:l ( ex:x ex:y ) .
[ ex:p "q" ] .`);
    expect(doc.error).toBeUndefined();
    const objects = doc.triples.filter((t) => t.p.term.value === 'http://e/n').map((t) => termKey(t.o.term));
    expect(objects).toContain(JSON.stringify(['4', 'http://www.w3.org/2001/XMLSchema#integer']));
    expect(objects).toContain(JSON.stringify(['x', '@', 'en-gb']));
    expect(objects).toContain(JSON.stringify(['long\ntext', 'http://www.w3.org/2001/XMLSchema#string']));
    expect(doc.triples.some((t) => t.p.term.value === 'http://e/c' && t.s.term.kind === 'blank')).toBe(true);
  });

  it('stops at the first error and says where', () => {
    const text = '@prefix ex: <http://e/> .\nex:a ex:b ex:c\nex:d ex:e ex:f .';
    const doc = parseTurtle(text);
    expect(doc.error?.message).toMatch(/Expected “\.”/);
    expect(text.slice(doc.error!.from, doc.error!.to)).toBe('ex:d');
  });

  it('uses prefixes already in scope from the ontology', () => {
    expect(parseTurtle('vol:x a vol:Y .').error?.message).toMatch(/hasn’t been declared/);
    expect(parseTurtle('vol:x a vol:Y .', { prefixes: { vol: VOL } }).error).toBeUndefined();
  });
});

describe('describeFindings', () => {
  it('says what is missing, with the data’s prefixes and how many were found', () => {
    const [missing] = describeFindings(REPORT, ctx(DATA));
    expect(missing.text).toBe('ex:foodbank requires at least one vol:offersOpportunity, 0 found');
    expect(DATA.slice(missing.at!.from, missing.at!.to)).toBe('ex:foodbank');
    expect(missing.at!.line).toBe(7);
  });

  it('says what type a value is and what it must be, and suggests a fix', () => {
    const [, age] = describeFindings(REPORT, ctx(DATA));
    expect(age.text).toBe('Value "sixteen" is of type xsd:string but must be of type xsd:nonNegativeInteger. Write it as "16"^^xsd:nonNegativeInteger.');
    expect(DATA.slice(age.at!.from, age.at!.to)).toBe('"sixteen"');
    expect(age.focus).toBe('ex:saturday-shift');
    expect(age.path).toBe('vol:minimumAge');
  });

  it('names the value’s types for a wrong class', () => {
    const text = `${DATA}ex:other a vol:VolunteeringOpportunity ; vol:offeredBy ex:saturday-shift .\n`;
    const [f] = describeFindings(
      [
        {
          focusNode: '<https://example.org/data/other>',
          path: `<${VOL}offeredBy>`,
          value: '<https://example.org/data/saturday-shift>',
          sourceConstraintComponent: 'http://www.w3.org/ns/shacl#ClassConstraintComponent',
          message: `Value does not have class <${VOL}Organisation>`,
        },
      ],
      ctx(text),
    );
    expect(f.text).toBe('Value ex:saturday-shift is of type vol:VolunteeringOpportunity but must be of type vol:Organisation');
    expect(text.slice(f.at!.from, f.at!.to)).toBe('ex:saturday-shift');
    expect(f.at!.line).toBe(14);
  });

  it('underlines every extra value for too many', () => {
    const text = `@prefix vol: <${VOL}> .\n@prefix ex: <https://example.org/data/> .\nex:s vol:minimumAge 1, 2 .\n`;
    const [f] = describeFindings(
      [{ focusNode: '<https://example.org/data/s>', path: `<${VOL}minimumAge>`, sourceConstraintComponent: 'http://www.w3.org/ns/shacl#MaxCountConstraintComponent', message: 'More than 1 values' }],
      ctx(text),
    );
    expect(f.text).toBe('ex:s allows at most one vol:minimumAge, 2 found');
    expect(f.ranges).toHaveLength(2);
  });

  it('prefers the data’s own prefix over the ontology’s', () => {
    const text = DATA.replace(/vol:/g, 'v:').replace('@prefix v:', '@prefix v:');
    const [missing] = describeFindings(REPORT, ctx(text));
    expect(missing.text).toBe('ex:foodbank requires at least one v:offersOpportunity, 0 found');
  });
});

describe('shortIri', () => {
  it('falls back to <…> when no prefix fits', () => {
    expect(shortIri('http://other/x', [['ex', 'http://e/']])).toBe('<http://other/x>');
  });
});

describe('unknownTerms', () => {
  it('flags ontology terms that don’t exist and suggests the closest', () => {
    const text = DATA.replace('vol:title', 'vol:titel');
    const doc = parseTurtle(text);
    const [w] = unknownTerms(doc, VOL, [`${VOL}title`, `${VOL}minimumAge`, `${VOL}offeredBy`, `${VOL}VolunteeringOpportunity`, `${VOL}VolunteerInvolvingOrganisation`], displayPrefixes(doc));
    expect(w.message).toBe('vol:titel isn’t defined in this ontology. Did you mean vol:title?');
    expect(text.slice(w.from, w.to)).toBe('vol:titel');
  });
});

describe('parseSyntaxError', () => {
  it('turns sparq’s byte offset into a position in the data', () => {
    const header = '@prefix vol: <x> .\n';
    const text = 'ex:a ex:b "é" ex:c .';
    const at = parseSyntaxError(`Turtle: expected '.' at byte ${new TextEncoder().encode(header).length + 15}`, text, new TextEncoder().encode(header).length);
    expect(at).toEqual({ message: "Expected '.'", from: 14 });
  });
});

describe('formatTurtle', () => {
  it('lays out statements and keeps comments and meaning', () => {
    const messy = `@prefix ex: <http://e/> .   @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
# A comment about a
ex:a    a ex:T;ex:n 4 , "x"@en ;   # trailing note
 ex:b [ ex:c ex:d ; ex:e "f"^^xsd:string ] ; ex:l ( ex:x ex:y ) ;.
ex:z ex:p [] .`;
    const out = formatTurtle(messy)!;
    expect(out).toBe(`@prefix ex: <http://e/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

# A comment about a
ex:a a ex:T ;
  ex:n 4, "x"@en ; # trailing note
  ex:b [
    ex:c ex:d ;
    ex:e "f"^^xsd:string
  ] ;
  ex:l ( ex:x ex:y ) .

ex:z ex:p [] .
`);
    const keys = (t: string) => parseTurtle(t).triples.map((x) => [x.s, x.p, x.o].map((p) => termKey(p.term)).join(' ')).sort();
    expect(keys(out)).toEqual(keys(messy));
    expect(formatTurtle(out)).toBe(out);
  });

  it('leaves a broken document alone', () => {
    expect(formatTurtle('ex:a ex:b')).toBeUndefined();
  });
});
