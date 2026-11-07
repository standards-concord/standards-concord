/**
 * Runs one validation at a time for validationPool.ts, in a process of its
 * own, so a slow or memory-hungry input can be stopped without stopping the
 * server. Parsed ontologies and their shapes are kept between jobs, keyed by a
 * hash of the ontology's Turtle.
 */
import { Worker } from 'node:worker_threads';
import { checkData, DataError, MAX_LISTED, OntologyGraph, prepareOntology, toShacl, type DataCheckOutcome, type DataFormat, type PreparedOntology } from '@concord/core';

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

export type ValidationOutcome = DataCheckOutcome;
export { MAX_LISTED };

export type WorkerReply = ({ id: number; ok: true; outcome: ValidationOutcome } | { id: number; ok: false; status?: number; message: string }) & {
  /** Replace this process: it has grown past recycleMb. */
  recycle?: true;
};

/** The heap ran out, or the process used more memory in all than the server allows. */
export const OUT_OF_MEMORY = 'Checking the data needed more memory than the validator allows. Try smaller data.';

const cache = new Map<string, PreparedOntology>();

async function prepared(hash: string, ontology: string) {
  let hit = cache.get(hash);
  if (!hit) {
    const graph = await OntologyGraph.fromTurtle(ontology);
    hit = await prepareOntology(graph, await toShacl(graph));
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

async function run(job: ValidationJob): Promise<ValidationOutcome> {
  return checkData(() => prepared(job.hash, job.ontology), job.text, job.format, { baseIRI: job.baseIRI, maxTriples: job.maxTriples, turtle: job.turtle, maxChars: MAX_REPLY_CHARS });
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
