/**
 * Core ontology types shared by the engine, the server and the web app.
 *
 * The OWL ontology (as RDF) is always the source of truth. `OntologyView` is a
 * read-only projection for display; `ChangeOp` is the only way the platform
 * (and the LLM) mutates an ontology, so every change is structured, diffable
 * and classifiable.
 */

export type IRI = string;

export type ChangeLevel = 'patch' | 'minor' | 'major';

export type OutputFormat =
  | 'turtle'
  | 'ntriples'
  | 'rdfxml'
  | 'jsonld'
  | 'manchester'
  | 'linkml'
  | 'shacl'
  | 'shaclc'
  | 'typescript'
  | 'javascript';

export type PropertyCharacteristic =
  | 'functional'
  | 'inverseFunctional'
  | 'transitive'
  | 'symmetric'
  | 'asymmetric'
  | 'reflexive'
  | 'irreflexive';

export type RestrictionKind = 'some' | 'only' | 'min' | 'max' | 'exactly' | 'value';

export interface Restriction {
  property: IRI;
  kind: RestrictionKind;
  /** Class IRI, datatype IRI (e.g. xsd:string expanded), or for `value` an IRI/literal. */
  filler?: IRI;
  /** For `value` restrictions on datatype properties. */
  literal?: string;
  cardinality?: number;
  /** Addition: Manchester rendering of a complex (anonymous) filler, e.g. "(vol:A or vol:B)". */
  fillerExpression?: string;
}

export interface TermAnnotations {
  label?: string;
  /** skos:definition — a genus–differentia definition is expected for classes. */
  definition?: string;
  comment?: string;
  altLabels?: string[];
  examples?: string[];
  /** Free-text editorial note, e.g. where the term came from. */
  editorialNote?: string;
  /** dcterms:source — a use case, meeting or URL the term was elicited from. */
  source?: string[];
  /**
   * Addition: mapping annotations (skos:exactMatch/closeMatch/broadMatch/narrowMatch/relatedMatch,
   * rdfs:seeAlso), keyed by the mapping property IRI.
   */
  mappings?: Record<IRI, IRI[]>;
}

export interface TermBase extends TermAnnotations {
  iri: IRI;
  deprecated?: boolean;
  replacedBy?: IRI;
}

export interface ClassView extends TermBase {
  kind: 'class';
  superClasses: IRI[];
  equivalentClasses: IRI[];
  disjointWith: IRI[];
  restrictions: Restriction[];
  /** Addition: anonymous non-restriction superclasses (e.g. unions), in Manchester syntax. */
  superClassExpressions?: string[];
  /**
   * Addition: for each anonymous superclass that is an intersection of named classes and
   * simple restrictions, its parts (the expression is also in superClassExpressions).
   */
  superClassConjuncts?: { expression: string; classes: IRI[]; restrictions: Restriction[] }[];
  /** Addition: anonymous equivalent class expressions (logical definitions), in Manchester syntax. */
  equivalentExpressions?: string[];
}

export interface PropertyView extends TermBase {
  kind: 'objectProperty' | 'datatypeProperty' | 'annotationProperty';
  domain: IRI[];
  range: IRI[];
  superProperties: IRI[];
  inverseOf?: IRI;
  characteristics: PropertyCharacteristic[];
  /** Addition: anonymous domain/range expressions (e.g. unions), in Manchester syntax. */
  domainExpressions?: string[];
  rangeExpressions?: string[];
  /** Controlled values from this SKOS concept scheme; replaces the property range. */
  codeList?: IRI;
}

export interface IndividualView extends TermBase {
  kind: 'individual';
  types: IRI[];
  /** property IRI -> values (IRIs or literal lexical forms) */
  facts: Record<IRI, string[]>;
}

export interface ConceptSchemeView extends TermBase {
  kind: 'conceptScheme';
  topConcepts: IRI[];
}

export interface ConceptView extends TermBase {
  kind: 'concept';
  notation?: string;
  inScheme: IRI[];
  broader: IRI[];
  /** Inverse of skos:broader, computed without storing redundant triples. */
  narrower: IRI[];
  topConceptOf: IRI[];
}

export type ConceptAnnotations = Pick<TermAnnotations, 'label' | 'definition' | 'altLabels' | 'examples' | 'editorialNote'> & { notation?: string };
export type CodeListOp =
  | ({ op: 'addConceptScheme' } & Pick<NewTermFields, 'localName' | 'label' | 'definition' | 'altLabels' | 'editorialNote' | 'source'>)
  | ({ op: 'addConcept'; scheme: IRI; notation?: string; broader?: IRI } & Pick<NewTermFields, 'localName' | 'label' | 'definition' | 'altLabels' | 'examples' | 'editorialNote' | 'source'>)
  | { op: 'updateConcept'; iri: IRI; set: ConceptAnnotations; expect?: ConceptAnnotations }
  | { op: 'moveConcept'; iri: IRI; broader: IRI | null; expect?: { broader: IRI | null } }
  | { op: 'deprecateConcept'; iri: IRI; reason: string; replacedBy?: IRI }
  | { op: 'setCodeList'; property: IRI; scheme: IRI | null };

