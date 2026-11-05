import type { ReasonerResult } from '@concord/core/types';

/** How far a reasoner run got; reports stored before `checked` existed count as complete when available. */
export const checkedOf = (r: ReasonerResult) => r.checked ?? (r.available ? 'complete' : 'none');

const sorted = (xs: string[]) => [...xs].sort().join(' ');

/**
 * Whether two reasoner runs agree on everything the panel shows apart from timings: the engine,
 * the verdict, how far each got, unsatisfiable classes, inferred relations, profile notes, the
 * explanation and why a check didn't finish.
 */
export const sameResult = (a: ReasonerResult, b: ReasonerResult) =>
  a.engine === b.engine &&
  a.available === b.available &&
  checkedOf(a) === checkedOf(b) &&
  a.consistent === b.consistent &&
  sorted(a.unsatisfiable) === sorted(b.unsatisfiable) &&
  sorted(a.inferredSubClassOf.map(([x, y]) => `${x}<${y}`)) === sorted(b.inferredSubClassOf.map(([x, y]) => `${x}<${y}`)) &&
  sorted((a.profile ?? []).map((n) => `${n.kind}:${n.detail}`)) === sorted((b.profile ?? []).map((n) => `${n.kind}:${n.detail}`)) &&
  (a.explanation ?? '') === (b.explanation ?? '') &&
  (a.error ?? '') === (b.error ?? '');

/**
 * Compares an in-browser run (of the draft at `checkedRevision`) with the server's report (for
 * `serverRevision`). Runs of different revisions are never compared.
 */
export function compareWithServer(browser: ReasonerResult, checkedRevision: string | undefined, server: ReasonerResult, serverRevision: string | undefined): 'other-revision' | 'same' | 'differs' {
  if (!serverRevision || checkedRevision !== serverRevision) return 'other-revision';
  return sameResult(browser, server) ? 'same' : 'differs';
}
