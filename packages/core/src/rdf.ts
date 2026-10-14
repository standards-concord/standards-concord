/**
 * Low-level RDF helpers over an N3.js Store: term construction, RDF list access,
 * blank-node-insensitive canonical forms and Manchester rendering of class expressions.
 */
import { DataFactory, Store } from 'n3';
import type { Quad, Term, Literal, NamedNode, BlankNode, DefaultGraph } from 'n3';
import { NS, RDF_TYPE, compactIRI, qname } from './ns.js';

export const namedNode = (iri: string): NamedNode => DataFactory.namedNode(iri);
export const blankNode = (name?: string): BlankNode => DataFactory.blankNode(name);
export const defaultGraph = (): DefaultGraph => DataFactory.defaultGraph();
export const literal = (value: string, langOrDatatype?: string | NamedNode): Literal => DataFactory.literal(value, langOrDatatype);
export const quad = (s: Term, p: Term, o: Term, g: Term = DataFactory.defaultGraph()): Quad =>
  DataFactory.quad(s as any, p as any, o as any, g as any) as Quad;

export const RDF_FIRST = NS.rdf + 'first';
export const RDF_REST = NS.rdf + 'rest';
export const RDF_NIL = NS.rdf + 'nil';

export const nn = (iri: string) => namedNode(iri);
export const langLit = (value: string, lang = 'en') => literal(value, lang);
export const typedLit = (value: string, datatype: string) => literal(value, namedNode(datatype));

export function objects(store: Store, s: Term | string, p: string): Term[] {
  const subj = typeof s === 'string' ? namedNode(s) : s;
  return store.getObjects(subj as any, namedNode(p), null);
}

export function subjects(store: Store, p: string, o: Term | string): Term[] {
  const obj = typeof o === 'string' ? namedNode(o) : o;
  return store.getSubjects(namedNode(p), obj as any, null);
}

export function firstObject(store: Store, s: Term | string, p: string): Term | undefined {
  return objects(store, s, p)[0];
}

export function hasType(store: Store, s: Term | string, type: string): boolean {
  const subj = typeof s === 'string' ? namedNode(s) : s;
  return store.countQuads(subj as any, namedNode(RDF_TYPE), namedNode(type), null) > 0;
}

/** Reads a well-formed RDF collection; returns null if `head` is not a list. */
export function readList(store: Store, head: Term): Term[] | null {
  const items: Term[] = [];
  const seen = new Set<string>();
  let node: Term = head;
  while (!(node.termType === 'NamedNode' && node.value === RDF_NIL)) {
    if (node.termType !== 'BlankNode' || seen.has(node.value)) return null;
    seen.add(node.value);
    const first = objects(store, node, RDF_FIRST);
    const rest = objects(store, node, RDF_REST);
    if (first.length !== 1 || rest.length !== 1) return null;
    items.push(first[0]);
    node = rest[0];
  }
  return items;
}

/** Creates an RDF list in the store and returns its head. */
export function writeList(store: Store, items: Term[]): Term {
  if (items.length === 0) return namedNode(RDF_NIL);
  const nodes = items.map(() => blankNode());
  items.forEach((item, i) => {
    store.addQuad(nodes[i], namedNode(RDF_FIRST), item as any);
    store.addQuad(nodes[i], namedNode(RDF_REST), (i + 1 < nodes.length ? nodes[i + 1] : namedNode(RDF_NIL)) as any);
  });
  return nodes[0];
}

/** Escapes a string for an N-Triples/Turtle short literal. */
export function escapeString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

export function literalToNT(l: Literal): string {
  const base = `"${escapeString(l.value)}"`;
  if (l.language) return `${base}@${l.language}`;
  if (l.datatype && l.datatype.value !== NS.xsd + 'string') return `${base}^^<${l.datatype.value}>`;
  return base;
}

/** N-Triples form of a non-blank term. */
export function termToNT(t: Term): string {
  if (t.termType === 'NamedNode') return `<${t.value}>`;
  if (t.termType === 'Literal') return literalToNT(t as Literal);
  if (t.termType === 'BlankNode') return `_:${t.value}`;
  return t.value;
}

/**
 * Canonical, blank-node-label-independent string for a term: blank nodes are
 * expanded to their (sorted) property structure, lists to `( ... )`.
 */
export function canonical(store: Store, t: Term, seen: Set<string> = new Set()): string {
  if (t.termType !== 'BlankNode') return termToNT(t);
  if (seen.has(t.value)) return '[cycle]';
  const next = new Set(seen).add(t.value);
  const list = readList(store, t);
  if (list) return '( ' + list.map((i) => canonical(store, i, next)).join(' ') + ' )';
  const parts = store
    .getQuads(t, null, null, null)
    .map((q) => `<${q.predicate.value}> ${canonical(store, q.object as Term, next)}`)
    .sort();
  return '[ ' + parts.join(' ; ') + ' ]';
}

/** Removes all triples of a blank-node structure (recursively), e.g. a restriction. */
export function removeBlankSubtree(store: Store, t: Term, seen: Set<string> = new Set()): void {
  if (t.termType !== 'BlankNode' || seen.has(t.value)) return;
  seen.add(t.value);
  for (const q of store.getQuads(t, null, null, null)) {
    store.removeQuad(q);
    removeBlankSubtree(store, q.object as Term, seen);
  }
}

