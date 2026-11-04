import { createHash } from 'node:crypto';
import { DataError, type DataFormat, type OntologyGraph, type ShaclResult, type TermIssue } from '@concord/core';
import type { OntologyProject } from '@concord/shared';
import { ontologyStore } from './ontologyStore.js';
import { runValidation } from './validationPool.js';

/**
 * Validating instance data against one version of an ontology: SHACL (the
 * shapes derived from that version) plus checks on the terms the data uses.
 * Used by POST to the ontology's /def URI and by the MCP validate_data tool.
 */

/** Limits for one request. Time and memory are limited too, in validationPool.ts. */
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

/** Each loaded ontology version's Turtle and its hash, for the worker's cache. */
const sources = new WeakMap<OntologyGraph, { text: string; hash: string }>();

async function ontologySource(graph: OntologyGraph) {
  let hit = sources.get(graph);
  if (!hit) {
    const text = await graph.toTurtle();
    hit = { text, hash: createHash('sha256').update(text).digest('hex') };
    sources.set(graph, hit);
  }
  return hit;
}

/** Relative IRIs in data resolve against this unless the caller gives a base (a reserved domain, so it never means a real thing). */
export const DEFAULT_DATA_BASE = 'https://data.example/';

export interface ValidateOptions {
  format: DataFormat;
  /** Defaults to DEFAULT_DATA_BASE. */
  baseIRI?: string;
  /** Link to the shapes used, for the report. */
  shapesUrl?: string;
  /** Also write the SHACL validation report in Turtle. */
  turtle?: boolean;
  /** Aborted when the caller goes away: the job is dropped or its worker stopped. */
  signal?: AbortSignal;
}

/**
 * Parses and validates data in a worker thread (validationPool.ts). Throws
 * DataError: 400 unparseable, 413 too large, 422 too slow, 503 busy.
 */
export async function validateDataAgainst(project: OntologyProject, version: string, text: string, opts: ValidateOptions): Promise<{ body: DataValidation; turtle?: string }> {
  if (Buffer.byteLength(text) > VALIDATION_LIMITS.bytes) {
    throw new DataError(413, `The data is larger than ${VALIDATION_LIMITS.bytes / 1024 / 1024} MB.`);
  }
  const graph = await ontologyStore.at(project, version === 'draft' ? 'working' : version);
  const source = await ontologySource(graph);
  const outcome = await runValidation({
    hash: source.hash,
    ontology: source.text,
    text,
    format: opts.format,
    baseIRI: opts.baseIRI ?? DEFAULT_DATA_BASE,
    maxTriples: VALIDATION_LIMITS.triples,
    turtle: !!opts.turtle,
  }, opts.signal);
  const count = (s: string) => outcome.results.filter((r) => r.severity === s).length;
  const body: DataValidation = {
    ontology: graph.ontologyIRI || project.ontologyIRI,
    version,
    ...(opts.shapesUrl ? { shapes: opts.shapesUrl } : {}),
    conforms: outcome.conforms,
    valid: outcome.valid,
    triples: outcome.triples,
    summary: {
      violations: count('Violation'),
      warnings: count('Warning'),
      infos: count('Info'),
      termErrors: outcome.terms.filter((t) => t.severity === 'error').length,
      termWarnings: outcome.terms.filter((t) => t.severity === 'warning').length,
    },
    results: outcome.results,
    terms: outcome.terms,
  };
  return { body, turtle: outcome.turtle };
}
