/**
 * Work started during a request that may outlive its response (scheduled work, a simulated call carried on):
 * kept running until it finishes. On Vercel the entry point sets this to `waitUntil`; on a long-running server
 * there is nothing to do.
 */
let hook: (work: Promise<unknown>) => void = () => undefined;
export function setKeepAlive(fn: (work: Promise<unknown>) => void) {
  hook = fn;
}
export function keepAlive<T>(work: Promise<T>): Promise<T> {
  // The caller handles a failure; the platform only needs to know when it is over.
  hook(work.then(
    () => undefined,
    () => undefined,
  ));
  return work;
}
