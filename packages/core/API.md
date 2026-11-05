# @concord/core — public API contract

All types are in `src/types.ts`. `src/index.ts` must export exactly these (plus the types):

```ts
// Graph handling (N3.js Store underneath)
export class OntologyGraph {
  static fromTurtle(turtle: string, baseIRI?: string): Promise<OntologyGraph>;   // also accepts RDF/XML if the text starts with '<?xml' or '<rdf:RDF'
  static parse(text: string, format: 'turtle' | 'rdfxml' | 'jsonld' | 'ntriples'): Promise<OntologyGraph>;
  static empty(opts: { iri: string; namespace: string; prefix: string; title: string; description?: string; creators?: string[]; license?: string }): OntologyGraph; // emits owl:Ontology header with FAIR metadata
  clone(): OntologyGraph;
  readonly store: import('n3').Store;
  readonly prefixes: Record<string, string>;
  readonly ontologyIRI: string;
  readonly namespace: string;            // preferred namespace (vann:preferredNamespaceUri) or derived from ontology IRI
  size: number;
  view(): OntologyView;
  term(iri: string): TermView | undefined;
  search(query: string, limit?: number): TermView[];   // label/altLabel/definition/local-name fuzzy match
  toTurtle(): Promise<string>;            // pretty, grouped by subject, ontology header first, stable ordering (deterministic output — important for git diffs)
}

export function serialize(graph: OntologyGraph, format: OutputFormat): Promise<string>;
export const FORMAT_INFO: Record<OutputFormat, { label: string; mediaType: string; extension: string }>;

// Changes
export function applyChangeOps(graph: OntologyGraph, ops: ChangeOp[], ctx?: { author?: string; date?: string; source?: string }):
  { graph: OntologyGraph; warnings: string[]; touched: string[] };     // returns a NEW graph, never mutates input. Throws ChangeOpError on invalid op (unknown IRI etc.)
export class ChangeOpError extends Error { opIndex: number }
export function diffOntologies(before: OntologyGraph, after: OntologyGraph): OntologyDiff;
export function classifyChange(diff: OntologyDiff, before?: OntologyGraph, after?: OntologyGraph): ChangeClassification;
export const CLASSIFICATION_RULES: { id: string; level: ChangeLevel; description: string }[];  // for display in UI

// Versioning
export function bumpVersion(version: string, level: ChangeLevel): string;  // semver
export function stampRelease(graph: OntologyGraph, opts: { version: string; versionIRIBase?: string; priorVersionIRI?: string; level: ChangeLevel; date: string; backwardCompatible: boolean }): OntologyGraph;
   // sets owl:versionIRI (`${ontologyIRI}/${version}` by default unless base given), owl:versionInfo, owl:priorVersion, owl:backwardCompatibleWith or owl:incompatibleWith, dcterms:modified/issued

// Quality
export function lint(graph: OntologyGraph, opts?: { strict?: boolean }): Issue[];
export function fairCheck(graph: OntologyGraph): FairReport;
export function structuralReasoner(graph: OntologyGraph): ReasonerResult;  // pure TS: subclass closure, disjointness violations, unsatisfiable via disjoint ancestors, domain/range conflicts with disjointness, individuals typed with disjoint classes, cycles in subClassOf (warning, implies equivalence)
export function owlReasoner(graph: OntologyGraph, opts?: { budget?: { maxSteps?: number; maxNodes?: number } }): Promise<ReasonerResult>; // sparq's OWL 2 DL reasoner (checkOwlDl, WebAssembly; Node and browser): consistency, unsatisfiable classes, direct inferred subclasses, profile notes; falls back to structuralReasoner with available:false and the reason when sparq gives no verdict
export function runCompetencyQuestions(graph: OntologyGraph, cqs: { question: string; sparql: string; exampleData?: string }[]): Promise<CompetencyQuestionResult[]>; // oxigraph in-memory, loads ontology + optional example Turtle data
export function validate(graph: OntologyGraph, opts?: { cqs?: {question:string; sparql:string; exampleData?: string}[]; reasoner?: 'owl' | 'structural' }): Promise<ValidationReport>;

// Formats
export function toLinkML(graph: OntologyGraph): string;                   // YAML string; LinkML schema (id, name, prefixes, default_prefix, imports linkml:types, classes with is_a/mixins/description/slot_usage, slots with range/required/multivalued/domain, enums for owl:oneOf if present)
export function fromLinkML(yaml: string): Promise<OntologyGraph>;        // subset inverse
export function toManchester(graph: OntologyGraph): string;
export function toShacl(graph: OntologyGraph): Promise<string>;           // derive SHACL node shapes from classes + restrictions + domain/range (Turtle)

// Helpers
export function compactIRI(iri: string, prefixes: Record<string, string>): string;
export function expandIRI(curieOrIri: string, prefixes: Record<string, string>): string;
export function localName(iri: string): string;
export function isValidLocalName(name: string, kind: 'class' | 'property' | 'individual'): boolean; // UpperCamelCase classes, lowerCamelCase properties
export const XSD: Record<string, string>;  // common datatypes
export const NS: { owl, rdf, rdfs, xsd, skos, dcterms, dc, vann, prov, sh, schema, foaf, obo } // namespace strings
```

## Conventions enforced (strict mode)
- Every owl:Class / owl:ObjectProperty / owl:DatatypeProperty declared in the ontology namespace has exactly one `rdfs:label` (@en), exactly one `skos:definition`.
- Classes UpperCamelCase, properties lowerCamelCase, no spaces/underscores in local names.
- Class definitions should be genus–differentia ("A <superclass label> that …") – warning if the definition does not mention the label of a superclass (info level if no superclass).
- Every class except roots should have a superclass; warn on more than 7 direct subclasses? (info)
- No undeclared terms used in axioms (error) unless they are in owl:imports or well-known vocabularies (rdfs/owl/xsd/skos/dcterms/prov/schema/foaf).
- Properties should have domain and range (warning) ; datatype property range must be an XSD/rdf datatype (error if class).
- Object property range must not be a datatype (error).
- `owl:deprecated true` terms must have `rdfs:comment`/`skos:historyNote` reason (warning) and should have `dcterms:isReplacedBy` (info).
- Deprecated terms must not be used in axioms of non-deprecated terms (warning).
- Cycles in rdfs:subClassOf (error in strict).
- Ontology header: dcterms:title, dcterms:description, dcterms:license, dcterms:creator, owl:versionIRI, owl:versionInfo, vann:preferredNamespacePrefix/Uri (FAIR checks).
- Punning (IRI typed as both class and individual/property) → warning.
- Label collisions (two terms same label) → error.

Classification rules: see `src/classify.ts` CLASSIFICATION_RULES. Default semantics:
- major: removing a term; renaming (IRI change); changing a property's domain/range to something narrower or unrelated; adding superclass to an existing class (narrows instances? – actually it *broadens inferences*; treat as major if it can make existing data inconsistent: adding disjointness, adding restrictions only/cardinality max/exactly to existing class, making property functional/inverseFunctional/asymmetric/irreflexive); changing class to a different kind; removing superclass; un-deprecating?; changing namespace.
- minor: adding new terms; deprecating a term (with replacement); adding `some`/min restriction to new class only; broadening domain/range (to a superclass) ; adding altLabels/examples to terms *does* = patch.
- patch: annotation-only changes to existing terms (label wording, definition clarification, comment, examples, altLabels, editorial notes), metadata changes.
Overall level = max of reasons. Empty diff = patch with reason "no-op".
