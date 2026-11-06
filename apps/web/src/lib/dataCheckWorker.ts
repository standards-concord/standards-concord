/**
 * Web Worker that checks data against an ontology version with sparq (WebAssembly), on this
 * device, so the data never leaves the browser and a large file never freezes the page.
 * The same check the server runs (@concord/core/data-check). Started by checkDataInBrowser.ts.
 * Each version's parsed ontology and shapes are kept, so checking again is quick.
 */
import { checkData, prepareOntology, type PreparedOntology } from '@concord/core/data-check';
import type { DataCheckJob } from './checkDataInBrowser';

// The worker global, typed without the webworker lib (it clashes with this project's DOM lib).
const scope = self as unknown as { onmessage: ((ev: MessageEvent<DataCheckJob & { id: number }>) => void) | null; postMessage: (m: unknown) => void };

const cache = new Map<string, Promise<PreparedOntology>>();

scope.onmessage = async ({ data: job }) => {
  try {
    let prepared = cache.get(job.key);
    if (!prepared) {
      prepared = prepareOntology(job.ontology, job.shapes);
      cache.set(job.key, prepared);
      prepared.catch(() => cache.delete(job.key));
      if (cache.size > 4) cache.delete(cache.keys().next().value!);
    }
    const p = prepared;
    const t0 = performance.now();
    const outcome = await checkData(() => p, job.text, job.format, { baseIRI: job.baseIRI, maxTriples: job.maxTriples, turtle: job.turtle });
    scope.postMessage({ id: job.id, outcome, ms: performance.now() - t0 });
  } catch (e) {
    scope.postMessage({ id: job.id, error: (e as Error).message ?? String(e), status: (e as { status?: number }).status });
  }
};
