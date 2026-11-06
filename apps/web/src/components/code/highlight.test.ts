import { describe, expect, it } from 'vitest';
import { highlightSegments } from './highlight';
import type { CodeLanguage } from './languages';

/** The class each listed fragment was highlighted with. */
function classesOf(code: string, lang: CodeLanguage, fragments: string[]) {
  const segs = highlightSegments(code, lang);
  return Object.fromEntries(fragments.map((f) => [f, segs.find((s) => s.text === f)?.cls]));
}

describe('RDF highlighting', () => {
  it('Turtle: directives, IRIs, prefixed names, literals, datatypes, language tags and comments', () => {
    const code = '@prefix vol: <https://w3id.org/odi/volunteering#> .\n# a comment\nvol:Thing a owl:Class ;\n  rdfs:label "Thing"@en ;\n  vol:age "16"^^xsd:integer ;\n  vol:n 4.5 ; vol:ok true .';
    expect(classesOf(code, 'turtle', ['@prefix', '<https://w3id.org/odi/volunteering#>', '# a comment', 'vol:', 'Thing', 'a', '"Thing"', '@en', 'xsd:integer', '4.5', 'true'])).toEqual({
      '@prefix': 'tok-meta',
      '<https://w3id.org/odi/volunteering#>': 'tok-iri',
      '# a comment': 'tok-comment',
      'vol:': 'tok-prefix',
      Thing: 'tok-name',
      a: 'tok-keyword',
      '"Thing"': 'tok-string',
      '@en': 'tok-annotation',
      'xsd:integer': 'tok-annotation',
      '4.5': 'tok-number',
      true: 'tok-number',
    });
  });

  it('Turtle: a statement-ending dot is not part of a prefixed name', () => {
    const segs = highlightSegments('ex:a ex:p ex:o.', 'turtle');
    expect(segs.find((s) => s.text === 'o')?.cls).toBe('tok-name');
    expect(segs.at(-1)).toEqual({ text: '.', cls: 'tok-punct' });
  });

  it('Turtle: long strings spanning lines stay strings', () => {
    const segs = highlightSegments('ex:a rdfs:comment """line one\nline "two"\nend""" .', 'turtle');
    expect(segs.filter((s) => s.cls === 'tok-string').map((s) => s.text).join('')).toContain('line "two"');
  });

  it('SPARQL: keywords, variables, functions and comparison operators', () => {
    const code = 'SELECT ?x WHERE { ?x vol:age ?age . FILTER(CONTAINS(STR(?x), "a") && ?age < 18) }';
    expect(classesOf(code, 'sparql', ['SELECT', 'WHERE', '?x', 'CONTAINS', 'STR', 'FILTER', '18'])).toEqual({
      SELECT: 'tok-keyword',
      WHERE: 'tok-keyword',
      '?x': 'tok-variable',
      CONTAINS: 'tok-func',
      STR: 'tok-func',
      FILTER: 'tok-keyword',
      '18': 'tok-number',
    });
    const lt = highlightSegments(code, 'sparql').find((s) => s.text === '<');
    expect(lt?.cls).toBe('tok-punct');
  });

  it('Manchester: frames and class-expression keywords', () => {
    const code = 'Class: vol:Opportunity\n    SubClassOf: vol:offeredBy some vol:Organisation';
    expect(classesOf(code, 'manchester', ['Class:', 'SubClassOf:', 'some', 'Opportunity'])).toEqual({
      'Class:': 'tok-meta',
      'SubClassOf:': 'tok-meta',
      some: 'tok-keyword',
      Opportunity: 'tok-name',
    });
  });

  it('N-Triples: IRIs, blank nodes and literals', () => {
    const code = '<http://a> <http://b> _:b0 .\n<http://a> <http://c> "x"^^<http://www.w3.org/2001/XMLSchema#string> .';
    expect(classesOf(code, 'ntriples', ['<http://a>', '_:b0', '"x"', '<http://www.w3.org/2001/XMLSchema#string>'])).toEqual({
      '<http://a>': 'tok-iri',
      '_:b0': 'tok-variable',
      '"x"': 'tok-string',
      '<http://www.w3.org/2001/XMLSchema#string>': 'tok-annotation',
    });
  });

  it('XML, JSON-LD and LinkML YAML use their grammars', () => {
    expect(highlightSegments('<rdf:RDF xmlns:a="x"/>', 'xml').some((s) => s.cls === 'tok-tag')).toBe(true);
    expect(classesOf('{"@id": "vol:Thing", "n": 2}', 'json', ['"@id"', '"vol:Thing"', '2'])).toEqual({ '"@id"': 'tok-attr', '"vol:Thing"': 'tok-string', '2': 'tok-number' });
    expect(highlightSegments('classes:\n  Thing:\n    class_uri: vol:Thing\n', 'yaml').some((s) => s.cls === 'tok-attr')).toBe(true);
  });

  it('SHACL compact syntax: shape keywords, parameters and the Turtle terms', () => {
    const code = 'BASE <https://w3id.org/odi/volunteering/shapes>\nPREFIX vol: <https://w3id.org/odi/volunteering#>\n\nshape volsh:SessionShape -> vol:Session {\n\tvol:startDateTime xsd:dateTime [1..1] .\n\tvol:joiningUrl datatype=xsd:anyURI .\n}';
    expect(classesOf(code, 'shaclc', ['BASE', 'PREFIX', 'shape', 'datatype', 'SessionShape', 'vol:'])).toEqual({
      BASE: 'tok-meta',
      PREFIX: 'tok-meta',
      shape: 'tok-keyword',
      datatype: 'tok-keyword',
      SessionShape: 'tok-name',
      'vol:': 'tok-prefix',
    });
  });

  it('the generated classes use the JavaScript and TypeScript modes', () => {
    const code = 'export class Volunteer extends Person {\n  get title(): Set<string> {\n    return SetFrom.subjectPredicate(this, "https://x", LiteralAs.string, LiteralFrom.string);\n  }\n}';
    const ts = highlightSegments(code, 'typescript');
    expect(ts.find((s) => s.text === 'class')?.cls).toBe('tok-keyword');
    expect(ts.find((s) => s.text === '"https://x"')?.cls).toBe('tok-string');
    expect(highlightSegments('import { A } from "https://x/a.js";', 'javascript').find((s) => s.text === 'import')?.cls).toBe('tok-keyword');
  });

  it('shell: the command, flags, URLs, quoted strings, @files and line continuations', () => {
    const code = "curl -X POST https://example.org/def/vol \\\n  -H 'Content-Type: text/turtle' \\\n  --data-binary @data.ttl";
    expect(classesOf(code, 'shell', ['curl', '-X', 'POST', 'https://example.org/def/vol', '\\', '-H', "'Content-Type: text/turtle'", '--data-binary', '@data.ttl'])).toEqual({
      curl: 'tok-func',
      '-X': 'tok-attr',
      POST: 'tok-keyword',
      'https://example.org/def/vol': 'tok-iri',
      '\\': 'tok-punct',
      '-H': 'tok-attr',
      "'Content-Type: text/turtle'": 'tok-string',
      '--data-binary': 'tok-attr',
      '@data.ttl': 'tok-variable',
    });
    // A continued line carries on the command, so its first word is not a new command.
    expect(highlightSegments('curl \\\n  example', 'shell').find((s) => s.text === 'example')?.cls).toBeUndefined();
    // Single quotes have no escapes: a backslash inside them doesn't swallow the closing quote.
    expect(highlightSegments("echo 'a\\' b", 'shell').find((s) => s.text === "'a\\'")?.cls).toBe('tok-string');
  });

  it('plain text is left alone', () => {
    expect(highlightSegments('hello', 'text')).toEqual([{ text: 'hello' }]);
  });
});