/** Copies the blank-node structure rooted at `t` from `src` into `dst`, returning the new root. */
export function copyBlankSubtree(src: Store, dst: Store, t: Term, map: Map<string, Term> = new Map()): Term {
  if (t.termType !== 'BlankNode') return t;
  const existing = map.get(t.value);
  if (existing) return existing;
  const b = blankNode();
  map.set(t.value, b);
  for (const q of src.getQuads(t, null, null, null)) {
    dst.addQuad(b, q.predicate as any, copyBlankSubtree(src, dst, q.object as Term, map) as any);
  }
  return b;
}

/** All IRIs mentioned anywhere inside a (possibly blank) term's structure. */
export function iriSignature(store: Store, t: Term, out: Set<string> = new Set(), seen: Set<string> = new Set()): Set<string> {
  if (t.termType === 'NamedNode') out.add(t.value);
  else if (t.termType === 'BlankNode' && !seen.has(t.value)) {
    seen.add(t.value);
    for (const q of store.getQuads(t, null, null, null)) {
      if (q.predicate.value !== RDF_TYPE && q.predicate.value !== RDF_FIRST && q.predicate.value !== RDF_REST) {
        out.add(q.predicate.value);
      }
      iriSignature(store, q.object as Term, out, seen);
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* Manchester rendering                                                      */
/* ------------------------------------------------------------------------ */

export function renderName(iri: string, prefixes: Record<string, string>): string {
  return qname(iri, prefixes) ?? `<${iri}>`;
}

export function renderLiteral(l: Literal, prefixes: Record<string, string>): string {
  const base = `"${escapeString(l.value)}"`;
  if (l.language) return `${base}@${l.language}`;
  const dt = l.datatype?.value;
  if (!dt || dt === NS.xsd + 'string') return base;
  if (dt === NS.xsd + 'integer' && /^[+-]?\d+$/.test(l.value)) return l.value;
  if (dt === NS.xsd + 'boolean' && /^(true|false)$/.test(l.value)) return l.value;
  return `${base}^^${compactIRI(dt, prefixes) === dt ? `<${dt}>` : compactIRI(dt, prefixes)}`;
}

const FACETS: Record<string, string> = {
  minInclusive: '>=', maxInclusive: '<=', minExclusive: '>', maxExclusive: '<',
  length: 'length', minLength: 'minLength', maxLength: 'maxLength', pattern: 'pattern',
};

/** Renders a class/data range expression in Manchester syntax. */
export function manchesterExpr(store: Store, t: Term, prefixes: Record<string, string>, nested = false): string {
  if (t.termType === 'NamedNode') return renderName(t.value, prefixes);
  if (t.termType === 'Literal') return renderLiteral(t as Literal, prefixes);
  const one = (p: string) => firstObject(store, t, NS.owl + p);
  const wrap = (s: string) => (nested ? `(${s})` : s);
  const sub = (x: Term) => manchesterExpr(store, x, prefixes, true);

  const onProp = one('onProperty');
  if (onProp) {
    let p: string;
    const inv = onProp.termType === 'BlankNode' ? firstObject(store, onProp, NS.owl + 'inverseOf') : undefined;
    p = inv ? `inverse ${sub(inv)}` : sub(onProp);
    const filler = one('onClass') ?? one('onDataRange');
    const card = (k: string) => {
      const n = one(k);
      return n ? n.value : undefined;
    };
    let s: string | undefined;
    if (one('someValuesFrom')) s = `${p} some ${sub(one('someValuesFrom')!)}`;
    else if (one('allValuesFrom')) s = `${p} only ${sub(one('allValuesFrom')!)}`;
    else if (one('hasValue')) s = `${p} value ${sub(one('hasValue')!)}`;
    else if (one('hasSelf')) s = `${p} Self`;
    else {
      for (const [k, word] of [['minCardinality', 'min'], ['maxCardinality', 'max'], ['cardinality', 'exactly'],
        ['minQualifiedCardinality', 'min'], ['maxQualifiedCardinality', 'max'], ['qualifiedCardinality', 'exactly']]) {
        const n = card(k);
        if (n !== undefined) {
          s = `${p} ${word} ${n}${filler ? ' ' + sub(filler) : ''}`;
          break;
        }
      }
    }
    return wrap(s ?? `${p} ?`);
  }
  for (const [k, op] of [['intersectionOf', ' and '], ['unionOf', ' or ']] as const) {
    const head = one(k);
    if (head) {
      const items = readList(store, head) ?? [];
      return wrap(items.map(sub).join(op));
    }
  }
  const comp = one('complementOf') ?? one('datatypeComplementOf');
  if (comp) return `not ${sub(comp)}`;
  const oneOf = one('oneOf');
  if (oneOf) return `{${(readList(store, oneOf) ?? []).map(sub).join(' , ')}}`;
  const onDatatype = one('onDatatype');
  if (onDatatype) {
    const facets = (readList(store, one('withRestrictions') ?? namedNode(RDF_NIL)) ?? []).flatMap((f) =>
      store.getQuads(f, null, null, null).map((q) => {
        const name = q.predicate.value.startsWith(NS.xsd) ? q.predicate.value.slice(NS.xsd.length) : q.predicate.value;
        return `${FACETS[name] ?? name} ${renderLiteral(q.object as Literal, prefixes)}`;
      }),
    );
    return `${sub(onDatatype)}[${facets.join(' , ')}]`;
  }
  return `[${canonical(store, t)}]`;
}

/** Copies quads into a fresh store (sharing term objects, which are immutable). */
export function cloneStore(store: Store): Store {
  const s = new Store();
  s.addQuads(store.getQuads(null, null, null, null) as Quad[]);
  return s;
}
