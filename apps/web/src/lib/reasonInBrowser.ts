import type { ReasonerResult } from '@concord/core/types';

/**
 * Runs sparq's OWL 2 DL reasoner on this device, in a Web Worker so the page stays responsive.
 * Each call uses a fresh worker, which is stopped when it answers or after `timeoutMs`.
 */
export function reasonInBrowser(turtle: string, timeoutMs = 60_000): Promise<ReasonerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./reasonWorker.ts', import.meta.url), { type: 'module', name: 'sparq-reasoner' });
    const done = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error(`the reasoner took longer than ${Math.round(timeoutMs / 1000)} s and was stopped`));
    }, timeoutMs);
    worker.onmessage = (ev: MessageEvent<{ result?: ReasonerResult; error?: string }>) => {
      done();
      if (ev.data.result) resolve(ev.data.result);
      else reject(new Error(ev.data.error ?? 'the reasoner failed'));
    };
    worker.onerror = (ev) => {
      done();
      reject(new Error(ev.message || 'the reasoner could not start'));
    };
    worker.postMessage({ turtle });
  });
}
