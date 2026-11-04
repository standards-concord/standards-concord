import { describe, expect, it } from 'vitest';
import { parseSparql, policyProblem, resourceProblem } from '../src/sparqlGuard.js';

const tree = (q: string) => {
  const p = parseSparql(q);
  if ('error' in p) throw new Error(p.error);
  return p.tree;
};

/** BIND chains where each step concatenates the previous value with itself: 2^steps characters from one. */
const doubling = (steps: number, arity = 2) =>
  `SELECT ?v${steps} WHERE { BIND("x" AS ?v0) ${Array.from({ length: steps }, (_, i) => `BIND(CONCAT(${Array(arity).fill(`?v${i}`).join(', ')}) AS ?v${i + 1})`).join(' ')} }`;

describe('resource checks', () => {
  it('refuses expressions that can build enormous values before any row comes back', () => {
    // The reviewer's case: about 840 characters of SPARQL building one 64 MiB value.
    expect(doubling(26).length).toBeLessThan(1000);
    expect(resourceProblem(tree(doubling(26)))).toMatch(/67,108,864 characters \(\?v26\)/);
    expect(resourceProblem(tree(doubling(8, 10)))).toMatch(/characters/);
    // However it is written: in a projection, in a FILTER, nested, with REPLACE.
    expect(resourceProblem(tree(`SELECT (CONCAT(?v20, ?v20) AS ?big) WHERE { ${doubling(20).replace(/^SELECT \?v20 WHERE \{|\}$/g, '')} }`))).toMatch(/characters/);
    expect(resourceProblem(tree('SELECT ?s WHERE { ?s ?p ?o FILTER(STRLEN(REPLACE(STR(?o), "", STR(?p))) > 3) }'))).toMatch(/characters/);
    expect(resourceProblem(tree('SELECT ?b WHERE { BIND(CONCAT(CONCAT(CONCAT(?o, ?o, ?o, ?o, ?o), ?o, ?o, ?o, ?o, ?o), ?o, ?o) AS ?b) ?s ?p ?o }'))).toMatch(/characters/);
  });

  it('lets ordinary string building through', () => {
    for (const q of [
      doubling(10),
      'SELECT ?s (CONCAT(?label, " – ", ?definition) AS ?text) WHERE { ?s <http://www.w3.org/2000/01/rdf-schema#label> ?label ; <http://www.w3.org/2004/02/skos/core#definition> ?definition }',
      'SELECT (REPLACE(STR(?s), "#", "/") AS ?path) WHERE { ?s ?p ?o }',
      'SELECT ?p (GROUP_CONCAT(DISTINCT STR(?o); SEPARATOR=", ") AS ?all) WHERE { ?s ?p ?o } GROUP BY ?p',
      'SELECT ?s WHERE { ?s ?p ?o FILTER(CONTAINS(LCASE(STR(?o)), "park")) } ORDER BY UCASE(STR(?o))',
    ])
      expect(resourceProblem(tree(q)), q).toBeUndefined();
  });

  it('multiplies VALUES lists however their terms and names are written', () => {
    const list = Array.from({ length: 200 }, (_, i) => i);
    expect(resourceProblem(tree(`SELECT * WHERE { VALUES ?a { ${list.join(' ')} } VALUES ?b { ${list.join('+')} } VALUES ?ä { ${list.join(' ')} } VALUES ?é { ${list.join(' ')} } }`))).toMatch(/1,600,000,000 rows/);
    expect(resourceProblem(tree(`SELECT * WHERE { VALUES ?a { ${list.join(' ')} } }`))).toBeUndefined();
  });

  it('policy: read-only, over the page’s own data', () => {
    expect(policyProblem(tree('INSERT DATA { <a:b> <a:c> <a:d> }'))).toMatch(/read-only/);
    expect(policyProblem(tree('SELECT * WHERE { # c\r SERVICE <http://e.org/s> { ?s ?p ?o } }'))).toMatch(/SERVICE/);
    expect(policyProblem(tree('SELECT * FROM <http://e.org/g> WHERE { ?s ?p ?o }'))).toMatch(/FROM/);
    expect(policyProblem(tree(doubling(26)))).toMatch(/characters/);
    expect(policyProblem(tree('SELECT * WHERE { ?s ?p ?o } LIMIT 5'))).toBeUndefined();
  });
});
