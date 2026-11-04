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
  | 'shacl';

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
}

export interface IndividualView extends TermBase {
  kind: 'individual';
  types: IRI[];
  /** property IRI -> values (IRIs or literal lexical forms) */
  facts: Record<IRI, string[]>;
}

export type TermView = ClassView | PropertyView | IndividualView;

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
  | ({
      op: 'addClass';
      subClassOf?: IRI[];
      equivalentTo?: IRI[];
      disjointWith?: IRI[];
      restrictions?: Restriction[];
    } & NewTermFields)
  | ({
      op: 'addObjectProperty';
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

export interface ReasonerResult {
  engine: 'hermit' | 'pellet' | 'structural';
  available: boolean;
  consistent: boolean;
  unsatisfiable: IRI[];
  /** Inferred direct subclass axioms not asserted: [sub, super] */
  inferredSubClassOf: [IRI, IRI][];
  explanation?: string;
  durationMs: number;
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
}

export interface ValidationReport {
  lint: Issue[];
  fair: FairReport;
  reasoner: ReasonerResult;
  competencyQuestions: CompetencyQuestionResult[];
  /** true when there are no errors from lint and the reasoner says consistent with no unsatisfiable classes */
  passed: boolean;
}
