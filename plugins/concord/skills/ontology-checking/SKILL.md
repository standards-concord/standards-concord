---
name: ontology-checking
description: Check an OWL ontology or a proposed change for quality and logical soundness - lint, OWL 2 DL reasoning, imports, FAIR metadata, competency questions, SHACL shapes and data validation. Use before publishing a change, or when asked whether an ontology or data is valid.
---

# Checking an ontology

Use this when someone asks whether an OWL ontology (or a draft change, or a set of new terms) is sound, before publishing a change, or when data has to be checked against an ontology. It works with any toolchain; tools are suggested for each layer.

**A sensible gate:** no lint *errors*, an OWL 2 DL reasoner *finished* and found the ontology consistent, and no class is unsatisfiable. If the reasoner gives no verdict (timeout, unsupported construct, outside DL), the check **fails closed**: "couldn't decide" is never reported as "fine". FAIR checks and lint warnings are advisory but should be explained, not ignored. Competency questions, where they exist, must return their expected answers.

Run the layers in order. A later layer's results mean little if an earlier one fails.

## 1. Parse

The file must parse as RDF (Turtle, RDF/XML, JSON-LD, N-Triples, or OWL functional syntax) and normally has **exactly one** `owl:Ontology` header. If you are checking a union of several files, merge their headers first: some reasoners refuse a graph with more than one.

Tools: any RDF parser (rdflib, N3.js, Jena `riot`), `robot convert`.

## 2. Lint (naming, annotations, structure, header)

Check every term in the ontology's own namespace. Most of these match a ROBOT report check or an OOPS! pitfall.

**Errors (should block a change)**
- More than one `rdfs:label` in a language (synonyms belong in `skos:altLabel`); two non-deprecated terms sharing a label
- A missing label or definition on a local term; more than one definition
- An IRI used in an axiom, as a type or as a predicate that is not declared, imported or from a well-known vocabulary
- Object vs datatype property confusion: a datatype property with a class range, an object property with a datatype range, an IRI declared as both
- Axioms about built-in terms (`owl:`, `rdf:`, `rdfs:`, `xsd:`)
- Class or property names that break the naming convention; `rdfs:subClassOf` cycles
- No ontology header, title, description or licence
- Code lists: a code with no `skos:prefLabel` or no scheme, a duplicate notation in one scheme, `skos:broader` to a code in another scheme, broader cycles

**Warnings (explain or fix)**
- Local properties with no domain or range; several domains or ranges (they intersect)
- Class definitions that don't mention the superclass (not genus-differentia), start with their own label, or only restate it
- Deprecated terms with no reason, `isReplacedBy` pointing at another deprecated term or on a term that isn't deprecated, deprecated terms still used in axioms
- Asserted equivalent named classes, punning, a range that isn't declared as a class, stray whitespace in annotations, header gaps (creator, version IRI, version info, preferred prefix and namespace)

**Info**: datatypes outside the OWL 2 map (e.g. `xsd:date`), deprecation with no replacement, more than about seven direct subclasses, classes with no superclass, sibling classes with no disjointness.

The ontology-term-drafting skill says how to fix each of these. Tools: `robot report` covers many; OOPS! (online pitfall scanner); a SPARQL query per rule for the rest.

## 3. OWL 2 DL reasoning

Run a complete OWL 2 DL reasoner and read four things:

- **Consistent?** An inconsistent ontology entails everything; nothing else matters until it is fixed.
- **Unsatisfiable classes**: classes that can have no members. Any one is a bug: usually a disjointness clash, a contradictory restriction, or a domain/range that conflicts with disjointness.
- **Inferred subclass relations** that weren't asserted. Review the direct ones: an unexpected one ("Person is a Place") is a modelling bug even though nothing is inconsistent.
- **Profile**: whether the ontology is in OWL 2 DL at all, with the violations. Outside DL, reasoners may answer incompletely or refuse.

