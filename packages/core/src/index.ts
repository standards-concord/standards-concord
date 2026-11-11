/**
 * @concord/core — the Concord ontology engine. See API.md for the contract.
 */
export * from './types.js';

// Graph handling
export { OntologyGraph } from './graph.js';
export { allTerms, findTerm, searchTerms, termDetail, usedBy, type TermDetail, type UsedBy } from './termIndex.js';
export type { EmptyOntologyOptions } from './graph.js';
export { serialize, FORMAT_INFO } from './serialize.js';

// Changes
export { applyChangeOps, ChangeOpError, sameAnnotationValue, setMetadata } from './changes.js';
export { generatedProvenanceTitles, rewriteLiterals, scrubGeneratedProvenance } from './remediate.js';
export type { ChangeContext, ApplyResult } from './changes.js';
export { canonicalTriples, diffOntologies, termDescription } from './diff.js';
export { classifyChange, CLASSIFICATION_RULES, withDeclaredLevel } from './classify.js';
export type { ClassifyOptions, ClassificationRule } from './classify.js';
export { toKGCL, migrationSparql } from './kgcl.js';

// Versioning
export { bumpVersion, stampRelease } from './version.js';
export type { StampOptions } from './version.js';

// Quality
export { lint } from './lint.js';
export type { LintOptions } from './lint.js';
export { fairCheck } from './fair.js';
export { structuralReasoner, owlReasoner } from './reasoner.js';
export type { OwlReasonerOptions } from './reasoner.js';
export { runCompetencyQuestions, validate } from './cq.js';
export { checkImports, foreignAxioms, MAX_IMPORTS, resolveImportClosure, unionGraph } from './imports.js';
export type { ImportClosure, ImportResolver, ResolvedImport, UnresolvedReason } from './imports.js';
export { checkFederation, federationRoot, federationUnion } from './federation.js';
export type { FederationMemberInput } from './federation.js';
export type { CompetencyQuestion, ValidateOptions } from './cq.js';

// Queries
export {
  buildSparql,
  newStep,
  pathLabels,
  activeFilter,
  isRequired,
  fitsControl,
  updateStep,
  findStep,
  allSteps,
  varNameFor,
  FILTER_LABELS,
} from './sparql-builder.js';
export type { BuilderModel, PathStep, FilterOp, ValueType, BuiltQuery, BuilderContext } from './sparql-builder.js';

// Formats
export { toLinkML, fromLinkML } from './linkml.js';
export { toManchester } from './manchester.js';
export { toShacl } from './shacl.js';

// Validating instance data
export { DATA_FORMATS, DATA_MEDIA_TYPES, DataError, MAX_DATA_CHARS, MAX_IRI_LENGTH, ShapesValidator, checkTerms, classHierarchy, dataFormatForFile, dataFormatForMediaType, parseData, sniffDataFormat } from './validation.js';
export { DATA_CHECK_LIMITS, DEFAULT_DATA_BASE, MAX_LISTED, checkData, prepareOntology } from './dataCheck.js';
export type { DataCheckOptions, DataCheckOutcome, PreparedOntology } from './dataCheck.js';
export type { DataFormat, ParseDataOptions, Severity, ShaclReport, ShaclResult, TermIssue, ValidatedReport } from './validation.js';

// Helpers
export { compactIRI, expandIRI, localName, isValidLocalName, XSD, NS } from './ns.js';
export { toShaclc, deriveShapes, shaclStore } from './shacl.js';
export { toWrapperClasses, withWrapperImport, npmPackage, WRAPPER_VERSION, WRAPPER_CDN } from './codegen.js';
export type { GeneratedModule, GeneratedClass, CodegenOptions, PackageOptions } from './codegen.js';
export { canonicalNQuads, rdfcHash, sha256Hex } from './canon.js';
export { fedVersionIRI, manifestGraph, suggestFederationVersion, versionStep } from './fedRelease.js';
export type { FederationPin, ManifestInput } from './fedRelease.js';
export { AGREEING, compareGraphs } from './compare.js';
export type { GraphComparison, TermComparison, TermRelation } from './compare.js';
export { upstreamOps } from './upstream.js';
export type { UpstreamPlan } from './upstream.js';

export { termNamespace } from './termRules.js';
