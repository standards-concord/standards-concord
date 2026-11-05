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
    expect(resourceProblem(tree('SELECT ?b WHERE { ?s ?p ?o BIND(CONCAT(CONCAT(CONCAT(?o, ?o, ?o, ?o, ?o), ?o, ?o, ?o, ?o, ?o), ?o, ?o) AS ?b) }'))).toMatch(/characters/);
    // Inside a subquery, and passed out of one.
    const inner = doubling(20).replace(/^SELECT \?v20 WHERE \{|\}$/g, '');
    expect(resourceProblem(tree(`SELECT ?big WHERE { { SELECT ?v20 WHERE { ${inner} } } BIND(CONCAT(?v20, ?v20) AS ?big) }`))).toMatch(/characters/);
    expect(resourceProblem(tree(`SELECT * WHERE { { SELECT * WHERE { { SELECT ?v20 WHERE { ${inner} } } } } }`))).toMatch(/characters/);
    // In one branch of a UNION, an OPTIONAL or a FILTER EXISTS.
    expect(resourceProblem(tree(`SELECT * WHERE { { ?s ?p ?o } UNION { ${inner} } }`))).toMatch(/characters/);
    expect(resourceProblem(tree(`SELECT * WHERE { ?s ?p ?o OPTIONAL { ${inner} } }`))).toMatch(/characters/);
    expect(resourceProblem(tree(`SELECT * WHERE { ?s ?p ?o FILTER EXISTS { ${inner} } }`))).toMatch(/characters/);
    // A variable that may be unbound on some rows (UNDEF, OPTIONAL, one branch of a UNION) lets a long value through
    // a join unchanged: the shorter estimate used to win, and this built 131,072 characters.
    const long = `{ SELECT ?x WHERE { ${doubling(16).replace(/^SELECT \?v16 WHERE \{|\}$/g, '')} BIND(?v16 AS ?x) } }`;
    for (const maybe of ['VALUES ?x { UNDEF }', 'OPTIONAL { BIND("a" AS ?x) }', '{ BIND("a" AS ?x) } UNION { BIND(1 AS ?y) }'])
      expect(resourceProblem(tree(`SELECT ?big WHERE { ${maybe} ${long} BIND(CONCAT(?x, ?x) AS ?big) }`)), maybe).toMatch(/characters/);
    // Growth built on GROUP_CONCAT (whose own size depends on the data) still counts.
    expect(resourceProblem(tree(`SELECT ?big WHERE { { SELECT (GROUP_CONCAT(?o) AS ?g) WHERE { ?s ?p ?o } } BIND(CONCAT(?g, ?g, ?g) AS ?big) }`))).toMatch(/characters/);
  });

  it('lets ordinary string building through', () => {
    for (const q of [
      // An inner and an outer ?x are different variables: this returns "aa" (it used to be estimated at 5 million characters).
      'SELECT ?x WHERE { { SELECT (CONCAT(?x, ?x) AS ?y) WHERE { VALUES ?x { "a" } } } BIND(?y AS ?x) }',
      // Eleven copies of a one-character value are eleven characters, whatever order the text puts them in.
      `SELECT (CONCAT(${Array(11).fill('?x').join(', ')}) AS ?y) WHERE { BIND("x" AS ?x) }`,
      `SELECT ?y WHERE { BIND("x" AS ?x) BIND(CONCAT(${Array(11).fill('?x').join(', ')}) AS ?y) }`,
      'SELECT ?y WHERE { { BIND("ab" AS ?x) } UNION { BIND("cd" AS ?x) } BIND(CONCAT(?x, ?x, ?x) AS ?y) }',
      // A FILTER is judged with its whole group's bindings, wherever it is written (it used to be refused when written first).
      `SELECT ?x WHERE { FILTER(STRLEN(CONCAT(${Array(11).fill('?x').join(',')})) > 0) VALUES ?x { "x" } }`,
      `SELECT ?x WHERE { VALUES ?x { "x" } FILTER(STRLEN(CONCAT(${Array(11).fill('?x').join(',')})) > 0) }`,
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
