/**
 * @concord/core — the Concord ontology engine. See API.md for the contract.
 */
export * from './types.js';

// Graph handling
export { OntologyGraph } from './graph.js';
export type { EmptyOntologyOptions } from './graph.js';
export { serialize, FORMAT_INFO } from './serialize.js';

// Changes
export { applyChangeOps, ChangeOpError, sameAnnotationValue } from './changes.js';
export type { ChangeContext, ApplyResult } from './changes.js';
export { diffOntologies } from './diff.js';
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
export type { CompetencyQuestion, ValidateOptions } from './cq.js';

// Formats
export { toLinkML, fromLinkML } from './linkml.js';
export { toManchester } from './manchester.js';
export { toShacl } from './shacl.js';

// Helpers
export { compactIRI, expandIRI, localName, isValidLocalName, XSD, NS } from './ns.js';
export { toShaclc, deriveShapes } from './shacl.js';
export { toWrapperClasses, withWrapperImport, npmPackage, WRAPPER_VERSION, WRAPPER_CDN } from './codegen.js';
export type { GeneratedModule, GeneratedClass, CodegenOptions, PackageOptions } from './codegen.js';
