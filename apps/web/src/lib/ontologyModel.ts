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
 *  - Contradictory bounds are reported as a conflict, never silently "fixed".
 *  - Axioms the model can't summarise (anonymous intersections, inverse restrictions,
 *    complex fillers) are listed as such, so the summary never claims to be complete
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
    const ps = [...new Set(c.superClasses.filter((s) => classes.has(s) && s !== c.iri))];
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
  const subsumedBy = (a: string, b: string) => a === b || b === OWL_THING || ancestors(a).includes(b);

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

  // Functional directly, or because an inverse of it is inverse-functional.
  const functional = (p: PropertyView) =>
    p.characteristics.includes('functional') ||
    (!!p.inverseOf && !!properties.get(p.inverseOf)?.characteristics.includes('inverseFunctional')) ||
    [...properties.values()].some((q) => q.inverseOf === p.iri && q.characteristics.includes('inverseFunctional'));

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

  /** Drop types implied by a more specific one in the same intersection. */
  const mostSpecific = (types: string[]) => {
    const uniq = [...new Set(types)].filter((t) => t !== OWL_THING);
    return uniq.filter((t) => !uniq.some((u) => u !== t && classes.has(u) && subsumedBy(u, t)));
  };

  const isUnqualified = (r: Restriction) => !r.filler && !r.fillerExpression ? true : r.filler === OWL_THING || r.filler === RDFS_LITERAL;

  /** Combined slot for one property on one class, from the class and all its ancestors. */
  const combine = (cls: string, p: PropertyView, contributions: { on: string; r?: Restriction; domain?: boolean }[]): Slot => {
    const pr = propRanges(p.iri);
    let range = [...pr.range];
    const rangeExpressions = [...pr.expressions];
    let min = 0;
    let max: Max = functional(p) ? 1 : '*';
    const qualified: Qualified[] = [];
    let closed = false;
    for (const c of contributions) {
      const r = c.r;
      if (!r) continue;
      const n = r.cardinality ?? 0;
      if (r.kind === 'only') {
        closed = true;
        if (r.filler) range.push(r.filler);
        if (r.fillerExpression) rangeExpressions.push(r.fillerExpression);
        continue;
      }
      if (isUnqualified(r) && (r.kind === 'min' || r.kind === 'max' || r.kind === 'exactly')) {
        if (r.kind !== 'max') min = Math.max(min, n);
        if (r.kind !== 'min') max = minOf(max, n);
        continue;
      }
      const kind = r.kind as Qualified['kind'];
      qualified.push({ kind, n: kind === 'some' || kind === 'value' ? 1 : n, filler: r.filler, expression: r.fillerExpression, literal: r.literal, on: c.on });
    }
    range = mostSpecific(range);
    // At least n of one filler means at least n in total.
    for (const q of qualified) if (q.kind === 'some' || q.kind === 'value' || q.kind === 'min' || q.kind === 'exactly') min = Math.max(min, q.n);
    // A qualified maximum bounds the total only when every possible value is of that filler.
    const covers = (f?: string) => !!f && (f === OWL_THING || f === RDFS_LITERAL || (range.length > 0 && range.some((t) => subsumedBy(t, f))));
    for (const q of qualified) if ((q.kind === 'max' || q.kind === 'exactly') && covers(q.filler)) max = minOf(max, q.n);
    for (const q of qualified) if (q.kind !== 'value' && covers(q.filler)) q.implied = true;

    let conflict: string | undefined;
    if (max !== '*' && min > max) conflict = `needs at least ${min} but allows at most ${max}`;
    for (const q of qualified) {
      if (!q.filler || conflict) continue;
      // Same filler, or one implied by another: min/some above a max on a covering filler.
      const lower = qualified.filter((o) => (o.kind === 'min' || o.kind === 'exactly' || o.kind === 'some') && o.filler && subsumedBy(o.filler, q.filler!)).reduce((m, o) => Math.max(m, o.n), 0);
      if ((q.kind === 'max' || q.kind === 'exactly') && lower > q.n) conflict = `needs at least ${lower} values of one type but allows at most ${q.n}`;
    }
    const sources = [...new Set(contributions.map((c) => c.on))];
    const order = [cls, ...ancestors(cls)];
    const from = order.find((o) => sources.includes(o)) ?? cls;
    return {
      property: p,
      from,
      sources,
      range,
      rangeExpressions: [...new Set(rangeExpressions)],
      min,
      max,
      qualified,
      conflict,
      closed,
      source: contributions.some((c) => c.domain) ? 'domain' : 'restriction',
    };
  };

  const slotsOf = memo((iri: string): Slot[] => {
    const chain = [iri, ...ancestors(iri)];
    const contributions = new Map<string, { on: string; r?: Restriction; domain?: boolean }[]>();
    const add = (prop: string, c: { on: string; r?: Restriction; domain?: boolean }) => contributions.set(prop, [...(contributions.get(prop) ?? []), c]);
    for (const on of chain) {
      for (const p of properties.values()) if (p.domain.includes(on)) add(p.iri, { on, domain: true });
      for (const r of classes.get(on)?.restrictions ?? []) if (properties.has(r.property)) add(r.property, { on, r });
    }
    return [...contributions.entries()]
      .map(([prop, cs]) => combine(iri, properties.get(prop)!, cs))
      .sort((a, b) => (a.property.label ?? a.property.iri).localeCompare(b.property.label ?? b.property.iri));
  });

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
        const hit = s.range.find((r) => targets.has(r)) ?? s.qualified.find((q) => q.filler && targets.has(q.filler))?.filler;
        if (!hit) continue;
        out.push({ property: s.property, from: c, card: slotCard(s), via: hit === iri ? undefined : hit, conflict: !!s.conflict });
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
      for (const e of c.superClassExpressions ?? []) out.push({ on, text: `SubClassOf: ${e}` });
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
