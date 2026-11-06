import { DataFactory, Store } from 'n3';
import { describe, expect, it } from 'vitest';
import { storeRevision } from '../src/storeRevision.js';
import { OntologyGraph, checkTerms, parseData } from '../src/index.js';
import { dataConsistency } from '../src/reasoner.js';

const { namedNode: nn, quad } = DataFactory;
const q = (s: string, o = 'o') => quad(nn(`https://e/${s}`), nn('https://e/p'), nn(`https://e/${o}`));

describe('storeRevision', () => {
  it('changes with every way n3 adds or removes quads, and not otherwise', async () => {
    const store = new Store([q('a')]);
    let last = storeRevision(store);
    const changed = (label: string) => {
      const now = storeRevision(store);
      expect(now, label).not.toBe(last);
      last = now;
    };
    store.addQuad(q('b'));
    changed('addQuad');
    store.addQuad(q('b'));
    expect(storeRevision(store), 'adding a quad already there').toBe(last);
    store.addQuads([q('c'), q('d')]);
    changed('addQuads');
    store.add(q('e'));
    changed('add');
    store.addAll(new Store([q('f')]));
    changed('addAll from a store');
    store.removeQuad(q('f'));
    changed('removeQuad');
    store.removeQuad(q('zz'));
    expect(storeRevision(store), 'removing a quad that is not there').toBe(last);
    store.removeQuads([q('e')]);
    changed('removeQuads');
    store.delete(q('d'));
    changed('delete');
    // removeMatches removes as a stream: done once it ends.
    await new Promise((r) => store.removeMatches(nn('https://e/c'), null, null, null).on('end', r));
    changed('removeMatches');
    store.deleteMatches(nn('https://e/b'));
    changed('deleteMatches');
    // Replacing one triple with another keeps the size the same, but is a change.
    const size = store.size;
    store.removeQuad(q('a'));
    store.addQuad(q('a', 'other'));
    expect(store.size).toBe(size);
    changed('replace');
  });
});

describe('caches built from an ontology follow its changes', () => {
  // Used to go wrong: the consistency check and term index were only rebuilt when the ontology's
  // triple count changed, so replacing a triple (same count) kept the old analysis.
  it('the consistency check sees a replaced disjointness, and the terms check a renamed term', async () => {
    const g = await OntologyGraph.fromTurtle(`@prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix ex: <https://example.org/> .
<https://example.org/> a owl:Ontology .
ex:A a owl:Class . ex:B a owl:Class . ex:C a owl:Class . ex:A owl:disjointWith ex:C .
ex:p a owl:DatatypeProperty .`);
    expect(g.namespace).toBe('https://example.org/');
    const data = await parseData('<https://example.org/x> a <https://example.org/A>, <https://example.org/B> ; <https://example.org/q> "v" .', 'turtle');
    expect(dataConsistency(g, data).consistent).toBe(true);
    expect(checkTerms(g, data).some((i) => i.term === 'https://example.org/q')).toBe(true);
    const ex = (l: string) => nn(`https://example.org/${l}`);
    const disjoint = nn('http://www.w3.org/2002/07/owl#disjointWith');
    g.store.removeQuad(quad(ex('A'), disjoint, ex('C')));
    g.store.addQuad(quad(ex('A'), disjoint, ex('B')));
    const type = nn('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
    const prop = nn('http://www.w3.org/2002/07/owl#DatatypeProperty');
    g.store.removeQuad(quad(ex('p'), type, prop));
    g.store.addQuad(quad(ex('q'), type, prop));
    expect(dataConsistency(g, data).consistent).toBe(false);
    expect(checkTerms(g, data).some((i) => i.term === 'https://example.org/q')).toBe(false);
  });
});
