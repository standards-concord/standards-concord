---
name: ontology-checking
description: Check an OWL ontology or a proposed change for quality and logical soundness - lint, OWL 2 DL reasoning with sparq checkOwlDl, imports, FAIR metadata, competency questions, derived SHACL and data validation. Use before proposing or releasing, or when asked whether an ontology or data is valid.
---

# Checking an ontology

Use this when someone asks whether an ontology (or a draft change, a fork, or a set of terms) is sound, before proposing or releasing a change, or when data has to be checked against an ontology. The layers below mirror Concord's validation gate, which every change request goes through, so a clean result here means a clean result there.

**What "passes" means in Concord:** no lint *errors* under strict rules, the OWL 2 DL reasoner *finished* and found the ontology consistent, and no class is unsatisfiable. If the reasoner gives no verdict, the check fails closed: "couldn't decide" is never reported as "fine". FAIR checks and lint warnings are advisory but should be explained, not ignored. Competency questions, when an ontology has them, must return their expected answers.

Run the layers in order. A later layer's results mean little if an earlier one fails.

## 1. Parse

The file must parse as RDF (Turtle, RDF/XML, JSON-LD, N-Triples) and have **exactly one** `owl:Ontology` header. If you are checking a union of several files, merge their headers first: sparq refuses a graph with more than one ontology header.

## 2. Lint (naming, annotations, structure, header)

Check every term in the ontology's own namespace. Concord's lint codes, worst first:

**Errors (block a change)**
- `multiple-labels`: more than one `rdfs:label` in a language (synonyms belong in `skos:altLabel`)
- `label-collision`: two non-deprecated terms share a label
- `undeclared-term`: an IRI used in an axiom, type or predicate that is not declared here, imported or well known
- `datatype-range-is-class`, `object-range-is-datatype`, `property-kind-conflict`: object vs datatype property confusion
- `illegal-builtin-use`: axioms about `owl:`, `rdf:`, `rdfs:` or `xsd:` terms
- code lists: `code-missing-pref-label`, `code-missing-scheme`, `code-invalid-scheme`, `code-duplicate-notation`, `code-invalid-broader`, `code-broader-cycle`, `property-invalid-code-list`
- under strict rules also: `missing-label`, `missing-definition`, `multiple-definitions`, `naming-class-case`, `naming-property-case`, `subclass-cycle`, missing header title, description or licence