export type TermView = ClassView | PropertyView | IndividualView | ConceptSchemeView | ConceptView;

export interface OntologyMetadata {
  iri: IRI;
  versionIRI?: IRI;
  versionInfo?: string;
  priorVersion?: IRI;
  backwardCompatibleWith?: IRI[];
  incompatibleWith?: IRI[];
  title?: string;
  description?: string;
  license?: string;
  creators: string[];
  contributors: string[];
  publisher?: string;
  created?: string;
  modified?: string;
  issued?: string;
  preferredPrefix?: string;
  preferredNamespace?: string;
  imports: IRI[];
}

export interface OntologyView {
  metadata: OntologyMetadata;
  classes: ClassView[];
  objectProperties: PropertyView[];
  datatypeProperties: PropertyView[];
  annotationProperties: PropertyView[];
  individuals: IndividualView[];
  conceptSchemes: ConceptSchemeView[];
  concepts: ConceptView[];
  prefixes: Record<string, string>;
  tripleCount: number;
}

/* ------------------------------------------------------------------------ */
/* Change operations                                                         */
/* ------------------------------------------------------------------------ */

interface NewTermFields extends TermAnnotations {
  /** Local name, e.g. "VolunteerRole". The engine mints `${namespace}${localName}`. */
  localName: string;
  label: string;
  definition: string;
}

export type ChangeOp =
  | CodeListOp
  | ({
      op: 'addClass';
      subClassOf?: IRI[];
      equivalentTo?: IRI[];
      disjointWith?: IRI[];
      restrictions?: Restriction[];
    } & NewTermFields)
  | ({
      op: 'addObjectProperty';
      codeList?: IRI;
      domain?: IRI[];
      range?: IRI[];
      subPropertyOf?: IRI[];
      inverseOf?: IRI;
      characteristics?: PropertyCharacteristic[];
    } & NewTermFields)
  | ({
      op: 'addDatatypeProperty';
      domain?: IRI[];
      /** XSD datatype IRI (full IRI). */
      range?: IRI[];
      subPropertyOf?: IRI[];
      functional?: boolean;
    } & NewTermFields)
  | ({
      op: 'addIndividual';
      types: IRI[];
      facts?: Record<IRI, string[]>;
    } & Omit<NewTermFields, 'definition'> & { definition?: string })
  | {
      op: 'updateAnnotations';
      iri: IRI;
      set: TermAnnotations;
      /**
       * The values these fields had when the edit was proposed. Applying the op
       * fails if any of them has changed since (e.g. another edit merged first),
       * so a later merge never silently overwrites someone else's change.
       */
      expect?: Omit<TermAnnotations, 'mappings'>;
    }
  | {
      op: 'setSuperClasses';
      iri: IRI;
      superClasses: IRI[];
    }
  | {
      op: 'setDomainRange';
      iri: IRI;
      domain?: IRI[];
      range?: IRI[];
    }
  | { op: 'addRestriction'; classIri: IRI; restriction: Restriction }
  | { op: 'removeRestriction'; classIri: IRI; restriction: Restriction }
  | { op: 'addDisjointness'; classes: IRI[] }
  | { op: 'removeDisjointness'; classes: IRI[] }
  | { op: 'setCharacteristics'; iri: IRI; characteristics: PropertyCharacteristic[] }
  | { op: 'deprecateTerm'; iri: IRI; reason: string; replacedBy?: IRI }
  | { op: 'removeTerm'; iri: IRI }
  | { op: 'renameTerm'; iri: IRI; newLocalName: string }
  | { op: 'setMetadata'; set: Partial<Omit<OntologyMetadata, 'iri' | 'imports'>> }
  | { op: 'addImport'; iri: IRI };

export type ChangeOpName = ChangeOp['op'];

/* ------------------------------------------------------------------------ */
/* Diff, classification and validation                                       */
/* ------------------------------------------------------------------------ */

export interface TermChange {
  iri: IRI;
  label?: string;
  kind: TermView['kind'] | 'ontology';
  change: 'added' | 'removed' | 'modified' | 'deprecated' | 'undeprecated';
  /** human-readable list of field-level changes, e.g. "range: xsd:string → xsd:date" */
  details: string[];
  /** Field-level detail for rule evaluation. */
  fields: FieldChange[];
}

