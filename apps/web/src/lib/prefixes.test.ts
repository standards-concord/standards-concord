import { describe, expect, it } from 'vitest';
import { declaredPrefixes, insertTerm } from './prefixes';

const NS = 'https://w3id.org/odi/volunteering#';
const IRI = `${NS}Volunteer`;

describe('declaredPrefixes', () => {
  it('reads PREFIX and @prefix, ignoring comments and # inside IRIs', () => {
    const doc = `# PREFIX no: <https://example.org/no#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> PREFIX vol: <${NS}>
@prefix ex: <https://example.org/data/> .
SELECT * WHERE { ?s rdfs:label "PREFIX fake: <x>" }`;
    const d = declaredPrefixes(doc);
    expect([...d.keys()].sort()).toEqual(['ex', 'rdfs', 'vol']);
    expect(d.get('rdfs')).toBe('http://www.w3.org/2000/01/rdf-schema#');
  });
});

describe('insertTerm', () => {
  it('adds the declaration when the prefix is missing', () => {
    expect(insertTerm('SELECT * WHERE { ?s a ', 'sparql', 'vol', NS, IRI)).toEqual({ declaration: `PREFIX vol: <${NS}>\n`, text: 'vol:Volunteer' });
    expect(insertTerm('', 'turtle', 'vol', NS, IRI).declaration).toBe(`@prefix vol: <${NS}> .\n`);
  });
  it('a commented-out declaration does not count', () => {
    expect(insertTerm(`# PREFIX vol: <${NS}>\n`, 'sparql', 'vol', NS, IRI).declaration).toBeDefined();
  });
  it('prefix names are case-sensitive', () => {
    expect(insertTerm(`PREFIX VOL: <https://other.example/>\n`, 'sparql', 'vol', NS, IRI).declaration).toBe(`PREFIX vol: <${NS}>\n`);
  });
  it('uses the existing declaration when it matches', () => {
    expect(insertTerm(`prefix vol: <${NS}>\n`, 'sparql', 'vol', NS, IRI)).toEqual({ text: 'vol:Volunteer' });
  });
  it('uses another prefix bound to the same namespace', () => {
    expect(insertTerm(`PREFIX v: <${NS}>\n`, 'sparql', 'vol', NS, IRI)).toEqual({ text: 'v:Volunteer' });
  });
  it('falls back to the full IRI when the prefix is bound elsewhere', () => {
    expect(insertTerm(`PREFIX vol: <https://other.example/>\n`, 'sparql', 'vol', NS, IRI)).toEqual({ text: `<${IRI}>` });
  });
});
