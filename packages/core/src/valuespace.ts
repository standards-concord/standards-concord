/**
 * Checks that values are in several datatypes at once, by value rather than
 * by datatype IRI.
 *
 * OWL's `p only D` means every value is in D's value space, but sh:datatype
 * checks a literal's datatype IRI exactly. One sh:datatype per restriction is
 * fine for a single datatype, but for two datatypes neither of which is
 * narrower (xsd:nonNegativeInteger and xsd:nonPositiveInteger) no literal has
 * both IRIs, so a pair of exact checks rejects every value, including the 0 OWL
 * allows. Instead the intersection is worked out here as constraints SHACL can
 * check by value: the family of datatypes whose values qualify (every XML
 * Schema type derived from the same primitive), numeric bounds, whole numbers,
 * lengths and patterns, from XML Schema's built-in types and the facets of the
 * ontology's own datatype definitions.
 */
import type { Store, Term } from 'n3';
import { NS } from './ns.js';
import { nn, objects, readList } from './rdf.js';
import { XSD_BASE } from './codemodel.js';

const XSD = NS.xsd;

/** XML Schema's primitive datatypes (and OWL 2's): their value spaces are pairwise disjoint. */
const PRIMITIVES = new Set(
  ['string', 'boolean', 'decimal', 'float', 'double', 'duration', 'dateTime', 'time', 'date', 'gYearMonth', 'gYear', 'gMonthDay', 'gDay', 'gMonth', 'hexBinary', 'base64Binary', 'anyURI', 'QName', 'NOTATION'].map(
    (l) => XSD + l,
  ),
);

/** Bounds of the built-in integer types (each also has its base's). */
const INTEGER_BOUNDS: Record<string, [string | undefined, string | undefined]> = {
  nonPositiveInteger: [undefined, '0'],
  negativeInteger: [undefined, '-1'],
  long: ['-9223372036854775808', '9223372036854775807'],
  int: ['-2147483648', '2147483647'],
  short: ['-32768', '32767'],
  byte: ['-128', '127'],
  nonNegativeInteger: ['0', undefined],
  unsignedLong: ['0', '18446744073709551615'],
  unsignedInt: ['0', '4294967295'],
  unsignedShort: ['0', '65535'],
  unsignedByte: ['0', '255'],
  positiveInteger: ['1', undefined],
};

/** The lexical forms of whole numbers among xsd:decimal's (1, +01, 1.0, 1., .0). */
export const WHOLE_NUMBER_PATTERN = '^[+-]?([0-9]+(\\.0*)?|\\.0+)$';

/** The primitive a built-in XML Schema datatype derives from, if it is one. */
function builtinRoot(dt: string): string | undefined {
  for (let x: string | undefined = dt, n = 0; x && n < 20; n++) {
    if (PRIMITIVES.has(x)) return x;
    x = x.startsWith(XSD) && XSD_BASE[x.slice(XSD.length)] ? XSD + XSD_BASE[x.slice(XSD.length)] : undefined;
  }
  return undefined;
}

/** The built-in datatypes whose values are values of `root`: the root and everything derived from it. */
export function family(root: string): string[] {
  return [root, ...Object.keys(XSD_BASE).map((l) => XSD + l).filter((d) => d !== root && builtinRoot(d) === root && derives(d, root))];
}
const derives = (a: string, b: string): boolean => {
  for (let x: string | undefined = a; x; x = x.startsWith(XSD) && XSD_BASE[x.slice(XSD.length)] ? XSD + XSD_BASE[x.slice(XSD.length)] : undefined) if (x === b) return true;
  return false;
};

interface Bound {
  value: string;
  inclusive: boolean;
}

/** What values of one datatype, or of several at once, satisfy. */
export interface ValueSpace {
  /** The primitive whose value space the values are in, when known. */
  root?: string;
  whole?: boolean;
  min?: Bound;
  max?: Bound;
  minLength?: number;
  maxLength?: number;
  /** XML Schema patterns, each matching the whole lexical form. */
  patterns: string[];
  /** Nothing qualifies. */
  empty?: boolean;
  /** Some of the definition couldn't be expressed, so the check is laxer than OWL. */
  partial: string[];
}

/** One definition of an ontology's datatype: the datatype it restricts (or equals) and the facets. */
interface Definition {
  base: string;
  facets: [string, Term][];
}

/** Every definition of each datatype defined in the store (`owl:equivalentClass` a datatype, or `owl:onDatatype` with facets). */
export function datatypeDefinitions(store: Store): Map<string, Definition[]> {
  const out = new Map<string, Definition[]>();
  for (const d of store.getSubjects(nn(NS.rdf + 'type'), nn(NS.rdfs + 'Datatype'), null)) {
    if (d.termType !== 'NamedNode') continue;
    const defs: Definition[] = [];
    for (const eq of objects(store, d, NS.owl + 'equivalentClass')) {
      if (eq.termType === 'NamedNode') {
        if (eq.value !== d.value) defs.push({ base: eq.value, facets: [] });
        continue;
      }
      const base = objects(store, eq, NS.owl + 'onDatatype')[0];
      if (base?.termType !== 'NamedNode') continue;
      const list = objects(store, eq, NS.owl + 'withRestrictions')[0];
      const facets = (list ? readList(store, list) ?? [] : []).flatMap((f) => store.getQuads(f, null, null, null).map((q): [string, Term] => [q.predicate.value, q.object]));
      defs.push({ base: base.value, facets });
    }
    if (defs.length) out.set(d.value, defs);
  }
  return out;
}

