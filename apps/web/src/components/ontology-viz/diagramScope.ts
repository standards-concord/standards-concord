import { cardText, type OntologyModel, type Slot } from '../../lib/ontologyModel';

export interface DiagramOptions {
  attributes: boolean;
  inherited: boolean;
  associations: boolean;
  subclasses: boolean;
}

export const DEFAULT_DIAGRAM_OPTIONS: DiagramOptions = { attributes: true, inherited: false, associations: true, subclasses: true };

/**
 * The classes an object property slot links to, each with its own bounds: the range classes,
 * plus any class named in a qualified restriction (e.g. "0..1 Cat" and "1..* Dog"). If the
 * property's constraints contradict each other, every edge shows the conflict.
 */
export function slotTargets(model: OntologyModel, s: Slot): { target: string; card: string }[] {
  if (s.property.kind !== 'objectProperty') return [];
  return s.targets.filter((t) => model.classes.has(t.filler)).map((t) => ({ target: t.filler, card: s.conflict || t.conflict ? 'conflict' : cardText(t.min, t.max) }));
}

/** Classes within `hops` links of `focus`, following the relationships that are drawn. */
export function neighbourhood(model: OntologyModel, focus: string, hops: number, opts: DiagramOptions) {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!model.classes.has(a) || !model.classes.has(b)) return;
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
  };
  for (const [c, ps] of model.parents) for (const p of ps) link(c, p);
  if (opts.associations)
    for (const c of model.classes.keys()) for (const s of model.ownSlots(c)) for (const t of slotTargets(model, s)) link(c, t.target);
  const seen = new Set([focus]);
  let frontier = [focus];
  for (let i = 0; i < hops; i++) {
    const next: string[] = [];
    for (const f of frontier) for (const n of adj.get(f) ?? []) if (!seen.has(n)) (seen.add(n), next.push(n));
    frontier = next;
  }
  return seen;
}

