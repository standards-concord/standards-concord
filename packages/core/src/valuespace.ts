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
import { derives, XSD_BASE } from './xsdTypes.js';

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

/**
 * The restrictions XML Schema puts on its built-in string subtypes and
 * xsd:dateTimeStamp, as SHACL patterns on the lexical form (which for the
 * string types is the value). Name-like types need XML's name-character
 * escapes (`\i`, `\c`), which XPath has but not every SHACL engine supports
 * (pySHACL doesn't), and a duration's lexical form doesn't show its value (P0Y
 * and PT0S are both zero), so those aren't checked here: only the token rules
 * they inherit are, and a note says so.
 */
const BUILTIN_PATTERNS: Record<string, string | null> = {
  normalizedString: '^[^\\r\\n\\t]*$',
  token: '^([^ \\r\\n\\t]+( [^ \\r\\n\\t]+)*)?$',
  language: '^[a-zA-Z]{1,8}(-[a-zA-Z0-9]{1,8})*$',
  Name: null,
  NCName: null,
  NMTOKEN: null,
  ID: null,
  IDREF: null,
  ENTITY: null,
  dateTimeStamp: '(Z|[+-][0-9]{2}:[0-9]{2})$',
  yearMonthDuration: null,
  dayTimeDuration: null,
};

/**
 * An XML Schema pattern as a SHACL (XPath) one: XML Schema patterns match the
 * whole value and treat `^` and `$` as ordinary characters; XPath's match
 * anywhere and use them as anchors. So outside character classes they are
 * escaped, and the pattern is anchored. XML Schema has no back-references, so
 * the added group changes nothing.
 */
export function xsdToXPathPattern(p: string): string {
  let out = '';
  let depth = 0;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\') {
      out += c + (p[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']' && depth > 0) depth--;
    else if ((c === '^' || c === '$') && depth === 0) {
      out += `\\${c}`;
      continue;
    }
    out += c;
  }
  return `^(${out})$`;
}

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
  /** SHACL (XPath) patterns, anchored, that the lexical form must match. */
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

/** A decimal lexical form as an exact fraction: `n / 10^scale`. */
function decimal(s: string): { n: bigint; scale: number } {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s)!;
  const frac = m[3] ?? '';
  return { n: BigInt(`${m[1]}${m[2] || '0'}${frac}`), scale: frac.length };
}

/** -1, 0 or 1, comparing two decimal lexical forms exactly. */
export function compare(a: string, b: string): number {
  const x = decimal(a);
  const y = decimal(b);
  const l = x.n * 10n ** BigInt(Math.max(0, y.scale - x.scale));
  const r = y.n * 10n ** BigInt(Math.max(0, x.scale - y.scale));
  return l < r ? -1 : l > r ? 1 : 0;
}

/** The whole numbers at or above `min`, or at or below `max`: the bound rounded inwards, exactly. */
function wholeBound(b: Bound, side: 'min' | 'max'): bigint {
  const { n, scale } = decimal(b.value);
  const d = 10n ** BigInt(scale);
  // BigInt division truncates towards zero.
  const floor = n >= 0n || n % d === 0n ? n / d : n / d - 1n;
  const exact = n % d === 0n;
  if (side === 'min') return exact ? (b.inclusive ? floor : floor + 1n) : floor + 1n;
  return exact ? (b.inclusive ? floor : floor - 1n) : floor;
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
/** What a value space says it can't check about a datatype it knows nothing of. */
export const uncheckable = (dt: string) => `${name(dt)} isn't a datatype whose values can be checked`;

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
  // Whole numbers: the bounds become the nearest whole numbers inside them, so emptiness is exact.
  if (out.whole) {
    if (out.min) out.min = { value: wholeBound(out.min, 'min').toString(), inclusive: true };
    if (out.max) out.max = { value: wholeBound(out.max, 'max').toString(), inclusive: true };
  }
  if (out.min && out.max) {
    const c = compare(out.min.value, out.max.value);
    if (c > 0 || (c === 0 && !(out.min.inclusive && out.max.inclusive))) out.empty = true;
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
      const local = x.slice(XSD.length);
      if (local in BUILTIN_PATTERNS) {
        const pattern = BUILTIN_PATTERNS[local];
        out = meet(out, pattern ? { patterns: [pattern], partial: [] } : { patterns: [], partial: [`the restrictions of ${name(x)}`] });
      }
    }
    return out;
  }
  const own = defs.get(dt);
  if (!own || seen.has(dt)) return { patterns: [], partial: [uncheckable(dt)] };
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
      out.patterns.push(xsdToXPathPattern(value.value));
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