/** -1, 0 or 1. Integers are compared exactly; anything else as numbers. */
function compare(a: string, b: string): number {
  const int = /^[+-]?\d+$/;
  if (int.test(a) && int.test(b)) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const x = Number(a);
  const y = Number(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

const tighterMin = (a: Bound | undefined, b: Bound | undefined): Bound | undefined => {
  if (!a || !b) return a ?? b;
  const c = compare(a.value, b.value);
  return c > 0 ? a : c < 0 ? b : { value: a.value, inclusive: a.inclusive && b.inclusive };
};
const tighterMax = (a: Bound | undefined, b: Bound | undefined): Bound | undefined => {
  if (!a || !b) return a ?? b;
  const c = compare(a.value, b.value);
  return c < 0 ? a : c > 0 ? b : { value: a.value, inclusive: a.inclusive && b.inclusive };
};

const name = (iri: string) => (iri.startsWith(XSD) ? `xsd:${iri.slice(XSD.length)}` : `<${iri}>`);

/** Both value spaces: what values of `a` and of `b` must satisfy. */
function meet(a: ValueSpace, b: ValueSpace): ValueSpace {
  const out: ValueSpace = {
    root: a.root ?? b.root,
    whole: a.whole || b.whole || undefined,
    min: tighterMin(a.min, b.min),
    max: tighterMax(a.max, b.max),
    minLength: Math.max(a.minLength ?? 0, b.minLength ?? 0) || undefined,
    maxLength: a.maxLength === undefined ? b.maxLength : b.maxLength === undefined ? a.maxLength : Math.min(a.maxLength, b.maxLength),
    patterns: [...new Set([...a.patterns, ...b.patterns])],
    empty: a.empty || b.empty || (a.root !== undefined && b.root !== undefined && a.root !== b.root) || undefined,
    partial: [...new Set([...a.partial, ...b.partial])],
  };
  if (out.min && out.max) {
    const c = compare(out.min.value, out.max.value);
    if (c > 0 || (c === 0 && !(out.min.inclusive && out.max.inclusive))) out.empty = true;
    // Whole numbers strictly between two consecutive whole numbers: none.
    if (out.whole && !out.empty) {
      const lo = Math.ceil(Number(out.min.value) + (out.min.inclusive ? 0 : 1e-9));
      const hi = Math.floor(Number(out.max.value) - (out.max.inclusive ? 0 : 1e-9));
      if (Number.isSafeInteger(lo) && Number.isSafeInteger(hi) && lo > hi) out.empty = true;
    }
  }
  if (out.minLength !== undefined && out.maxLength !== undefined && out.minLength > out.maxLength) out.empty = true;
  return out;
}

/** The value space of one datatype, from XML Schema's built-in types and the ontology's definitions. */
export function valueSpace(dt: string, defs: Map<string, Definition[]>, seen: Set<string> = new Set()): ValueSpace {
  const root = builtinRoot(dt);
  if (root) {
    let out: ValueSpace = { root, patterns: [], partial: [] };
    if (derives(dt, XSD + 'integer')) out.whole = true;
    for (let x: string | undefined = dt; x && x !== root; x = XSD + XSD_BASE[x.slice(XSD.length)]) {
      const b = INTEGER_BOUNDS[x.slice(XSD.length)];
      if (b) out = meet(out, { patterns: [], partial: [], min: b[0] === undefined ? undefined : { value: b[0], inclusive: true }, max: b[1] === undefined ? undefined : { value: b[1], inclusive: true } });
    }
    return out;
  }
  const own = defs.get(dt);
  if (!own || seen.has(dt)) return { patterns: [], partial: [`${name(dt)} isn't a datatype whose values can be checked`] };
  seen.add(dt);
  // Every definition is equivalent, so values satisfy all of them.
  let out: ValueSpace | undefined;
  for (const d of own) {
    let v = valueSpace(d.base, defs, new Set(seen));
    for (const [facet, value] of d.facets) v = meet(v, facetSpace(facet, value, v.root));
    out = out ? meet(out, v) : v;
  }
  return out!;
}

function facetSpace(facet: string, value: Term, root: string | undefined): ValueSpace {
  const out: ValueSpace = { patterns: [], partial: [] };
  const f = facet.startsWith(XSD) ? facet.slice(XSD.length) : facet;
  const n = Number(value.value);
  const numeric = root === XSD + 'decimal';
  switch (f) {
    case 'minLength':
    case 'maxLength':
    case 'length':
      // sh:minLength counts the lexical form's characters, which is the facet's length only for strings and IRIs.
      if (!Number.isSafeInteger(n) || n < 0 || (root !== XSD + 'string' && root !== XSD + 'anyURI')) break;
      if (f !== 'maxLength') out.minLength = n;
      if (f !== 'minLength') out.maxLength = n;
      return out;
    case 'pattern':
      out.patterns.push(value.value);
      return out;
    case 'minInclusive':
    case 'minExclusive':
    case 'maxInclusive':
    case 'maxExclusive':
      if (!numeric || !/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(value.value)) break;
      out[f.startsWith('min') ? 'min' : 'max'] = { value: value.value, inclusive: f.endsWith('Inclusive') };
      return out;
  }
  out.partial.push(`the ${name(facet)} facet`);
  return out;
}

/** What several datatypes at once allow. */
export function intersect(datatypes: string[], defs: Map<string, Definition[]>): ValueSpace {
  return datatypes.map((d) => valueSpace(d, defs)).reduce(meet);
}

/** A numeric bound written as a literal: an xsd:integer when it is a whole number, otherwise an xsd:decimal. */
export const boundDatatype = (value: string) => (/^[+-]?\d+$/.test(value) ? XSD + 'integer' : XSD + 'decimal');
