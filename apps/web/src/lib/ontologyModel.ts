import type { OntologyView } from '@concord/shared';
import type { ClassView, PropertyView, Restriction } from '@concord/core/types';

/**
 * A derived, navigable model of an ontology for the visual views: the class hierarchy
 * in both directions, and for each class the properties that apply to it (its "slots",
 * in LinkML terms), with expected types and cardinalities.
 *
 * Cardinalities follow OWL 2 semantics rather than a naive "last one wins":
 *  - Restrictions on a class and on all of its ancestors accumulate (a subclass inherits
 *    every superclass restriction; nothing is overridden).
 *  - Total (unqualified) bounds come from functional characteristics (including via an
 *    inverse-functional inverse), unqualified cardinality restrictions, and lower bounds
 *    implied by existential and qualified minimum restrictions.
 *  - Qualified restrictions (`p max 1 Cat`, `p some Dog`) are kept as separate
 *    constraints. A qualified maximum only bounds the total when its filler covers the
 *    whole range.
 *  - rdfs:range declarations (including those of super-properties) and `only` fillers
 *    are intersected, not offered as alternatives.
 *  - Several constraints on the same type combine into per-type bounds ("targets"):
 *    `p min 2 Cat` and `p max 3 Cat` give 2..3 Cats.
 *  - Contradictions are reported as a conflict, never silently "fixed": bounds that can't
 *    all hold, values required of types disjoint with the range, or more distinct values
 *    (for mutually disjoint types) than the maximum allows. This is a summary of the stated
 *    axioms, not a reasoner; the consistency check is the authority.
 *  - Anonymous intersections of named classes and restrictions are split into their parts.
 *    Axioms the model can't summarise (unions, inverse restrictions, complex fillers) are
 *    listed as such, so the summary never claims to be complete
 *    when it isn't.
 */

export const XSD = 'http://www.w3.org/2001/XMLSchema#';
export const RDFS_LITERAL = 'http://www.w3.org/2000/01/rdf-schema#Literal';
export const OWL_THING = 'http://www.w3.org/2002/07/owl#Thing';

export type Max = number | '*';

/** One filler-qualified constraint, e.g. "at least 1 Dog" or "at most 1 Cat". */
export interface Qualified {
  kind: 'some' | 'min' | 'max' | 'exactly' | 'value';
  n: number;
  /** Class or datatype IRI. */
  filler?: string;
  /** Manchester text for an anonymous filler. */
  expression?: string;
  /** For `value` restrictions with a literal. */
  literal?: string;
  /** Class the restriction is asserted on. */
  on: string;
  /** Already reflected in the slot's total bounds and range (its filler covers the whole range). */
  implied?: boolean;
}

/** How many values of one particular type a slot allows, e.g. "0..1 Cat" alongside "1..* Animal" in total. */
export interface Target {
  /** Class or datatype IRI. */
  filler: string;
  min: number;
  max: Max;
  /** False for a type in the slot's range, true for one named only in a qualified restriction. */
  qualified: boolean;
  conflict?: string;
}

export interface Slot {
  property: PropertyView;
  /** The nearest class (the class itself, else the closest ancestor) that contributes to this slot. */
  from: string;
  /** Every class that contributes a domain or restriction to this slot. */
  sources: string[];
  /** Expected types, all of which apply (an intersection), reduced to the most specific. */
  range: string[];
  /** Manchester text for anonymous ranges (e.g. unions). */
  rangeExpressions: string[];
  /** Total number of values, across all fillers. */
  min: number;
  max: Max;
  qualified: Qualified[];
  /** Bounds per named type: each range class, and each class or datatype in a qualified restriction. */
  targets: Target[];
  /** Set when the bounds can't all hold (the class is then unsatisfiable). */
  conflict?: string;
  /** True when an `only` restriction narrows the range. */
  closed?: boolean;
  source: 'domain' | 'restriction';
}

export interface Relation {
  property: PropertyView;
  /** The class whose instances point here. */
  from: string;
  card: string;
  /** Set when the relationship targets an ancestor rather than the class itself. */
  via?: string;
  conflict?: boolean;
}

