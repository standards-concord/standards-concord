/**
 * Runs one validation at a time for validationPool.ts, off the server's main
 * thread, so a slow or memory-hungry input can be stopped without stopping the
 * server. Parsed ontologies and their shapes are kept between jobs, keyed by a
 * hash of the ontology's Turtle.
 */
import { parentPort } from 'node:worker_threads';
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

async function run(job: ValidationJob): Promise<ValidationOutcome> {
  const data = await parseData(job.text, job.format, { baseIRI: job.baseIRI, maxTriples: job.maxTriples });
  const { graph, validator, hierarchy } = await prepared(job.hash, job.ontology);
  const report = await validator.validate(data, hierarchy);
  const terms = checkTerms(graph, data);
  return {
    conforms: report.conforms,
    valid: report.conforms && !terms.some((t) => t.severity === 'error'),
    triples: data.length,
    results: report.results,
    terms,
    ...(job.turtle ? { turtle: validator.reportTurtle(report, graph.prefixes) } : {}),
  };
}

parentPort?.on('message', async (job: ValidationJob) => {
  let reply: WorkerReply;
  try {
    reply = { id: job.id, ok: true, outcome: await run(job) };
  } catch (err) {
    reply = { id: job.id, ok: false, status: err instanceof DataError ? err.status : undefined, message: (err as Error).message };
  }
  parentPort!.postMessage(reply);
});
