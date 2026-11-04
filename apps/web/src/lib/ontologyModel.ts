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
  for (const c of view.classes) {
    const named = [...c.superClasses, ...(c.superClassConjuncts ?? []).flatMap((x) => x.classes)];
    const ps = [...new Set(named.filter((s) => classes.has(s) && s !== c.iri))];
    parents.set(c.iri, ps);
    for (const p of ps) children.set(p, [...(children.get(p) ?? []), c.iri]);
  }
  const byLabel = (a: string, b: string) => (classes.get(a)?.label ?? a).localeCompare(classes.get(b)?.label ?? b);
  for (const v of children.values()) v.sort(byLabel);
  const roots = view.classes.filter((c) => !parents.get(c.iri)?.length).map((c) => c.iri).sort(byLabel);

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

  // Depth-first, stopping as soon as the budget is spent, so multiple inheritance can't explode.
  const paths = (iri: string, limit = 4) => {
    const out: string[][] = [];
    let more = false;
    const go = (x: string, suffix: string[], seen: Set<string>) => {
      if (out.length >= limit) {
        more = true;
        return;
      }
      const ps = (parents.get(x) ?? []).filter((p) => !seen.has(p));
      if (!ps.length) {
        out.push([x, ...suffix]);
        return;
      }
      for (const p of ps) {
        if (out.length >= limit) {
          more = true;
          return;
        }
        go(p, [x, ...suffix], new Set([...seen, x]));
      }
    };
    go(iri, [], new Set());
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
  const addInverse = (a: string, b: string) => inverses.set(a, [...(inverses.get(a) ?? []), b]);
  for (const p of properties.values()) if (p.inverseOf) (addInverse(p.iri, p.inverseOf), addInverse(p.inverseOf, p.iri));
  const functionalIri = memo((iri: string): boolean => {
    const p = properties.get(iri);
    if (!p) return false;
    if (p.characteristics.includes('functional')) return true;
    if ((inverses.get(iri) ?? []).some((q) => properties.get(q)?.characteristics.includes('inverseFunctional'))) return true;
    return p.superProperties.some((sp) => sp !== iri && functionalSafe(sp));
  });
  const visiting = new Set<string>();
  const functionalSafe = (iri: string) => {
    if (visiting.has(iri)) return false;
    visiting.add(iri);
    try {
      return functionalIri(iri);
    } finally {
      visiting.delete(iri);
    }
  };
  const functional = (p: PropertyView) => functionalSafe(p.iri);

  const domainIndex = new Map<string, PropertyView[]>();
  for (const p of properties.values()) for (const d of p.domain) domainIndex.set(d, [...(domainIndex.get(d) ?? []), p]);

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

    // Lower bounds on named classes (not individuals in `value`), largest first.
    const lowers = qualified.filter((q) => LOWER.has(q.kind) && q.n > 0 && q.filler && classes.has(q.filler)).sort((a, b) => b.n - a.n);
    const uppers = qualified.filter((q) => UPPER.has(q.kind) && q.filler);
    const rangeClasses = range.filter((r) => classes.has(r));

    // Values required of a type disjoint with the expected type can't exist.
    for (const q of lowers) if (rangeClasses.some((r) => disjoint(q.filler!, r))) conflicts.push('needs a value of a type that is disjoint with its expected type');
    for (let i = 0; i < rangeClasses.length; i++)
      for (let j = i + 1; j < rangeClasses.length; j++)
        if (min > 0 && disjoint(rangeClasses[i], rangeClasses[j])) conflicts.push('its expected types are disjoint, so it can have no values');
    // Fillers that can't overlap need distinct values (a greedy, so lower, estimate).
    const picked: Qualified[] = [];
    for (const q of lowers) if (picked.every((o) => disjoint(o.filler!, q.filler!))) picked.push(q);
    if (picked.length > 1) min = Math.max(min, picked.reduce((n, q) => n + q.n, 0));

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
      // At least n of a subclass of f means at least n of f.
      const below = classes.has(f) ? descendants(f) : [];
      if (below.length < lowerBy.size) {
        for (const g of [f, ...below]) tmin = Math.max(tmin, lowerBy.get(g) ?? 0);
      } else for (const [g, n] of lowerBy) if (subsumedBy(g, f)) tmin = Math.max(tmin, n);
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

  // Restrictions stated on a class, including the parts of intersection superclasses.
  const statedRestrictions = memo((iri: string) => {
    const c = classes.get(iri);
    return [...(c?.restrictions ?? []), ...(c?.superClassConjuncts ?? []).flatMap((x) => x.restrictions)].filter((r) => properties.has(r.property));
  });

  // Every domain and restriction that applies to a class, by property, built from its parents'
  // (already deduplicated) lists, so the work grows with the distinct restrictions rather
  // than with depth times restrictions. A restriction repeated further up adds nothing, so
  // only its nearest statement is kept.
  type Bucket = { keys: Set<string>; list: Contribution[] };
  const collect = (iri: string, inherit: (parent: string) => Map<string, Bucket>) => {
    const out = new Map<string, Bucket>();
    const add = (prop: string, c: Contribution) => {
      const key = c.r ? restrictionKey(c.r) : `domain|${c.on}`;
      let b = out.get(prop);
      if (!b) out.set(prop, (b = { keys: new Set(), list: [] }));
      if (b.keys.has(key)) return;
      b.keys.add(key);
      b.list.push(c);
    };
    for (const p of domainIndex.get(iri) ?? []) add(p.iri, { on: iri, domain: true });
    for (const r of statedRestrictions(iri)) add(r.property, { on: iri, r });
    for (const parent of parents.get(iri) ?? []) for (const [prop, b] of inherit(parent)) for (const c of b.list) add(prop, c);
    return out;
  };
  // In a subclass cycle, a class's parents depend on it, so it's collected from its flat ancestor list instead.
  const inCycle = (iri: string) => (parents.get(iri) ?? []).some((p) => p === iri || ancestorSet(p).has(iri));
  const own = (iri: string) => collect(iri, () => new Map());
  const applicable: (iri: string) => Map<string, Bucket> = memo((iri: string) => {
    if (!inCycle(iri)) return collect(iri, applicable);
    const out = own(iri);
    for (const a of ancestors(iri))
      for (const [prop, b] of own(a)) {
        let mine = out.get(prop);
        if (!mine) out.set(prop, (mine = { keys: new Set(), list: [] }));
        for (const c of b.list) {
          const key = c.r ? restrictionKey(c.r) : `domain|${c.on}`;
          if (!mine.keys.has(key)) (mine.keys.add(key), mine.list.push(c));
        }
      }
    return out;
  });

  const slotsOf = memo((iri: string): Slot[] =>
    [...applicable(iri).entries()]
      .map(([prop, b]) => combine(iri, properties.get(prop)!, b.list))
      .sort((a, b) => (a.property.label ?? a.property.iri).localeCompare(b.property.label ?? b.property.iri)),
  );

  const ownSlots = (iri: string) => slotsOf(iri).filter((s) => s.from === iri);

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
      const split = new Set((c.superClassConjuncts ?? []).map((x) => x.expression));
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
