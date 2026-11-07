import { describe, expect, it } from 'vitest';
import { OntologyGraph, owlReasoner, resolveImportClosure, unionGraph, validate, type ImportResolver, type ResolvedImport } from '../src/index.js';

const BASE = `@prefix : <https://ex.org/base#> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<https://ex.org/base> a owl:Ontology ; rdfs:label "Base" .
:Person a owl:Class ; rdfs:label "person" .
:Organisation a owl:Class ; rdfs:label "organisation" ; owl:disjointWith :Person .`;

const importer = (extra = '') => `@prefix : <https://ex.org/app#> . @prefix b: <https://ex.org/base#> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<https://ex.org/app> a owl:Ontology ; rdfs:label "App" ; owl:imports <https://ex.org/base> .
b:Person a owl:Class . b:Organisation a owl:Class .
:Member a owl:Class ; rdfs:label "member" ; rdfs:subClassOf b:Person .
${extra}`;

async function resolverFor(map: Record<string, string>): Promise<ImportResolver> {
  const graphs = Object.fromEntries(await Promise.all(Object.entries(map).map(async ([iri, ttl]) => [iri, await OntologyGraph.fromTurtle(ttl)] as const)));
  return async (iri) => {
    const graph = graphs[iri];
    if (!graph) return null;
    return { iri, graph, title: graph.metadata().title ?? iri, version: '1.0.0', ontologyId: iri, revision: 'r1' } satisfies ResolvedImport;
  };
}

describe('checking an ontology with its imports', () => {
  it('cannot be reasoned over alone, because sparq needs its imports loaded', async () => {
    const g = await OntologyGraph.fromTurtle(importer());
    const r = await owlReasoner(g);
    expect(r.available).toBe(false);
    expect(r.error).toMatch(/owl:imports targets were not loaded/);
  });

  it('passes when the union with the imported ontology is consistent', async () => {
    const g = await OntologyGraph.fromTurtle(importer());
    const imports = await resolveImportClosure(g, await resolverFor({ 'https://ex.org/base': BASE }));
    expect(imports.imported.map((i) => i.iri)).toEqual(['https://ex.org/base']);
    const report = await validate(g, { imports });
    expect(report.imports).toMatchObject({ passed: true, consistent: true, checked: 'complete', unsatisfiable: [], blame: [] });
    expect(report.reasoner).toMatchObject({ available: true, consistent: true, unsatisfiable: [] });
  });

  // Used to go wrong: each ontology was checked alone, so a class under two classes that an
  // imported ontology declares disjoint looked fine.
  it('fails a class that is unsatisfiable only because of an imported disjointness, and blames the import', async () => {
    const g = await OntologyGraph.fromTurtle(importer(':Both a owl:Class ; rdfs:label "both" ; rdfs:subClassOf b:Person, b:Organisation .'));
    const imports = await resolveImportClosure(g, await resolverFor({ 'https://ex.org/base': BASE }));
    const report = await validate(g, { imports });
    expect(report.passed).toBe(false);
    expect(report.imports?.unsatisfiable).toEqual(['https://ex.org/app#Both']);
    expect(report.imports?.blame).toEqual([{ import: 'https://ex.org/base', title: 'Base', inconsistent: false, unsatisfiable: ['https://ex.org/app#Both'] }]);
    expect(report.reasoner.unsatisfiable).toEqual(['https://ex.org/app#Both']);
  });

  it("reports axioms it states about an imported ontology's terms", async () => {
    const g = await OntologyGraph.fromTurtle(importer('b:Person rdfs:subClassOf :Member .'));
    const imports = await resolveImportClosure(g, await resolverFor({ 'https://ex.org/base': BASE }));
    const report = await validate(g, { imports });
    expect(report.imports?.foreignAxioms).toEqual([{ subject: 'https://ex.org/base#Person', predicate: 'http://www.w3.org/2000/01/rdf-schema#subClassOf', object: 'https://ex.org/app#Member', owner: 'Base' }]);
  });

  it('lists an import Concord does not host as not checked, and follows imports transitively', async () => {
    const mid = `@prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<https://ex.org/mid> a owl:Ontology ; rdfs:label "Mid" ; owl:imports <https://ex.org/base>, <https://elsewhere.example/x> .`;
    const g = await OntologyGraph.fromTurtle(importer().replace('owl:imports <https://ex.org/base>', 'owl:imports <https://ex.org/mid>'));
    const imports = await resolveImportClosure(g, await resolverFor({ 'https://ex.org/base': BASE, 'https://ex.org/mid': mid }));
    expect(imports.imported.map((i) => [i.iri, i.via])).toEqual([
      ['https://ex.org/mid', 'https://ex.org/app'],
      ['https://ex.org/base', 'https://ex.org/mid'],
    ]);
    expect(imports.unresolved).toEqual([{ iri: 'https://elsewhere.example/x', via: 'https://ex.org/mid', reason: 'not-hosted' }]);
  });

  it('merges every ontology under the importing ontology’s one header, with no owl:imports left', async () => {
    const g = await OntologyGraph.fromTurtle(importer());
    const base = await OntologyGraph.fromTurtle(BASE);
    const u = unionGraph(g, [{ graph: base }]);
    const ontologies = u.store.getSubjects('http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'http://www.w3.org/2002/07/owl#Ontology', null).map((t) => t.value);
    expect(ontologies).toEqual(['https://ex.org/app']);
    expect(u.store.countQuads(null, 'http://www.w3.org/2002/07/owl#imports', null, null)).toBe(0);
    expect(u.isDeclared('https://ex.org/base#Organisation')).toBe(true);
  });

  // Review r1: the root kept its blank node labels while imports got "imp<i>_" prefixes, so a root node
  // labelled _:imp0_x and the first import's _:x became one node, merging unrelated restrictions.
  it('keeps every input’s blank nodes apart, whatever labels they use', async () => {
    const H = '@prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .';
    const root = await OntologyGraph.fromTurtle(`${H} <https://ex.org/a> a owl:Ontology . <https://ex.org/a#C> a owl:Class ; rdfs:subClassOf _:imp0_x . _:imp0_x a owl:Restriction ; owl:onProperty <https://ex.org/a#p> ; owl:someValuesFrom owl:Thing .`);
    const imp = await OntologyGraph.fromTurtle(`${H} <https://ex.org/b> a owl:Ontology . <https://ex.org/b#D> a owl:Class ; rdfs:subClassOf _:x . _:x a owl:Restriction ; owl:onProperty <https://ex.org/b#q> ; owl:allValuesFrom owl:Nothing .`);
    // n3 relabels parsed blank nodes, so name them exactly as the review described.
    const relabel = (g: OntologyGraph, from: (v: string) => boolean, to: string) => {
      const s = new (g.store.constructor as any)();
      for (const q of g.store.getQuads(null, null, null, null)) {
        const f = (t: any) => (t.termType === 'BlankNode' && from(t.value) ? { termType: 'BlankNode', value: to, equals: (o: any) => o?.termType === 'BlankNode' && o.value === to } : t);
        s.addQuad(f(q.subject), q.predicate, f(q.object));
      }
      return new OntologyGraph(s, {});
    };
    const u = unionGraph(relabel(root, () => true, 'imp0_x'), [{ graph: relabel(imp, () => true, 'x') }]);
    const restrictions = u.store.getSubjects('http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'http://www.w3.org/2002/07/owl#Restriction', null);
    expect(restrictions).toHaveLength(2);
    for (const r of restrictions) expect(u.store.countQuads(r, 'http://www.w3.org/2002/07/owl#onProperty', null, null)).toBe(1);
  });
});
