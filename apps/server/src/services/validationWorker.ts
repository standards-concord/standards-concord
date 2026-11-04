/**
 * Runs one validation at a time for validationPool.ts, in a process of its
 * own, so a slow or memory-hungry input can be stopped without stopping the
 * server. Parsed ontologies and their shapes are kept between jobs, keyed by a
 * hash of the ontology's Turtle.
 */
import { Worker } from 'node:worker_threads';
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
  /** How long the job may run before this process kills itself (the server stops it sooner while it is there). */
  deadlineMs: number;
}

export interface ValidationOutcome {
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

/** The most results, and term issues, a reply lists. The summary still counts them all. */
export const MAX_LISTED = 1000;

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
  // The SHACL engine makes its whole report at once. That can be large, so it runs within this
  // process's limits: its heap (--max-old-space-size) and the memory the server lets it use in all
  // (validationPool.ts). Only the first MAX_LISTED results are kept from here on.
  const full = await validator.validate(data, hierarchy);
  const allTerms = checkTerms(graph, data);
  const count = (s: string) => full.results.filter((r) => r.severity === s).length;
  const summary = {
    violations: count('Violation'),
    warnings: count('Warning'),
    infos: count('Info'),
    termErrors: allTerms.filter((t) => t.severity === 'error').length,
    termWarnings: allTerms.filter((t) => t.severity === 'warning').length,
  };
  const truncated = full.results.length > MAX_LISTED || allTerms.length > MAX_LISTED;
  const report = { ...full, results: full.results.slice(0, MAX_LISTED), sources: full.sources.slice(0, MAX_LISTED) };
  const terms = allTerms.slice(0, MAX_LISTED);
  const tooBig = () => new DataError(413, 'The validation report is too large to send back. Check the data in smaller parts.');
  let size = textSize([report.results, terms], MAX_REPLY_CHARS);
  if (size > MAX_REPLY_CHARS) throw tooBig();
  let turtle: string | undefined;
  if (job.turtle) {
    turtle = validator.reportTurtle(report, graph.prefixes);
    if (full.results.length > MAX_LISTED) {
      turtle = `# The first ${MAX_LISTED.toLocaleString('en')} of ${full.results.length.toLocaleString('en')} results.\n${turtle}`;
    }
    if ((size += turtle.length) > MAX_REPLY_CHARS) throw tooBig();
  }
  return {
    conforms: full.conforms,
    valid: full.conforms && summary.termErrors === 0,
    triples: data.length,
    summary,
    results: report.results,
    terms,
    ...(truncated ? { truncated: true as const } : {}),
    ...(turtle !== undefined ? { turtle } : {}),
  };
}

/** Keeps this process's deadline, and stops it if the server goes away, even while this thread is busy. */
const watchdog = new Worker(new URL('./validationWatchdog.cjs', import.meta.url), { workerData: { parent: process.ppid } });
watchdog.unref();

// The server went away: so does this worker.
process.on('disconnect', () => process.exit(0));

process.on('message', async (job: ValidationJob) => {
  watchdog.postMessage(job.deadlineMs);
  let reply: WorkerReply;
  try {
    reply = { id: job.id, ok: true, outcome: await run(job) };
  } catch (err) {
    reply = { id: job.id, ok: false, status: err instanceof DataError ? err.status : undefined, message: (err as Error).message };
  }
  watchdog.postMessage(0);
  process.send!(reply);
});
