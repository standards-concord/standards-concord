import { checkTerms, classHierarchy, DataError, parseData, ShapesValidator, toShacl, type DataFormat, type ShaclResult, type TermIssue } from '@concord/core';
import type { OntologyProject } from '@concord/shared';
import { ontologyStore } from './ontologyStore.js';

/**
 * Validating instance data against one version of an ontology: SHACL (the
 * shapes derived from that version) plus checks on the terms the data uses.
 * Used by POST to the ontology's /def URI and by the MCP validate_data tool.
 */

/** Limits for one request. The engine runs on the server's main thread, so the triple cap bounds how long it blocks. */
export const VALIDATION_LIMITS = { bytes: 5 * 1024 * 1024, triples: 25_000 };

export interface DataValidation {
  /** The ontology IRI and the version validated against ('1.0.0', or 'draft' for the working draft). */
  ontology: string;
  version: string;
  /** Where the SHACL shapes used can be fetched. */
  shapes?: string;
  /** SHACL conformance: true when there are no SHACL results at all. */
  conforms: boolean;
  /** conforms, and no errors in the terms check. */
  valid: boolean;
  triples: number;
  summary: { violations: number; warnings: number; infos: number; termErrors: number; termWarnings: number };
  results: ShaclResult[];
  terms: TermIssue[];
}

const cache = new Map<string, { shapes: string; validator: ShapesValidator }>();

async function validatorFor(project: OntologyProject, version: string) {
  const graph = await ontologyStore.at(project, version === 'draft' ? 'working' : version);
  const key = `${project.id}@${version}`;
  const hit = cache.get(key);
  // Releases never change; the draft does, so compare its shapes.
  if (hit && version !== 'draft') return { graph, ...hit };
  const shapes = await toShacl(graph);
  if (hit && hit.shapes === shapes) return { graph, ...hit };
  const entry = { shapes, validator: ShapesValidator.fromTurtle(shapes) };
  cache.delete(key);
  cache.set(key, entry);
  // Keep the cache small: the oldest entry goes first.
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
  return { graph, ...entry };
}

/** Relative IRIs in data resolve against this unless the caller gives a base (a reserved domain, so it never means a real thing). */
export const DEFAULT_DATA_BASE = 'https://data.example/';

export interface ValidateOptions {
  format: DataFormat;
  /** Defaults to DEFAULT_DATA_BASE. */
  baseIRI?: string;
  /** Link to the shapes used, for the report. */
  shapesUrl?: string;
}

/** Parses and validates data. Throws DataError (status 400 or 413) for data that can't be validated. */
export async function validateDataAgainst(project: OntologyProject, version: string, text: string, opts: ValidateOptions) {
  if (Buffer.byteLength(text) > VALIDATION_LIMITS.bytes) {
    throw new DataError(413, `The data is larger than ${VALIDATION_LIMITS.bytes / 1024 / 1024} MB.`);
  }
  const data = await parseData(text, opts.format, { baseIRI: opts.baseIRI ?? DEFAULT_DATA_BASE, maxTriples: VALIDATION_LIMITS.triples });
  const { graph, validator } = await validatorFor(project, version);
  const report = await validator.validate(data, classHierarchy(graph));
  const terms = checkTerms(graph, data);
  const count = (s: string) => report.results.filter((r) => r.severity === s).length;
  const body: DataValidation = {
    ontology: graph.ontologyIRI || project.ontologyIRI,
    version,
    ...(opts.shapesUrl ? { shapes: opts.shapesUrl } : {}),
    conforms: report.conforms,
    valid: report.conforms && !terms.some((t) => t.severity === 'error'),
    triples: data.length,
    summary: {
      violations: count('Violation'),
      warnings: count('Warning'),
      infos: count('Info'),
      termErrors: terms.filter((t) => t.severity === 'error').length,
      termWarnings: terms.filter((t) => t.severity === 'warning').length,
    },
    results: report.results,
    terms,
  };
  return { body, turtle: () => validator.reportTurtle(report, graph.prefixes) };
}
