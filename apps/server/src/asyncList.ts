/**
 * Array helpers for checks that are async. Array.prototype.filter, some and every take each promise an
 * async callback returns as true, so `xs.filter(async (x) => …)` keeps everything: use these instead.
 */
export async function filterAsync<T>(xs: readonly T[], keep: (x: T) => Promise<boolean> | boolean): Promise<T[]> {
  const kept = await Promise.all(xs.map(keep));
  return xs.filter((_, i) => kept[i]);
}

/** True if any item passes, checking one at a time and stopping at the first that does. */
export async function someAsync<T>(xs: readonly T[], test: (x: T) => Promise<boolean> | boolean): Promise<boolean> {
  for (const x of xs) if (await test(x)) return true;
  return false;
}

/** True if every item passes, checking one at a time and stopping at the first that doesn't. */
export async function everyAsync<T>(xs: readonly T[], test: (x: T) => Promise<boolean> | boolean): Promise<boolean> {
  for (const x of xs) if (!(await test(x))) return false;
  return true;
}
