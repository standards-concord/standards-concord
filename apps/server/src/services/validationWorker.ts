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
  /** The most memory this process may use in all, in MB (resident set: heap, WebAssembly and native memory). */
  rssMb: number;
  /** Past this peak, in MB, the process asks to be replaced once the job is done, to give memory back. */
  recycleMb: number;
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

export type WorkerReply = ({ id: number; ok: true; outcome: ValidationOutcome } | { id: number; ok: false; status?: number; message: string }) & {
  /** Replace this process: it has grown past recycleMb. */
  recycle?: true;
};

/** The heap ran out, or the process used more memory in all than the server allows. */
export const OUT_OF_MEMORY = 'Checking the data needed more memory than the validator allows. Try smaller data.';

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
  // Only the first MAX_LISTED results are kept, as they are made: the rest are only counted
  // (the SHACL engine runs on batches of the data, so each of its reports stays small).
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
  const report = full;
  const terms = allTerms.slice(0, MAX_LISTED);
  const tooBig = () => new DataError(413, 'The validation report is too large to send back. Check the data in smaller parts.');
  let size = textSize([report.results, terms], MAX_REPLY_CHARS);
  if (size > MAX_REPLY_CHARS) throw tooBig();
  let turtle: string | undefined;
  if (job.turtle) {
    turtle = validator.reportTurtle(report, graph.prefixes);
    if (total > MAX_LISTED) turtle = `# The first ${MAX_LISTED.toLocaleString('en')} of ${total.toLocaleString('en')} results.\n${turtle}`;
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

/**
 * Keeps this process's deadline and memory limit, and stops it if the server goes away, even
 * while this thread is busy (see validationWatchdog.cjs).
 */
const watchdog = new Worker(new URL('./validationWatchdog.cjs', import.meta.url), { workerData: { parent: process.ppid } });
watchdog.unref();

// The server went away: so does this worker.
process.on('disconnect', () => process.exit(0));

const MB = 1024 * 1024;

process.on('message', async (job: ValidationJob) => {
  watchdog.postMessage({ deadlineMs: job.deadlineMs, rssMb: job.rssMb });
  let reply: WorkerReply;
  try {
    const outcome = await run(job);
    // The watchdog samples memory as the job runs; the peak the system recorded catches anything
    // between samples. (maxRSS is in kilobytes. It never goes down, so a process past recycleMb is replaced.)
    const peak = process.resourceUsage().maxRSS / 1024;
    reply = peak > job.rssMb ? { id: job.id, ok: false, status: 413, message: OUT_OF_MEMORY } : { id: job.id, ok: true, outcome };
  } catch (err) {
    reply = { id: job.id, ok: false, status: err instanceof DataError ? err.status : undefined, message: (err as Error).message };
  }
  watchdog.postMessage(0);
  if (Math.max(process.resourceUsage().maxRSS / 1024, process.memoryUsage.rss() / MB) > job.recycleMb) reply.recycle = true;
  process.send!(reply);
});
