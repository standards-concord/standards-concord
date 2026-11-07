import { describe, expect, it } from 'vitest';
import { formatTurtle, parseTurtle, resolveIri, termKey, tokenize } from './turtleDoc';
import { ShapesIndex, describeFindings, displayPrefixes, fitsDatatype, parseSyntaxError, shortIri, unknownTerms } from './shaclFindings';

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
    expect(missing.text).toBe('ex:foodbank requires at least 1 vol:offersOpportunity, 0 found');
    expect(DATA.slice(missing.at!.from, missing.at!.to)).toBe('ex:foodbank');
    expect(missing.at!.line).toBe(7);
    expect(missing.parts.filter((p) => typeof p !== 'string' && 'strong' in p)).toEqual([{ strong: '1' }, { strong: '0' }]);
  });

  it('says what type a value is and what it must be, and suggests a fix', () => {
    const [, age] = describeFindings(REPORT, ctx(DATA));
    expect(age.text).toBe('Value "sixteen" is of type xsd:string but must be of type xsd:nonNegativeInteger. Write it as "16"^^xsd:nonNegativeInteger');
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
    expect(f.text).toBe('ex:s allows at most 1 vol:minimumAge, 2 found');
    expect(f.ranges).toHaveLength(2);
  });

  it('prefers the data’s own prefix over the ontology’s', () => {
    const text = DATA.replace(/vol:/g, 'v:').replace('@prefix v:', '@prefix v:');
    const [missing] = describeFindings(REPORT, ctx(text));
    expect(missing.text).toBe('ex:foodbank requires at least 1 v:offersOpportunity, 0 found');
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
    const [w] = unknownTerms(doc, VOL, new Set([`${VOL}title`, `${VOL}minimumAge`, `${VOL}offeredBy`, `${VOL}VolunteeringOpportunity`, `${VOL}VolunteerInvolvingOrganisation`]), displayPrefixes(doc));
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

/*
 * Regressions from the first review of the Check data rework (PR #50). Each
 * test names what used to go wrong.
 */
const EX = 'http://e/';
const SHAPES = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <${EX}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
ex:S a sh:NodeShape ; sh:targetClass ex:C ;
  sh:property [ sh:path ex:p ; sh:minCount 2 ; sh:message "Please supply two contacts" ] ,
    [ sh:path ex:d ; sh:datatype xsd:date ; sh:message "See <https://help.example/dates> for date formats" ] ,
    [ sh:path ex:q ; sh:or ( [ sh:class ex:A ] [ sh:datatype xsd:integer ] ) ] .
`;
const sh = (c: string) => `http://www.w3.org/ns/shacl#${c}ConstraintComponent`;
function exCtx(text: string, shapes = SHAPES) {
  const doc = parseTurtle(text);
  return { doc, text, prefixes: displayPrefixes(doc), shapes: new ShapesIndex(shapes) };
}

describe('review regressions', () => {
  // Used to throw a RangeError while rendering, crashing the page.
  it('an out-of-range \\U escape is a positioned syntax error, not a crash', () => {
    for (const text of ['ex:a ex:b "\\UFFFFFFFF" .', '<\\UFFFFFFFF> <http://e/p> 1 .', 'ex:a ex:b "\\uD800" .']) {
      const doc = parseTurtle(text, { prefixes: { ex: EX } });
      expect(doc.error?.message).toMatch(/isn’t a valid character escape/);
      expect(text.slice(doc.error!.from, doc.error!.to)).toContain('\\');
    }
  });

  // The local reader accepted these, so Format could rewrite invalid input.
  it('invalid escapes and a lone [] . are errors', () => {
    expect(tokenize('"bad\\q"')[0].type).toBe('error');
    expect(parseTurtle('[] .').error).toBeDefined();
  });

  // "ex:b." swallowed the full stop, so parsing stopped and later findings had no location.
  it('a prefixed name followed straight by the full stop, and supplementary-plane names', () => {
    const doc = parseTurtle('@prefix ex: <http://e/> .\nex:a ex:p ex:b.\nex:𐀀 ex:p ex:c.');
    expect(doc.error).toBeUndefined();
    expect(doc.triples.map((t) => t.o.term.value)).toEqual(['http://e/b', 'http://e/c']);
    expect(doc.triples[1].s.term.value).toBe('http://e/𐀀');
  });

  // new URL() percent-encoded IRIs, so they never matched what sparq reports.
  it('resolves relative IRIs the way sparq does, without percent-encoding', () => {
    const doc = parseTurtle('@base <http://e/a/b> .\n<café> <../p> <#x> .');
    expect(doc.triples[0].s.term.value).toBe('http://e/a/café');
    expect(doc.triples[0].p.term.value).toBe('http://e/p');
    expect(doc.triples[0].o.term.value).toBe('http://e/a/b#x');
    expect(resolveIri('?q', 'http://e/a/b?z')).toBe('http://e/a/b?q');
  });

  // Format turned "PREFIX # note\nex: <…>" into invalid Turtle, and dropped comments inside [ ].
  it('Format keeps comments in directives and blank nodes, and stays valid', () => {
    const text = 'PREFIX # note\nex: <http://e/>\nex:a ex:p [ # inside\n] ; ex:q [ # first\n ex:r 1 # second\n ] .';
    const out = formatTurtle(text)!;
    expect(out).toBeDefined();
    for (const c of ['# note', '# inside', '# first', '# second']) expect(out).toContain(c);
    expect(parseTurtle(out).error).toBeUndefined();
    expect(formatTurtle(out)).toBe(out);
  });

  // Typing in a big file did seconds of work on every keystroke.
  it('reading, tidying and typo-checking a 5,000-record file is fast', () => {
    let text = '@prefix ex: <http://e/> .\n';
    for (let i = 0; i < 5000; i++) text += `ex:r${i} a ex:Thing ; ex:name "Record number ${i}" ; ex:size ${i} .\n`;
    expect(text.length).toBeGreaterThan(140_000);
    let t0 = performance.now();
    const doc = parseTurtle(text);
    expect(doc.triples).toHaveLength(15000);
    expect(performance.now() - t0).toBeLessThan(1000);
    t0 = performance.now();
    expect(formatTurtle(text)).toBeDefined();
    expect(performance.now() - t0).toBeLessThan(2000);
    const known = new Set(Array.from({ length: 300 }, (_, i) => `${EX}term${i}`));
    t0 = performance.now();
    expect(unknownTerms(doc, EX, known, displayPrefixes(doc)).length).toBe(15000);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  // A blank node's identity was guessed from its properties, pointing at the wrong record.
  it('blank-node findings stay unlocated instead of guessing', () => {
    const text = '@prefix ex: <http://e/> .\n[] a ex:C .\n[ ex:p "valid" ] .\n';
    const [f] = describeFindings([{ focusNode: '_:__ttl_anon_3_1', path: `<${EX}p>`, sourceConstraintComponent: sh('MinCount'), message: 'Please supply two contacts' }], exCtx(text));
    expect(f.at).toBeUndefined();
    expect(f.ranges).toEqual([]);
    expect(f.text).not.toMatch(/found/);
    expect(f.text).toMatch(/^A blank node requires at least 2 ex:p/);
  });

  // Custom messages were mined for numbers and IRIs, inventing requirements.
  it('takes limits and datatypes from the shapes, and shows custom messages as written', () => {
    const text = '@prefix ex: <http://e/> .\nex:a a ex:C ; ex:p "x" ; ex:d "2025-02-30" .\n';
    const [count, date] = describeFindings(
      [
        { focusNode: `<${EX}a>`, path: `<${EX}p>`, sourceConstraintComponent: sh('MinCount'), message: 'Please supply two contacts' },
        { focusNode: `<${EX}a>`, path: `<${EX}d>`, value: '"2025-02-30"', sourceConstraintComponent: sh('Datatype'), message: 'See <https://help.example/dates> for date formats' },
      ],
      exCtx(text),
    );
    expect(count.text).toBe('ex:a requires at least 2 ex:p, 1 found. “Please supply two contacts”');
    expect(date.text).toMatch(/^Value "2025-02-30" is of type xsd:string but must be of type xsd:date\. “See <https:\/\/help\.example\/dates> for date formats”$/);
    // 30 February isn't a date, so there's no "Write it as".
    expect(date.text).not.toMatch(/Write it as/);
  });

  // Repeating a triple counted twice: "requires at least 2 ex:p, 2 found".
  it('counts distinct values, as SHACL does', () => {
    const text = '@prefix ex: <http://e/> .\nex:a ex:p "x" .\nex:a ex:p "x" .\n';
    const [f] = describeFindings([{ focusNode: `<${EX}a>`, path: `<${EX}p>`, sourceConstraintComponent: sh('MinCount'), message: 'Fewer than 2 values' }], exCtx(text, ''));
    expect(f.text).toBe('ex:a requires at least 2 ex:p, 1 found');
  });

  // Suggested fixes could be invalid ("999"^^xsd:byte, "2025-99-99"^^xsd:date) or change text ("one"@en → "1").
  it('only suggests fixes that are valid, and never turns words into numbers for text', () => {
    expect(fitsDatatype('999', 'http://www.w3.org/2001/XMLSchema#byte')).toBe(false);
    expect(fitsDatatype('127', 'http://www.w3.org/2001/XMLSchema#byte')).toBe(true);
    expect(fitsDatatype('2025-99-99', 'http://www.w3.org/2001/XMLSchema#date')).toBe(false);
    expect(fitsDatatype('2024-02-29', 'http://www.w3.org/2001/XMLSchema#date')).toBe(true);
    const text = '@prefix ex: <http://e/> .\nex:a ex:t "one"@en .\n';
    const [f] = describeFindings(
      [{ focusNode: `<${EX}a>`, path: `<${EX}t>`, value: '"one"@en', sourceConstraintComponent: sh('Datatype'), message: 'Value does not have datatype <http://www.w3.org/2001/XMLSchema#string>' }],
      exCtx(text, ''),
    );
    expect(f.text).toBe('Value "one"@en is of type rdf:langString but must be of type xsd:string. Write it as "one"');
  });

  // Instance names in the ontology's namespace got "did you mean" corrections.
  it('only checks properties, types and datatypes for typos, never record names', () => {
    const text = '@prefix ex: <http://e/> .\nex:role a ex:Role ; ex:titel "x" ; ex:link ex:other .\n';
    const doc = parseTurtle(text);
    const warnings = unknownTerms(doc, EX, new Set([`${EX}Role`, `${EX}title`, `${EX}link`]), displayPrefixes(doc));
    expect(warnings.map((w) => text.slice(w.from, w.to))).toEqual(['ex:titel']);
  });

  // sh:or showed "Value does not conform to any member shape".
  it('describes the alternatives of sh:or in plain words', () => {
    const text = '@prefix ex: <http://e/> .\nex:a a ex:C ; ex:q "x" .\n';
    const [f] = describeFindings([{ focusNode: `<${EX}a>`, path: `<${EX}q>`, value: '"x"', sourceConstraintComponent: sh('Or'), message: 'Value does not conform to any member shape' }], exCtx(text));
    expect(f.text).toBe('Value "x" must be a ex:A or a xsd:integer value');
  });

  // Review 2. 4,000 nested [ … ] overflowed the stack while rendering and took the page down.
  it('deeply nested brackets are a positioned error, not a crash', () => {
    const text = `@prefix ex: <http://e/> .\nex:a ex:p ${'[ ex:p '.repeat(4000)}1${' ]'.repeat(4000)} .\n`;
    const doc = parseTurtle(text);
    expect(doc.error?.message).toMatch(/nested more than 200 levels/);
    expect(text.slice(doc.error!.from, doc.error!.to)).toBe('[');
    expect(formatTurtle(text)).toBeUndefined();
  });

  // Review 2. The reader named [] "_anon1", the same as an explicit _:_anon1, so two values counted as one.
  it('anonymous nodes never share a name with a written _:label', () => {
    const text = '@prefix ex: <http://e/> .\nex:a ex:p [], _:_anon1 .\n';
    const shapes = `@prefix sh: <http://www.w3.org/ns/shacl#> .\n@prefix ex: <${EX}> .\nex:S sh:targetNode ex:a ; sh:property [ sh:path ex:p ; sh:maxCount 1 ] .\n`;
    const [f] = describeFindings([{ focusNode: `<${EX}a>`, path: `<${EX}p>`, sourceConstraintComponent: sh('MaxCount'), message: 'More than 1 values' }], exCtx(text, shapes));
    expect(f.text).toBe('ex:a allows at most 1 ex:p, 2 found');
  });

  // Review 2. "Value is not a valid date; …" looked like sparq's own wording, so it wasn't shown as the author's message.
  it('a custom message that reads like sparq’s is still shown as written', () => {
    const message = 'Value is not a valid date; see <https://help.example/dates>';
    const shapes = SHAPES.replace('See <https://help.example/dates> for date formats', message);
    const text = '@prefix ex: <http://e/> .\nex:a a ex:C ; ex:d "soon" .\n';
    const [f] = describeFindings([{ focusNode: `<${EX}a>`, path: `<${EX}d>`, value: '"soon"', sourceConstraintComponent: sh('Datatype'), message }], exCtx(text, shapes));
    expect(f.text).toBe(`Value "soon" is of type xsd:string but must be of type xsd:date. “${message}”`);
  });

  // Review 2. sh:or alternatives dropped their other constraints ("a xsd:integer value", not "… of at least 10").
  it('describes every constraint of each alternative, and stays generic when it can’t', () => {
    const text = '@prefix ex: <http://e/> .\nex:a a ex:C ; ex:q 3 .\n';
    const shapes = (alt: string) => `@prefix sh: <http://www.w3.org/ns/shacl#> .\n@prefix ex: <${EX}> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\nex:S sh:targetClass ex:C ; sh:property [ sh:path ex:q ; sh:or ( [ sh:class ex:A ] ${alt} ) ] .\n`;
    const result = { focusNode: `<${EX}a>`, path: `<${EX}q>`, value: '"3"^^<http://www.w3.org/2001/XMLSchema#integer>', sourceConstraintComponent: sh('Or'), message: 'Value does not conform to any member shape' };
    const [f] = describeFindings([result], exCtx(text, shapes('[ sh:datatype xsd:integer ; sh:minInclusive 10 ]')));
    expect(f.text).toBe('Value 3 must be a ex:A or a xsd:integer value of at least 10');
    const [g] = describeFindings([result], exCtx(text, shapes('[ sh:datatype xsd:integer ; sh:languageIn ( "en" ) ]')));
    expect(g.text).not.toMatch(/must be a ex:A or a xsd:integer value$/);
  });

  // #27: one datatype became an sh:or of it and every type derived from it, and the finding listed all thirteen.
  it('names one datatype when the alternatives are it and the types derived from it', () => {
    const X = 'http://www.w3.org/2001/XMLSchema#';
    const family = ['integer', 'nonPositiveInteger', 'negativeInteger', 'long', 'int', 'short', 'byte', 'nonNegativeInteger', 'unsignedLong', 'unsignedInt', 'unsignedShort', 'unsignedByte', 'positiveInteger'];
    const shapes = (types: string[]) => `@prefix sh: <http://www.w3.org/ns/shacl#> .\n@prefix ex: <${EX}> .\nex:S sh:targetClass ex:C ; sh:property [ sh:path ex:q ; sh:or ( ${types.map((t) => `[ sh:datatype <${X}${t}> ]`).join(' ')} ) ] .\n`;
    const text = '@prefix ex: <http://e/> .\nex:a a ex:C ; ex:q 1.5 .\n';
    const result = { focusNode: `<${EX}a>`, path: `<${EX}q>`, value: `"1.5"^^<${X}decimal>`, sourceConstraintComponent: sh('Or'), message: 'Value does not conform to any member shape' };
    const [f] = describeFindings([result], exCtx(text, shapes(family)));
    expect(f.text).toBe('Value "1.5" is of type xsd:decimal but must be of type xsd:integer or a type derived from it');
    // A value of a derived type that isn't valid as that type is named as such, not as the wrong type.
    const [h] = describeFindings([{ ...result, value: `"lots"^^<${X}byte>` }], exCtx('@prefix ex: <http://e/> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\nex:a a ex:C ; ex:q "lots"^^xsd:byte .\n', shapes(family)));
    expect(h.text).toBe('Value "lots" isn’t a valid xsd:byte');
    // Missing one of the family, it is a plain list again: the sentence never claims more than the shape allows.
    const [g] = describeFindings([result], exCtx(text, shapes(family.slice(0, -1))));
    expect(g.text).toMatch(/^Value 1\.5 must be a xsd:integer value, a xsd:nonPositiveInteger value, .* or a xsd:unsignedByte value$/);
  });

  // Review 2. sh:node named the shape's sh:targetClass as the type the value had to be.
  it('never presents a shape’s target class as a requirement', () => {
    const text = '@prefix ex: <http://e/> .\nex:a ex:n ex:b .\nex:b ex:x 1 .\n';
    const shapes = `@prefix sh: <http://www.w3.org/ns/shacl#> .\n@prefix ex: <${EX}> .\nex:Inner a sh:NodeShape ; sh:targetClass ex:Person ; sh:property [ sh:path ex:name ; sh:minCount 1 ] .\nex:Outer sh:targetNode ex:a ; sh:property [ sh:path ex:n ; sh:node ex:Inner ] .\n`;
    const [f] = describeFindings([{ focusNode: `<${EX}a>`, path: `<${EX}n>`, value: `<${EX}b>`, sourceConstraintComponent: sh('Node'), message: 'Value does not conform to the node shape' }], exCtx(text, shapes));
    expect(f.text).not.toMatch(/ex:Person/);
    expect(f.text).toBe('Value ex:b doesn’t meet the rules in the shape ex:Inner');
  });

  // Review 2. Every blank node was left without a place, even ones written as _:alice.
  it('finds _:labels the data wrote, and a sole anonymous value', () => {
    const text = '@prefix ex: <http://e/> .\n_:alice a ex:C .\nex:a ex:q [ ex:z 1 ] .\n';
    const [named, sole] = describeFindings(
      [
        { focusNode: '_:alice', path: `<${EX}p>`, sourceConstraintComponent: sh('MinCount'), message: 'Please supply two contacts' },
        { focusNode: `<${EX}a>`, path: `<${EX}q>`, value: '_:__ttl_anon_9_2', sourceConstraintComponent: sh('Or'), message: 'Value does not conform to any member shape' },
      ],
      exCtx(text),
    );
    expect(text.slice(named.ranges[0].from, named.ranges[0].to)).toBe('_:alice');
    expect(named.at?.line).toBe(2);
    expect(text.slice(sole.ranges[0].from, sole.ranges[0].from + 1)).toBe('[');
    expect(sole.at?.line).toBe(3);
  });

  // Review 2. "Not in your data" read as if the problem wasn't real; now it says why there's no place.
  it('explains why a finding has no place in the text', () => {
    const text = '@prefix ex: <http://e/> .\n[] a ex:C .\nex:a ex:q [ ex:z 1 ], [ ex:z 2 ] .\nex:shared ex:q 1 .\n';
    const [anon, two, shared] = describeFindings(
      [
        { focusNode: '_:__ttl_anon_3_1', path: `<${EX}p>`, sourceConstraintComponent: sh('MinCount'), message: 'Please supply two contacts' },
        { focusNode: `<${EX}a>`, path: `<${EX}q>`, value: '_:__ttl_anon_9_2', sourceConstraintComponent: sh('Or'), message: 'Value does not conform to any member shape' },
        { focusNode: `<${EX}shared>`, path: `<${EX}p>`, sourceConstraintComponent: sh('MinCount'), message: 'Fewer than 2 values' },
      ],
      { ...exCtx(text), external: new Set([termKey({ kind: 'iri', value: `${EX}shared` })]) },
    );
    expect(anon.unlocated).toMatch(/anonymous record/);
    expect(two.unlocated).toMatch(/more than one/);
    expect(shared.unlocated).toMatch(/described in the ontology/);
    // A record the ontology also describes may have values there, so no count is given.
    expect(shared.text).not.toMatch(/found/);
  });

  // Review 3. An alternative with a datatype and a node kind (or a class and a datatype) was described by one of them only.
  it('an alternative with two kinds of requirement falls back to general wording', () => {
    const text = '@prefix ex: <http://e/> .\nex:a a ex:C ; ex:q 5 .\n';
    const shapes = (alt: string) => `@prefix sh: <http://www.w3.org/ns/shacl#> .\n@prefix ex: <${EX}> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\nex:S sh:targetClass ex:C ; sh:property [ sh:path ex:q ; sh:or ( ${alt} [ sh:datatype xsd:string ] ) ] .\n`;
    const result = { focusNode: `<${EX}a>`, path: `<${EX}q>`, value: '"5"^^<http://www.w3.org/2001/XMLSchema#integer>', sourceConstraintComponent: sh('Or'), message: 'Value does not conform to any member shape' };
    for (const alt of ['[ sh:datatype xsd:integer ; sh:nodeKind sh:IRI ]', '[ sh:class ex:A ; sh:datatype xsd:integer ]']) {
      const [f] = describeFindings([result], exCtx(text, shapes(alt)));
      expect(f.text).toBe('Value 5 doesn’t match any of the allowed kinds of value');
    }
  });

  // Review 3. A node-level result (sparq reports the record as its own value, with no path) lost its underline and jump.
  it('a node-level finding points at the record', () => {
    const text = '@prefix ex: <http://e/> .\nex:a a ex:C .\n';
    const shapes = `@prefix sh: <http://www.w3.org/ns/shacl#> .\n@prefix ex: <${EX}> .\nex:S a sh:NodeShape ; sh:targetClass ex:C ; sh:nodeKind sh:Literal .\n`;
    const [f] = describeFindings([{ focusNode: `<${EX}a>`, value: `<${EX}a>`, sourceConstraintComponent: sh('NodeKind'), message: 'Value does not have node kind Literal' }], exCtx(text, shapes));
    expect(f.ranges.map((r) => text.slice(r.from, r.to))).toEqual(['ex:a']);
    expect(f.at?.line).toBe(2);
    expect(f.unlocated).toBeUndefined();
  });

  // Review 3. A written label that happens to start like sparq's own names (_:__ttl_anon_user) was treated as anonymous.
  it('a written _:label is found whatever it is called', () => {
    const text = '@prefix ex: <http://e/> .\n_:__ttl_anon_user a ex:C .\n';
    const [f] = describeFindings([{ focusNode: '_:__ttl_anon_user', path: `<${EX}p>`, sourceConstraintComponent: sh('MinCount'), message: 'Please supply two contacts' }], exCtx(text));
    expect(f.ranges.map((r) => text.slice(r.from, r.to))).toEqual(['_:__ttl_anon_user']);
    expect(f.unlocated).toBeUndefined();
  });

  // Review 3. With a single anonymous value the explanation said the record "has more than one".
  it('only says there are several anonymous values when there are', () => {
    const text = '@prefix ex: <http://e/> .\nex:a ex:p [ ex:z 1 ] .\nex:b ex:p [ ex:z 1 ] .\n';
    const result = (focus: string) => ({ focusNode: `<${EX}${focus}>`, path: `<${EX}p>`, value: '_:__ttl_anon_4_1', sourceConstraintComponent: sh('Class'), message: 'Value does not have class <http://e/K>' });
    const [shared] = describeFindings([result('a')], { ...exCtx(text), external: new Set([termKey({ kind: 'iri', value: `${EX}a` })]) });
    expect(shared.unlocated).toMatch(/described in the ontology/);
    expect(shared.unlocated).not.toMatch(/more than one/);
  });

  // Review 4. A node-level result for a record that only appears as a value (sh:targetObjectsOf) said "couldn't find this".
  it('a node-level finding for a record only used as a value points to where it’s used', () => {
    const text = '@prefix ex: <http://e/> .\nex:a ex:p _:__ttl_anon_user .\n';
    const shapes = `@prefix sh: <http://www.w3.org/ns/shacl#> .\n@prefix ex: <${EX}> .\nex:S sh:targetObjectsOf ex:p ; sh:nodeKind sh:IRI .\n`;
    const [f] = describeFindings([{ focusNode: '_:__ttl_anon_user', value: '_:__ttl_anon_user', sourceConstraintComponent: sh('NodeKind'), message: 'Value does not have node kind IRI' }], exCtx(text, shapes));
    expect(f.ranges.map((r) => text.slice(r.from, r.to))).toEqual(['_:__ttl_anon_user']);
    expect(f.at?.line).toBe(2);
  });
});
