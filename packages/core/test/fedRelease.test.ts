import { describe, expect, it } from 'vitest';
import { manifestGraph, OntologyGraph, rdfcHash, suggestFederationVersion } from '../src/index.js';

describe('content hashes (RDFC-1.0)', () => {
  it('give the same graph the same hash, whatever its syntax, order or blank node labels', async () => {
    const a = await OntologyGraph.fromTurtle(`@prefix ex: <https://ex.org/> . ex:a ex:p [ ex:q "x" ] ; ex:r ex:b .`);
    const b = await OntologyGraph.fromTurtle(`<https://ex.org/a> <https://ex.org/r> <https://ex.org/b> .
_:zz <https://ex.org/q> "x" . <https://ex.org/a> <https://ex.org/p> _:zz .`);
    const c = await OntologyGraph.fromTurtle(`@prefix ex: <https://ex.org/> . ex:a ex:p [ ex:q "y" ] ; ex:r ex:b .`);
    const [ha, hb, hc] = await Promise.all([rdfcHash(a), rdfcHash(b), rdfcHash(c)]);
    expect(ha).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hb).toBe(ha);
    expect(hc).not.toBe(ha);
  });
});

describe('federation releases', () => {
  const pin = (ontologyIRI: string, version: string, role: 'member' | 'import' = 'member') => ({ role, ontologyIRI, version });

  it('suggests the next version from how the members moved', () => {
    expect(suggestFederationVersion(undefined, [pin('a', '1.0.0')]).version).toBe('1.0.0');
    const prev = { version: '1.2.0', pins: [pin('a', '1.0.0'), pin('b', '2.1.0'), pin('x', '1.0.0', 'import')] };
    expect(suggestFederationVersion(prev, [pin('a', '1.0.1'), pin('b', '2.1.0')])).toMatchObject({ version: '1.2.1', level: 'patch' });
    expect(suggestFederationVersion(prev, [pin('a', '1.1.0'), pin('b', '2.1.0')])).toMatchObject({ version: '1.3.0', level: 'minor' });
    expect(suggestFederationVersion(prev, [pin('a', '1.0.0'), pin('b', '2.1.0'), pin('c', '0.1.0')])).toMatchObject({ version: '1.3.0', level: 'minor' });
    expect(suggestFederationVersion(prev, [pin('a', '2.0.0'), pin('b', '2.1.0')])).toMatchObject({ version: '2.0.0', level: 'major' });
    expect(suggestFederationVersion(prev, [pin('a', '1.0.0')])).toMatchObject({ version: '2.0.0', level: 'major', reasons: ['removed b'] });
  });

  // Review r1: the manifest owl:imported each member's version IRI, which doesn't freeze what a member
  // imports without naming a version. It now imports only the frozen closure, and lists the pins.
  it('publishes the manifest as one OWL ontology that imports only the frozen closure and pins every hash', async () => {
    const g = manifestGraph({
      iri: 'https://concord.example/def/fed/uk',
      version: '1.0.0',
      title: 'UK',
      issued: '2026-11-06T12:00:00Z',
      previousVersionIRI: 'https://old.concord.example/def/fed/uk/0.9.0',
      pins: [
        { role: 'member', title: 'Gov', ontologyIRI: 'https://ex.org/gov', version: '2.0.0', versionIRI: 'https://ex.org/gov/2.0.0', hash: 'sha256:' + 'a'.repeat(64) },
        { role: 'import', title: 'Base', ontologyIRI: 'https://ex.org/base', version: '1.0.0', versionIRI: 'https://ex.org/base/1.0.0', hash: 'sha256:' + 'b'.repeat(64) },
      ],
      shapes: { iri: 'https://concord.example/def/fed/uk/1.0.0/shapes', hash: 'sha256:' + 'c'.repeat(64) },
      closure: { iri: 'https://concord.example/def/fed/uk/1.0.0/closure', hash: 'sha256:' + 'd'.repeat(64) },
    });
    const ttl = await g.toTurtle();
    expect(g.ontologyIRI).toBe('https://concord.example/def/fed/uk');
    expect(g.metadata().imports).toEqual(['https://concord.example/def/fed/uk/1.0.0/closure']);
    expect(ttl).toContain('dcterms:hasPart <https://ex.org/gov/2.0.0>');
    expect(ttl).toContain('dcterms:requires <https://ex.org/base/1.0.0>');
    expect(ttl).toContain('d'.repeat(64));
    expect(ttl).toContain('owl:priorVersion <https://old.concord.example/def/fed/uk/0.9.0>');
    expect(ttl).toContain('a'.repeat(64));
    expect(ttl).toContain('b'.repeat(64));
    expect(ttl).toContain('c'.repeat(64));
    // The manifest is itself content-addressed the same way.
    expect(await rdfcHash(g)).toBe(await rdfcHash(await OntologyGraph.fromTurtle(ttl)));
  });
});
