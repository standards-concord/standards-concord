import type { Store } from 'n3';

/**
 * A number that changes whenever a store gains or loses a quad, for caches of what was worked out
 * from it. The size alone isn't enough: replacing one triple with another keeps it the same.
 *
 * The first call counts from then on, by wrapping the store's own add and remove. Every way n3
 * changes a store goes through those two (addQuad, addQuads, import, addAll, removeQuad,
 * removeQuads, removeMatches, deleteGraph...); test/storeRevision.test.ts checks that for the
 * n3 version in use, so an upgrade that adds another path fails there.
 */
const revisions = new WeakMap<Store, { n: number }>();

type Internal = { _addQuad: (...a: unknown[]) => boolean; _removeQuad: (...a: unknown[]) => boolean };

let unknownStores = 0;

export function storeRevision(store: Store): number {
  let rev = revisions.get(store);
  if (!rev) {
    const s = store as unknown as Internal;
    // A store without them (another n3 version) can't be watched: a fresh number every time means
    // caches are rebuilt each check, slower but never stale.
    if (typeof s._addQuad !== 'function' || typeof s._removeQuad !== 'function') return -++unknownStores;
    const counter = { n: 0 };
    const add = s._addQuad.bind(store);
    const remove = s._removeQuad.bind(store);
    s._addQuad = (...a) => {
      const changed = add(...a);
      if (changed !== false) counter.n++;
      return changed;
    };
    s._removeQuad = (...a) => {
      const changed = remove(...a);
      if (changed !== false) counter.n++;
      return changed;
    };
    revisions.set(store, counter);
    rev = counter;
  }
  return rev.n;
}
