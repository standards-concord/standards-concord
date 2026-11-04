import type { OntologyView } from '@concord/shared';
import type { ClassView, PropertyView, Restriction } from '@concord/core/types';

/**
 * A derived, navigable model of an ontology for the visual views: the class hierarchy
 * in both directions, and for each class the properties that apply to it (its "slots",
 * in LinkML terms), with expected types and cardinalities taken from domains, ranges,
 * restrictions and functional characteristics. Inherited slots are included, schema.org
 * style, so a class page shows everything an instance of it can have.
 */

export const XSD = 'http://www.w3.org/2001/XMLSchema#';
export const RDFS_LITERAL = 'http://www.w3.org/2000/01/rdf-schema#Literal';
export const OWL_THING = 'http://www.w3.org/2002/07/owl#Thing';

export interface Slot {
  property: PropertyView;
  /** The class the slot is declared on (the class itself or an ancestor). */
  from: string;
  /** Expected types: class IRIs for object properties, datatype IRIs for datatype properties. */
  range: string[];
  /** Manchester text when the range is an anonymous expression (e.g. a union). */
  rangeExpression?: string;
  min: number;
  max: number | '*';
  /** True when an `only` restriction narrows the range. */
  closed?: boolean;
  /** How the slot is known: from rdfs:domain, or from a restriction on the class. */
  source: 'domain' | 'restriction';
}

export interface Relation {
  property: PropertyView;
  /** The class whose instances point here. */
  from: string;
  card: string;
  /** Set when the relationship targets an ancestor rather than the class itself. */
  via?: string;
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
  /** Root-to-class paths, one per route through multiple inheritance. */
  paths: (iri: string) => string[][];
  /** Slots declared directly on the class. */
  ownSlots: (iri: string) => Slot[];
  /** Own slots followed by inherited ones, grouped by the ancestor they come from. */
  allSlots: (iri: string) => { from: string; slots: Slot[] }[];
  /** Object properties whose range includes this class (or an ancestor), with their source class. */
  incoming: (iri: string) => Relation[];
  depth: (iri: string) => number;
}

export function cardText(min: number, max: number | '*') {
  if (max === '*') return min === 0 ? '0..*' : `${min}..*`;
  if (min === max) return String(min);
  return `${min}..${max}`;
}

export function isDatatype(iri: string) {
  return iri.startsWith(XSD) || iri === RDFS_LITERAL || iri.startsWith('http://www.w3.org/1999/02/22-rdf-syntax-ns#');
}

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
  const ancestors = (iri: string) => walk(iri, parents);
  const descendants = (iri: string) => walk(iri, children);

  const paths = (iri: string): string[][] => {
    const go = (x: string, seen: Set<string>): string[][] => {
      const ps = (parents.get(x) ?? []).filter((p) => !seen.has(p));
      if (!ps.length) return [[x]];
      return ps.flatMap((p) => go(p, new Set([...seen, x])).map((path) => [...path, x]));
    };
    return go(iri, new Set()).slice(0, 6);
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

  const functional = (p: PropertyView) => p.characteristics.includes('functional');

  const ownSlots = (iri: string): Slot[] => {
    const c = classes.get(iri);
    const slots = new Map<string, Slot>();
    for (const p of properties.values()) {
      if (!p.domain.includes(iri)) continue;
      slots.set(p.iri, {
        property: p,
        from: iri,
        range: p.range,
        rangeExpression: p.rangeExpressions?.[0],
        min: 0,
        max: functional(p) ? 1 : '*',
        source: 'domain',
      });
    }
    for (const r of c?.restrictions ?? []) {
      const p = properties.get(r.property);
      if (!p) continue;
      const s: Slot = slots.get(p.iri) ?? { property: p, from: iri, range: p.range, rangeExpression: p.rangeExpressions?.[0], min: 0, max: functional(p) ? 1 : '*', source: 'restriction' };
      applyRestriction(s, r);
      slots.set(p.iri, s);
    }
    return [...slots.values()].sort((a, b) => (a.property.label ?? a.property.iri).localeCompare(b.property.label ?? b.property.iri));
  };

  const allSlots = (iri: string) => {
    const own = ownSlots(iri);
    const seen = new Set(own.map((s) => s.property.iri));
    const groups = [{ from: iri, slots: own }];
    for (const a of ancestors(iri)) {
      const slots = ownSlots(a).filter((s) => !seen.has(s.property.iri));
      slots.forEach((s) => seen.add(s.property.iri));
      if (slots.length) groups.push({ from: a, slots });
    }
    return groups;
  };

  const incoming = (iri: string): Relation[] => {
    const targets = new Set([iri, ...ancestors(iri)]);
    const out: Relation[] = [];
    for (const p of view.objectProperties) {
      const hit = p.range.find((r) => targets.has(r));
      if (!hit) continue;
      for (const d of p.domain.length ? p.domain : [OWL_THING]) out.push({ property: p, from: d, card: functional(p) ? '0..1' : '0..*', via: hit === iri ? undefined : hit });
    }
    // Restrictions elsewhere whose filler is this class.
    for (const c of view.classes)
      for (const r of c.restrictions)
        if (r.filler && targets.has(r.filler) && !out.some((o) => o.property.iri === r.property && o.from === c.iri)) {
          const p = properties.get(r.property);
          if (p && p.kind === 'objectProperty') {
            const s: Slot = { property: p, from: c.iri, range: [r.filler], min: 0, max: functional(p) ? 1 : '*', source: 'restriction' };
            applyRestriction(s, r);
            out.push({ property: p, from: c.iri, card: cardText(s.min, s.max), via: r.filler === iri ? undefined : r.filler });
          }
        }
    return out.sort((a, b) => (a.property.label ?? '').localeCompare(b.property.label ?? ''));
  };

  return { classes, properties, parents, children, roots, ancestors, descendants, paths, ownSlots, allSlots, incoming, depth };
}

function applyRestriction(s: Slot, r: Restriction) {
  s.source = s.source === 'domain' ? 'domain' : 'restriction';
  const n = r.cardinality ?? 0;
  switch (r.kind) {
    case 'some':
      s.min = Math.max(s.min, 1);
      if (r.filler) s.range = [r.filler];
      break;
    case 'only':
      if (r.filler) s.range = [r.filler];
      s.closed = true;
      break;
    case 'exactly':
      s.min = n;
      s.max = n;
      if (r.filler) s.range = [r.filler];
      break;
    case 'min':
      s.min = Math.max(s.min, n);
      if (r.filler) s.range = [r.filler];
      break;
    case 'max':
      s.max = s.max === '*' ? n : Math.min(s.max, n);
      if (r.filler) s.range = [r.filler];
      break;
    case 'value':
      s.min = Math.max(s.min, 1);
      break;
  }
  if (r.fillerExpression) s.rangeExpression = r.fillerExpression;
  if (s.max !== '*' && s.min > s.max) s.min = s.max;
}