export interface OntologyModel {
  classes: Map<string, ClassView>;
  properties: Map<string, PropertyView>;
  parents: Map<string, string[]>;
  children: Map<string, string[]>;
  roots: string[];
  /** All ancestors, nearest first, cycle-safe. */
  ancestors: (iri: string) => string[];
  descendants: (iri: string) => string[];
  /** Root-to-class paths, at most `limit`; `more` is true when there are others. */
  paths: (iri: string, limit?: number) => { paths: string[][]; more: boolean };
  /** Slots with a contribution from the class itself, combined with everything it inherits. */
  ownSlots: (iri: string) => Slot[];
  /** Every slot, grouped by the nearest class that contributes to it. */
  allSlots: (iri: string) => { from: string; slots: Slot[] }[];
  /** Object properties whose combined range or fillers include this class (or an ancestor). */
  incoming: (iri: string) => Relation[];
  /** Axioms on the class or its ancestors that the slot summary doesn't capture. */
  unsummarised: (iri: string) => { on: string; text: string }[];
  depth: (iri: string) => number;
}

export function cardText(min: number, max: Max) {
  if (max === '*') return min === 0 ? '0..*' : `${min}..*`;
  if (min === max) return String(min);
  return `${min}..${max}`;
}

export function slotCard(s: Pick<Slot, 'min' | 'max' | 'conflict'>) {
  return s.conflict ? 'conflict' : cardText(s.min, s.max);
}

export function isDatatype(iri: string) {
  return iri.startsWith(XSD) || iri === RDFS_LITERAL || iri.startsWith('http://www.w3.org/1999/02/22-rdf-syntax-ns#');
}

const minOf = (a: Max, b: Max): Max => (a === '*' ? b : b === '*' ? a : Math.min(a, b));

