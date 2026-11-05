/**
 * Per-key async locks. The server is one process, so serialising the
 * read-modify-write of one meeting here stops concurrent ticks, webhooks and
 * requests from booking a bot twice or overwriting each other's changes.
 */
const tails = new Map<string, Promise<unknown>>();

export function withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}
