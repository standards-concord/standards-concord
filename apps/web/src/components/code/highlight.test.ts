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

  it('plain text is left alone', () => {
    expect(highlightSegments('hello', 'text')).toEqual([{ text: 'hello' }]);
  });
});