Reasoners: [sparq](https://github.com/sparq-org/sparq)'s `checkOwlDl` (Rust compiled to WebAssembly, runs in Node and the browser, milliseconds on typical vocabularies), HermiT or Pellet (Java; `robot reason --reasoner hermit`, or Protégé), ELK for large OWL 2 EL ontologies (fast, but not complete for full DL), owlready2 (Python, bundles HermiT and Pellet).

**sparq example** (`@sparq-org/sparq` 0.1.8 or later):

```js
import { Parser, Writer } from 'n3';
import { checkOwlDl } from '@sparq-org/sparq';
import { readFileSync } from 'node:fs';

const quads = new Parser().parse(readFileSync('ontology.ttl', 'utf8'));
const nt = new Writer({ format: 'N-Triples' }).quadsToString(quads);
const r = await checkOwlDl(nt, undefined, { format: 'ntriples' });
console.log(r.consistent, r.unsatisfiable, r.inferredSubClassOf, r.reason, r.profile.violations);
```

The second argument takes instance data (an ABox) in the same format, to check data consistency against the ontology. `consistent` is `true`, `false` or `'unknown'`; when it is `'unknown'`, `reason.kind` says why, and each is a failure to fix, not a pass:

| `reason.kind` | Meaning | Usual fix |
|---|---|---|
| `NotInDl` | Outside OWL 2 DL (e.g. a non-simple property in a cardinality restriction, undeclared IRIs, an IRI used as two property kinds) | Fix the listed violations |
| `OutOfFragment` | A construct it doesn't decide | Check `reason.construct`; rewrite it, or map datatypes outside the OWL 2 map to `rdfs:Literal` before reasoning (and say you did) |
| `ImportsNotLoaded` | `owl:imports` targets weren't supplied | Load the import closure (layer 4) |
| `ResourceBudget` | Ran out of its work budget | Simplify, or raise `budget.maxSteps` / `maxNodes` deliberately |
| `DatatypeUnknown`, `Unconfirmed` | Couldn't settle a datatype or nominal question | Inspect the triple named in `reason.triples` |

Other reasoners fail differently (exceptions, timeouts, "unsupported datatype"); treat all of them the same way.

## 4. Imports and co-used ontologies

If the ontology has `owl:imports`, reason over the ontology *together with* its import closure: a change can be consistent alone and break with an import. Check that every import resolves, and that no class becomes unsatisfiable that wasn't before. Pin imports to version IRIs where you can, so an upstream release can't change your results silently. If your ontology is routinely used alongside others (a profile, an application ontology), check the combination too.

## 5. FAIR metadata

Modelled on the FOOPS! checks. On the ontology header, look for: an IRI on a persistent identifier service (w3id.org, purl.org, doi.org); an `owl:versionIRI` distinct from the ontology IRI; `owl:versionInfo`; `dcterms:title`, `dcterms:description`, `dcterms:license` (a recognised open licence URL), `dcterms:creator`; keywords (`dcat:keyword`); `vann:preferredNamespacePrefix` and `vann:preferredNamespaceUri`; HTTP(S) IRIs that resolve, with content negotiation for RDF. Report only failing checks unless asked for all of them. Tool: FOOPS! (online).

## 6. Competency questions

Competency questions are the ontology's tests: a plain-language question, a SPARQL query, small example data, and the expected answer. For each:

1. Load the ontology plus the example data into a SPARQL 1.1 engine (Jena, Oxigraph, rdflib, sparq).
2. Run the query; compare with the expected answer.
3. A question that can't be written as a query over the ontology's terms is a modelling gap: report it.

Write a negative example too where it matters ("this record is *not* an active opportunity").

## 7. SHACL shapes

OWL infers; it doesn't reject. Data that breaks a domain, range or `some` restriction is not an error to an OWL reasoner. To reject data, use SHACL shapes. Deriving them from the OWL keeps the two from drifting apart. A typical mapping:

| OWL | SHACL |
|---|---|
| A named class | A `sh:NodeShape` with `sh:targetClass` |
| `p some C` / `min n` | `sh:minCount 1` / `n` (with `sh:qualifiedValueShape` when not every value must be a C) |
| `max n`, functional property | `sh:maxCount n`, `sh:maxCount 1` |
| `only C`, object property range | `sh:class C` |
| datatype range | `sh:datatype`, or `sh:or` of the type and the types derived from it (so `xsd:integer` also takes `xsd:byte`) |
| range is a code list | `sh:in` with every code, deprecated ones included |

Check the shapes against example data that should pass *and* data that should fail. Tools: pySHACL, Jena SHACL, TopQuadrant SHACL, sparq's SHACL engine; SHACL compact syntax (SHACLC) is easier to review by eye.

## 8. Checking data against an ontology

1. Parse the data and check its size first; set limits for anything user-supplied.
2. Validate it against the SHACL shapes (layer 7).
3. Check that every class and property it uses is defined by the ontology (or a known vocabulary) and not deprecated. SHACL won't catch a typo in a predicate.
4. Optionally reason over ontology plus data for contradictions (e.g. an individual typed with two disjoint classes).

For a live SPARQL endpoint, check a bounded sample rather than the whole store: a fixed `CONSTRUCT` per class with a `LIMIT`, a cap on total triples and bytes, and a timeout. A sample that stops at the cap is a sample, not the whole dataset: say so when reporting.

When reporting data problems, group them by shape and property, give one example focus node for each, and say how to write the value correctly.

## 9. Impact of a change

For a proposed change, also say what it does to people already using the ontology:
- Its level (patch, minor, major) and why. See the ontology-term-drafting skill, section 8.
- New inferred subclass relations over *existing* terms: an entailment change, even when the edit looks additive.
- Whether existing example data, competency questions and known applications still pass against the changed version.

## How to report

Lead with the verdict in one line ("Passes: consistent, no unsatisfiable classes, 0 lint errors, 3 warnings"). Then list what needs action, grouped by layer, each with the term, the problem in plain words, and the fix. Put engine details, timings and passing checks in a details section. Never present an undecided reasoner result or a skipped layer as a pass; say which layer was skipped and why.
