/**
 * Runs one validation at a time for validationPool.ts, in a process of its
 * own, so a slow or memory-hungry input can be stopped without stopping the
 * server. Parsed ontologies and their shapes are kept between jobs, keyed by a
 * hash of the ontology's Turtle.
 */
import { checkTerms, classHierarchy, DataError, OntologyGraph, parseData, ShapesValidator, toShacl, type DataFormat } from '@concord/core';
import type { Quad } from 'n3';

export interface ValidationJob {
  id: number;
  /** Hash of `ontology`, the cache key. */
  hash: string;
  ontology: string;
  text: string;
  format: DataFormat;
  baseIRI: string;
  maxTriples: number;
  /** Also write the SHACL report in Turtle. */
  turtle: boolean;
}

export interface ValidationOutcome {
  conforms: boolean;
  valid: boolean;
  triples: number;
  results: Awaited<ReturnType<ShapesValidator['validate']>>['results'];
  terms: ReturnType<typeof checkTerms>;
  turtle?: string;
}

export type WorkerReply = { id: number; ok: true; outcome: ValidationOutcome } | { id: number; ok: false; status?: number; message: string };

const cache = new Map<string, { graph: OntologyGraph; validator: ShapesValidator; hierarchy: Quad[] }>();

async function prepared(hash: string, ontology: string) {
  let hit = cache.get(hash);
  if (!hit) {
    const graph = await OntologyGraph.fromTurtle(ontology);
    hit = { graph, validator: ShapesValidator.fromTurtle(await toShacl(graph)), hierarchy: classHierarchy(graph) };
    cache.set(hash, hit);
    if (cache.size > 8) cache.delete(cache.keys().next().value!);
  }
  return hit;
}

/**
 * The most text a reply may carry, in characters (summing every string in it).
 * The report repeats IRIs and values for each result, so even data within
 * parseData's limits can make a large one; past this the caller gets a 413
 * instead of a reply the server would have to copy and hold.
 */
export const MAX_REPLY_CHARS = 16 * 1024 * 1024;

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

async function run(job: ValidationJob): Promise<ValidationOutcome> {
  const data = await parseData(job.text, job.format, { baseIRI: job.baseIRI, maxTriples: job.maxTriples });
  const { graph, validator, hierarchy } = await prepared(job.hash, job.ontology);
  const report = await validator.validate(data, hierarchy);
  const terms = checkTerms(graph, data);
  const tooBig = () =>
    new DataError(413, `The validation report is too large to send back (${report.results.length.toLocaleString('en')} results). Check the data in smaller parts.`);
  let size = textSize([report.results, terms], MAX_REPLY_CHARS);
  if (size > MAX_REPLY_CHARS) throw tooBig();
  const turtle = job.turtle ? validator.reportTurtle(report, graph.prefixes) : undefined;
  if (turtle !== undefined && (size += turtle.length) > MAX_REPLY_CHARS) throw tooBig();
  return {
    conforms: report.conforms,
    valid: report.conforms && !terms.some((t) => t.severity === 'error'),
    triples: data.length,
    results: report.results,
    terms,
    ...(turtle !== undefined ? { turtle } : {}),
  };
}

// The server went away: so does this worker.
process.on('disconnect', () => process.exit(0));

process.on('message', async (job: ValidationJob) => {
  let reply: WorkerReply;
  try {
    reply = { id: job.id, ok: true, outcome: await run(job) };
  } catch (err) {
    reply = { id: job.id, ok: false, status: err instanceof DataError ? err.status : undefined, message: (err as Error).message };
  }
  process.send!(reply);
});