**Warnings (explain or fix)**
- `missing-domain`, `missing-range`; `multiple-domains`, `multiple-ranges` (they intersect)
- `definition-not-genus-differentia` (definition doesn't mention the superclass), `definition-circular`, `definition-restates-label`
- `deprecated-without-reason`, `misused-replaced-by`, `deprecated-term-used`
- `equivalent-pair`, `punning`, `range-not-class`, `annotation-whitespace`, header gaps (creator, versionIRI, versionInfo, preferred prefix and namespace)

**Info**: `datatype-not-owl2` (for example `xsd:date`: reasoners treat it as `rdfs:Literal`), `deprecated-without-replacement`, `many-direct-subclasses`, `missing-superclass`, `missing-disjointness`.

The ontology-term-drafting skill says how to fix each of these.

## 3. OWL 2 DL reasoning (sparq `checkOwlDl`)

Concord reasons with sparq's `checkOwlDl` (WebAssembly, SROIQ(D)), on the server and in the browser. It answers:

- **Consistent?** `true`, `false` or `'unknown'`.
- **Unsatisfiable classes**: classes that can have no members. Any one fails the gate; usually a disjointness clash, a contradictory restriction, or a domain/range that conflicts with disjointness.
- **Inferred subclass relations** not asserted. Concord reports only *direct*, non-told ones. Review them: an unexpected one ("Person is a Place") is a modelling bug even though nothing is "inconsistent".
- **Profile**: whether the graph is in OWL 2 DL, with violations.

When the verdict is `'unknown'`, `reason.kind` says why. Treat each as a failure to fix, not a pass:

| `reason.kind` | Meaning | Usual fix |
|---|---|---|
| `NotInDl` | Outside OWL 2 DL (e.g. a non-simple property in a cardinality restriction, untyped IRIs, an IRI used as two property kinds) | Fix the listed violations |
| `OutOfFragment` | A construct sparq doesn't decide | Check `reason.construct`; rewrite, or rewrite datatypes outside the OWL 2 map to `rdfs:Literal` before reasoning (Concord does this and says so) |
| `ImportsNotLoaded` | `owl:imports` targets weren't supplied | Load the import closure (layer 4) |
| `ResourceBudget` | Ran out of its work budget | Simplify, or raise `budget.maxSteps` / `maxNodes` deliberately |
| `DatatypeUnknown`, `Unconfirmed` | Couldn't settle a datatype or nominal question | Inspect the triple named in `reason.triples` |

**Running it yourself** (Node 20+ or a browser; `@sparq-org/sparq` 0.1.8 or later, the first npm release with `checkOwlDl`):

```js
import { Parser, Writer } from 'n3';
import { checkOwlDl } from '@sparq-org/sparq';
import { readFileSync } from 'node:fs';

const quads = new Parser().parse(readFileSync('ontology.ttl', 'utf8'));
const nt = new Writer({ format: 'N-Triples' }).quadsToString(quads);
const r = await checkOwlDl(nt, undefined, { format: 'ntriples' });
console.log(r.consistent, r.unsatisfiable, r.reason, r.profile.violations);
```

The second argument takes instance data (an ABox) in the same format, to check data consistency against the ontology. Without the connector or sparq, Concord's change-request validation report (layer 8) runs the same reasoner for you.

## 4. Imports and co-used ontologies

If the ontology has `owl:imports`, reason over the ontology *together with* its import closure: a change can be consistent alone and break with an import. Check that no class becomes unsatisfiable that wasn't before, and that every import resolves. Pin imports to version IRIs where you can. In Concord, an ontology can list "committed federations" whose breakage fails a change request.

## 5. FAIR metadata

Modelled on the FOOPS! checks. On the ontology header, look for: an IRI on a persistent identifier service (w3id.org, purl.org, doi.org); an `owl:versionIRI` distinct from the ontology IRI; `owl:versionInfo`; `dcterms:title`, `dcterms:description`, `dcterms:license` (a recognised open licence URL), `dcterms:creator`; keywords (`dcat:keyword`); `vann:preferredNamespacePrefix` and `vann:preferredNamespaceUri`; HTTP(S) IRIs. Report only failing checks unless asked for all of them.

## 6. Competency questions

Competency questions are the ontology's tests: a plain-language question, a SPARQL query, small example data, and the expected answer. For each:

1. Load the ontology plus the example data (Concord uses an in-memory store; any SPARQL 1.1 engine works).
2. Run the query; compare with the expected answer.
3. A question that can't be written as a query over the ontology's terms is a modelling gap: report it.

Write a negative example too where it matters ("this record is *not* an active opportunity").

## 7. SHACL shapes

In Concord SHACL is **always derived from the OWL**, never authored separately: one `sh:NodeShape` per named class (`sh:targetClass`), with property shapes from domain/range, restrictions and characteristics. So to change what data is required, change the OWL. Mapping to expect:

| OWL | Derived SHACL |
|---|---|
| `p some C` / `min n` (qualified where OWL needs it) | `sh:minCount 1` / `n` (with `sh:qualifiedValueShape` when not every value must be a C) |
| `max n`, functional property | `sh:maxCount n`, `sh:maxCount 1` |
| `only C`, object property range | `sh:class C` |
| datatype range | `sh:datatype`, or a value-space check (`sh:or` of the type and the types derived from it, e.g. `xsd:integer` also takes `xsd:byte`) |
| range is a code list | `sh:in` with every code, deprecated ones included |

Check the shapes against example data that should pass *and* data that should fail. Get the shapes with the connector's `get_ontology` (format `shacl`, or `shaclc` for the readable compact form), or from `/def/<slug>/<version>.shacl.ttl`.

## 8. Checking data against an ontology

- **Concord connector:** `validate_data` with the data, its format, and `version` (`"draft"`, a release such as `1.2.0`, or the default latest release). It checks the derived SHACL shapes, terms the ontology doesn't define or has deprecated, and logical contradictions.
- **HTTP:** `POST` the data to the ontology or version address: `curl -X POST https://standards-concord.vercel.app/def/<slug>/<version> -H 'Content-Type: text/turtle' --data-binary @data.ttl`. JSON report by default (`conforms` = SHACL only, `valid` = SHACL plus no term errors); `Accept: text/turtle` returns a SHACL `sh:ValidationReport`. Turtle, JSON-LD, N-Triples, N-Quads, TriG and RDF/XML; up to 5 MB (JSON-LD 2 MB) or 25,000 triples, 30 requests a minute.
- **A live SPARQL endpoint:** in the web app, *Validate data → Check data in a SPARQL endpoint* pulls a bounded sample (one fixed `CONSTRUCT` per class, at most 25,000 triples or 5 MB) from the browser. The endpoint must allow CORS (`Access-Control-Allow-Origin`); no credentials are sent. A sample that stops at the limit is a sample, not the whole dataset: say so when reporting.

When reporting data problems, group them by shape and property, give one example focus node for each, and say how to write the value correctly.

## 9. Impact of a change

For a proposed change, also say what it does to people already using the ontology:
- The classifier's level (patch, minor, major) and its reasons. See the ontology-term-drafting skill, section 8, for what counts as breaking.
- New inferred subclass relations over *existing* terms (an entailment change, even when the classifier says minor).
- Whether existing example data or app checks still pass. In Concord, connected apps test themselves against each open change request and report on it.

## How to report

Lead with the verdict in one line ("Passes: consistent, no unsatisfiable classes, 0 lint errors, 3 warnings"). Then list what needs action, grouped by layer, each with the term, the problem in plain words, and the fix. Put engine details, timings and passing checks one click (or one "details" section) away. Never present an `'unknown'` reasoner result or a skipped layer as a pass; say which layer was skipped and why.