export interface FieldChange {
  field:
    | 'notation'
    | 'inScheme'
    | 'broader'
    | 'topConceptOf'
    | 'codeList'
    | 'label'
    | 'definition'
    | 'comment'
    | 'altLabels'
    | 'examples'
    | 'editorialNote'
    | 'source'
    | 'superClasses'
    | 'equivalentClasses'
    | 'disjointWith'
    | 'restrictions'
    | 'domain'
    | 'range'
    | 'superProperties'
    | 'inverseOf'
    | 'characteristics'
    | 'types'
    | 'facts'
    | 'deprecated'
    | 'replacedBy'
    | 'mappings'
    | 'superClassExpressions'
    | 'equivalentExpressions'
    | 'metadata';
  added: string[];
  removed: string[];
}

export interface OntologyDiff {
  terms: TermChange[];
  addedTriples: number;
  removedTriples: number;
  /** N-Triples lines (sorted) for exact review; truncated by caller if huge. */
  addedNTriples: string[];
  removedNTriples: string[];
}

export interface ClassificationReason {
  rule: string;
  level: ChangeLevel;
  iri?: IRI;
  message: string;
}

export interface ChangeClassification {
  level: ChangeLevel;
  reasons: ClassificationReason[];
}

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface Issue {
  severity: IssueSeverity;
  code: string;
  message: string;
  iri?: IRI;
  /** Best-practice source, e.g. "OBO principle 6", "OOPS! P11", "FAIR F1". */
  reference?: string;
}

export type FairPrinciple = 'F' | 'A' | 'I' | 'R';

export interface FairCheck {
  id: string;
  principle: FairPrinciple;
  title: string;
  passed: boolean;
  /** 'not-checked' when the check needs information that wasn't available (e.g. no network); it is left out of the score. */
  status: 'pass' | 'fail' | 'not-checked';
  message: string;
  /** Addition: the FOOPS!/best-practice check this corresponds to, e.g. "FOOPS! PURL1". */
  reference?: string;
}

/** What happened when the ontology IRI was dereferenced over HTTP (done by the server, not in core). */
export interface FairResolution {
  /** The IRI returned an RDF serialisation when asked for one (Accept: text/turtle etc.). */
  rdf: boolean;
  /** The IRI returned HTML documentation when asked for text/html. */
  html: boolean;
  detail?: string;
}

export interface FairContext {
  resolution?: FairResolution;
}

export interface FairReport {
  /** 0..1: the mean of the F, A, I and R principle scores, so each principle counts equally. */
  score: number;
  /** Per principle: checks passed out of checks run (not-checked ones excluded). */
  byPrinciple: Record<FairPrinciple, { passed: number; total: number; score: number }>;
  checks: FairCheck[];
}

/** An OWL 2 DL profile violation the reasoner reported (OWL 2 Structural Specification §11 and related rules). */
export interface OwlProfileNote {
  /** sparq's violation kind, e.g. Undeclared, IllegalPunning, NonSimpleProperty. */
  kind: string;
  detail: string;
}

export interface ReasonerResult {
  /**
   * sparq: complete OWL 2 DL reasoning (WebAssembly). structural: the fast, incomplete checks.
   * hermit and pellet only appear in reports stored before Concord moved to sparq.
   */
  /** 'none': nothing could be checked (the OWL reasoner and the structural fallback both failed). */
  engine: 'sparq' | 'structural' | 'none' | 'hermit' | 'pellet';
  /** false when the OWL reasoner did not finish, so the structural checks filled in (see `error` and `checked`). */
  available: boolean;
  /**
   * How much the OWL reasoner decided. complete: consistency and every class's satisfiability.
   * consistency: the ontology is consistent, but not every class could be checked. none: no verdict.
   * Absent for the structural reasoner on its own and in reports stored before this field.
   */
  checked?: 'complete' | 'consistency' | 'none';
  consistent: boolean;
  unsatisfiable: IRI[];
  /** Inferred direct subclass axioms not asserted: [sub, super] */
  inferredSubClassOf: [IRI, IRI][];
  explanation?: string;
  /** OWL 2 DL profile violations that did not stop reasoning (e.g. an undeclared property). */
  profile?: OwlProfileNote[];
  durationMs: number;
  /** Time spent inside the reasoner itself, excluding loading and serialising. */
  checkMs?: number;
  error?: string;
}

export interface CompetencyQuestionResult {
  question: string;
  sparql: string;
  ok: boolean;
  rows: Record<string, string>[];
  error?: string;
  /** Satisfied = query ran and returned at least one row (or matched expected). */
  satisfied: boolean;
  /** The use case the question came from, if any. Results are shown only to people who may see it. */
  source?: string;
}