export function buildModel(view: OntologyView): OntologyModel {
  const classes = new Map(view.classes.map((c) => [c.iri, c]));
  const properties = new Map<string, PropertyView>([...view.objectProperties, ...view.datatypeProperties].map((p) => [p.iri, p]));
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  // Appends in place: building lists by spreading would make large hubs quadratic.
  const push = <T,>(m: Map<string, T[]>, k: string, v: T) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  for (const c of view.classes) {
    const named = [...c.superClasses, ...(c.superClassConjuncts ?? []).flatMap((x) => x.classes)];
    const ps = [...new Set(named.filter((s) => classes.has(s) && s !== c.iri))];
    parents.set(c.iri, ps);
    for (const p of ps) push(children, p, c.iri);
  }
  const byLabel = (a: string, b: string) => (classes.get(a)?.label ?? a).localeCompare(classes.get(b)?.label ?? b);
  for (const v of children.values()) v.sort(byLabel);
  const roots = view.classes.filter((c) => !parents.get(c.iri)?.length).map((c) => c.iri).sort(byLabel);
  // Classes in a subclass cycle with no way up to a true root would never appear in the tree,
  // so one class from each such group stands in as a root.
  {
    const reached = new Set<string>();
    const reach = (start: string) => {
      const stack = [start];
      while (stack.length) {
        const x = stack.pop()!;
        if (reached.has(x)) continue;
        reached.add(x);
        stack.push(...(children.get(x) ?? []));
      }
    };
    roots.forEach(reach);
    for (const c of [...classes.keys()].sort(byLabel)) if (!reached.has(c)) (roots.push(c), reach(c));
  }

  const walk = (start: string, next: Map<string, string[]>) => {
    const out: string[] = [];
    const seen = new Set([start]);
    let frontier = [start];
    while (frontier.length) {
      const nf: string[] = [];
      for (const f of frontier)
        for (const n of next.get(f) ?? [])
          if (!seen.has(n)) {
            seen.add(n);
            out.push(n);
            nf.push(n);
          }
      frontier = nf;
    }
    return out;
  };
  const memo = <T,>(f: (iri: string) => T) => {
    const cache = new Map<string, T>();
    return (iri: string) => {
      if (!cache.has(iri)) cache.set(iri, f(iri));
      return cache.get(iri)!;
    };
  };
  const ancestors = memo((iri: string) => walk(iri, parents));
  const descendants = memo((iri: string) => walk(iri, children));
  const ancestorSet = memo((iri: string) => new Set(ancestors(iri)));
  const subsumedBy = (a: string, b: string) => a === b || b === OWL_THING || ancestorSet(a).has(b);

  // Disjointness, inherited: if A and B are disjoint, so are all their subclasses.
  const declaredDisjoint = new Map<string, Set<string>>();
  const addDisjoint = (a: string, b: string) => (declaredDisjoint.get(a) ?? declaredDisjoint.set(a, new Set()).get(a)!).add(b);
  for (const c of view.classes) for (const d of c.disjointWith) (addDisjoint(c.iri, d), addDisjoint(d, c.iri));
  const disjointFrom = memo((iri: string) => {
    const out = new Set<string>();
    for (const x of [iri, ...ancestors(iri)]) for (const d of declaredDisjoint.get(x) ?? []) out.add(d);
    return out;
  });
  const disjoint = (a: string, b: string) => {
    const da = disjointFrom(a);
    return da.size > 0 && (da.has(b) || ancestors(b).some((y) => da.has(y)));
  };

  // The first route down to each class in tree order (roots, then children breadth first),
  // used when walking up can't find one cheaply.
  let treeParent: Map<string, string> | undefined;
  const treePath = (iri: string) => {
    if (!treeParent) {
      treeParent = new Map();
      const seen = new Set(roots);
      let frontier = [...roots];
      while (frontier.length) {
        const next: string[] = [];
        for (const f of frontier)
          for (const k of children.get(f) ?? [])
            if (!seen.has(k)) (seen.add(k), treeParent.set(k, f), next.push(k));
        frontier = next;
      }
    }
    const out = [iri];
    for (let x = treeParent.get(iri); x !== undefined; x = treeParent.get(x)) out.unshift(x);
    return out;
  };
  const rootSet = new Set(roots);
  // Paths run from a root shown in the tree (including a cycle's stand-in root) down to the
  // class. Depth-first, stopping as soon as the budget is spent, so multiple inheritance can't
  // explode; a walk that loops back on itself without reaching a root is dropped.
  const paths = (iri: string, limit = 4) => {
    const out: string[][] = [];
    let more = false;
    let steps = 0;
    const go = (x: string, suffix: string[], seen: Set<string>) => {
      if (out.length >= limit || ++steps > 5000) {
        more = true;
        return;
      }
      if (rootSet.has(x)) {
        out.push([x, ...suffix]);
        return;
      }
      for (const p of parents.get(x) ?? []) {
        if (seen.has(p)) continue;
        if (out.length >= limit) {
          more = true;
          return;
        }
        go(p, [x, ...suffix], new Set([...seen, x]));
      }
    };
    go(iri, [], new Set());
    if (!out.length && classes.has(iri)) out.push(treePath(iri));
    return { paths: out, more };
  };

  const depthCache = new Map<string, number>();
  const depth = (iri: string): number => {
    const cached = depthCache.get(iri);
    if (cached !== undefined) return cached;
    depthCache.set(iri, 0);
    const d = Math.max(0, ...(parents.get(iri) ?? []).map((p) => depth(p) + 1));
    depthCache.set(iri, d);
    return d;
  };

  // Functional directly, through a functional super-property, or because an inverse of it
  // is inverse-functional.
  const inverses = new Map<string, string[]>();
  const addInverse = (a: string, b: string) => push(inverses, a, b);
  for (const p of properties.values()) if (p.inverseOf) (addInverse(p.iri, p.inverseOf), addInverse(p.inverseOf, p.iri));
  // Searches every super-property reachable from the property, so the answer doesn't depend
  // on evaluation order even when sub-property links form a cycle.
  const functionalIri = memo((iri: string): boolean => {
    const seen = new Set<string>();
    const stack = [iri];
    while (stack.length) {
      const x = stack.pop()!;
      if (seen.has(x)) continue;
      seen.add(x);
      const p = properties.get(x);
      if (!p) continue;
      if (p.characteristics.includes('functional')) return true;
      if ((inverses.get(x) ?? []).some((q) => properties.get(q)?.characteristics.includes('inverseFunctional'))) return true;
      stack.push(...p.superProperties);
    }
    return false;
  });
  const functional = (p: PropertyView) => functionalIri(p.iri);

  const domainIndex = new Map<string, PropertyView[]>();
  for (const p of properties.values()) for (const d of p.domain) push(domainIndex, d, p);

  // A property's own ranges plus those of its super-properties.
  const propRanges = memo((iri: string) => {
    const out = new Set<string>();
    const exprs = new Set<string>();
    const seen = new Set<string>();
    const visit = (x: string) => {
      if (seen.has(x)) return;
      seen.add(x);
      const p = properties.get(x);
      if (!p) return;
      p.range.forEach((r) => out.add(r));
      p.rangeExpressions?.forEach((e) => exprs.add(e));
      p.superProperties.forEach(visit);
    };
    visit(iri);
    return { range: [...out], expressions: [...exprs] };
  });

  /**
   * Drop types implied by a more specific one in the same intersection. Of types that imply
   * each other (a subclass cycle), the first is kept.
   */
  const mostSpecific = (types: string[]) => {
    const uniq = [...new Set(types)].filter((t) => t !== OWL_THING);
    return uniq.filter((t, i) => !uniq.some((u, j) => u !== t && classes.has(u) && subsumedBy(u, t) && (!subsumedBy(t, u) || j < i)));
  };

  const isUnqualified = (r: Restriction) => !r.filler && !r.fillerExpression ? true : r.filler === OWL_THING || r.filler === RDFS_LITERAL;

  type Contribution = { on: string; r?: Restriction; domain?: boolean };
  const keys = new WeakMap<Restriction, string>();
  const restrictionKey = (r: Restriction) => {
    let k = keys.get(r);
    if (k === undefined) keys.set(r, (k = `${r.kind}|${r.cardinality ?? ''}|${r.filler ?? ''}|${r.fillerExpression ?? ''}|${r.literal ?? ''}`));
    return k;
  };
  const LOWER = new Set(['some', 'min', 'exactly']);
  const UPPER = new Set(['max', 'exactly']);

  /**
   * The fewest values that can satisfy "at least n of type X" for each listed type: the largest
   * total over a set of mutually disjoint types (each needs its own values). Exact for up to
   * 16 types, which covers real ontologies; beyond that a greedy lower estimate.
   */
  const distinctNeeded = (items: { filler: string; n: number }[]) => {
    const best = new Map<string, number>();
    for (const it of items) best.set(it.filler, Math.max(best.get(it.filler) ?? 0, it.n));
    const list = [...best].map(([filler, n]) => ({ filler, n })).sort((a, b) => b.n - a.n);
    if (list.length <= 1) return list[0]?.n ?? 0;
    if (list.length > 16) {
      const picked: typeof list = [];
      for (const q of list) if (picked.every((o) => disjoint(o.filler, q.filler))) picked.push(q);
      return Math.max(list[0].n, picked.reduce((n, q) => n + q.n, 0));
    }
    const rest = list.map((_, i) => list.slice(i).reduce((n, q) => n + q.n, 0));
    let top = 0;
    const go = (i: number, chosen: typeof list, sum: number) => {
      if (sum + (rest[i] ?? 0) <= top) return;
      if (i === list.length) return void (top = sum);
      const q = list[i];
      if (chosen.every((o) => disjoint(o.filler, q.filler))) go(i + 1, [...chosen, q], sum + q.n);
      go(i + 1, chosen, sum);
    };
    go(0, [], 0);
    return top;
  };

  /** Combined slot for one property on one class, from the class and all its ancestors. */
  const combine = (cls: string, p: PropertyView, contributions: Contribution[]): Slot => {
    const pr = propRanges(p.iri);
    let range = [...pr.range];
    const rangeExpressions = new Set(pr.expressions);
    let min = 0;
    let max: Max = functional(p) ? 1 : '*';
    const qualified: Qualified[] = [];
    const seen = new Set<string>();
    let closed = false;
    for (const c of contributions) {
      const r = c.r;
      if (!r) continue;
      const n = r.cardinality ?? 0;
      if (r.kind === 'only') {
        closed = true;
        if (r.filler) range.push(r.filler);
        if (r.fillerExpression) rangeExpressions.add(r.fillerExpression);
        continue;
      }
      if (isUnqualified(r) && (r.kind === 'min' || r.kind === 'max' || r.kind === 'exactly')) {
        if (r.kind !== 'max') min = Math.max(min, n);
        if (r.kind !== 'min') max = minOf(max, n);
        continue;
      }
      // The same restriction stated on several ancestors counts once.
      const key = restrictionKey(r);
      if (seen.has(key)) continue;
      seen.add(key);
      const kind = r.kind as Qualified['kind'];
      qualified.push({ kind, n: kind === 'some' || kind === 'value' ? 1 : n, filler: r.filler, expression: r.fillerExpression, literal: r.literal, on: c.on });
    }
    range = mostSpecific(range);
    const conflicts: string[] = [];

    // At least n of one filler means at least n in total.
    for (const q of qualified) if (q.kind === 'value' || LOWER.has(q.kind)) min = Math.max(min, q.n);
    // A qualified maximum bounds the total only when every possible value is of that filler.
    const covers = (f?: string) => !!f && (f === OWL_THING || f === RDFS_LITERAL || (range.length > 0 && range.some((t) => subsumedBy(t, f))));
    for (const q of qualified) if (UPPER.has(q.kind) && covers(q.filler)) max = minOf(max, q.n);
    for (const q of qualified) if (q.kind !== 'value' && covers(q.filler)) q.implied = true;

    // Lower bounds on named types (classes and datatypes, not the individuals in `value`).
    const lowers = qualified.filter((q) => LOWER.has(q.kind) && q.n > 0 && q.filler && (classes.has(q.filler) || isDatatype(q.filler)));
    const classLowers = lowers.filter((q) => classes.has(q.filler!)).map((q) => ({ filler: q.filler!, n: q.n }));
    const uppers = qualified.filter((q) => UPPER.has(q.kind) && q.filler);
    const rangeClasses = range.filter((r) => classes.has(r));

    // Values required of a type disjoint with the expected type can't exist.
    for (const q of classLowers) if (rangeClasses.some((r) => disjoint(q.filler, r))) conflicts.push('needs a value of a type that is disjoint with its expected type');
    for (let i = 0; i < rangeClasses.length; i++)
      for (let j = i + 1; j < rangeClasses.length; j++)
        if (min > 0 && disjoint(rangeClasses[i], rangeClasses[j])) conflicts.push('its expected types are disjoint, so it can have no values');
    // Types that can't overlap need distinct values.
    min = Math.max(min, distinctNeeded(classLowers));

    // Per-type bounds: each range class, and each qualified filler the range doesn't already imply.
    const targetFillers = [...range.filter((r) => classes.has(r) || isDatatype(r)), ...qualified.filter((q) => !q.implied && q.kind !== 'value' && q.filler).map((q) => q.filler!)];
    // Index the bounds by filler, so each target looks up its subclasses and superclasses
    // rather than comparing every pair of constraints.
    const lowerBy = new Map<string, number>();
    for (const q of lowers) lowerBy.set(q.filler!, Math.max(lowerBy.get(q.filler!) ?? 0, q.n));
    const upperBy = new Map<string, number>();
    for (const q of uppers) upperBy.set(q.filler!, Math.min(upperBy.get(q.filler!) ?? Infinity, q.n));
    const targets: Target[] = [];
    for (const f of new Set(targetFillers)) {
      let tmin = covers(f) ? min : 0;
      // At least n of a subclass of f means at least n of f; subclasses that can't overlap add up.
      if (classes.has(f)) tmin = Math.max(tmin, distinctNeeded(classLowers.filter((q) => subsumedBy(q.filler, f))));
      else tmin = Math.max(tmin, lowerBy.get(f) ?? 0);
      // At most n of a superclass of f means at most n of f.
      let tmax: Max = max;
      for (const g of [f, OWL_THING, ...(classes.has(f) ? ancestors(f) : [])]) {
        const n = upperBy.get(g);
        if (n !== undefined) tmax = minOf(tmax, n);
      }
      if (classes.has(f) && rangeClasses.some((r) => disjoint(f, r))) tmax = 0;
      const t: Target = { filler: f, min: tmin, max: tmax, qualified: !range.includes(f) };
      if (tmax !== '*' && tmin > tmax) t.conflict = `needs at least ${tmin} but allows at most ${tmax} of this type`;
      targets.push(t);
    }

    if (max !== '*' && min > max) conflicts.unshift(`needs at least ${min} but allows at most ${max}`);
    for (const t of targets) if (t.conflict) conflicts.push(t.conflict);
    const sourceSet = new Set(contributions.map((c) => c.on));
    const sources = [...sourceSet];
    const from = sourceSet.has(cls) ? cls : (ancestors(cls).find((o) => sourceSet.has(o)) ?? cls);
    return {
      property: p,
      from,
      sources,
      range,
      rangeExpressions: [...rangeExpressions],
      min,
      max,
      qualified,
      targets,
      conflict: conflicts[0],
      closed,
      source: contributions.some((c) => c.domain) ? 'domain' : 'restriction',
    };
  };

  // What each class states itself, by property: domains, restrictions, and restrictions inside
  // intersection superclasses.
  const stated = memo((iri: string) => {
    const out = new Map<string, Contribution[]>();
    const add = (prop: string, c: Contribution) => {
      const list = out.get(prop);
      if (list) list.push(c);
      else out.set(prop, [c]);
    };
    for (const p of domainIndex.get(iri) ?? []) add(p.iri, { on: iri, domain: true });
    const c = classes.get(iri);
    for (const r of [...(c?.restrictions ?? []), ...(c?.superClassConjuncts ?? []).flatMap((x) => x.restrictions)]) if (properties.has(r.property)) add(r.property, { on: iri, r });
    return out;
  });
  // The classes that state something about each property.
  const statedOn = new Map<string, string[]>();
  for (const c of classes.keys()) for (const prop of stated(c).keys()) push(statedOn, prop, c);
  const position = memo((iri: string) => new Map([iri, ...ancestors(iri)].map((c, i) => [c, i])));

  /**
   * Everything that applies to one property on a class, nearest class first. Only the classes
   * that mention the property are visited, and a restriction repeated further up the hierarchy
   * is kept once (at its nearest statement).
   */
  const keyOf = (x: Contribution) => (x.r ? restrictionKey(x.r) : `domain|${x.on}`);
  // Linear-time cycle check: an iterative depth-first search that finds a back edge.
  const hasCycle = (() => {
    const state = new Map<string, 1 | 2>();
    for (const start of classes.keys()) {
      if (state.has(start)) continue;
      const stack: [string, number][] = [[start, 0]];
      state.set(start, 1);
      while (stack.length) {
        const top = stack[stack.length - 1];
        const ps = parents.get(top[0]) ?? [];
        if (top[1] >= ps.length) {
          state.set(top[0], 2);
          stack.pop();
          continue;
        }
        const p = ps[top[1]++];
        const st = state.get(p);
        if (st === 1) return true;
        if (st === undefined) (state.set(p, 1), stack.push([p, 0]));
      }
    }
    return false;
  })();
  // For a property most of the hierarchy mentions, build each class's list from its parents'
  // (deduplicated) lists, so the work doesn't grow with depth times restrictions.
  // Each entry records how many subclass steps up its statement is, so with several parents
  // a restriction is attributed to the nearest class that states it.
  type Entry = { x: Contribution; d: number };
  const fromParents = new Map<string, Entry[]>();
  const incrementalEntries = (iri: string, prop: string): Entry[] => {
    const k = `${iri}\n${prop}`;
    const hit = fromParents.get(k);
    if (hit) return hit;
    const best = new Map<string, Entry>();
    const offer = (x: Contribution, d: number) => {
      const key = keyOf(x);
      const cur = best.get(key);
      if (!cur || d < cur.d) best.set(key, { x, d });
    };
    for (const x of stated(iri).get(prop) ?? []) offer(x, 0);
    for (const parent of parents.get(iri) ?? []) for (const e of incrementalEntries(parent, prop)) offer(e.x, e.d + 1);
    const out = [...best.values()].sort((a, b) => a.d - b.d);
    fromParents.set(k, out);
    return out;
  };
  const incremental = (iri: string, prop: string) => incrementalEntries(iri, prop).map((e) => e.x);
  const contributionsFor = (iri: string, prop: string) => {
    const all = statedOn.get(prop) ?? [];
    const chain = [iri, ...ancestors(iri)];
    let holders: string[];
    if (all.length >= chain.length && !hasCycle) return incremental(iri, prop);
    if (all.length >= chain.length) holders = chain.filter((c) => stated(c).has(prop));
    else {
      const pos = position(iri);
      holders = all.filter((c) => pos.has(c)).sort((a, b) => pos.get(a)! - pos.get(b)!);
    }
    const keys = new Set<string>();
    const out: Contribution[] = [];
    for (const c of holders)
      for (const x of stated(c).get(prop)!) {
        const key = keyOf(x);
        if (keys.has(key)) continue;
        keys.add(key);
        out.push(x);
      }
    return out;
  };
  const byLabelProp = (a: Slot, b: Slot) => (a.property.label ?? a.property.iri).localeCompare(b.property.label ?? b.property.iri);

  // Slots the class itself contributes to (combined with everything inherited for those
  // properties). Only these are computed for every class, so inherited properties aren't
  // rebuilt at every level.
  const ownSlots = memo((iri: string): Slot[] => [...stated(iri).keys()].map((prop) => combine(iri, properties.get(prop)!, contributionsFor(iri, prop))).sort(byLabelProp));

  const slotsOf = memo((iri: string): Slot[] => {
    const props = new Set<string>();
    for (const c of [iri, ...ancestors(iri)]) for (const prop of stated(c).keys()) props.add(prop);
    return [...props].map((prop) => combine(iri, properties.get(prop)!, contributionsFor(iri, prop))).sort(byLabelProp);
  });

  const allSlots = (iri: string) => {
    const groups = new Map<string, Slot[]>([[iri, []]]);
    for (const s of slotsOf(iri)) groups.set(s.from, [...(groups.get(s.from) ?? []), s]);
    const order = [iri, ...ancestors(iri)];
    return [...groups.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([from, slots]) => ({ from, slots }));
  };

  const incoming = memo((iri: string): Relation[] => {
    const targets = new Set([iri, ...ancestors(iri)]);
    const out: Relation[] = [];
    // From the class each slot is first stated on, using the same combined constraints as its table.
    for (const c of classes.keys())
      for (const s of ownSlots(c)) {
        if (s.property.kind !== 'objectProperty') continue;
        // The class itself if it's a target, else its nearest ancestor that is; each with its own bounds.
        const hit = s.targets.find((t) => t.filler === iri) ?? s.targets.find((t) => targets.has(t.filler));
        if (!hit) continue;
        const card = s.conflict ? 'conflict' : cardText(hit.min, hit.max);
        out.push({ property: s.property, from: c, card, via: hit.filler === iri ? undefined : hit.filler, conflict: !!s.conflict });
      }
    // Properties with no domain can point here from anything.
    for (const p of view.objectProperties) {
      if (p.domain.length) continue;
      const hit = propRanges(p.iri).range.find((r) => targets.has(r));
      if (hit) out.push({ property: p, from: OWL_THING, card: functional(p) ? '0..1' : '0..*', via: hit === iri ? undefined : hit });
    }
    return out.sort((a, b) => (a.property.label ?? '').localeCompare(b.property.label ?? ''));
  });

  const unsummarised = (iri: string) => {
    const out: { on: string; text: string }[] = [];
    for (const on of [iri, ...ancestors(iri)]) {
      const c = classes.get(on);
      if (!c) continue;
      // An intersection counts as summarised only if every restriction in it could be used.
      const split = new Set((c.superClassConjuncts ?? []).filter((x) => x.restrictions.every((r) => properties.has(r.property))).map((x) => x.expression));
      for (const e of c.superClassExpressions ?? []) if (!split.has(e)) out.push({ on, text: `SubClassOf: ${e}` });
      for (const e of c.equivalentExpressions ?? []) out.push({ on, text: `EquivalentTo: ${e}` });
      for (const r of c.restrictions) if (!properties.has(r.property)) out.push({ on, text: `Restriction on an unknown property: ${r.property}` });
    }
    return out;
  };

  return { classes, properties, parents, children, roots, ancestors, descendants, paths, ownSlots, allSlots, incoming, unsummarised, depth };
}

/** Plain-language summary of a qualified constraint, e.g. "at least 1 Dog". */
export function qualifiedText(q: Qualified, label: (iri: string) => string) {
  const what = q.expression ?? (q.filler ? (isDatatype(q.filler) ? q.filler.replace(/^.*[#/]/, '') : label(q.filler)) : q.literal !== undefined ? JSON.stringify(q.literal) : 'anything');
  switch (q.kind) {
    case 'some':
      return `at least one ${what}`;
    case 'value':
      return `has the value ${what}`;
    case 'min':
      return `at least ${q.n} ${what}`;
    case 'max':
      return `at most ${q.n} ${what}`;
    case 'exactly':
      return `exactly ${q.n} ${what}`;
  }
}
