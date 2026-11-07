/**
 * Checking instance data against one version of an ontology: its SHACL shapes
 * plus checks on the terms the data uses. The server's validation workers and
 * the web app's in-browser check (Validate data) both run this, so they give
 * the same report. It runs in a browser: the shapes come in as Turtle (the
 * server derives them with toShacl and serves them as the version's shapes).
 */
import type { Quad } from 'n3';
import { OntologyGraph } from './graph.js';
import { DataError, ShapesValidator, checkTerms, classHierarchy, parseData, type DataFormat } from './validation.js';

export { OntologyGraph };

/** An ontology version parsed and ready to check data against. Worth keeping between checks. */
export interface PreparedOntology {
  graph: OntologyGraph;
  validator: ShapesValidator;
  hierarchy: Quad[];
}

export async function prepareOntology(ontologyTurtle: string | OntologyGraph, shapesTurtle: string): Promise<PreparedOntology> {
  const graph = typeof ontologyTurtle === 'string' ? await OntologyGraph.fromTurtle(ontologyTurtle) : ontologyTurtle;
  return { graph, validator: ShapesValidator.fromTurtle(shapesTurtle), hierarchy: classHierarchy(graph) };
}

/** Relative IRIs in data resolve against this unless the caller gives a base (a reserved domain, so it never means a real thing). */
export const DEFAULT_DATA_BASE = 'https://data.example/';

/** Limits on the data one check takes, the same on the server and in the browser. */
export const DATA_CHECK_LIMITS = { bytes: 5 * 1024 * 1024, triples: 25_000 };

/** The most results, and term issues, a report lists. The summary still counts them all. */
export const MAX_LISTED = 1000;

export interface DataCheckOutcome {
  conforms: boolean;
  valid: boolean;
  triples: number;
  /** Counts over every result and term issue, including any left out of the lists. */
  summary: { violations: number; warnings: number; infos: number; termErrors: number; termWarnings: number };
  /** The first MAX_LISTED results and term issues. */
  results: Awaited<ReturnType<ShapesValidator['validate']>>['results'];
  terms: ReturnType<typeof checkTerms>;
  /** Set when there were more results or term issues than the lists hold. */
  truncated?: true;
  turtle?: string;
}

export interface DataCheckOptions {
  baseIRI: string;
  maxTriples: number;
  /** Also write the SHACL report in Turtle. */
  turtle?: boolean;
  /** The most text the outcome may carry, summing every string in it; past it, a 413 DataError. */
  maxChars?: number;
}

/** The characters in every string of a JSON-like value, stopping once past `limit`. */
function textSize(value: unknown, limit: number): number {
  let size = 0;
  const stack = [value];
  while (stack.length && size <= limit) {
    const v = stack.pop();
    if (typeof v === 'string') size += v.length;
    else if (v && typeof v === 'object') for (const x of Array.isArray(v) ? v : Object.values(v)) stack.push(x);
  }
  return size;
}

/**
 * Parses `text` and checks it. Throws DataError (400 unparseable, 413 too large). `prepared` may be a
 * function, called only once the data has parsed, so unparseable data never waits for the ontology.
 */
export async function checkData(prepared: PreparedOntology | (() => Promise<PreparedOntology>), text: string, format: DataFormat, opts: DataCheckOptions): Promise<DataCheckOutcome> {
  const data = await parseData(text, format, { baseIRI: opts.baseIRI, maxTriples: opts.maxTriples });
  const { graph, validator, hierarchy } = typeof prepared === 'function' ? await prepared() : prepared;
  const full = await validator.validate(data, hierarchy, { limit: MAX_LISTED });
  const allTerms = checkTerms(graph, data);
  const total = full.counts.Violation + full.counts.Warning + full.counts.Info;
  const summary = {
    violations: full.counts.Violation,
    warnings: full.counts.Warning,
    infos: full.counts.Info,
    termErrors: allTerms.filter((t) => t.severity === 'error').length,
    termWarnings: allTerms.filter((t) => t.severity === 'warning').length,
  };
  const truncated = total > MAX_LISTED || allTerms.length > MAX_LISTED;
  const terms = allTerms.slice(0, MAX_LISTED);
  const maxChars = opts.maxChars ?? Infinity;
  const tooBig = () => new DataError(413, 'The validation report is too large to send back. Check the data in smaller parts.');
  let size = textSize([full.results, terms], maxChars);
  if (size > maxChars) throw tooBig();
  let turtle: string | undefined;
  if (opts.turtle) {
    turtle = validator.reportTurtle(full, graph.prefixes);
    if (total > MAX_LISTED) turtle = `# The first ${MAX_LISTED.toLocaleString('en')} of ${total.toLocaleString('en')} results.\n${turtle}`;
    if ((size += turtle.length) > maxChars) throw tooBig();
  }
  return {
    conforms: full.conforms,
    valid: full.conforms && summary.termErrors === 0,
    triples: data.length,
    summary,
    results: full.results,
    terms,
    ...(truncated ? { truncated: true as const } : {}),
    ...(turtle !== undefined ? { turtle } : {}),
  };
}