export interface ValidationReport {
  lint: Issue[];
  fair: FairReport;
  reasoner: ReasonerResult;
  competencyQuestions: CompetencyQuestionResult[];
  /**
   * true when lint has no errors and the OWL reasoner finished and found the ontology consistent with
   * no unsatisfiable classes. A check that did not finish never passes.
   */
  passed: boolean;
  /** The working-draft revision the report is for, when the server validated its working draft. */
  revision?: string;
  /**
   * The ontology checked together with everything it imports (owl:imports), when it imports
   * anything. `reasoner` is then the verdict on that union, counting only this ontology's own classes.
   */
  imports?: ImportCheck;
  /**
   * For a proposed change: what it does to each federation the ontology belongs to while following
   * its working draft. Breaking a federation the ontology committed to makes `passed` false.
   */
  federations?: FederationImpact[];
}

/** An ontology loaded into an import closure. */
export interface ImportedOntologyRef {
  /** The owl:imports IRI as written. */
  iri: string;
  title: string;
  /** A release version, or 'draft'. */
  version: string;
  /** The ontology (or the root's IRI) whose owl:imports named this one. */
  via: string;
  /** Concord's id for the ontology, when Concord hosts it. */
  ontologyId?: string;
}

/** An ontology checked together with its import closure. */
export interface ImportCheck {
  imports: ImportedOntologyRef[];
  /** Imports that could not be loaded, so were not checked: not hosted on Concord, waiting for approval, or past the limit. */
  unresolved: { iri: string; via: string; reason: 'not-hosted' | 'held' | 'limit' }[];
  consistent: boolean;
  /** How much the reasoner decided about the union (as ReasonerResult.checked). */
  checked: 'complete' | 'consistency' | 'none';
  /** This ontology's own classes that are unsatisfiable once its imports are loaded. */
  unsatisfiable: IRI[];
  /** Classes of the imported ontologies that are unsatisfiable: theirs to fix, so they don't fail this one. */
  inheritedUnsatisfiable: IRI[];
  /**
   * What a failure comes from: this ontology alone (`import: null`), or each direct import
   * that fails together with this ontology.
   */
  blame: { import: string | null; title: string; inconsistent: boolean; unsatisfiable: IRI[] }[];
  /** Axioms this ontology states about another ontology's terms (it should constrain them, never re-define them). */
  foreignAxioms: { subject: IRI; predicate: IRI; object: string; owner: string }[];
  /** One ontology reached at two versions: both versions' axioms are in the union. */
  versionClashes: { ontologyId: string; title: string; versions: string[] }[];
  /** The union is consistent and none of this ontology's own classes is unsatisfiable. */
  passed: boolean;
  error?: string;
}

/** A federation's members checked alone and together (see federation.ts). */
export interface FederationCheck {
  /** Each member alone, with everything it imports. */
  members: { ontologyId: string; title: string; version: string; imports: number; consistent: boolean; checked: 'complete' | 'consistency' | 'none'; unsatisfiable: IRI[]; passed: boolean }[];
  /** Imports of a member that could not be loaded. */
  unresolved: { iri: string; via: string; reason: 'not-hosted' | 'held' | 'limit'; member: string }[];
  /** All members together: every impossible class, the member that declares it, and whether it is already impossible in a member alone (`alone`) or only in the combination. */
  joint: { consistent: boolean; checked: 'complete' | 'consistency' | 'none'; unsatisfiable: { iri: IRI; member: string | null; alone: boolean }[]; error?: string };
  /** Pairs of members that conflict when used together (member ids). */
  conflicts: { a: string; b: string; inconsistent: boolean; unsatisfiable: IRI[] }[];
  /** Statements a member makes about another member's terms. */
  foreignAxioms: { member: string; subject: IRI; predicate: IRI; object: string; owner: string }[];
  versionClashes: { ontologyId: string; title: string; versions: string[] }[];
  /** All members can be used together: consistent, with no impossible class. */
  passed: boolean;
  checkedAt: string;
}

/** What a proposed change does to a federation its ontology belongs to (following its working draft). */
export interface FederationImpact {
  federationId: string;
  slug: string;
  title: string;
  /** The ontology has committed to this federation, so breaking it fails the change. */
  committed: boolean;
  passedBefore: boolean;
  passedAfter: boolean;
  /** Classes the change makes impossible in the federation, that weren't before. */
  newlyUnsatisfiable: string[];
  /** The federation was consistent before the change and isn't after. */
  becomesInconsistent: boolean;
  /** The check couldn't run to the end. */
  error?: string;
}

/** One pinned ontology version. */
export interface FederationPin {
  role: 'member' | 'import';
  ontologyId?: string;
  title: string;
  ontologyIRI: string;
  version: string;
  versionIRI: string;
  /** `sha256:<hex>` over the version's RDFC-1.0 canonical form. */
  hash: string;
}
