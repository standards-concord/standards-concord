/**
 * The class model behind the generated JavaScript classes: which classes
 * exist, which one each extends, the accessors each declares and their names.
 *
 * OWL allows things a class hierarchy in code can't express directly, so:
 * - A class's accessors are its effective properties: its own constraints and
 *   those of every superclass all apply, so for each property the counts are
 *   the tightest and the value type the narrowest. A restriction that only sets
 *   a count keeps the inherited value type; the global range is a fallback.
 * - A class extends its first named superclass only when every property it
 *   inherits would have the same accessor type in both. A narrower restriction
 *   (say `exactly 1` where the parent allows many) can't override a parent
 *   accessor in TypeScript, so such a class extends TermWrapper instead and
 *   declares all its effective properties itself. Superclass cycles are flattened the same way.
 * - Names are unique across the inheritance chain and never clash with
 *   wrapper members, imported helpers or JavaScript words.
 */
import { NS, localName } from './ns.js';
import type { DerivedShapes, PropShape } from './shacl.js';

export interface CodeProperty {
  path: string;
  /** The accessor name. */
  name: string;
  /** Class-valued: the shape IRI of the value's class, or THING when it has none. */
  node?: string;
  datatype?: string;
  minCount?: number;
  maxCount?: number;
}

export interface CodeClass {
  shapeIRI: string;
  targetClass: string;
  name: string;
  /** Shape IRI of the class this one extends, if any. */
  base?: string;
  /** Accessors this class declares (the rest are inherited from `base`). */
  declared: CodeProperty[];
  /** Every effective property by path, inherited or declared. */
  effective: Map<string, CodeProperty>;
}

export interface CodeModel {
  /** Bases before the classes that extend them. */
  classes: CodeClass[];
  byShape: Map<string, CodeClass>;
  /** Name for the wrapper of values whose class has no class of its own, when needed. */
  thingName?: string;
  /** Every top-level name taken (classes, Thing); the dataset class must avoid these. */
  taken: Set<string>;
}

/** Marks a class-valued property whose class has no generated class. */
export const THING = 'urn:concord:thing';

/**
 * Members of @rdfjs/wrapper's TermWrapper (a wrapped node is also an RDF/JS
 * term), plus names the ODI shacl-converter reserves. An accessor can't use them.
 */
const RESERVED_MEMBERS = new Set([
  'constructor', 'dataset', 'factory', 'original', '_dataset', '_factory', 'termType', 'value', 'equals', 'language', 'direction',
  'datatype', 'subject', 'predicate', 'object', 'graph', 'type', 'toString', 'valueOf', 'prototype', '__proto__',
]);

/**
 * Names a generated class can't take: everything the module imports or
 * defines besides the classes, and global types it refers to. A test checks
 * this covers every export of @rdfjs/wrapper.
 */
export const RESERVED_CLASSES = new Set([
  // @rdfjs/wrapper exports
  'TermWrapper', 'DatasetWrapper', 'NamedGraphDataset', 'TermAs', 'TermFrom', 'LiteralAs', 'LiteralFrom', 'NamedNodeAs', 'NamedNodeFrom',
  'BlankNodeFrom', 'Mapping', 'RequiredFrom', 'RequiredAs', 'OptionalFrom', 'OptionalAs', 'SetFrom', 'WrapperError', 'TermError',
  'TermTypeError', 'LiteralDatatypeError', 'ListRootError', 'QuadError', 'NamedGraphError', 'RdfList', 'ListItem', 'WrappingSet',
  'WrappingMap', 'Overwriter', 'IndexerInterceptor', 'ILangString', 'ITermFromValueMapping', 'ITermAsValueMapping',
  'ITermWrapperConstructor', 'INamedGraphDatasetConstructor', 'IRdfJsTerm',
  // @rdfjs/types the module uses
  'DataFactory', 'Term', 'DatasetCore', 'Quad', 'NamedNode', 'Literal',
  // globals
  'Object', 'Set', 'Map', 'Date', 'String', 'Number', 'Boolean', 'Symbol', 'Array', 'Function', 'Promise', 'Error', 'Iterable',
  'Iterator', 'BigInt', 'URL', 'Uint8Array', 'JSON', 'Math', 'Reflect', 'Proxy', 'globalThis', 'undefined', 'NaN', 'Infinity',
]);
export const JS_KEYWORDS = new Set(('break case catch class const continue debugger default delete do else enum export extends false finally for function if ' +
  'implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield await arguments eval').split(' '));

/** IRIs the generator writes into code as string literals: anything that could break out of one is left out. */
export const safeIri = (iri: string) => !/["\\\s<>{}|^\u0000-\u001f\u2028\u2029]/.test(iri);

/** A valid identifier from an IRI local name: letters, digits and underscores, not starting with a digit. */
export function identifierFrom(name: string, style: 'pascal' | 'camel'): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  let id = words.map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1))).join('') || 'unnamed';
  id = style === 'pascal' ? id[0].toUpperCase() + id.slice(1) : id[0].toLowerCase() + id.slice(1);
  if (/^[0-9]/.test(id)) id = `_${id}`;
  return id;
}

function allocate(wanted: string, taken: Set<string>, reserved: Set<string>): string {
  let id = reserved.has(wanted) || JS_KEYWORDS.has(wanted) ? `${wanted}_` : wanted;
  const base = id;
  for (let n = 2; taken.has(id) || reserved.has(id); n++) id = `${base}${n}`;
  taken.add(id);
  return id;
}

/** Same accessor type: same arity (set, required or optional) and same value type. */
const typeKey = (p: Omit<CodeProperty, 'name' | 'path'>) =>
  `${p.maxCount === 1 ? ((p.minCount ?? 0) >= 1 ? 'one' : 'opt') : 'set'}|${p.node ?? ''}|${p.datatype ?? ''}`;

export interface PropertyInfo {
  objectProperty: boolean;
  range: string[];
}

export function codeModel(derived: DerivedShapes, info: Map<string, PropertyInfo>): CodeModel {
  const shapes = derived.shapes.filter((s) => safeIri(s.targetClass));
  const byClass = new Map(shapes.map((s) => [s.targetClass, s]));
  const byIri = new Map(shapes.map((s) => [s.iri, s]));

  // Class names, unique and clear of everything else the module defines.
  const taken = new Set<string>();
  const names = new Map<string, string>();
  for (const s of shapes) names.set(s.iri, allocate(identifierFrom(localName(s.targetClass), 'pascal'), taken, RESERVED_CLASSES));

  type Raw = Omit<CodeProperty, 'name'>;
  type ValueType = Pick<CodeProperty, 'node' | 'datatype'>;

  /** The value type a property shape states itself (sh:datatype, or a class from a restriction). */
  const statedType = (ps: PropShape): ValueType | undefined => {
    if (ps.datatype) return { datatype: ps.datatype };
    if (ps.cls) return { node: byClass.get(ps.cls)?.iri ?? THING };
    return undefined;
  };
  /** The value type from the property's global range, for a property shape that states none. */
  const rangeType = (path: string): ValueType => {
    const pi = info.get(path);
    const range = pi?.range ?? [];
    if (pi?.objectProperty) return { node: (range.length === 1 && byClass.get(range[0])?.iri) || THING };
    if (range.length === 1) return { datatype: range[0] };
    return {};
  };
  /** Whether shape `a`'s class is (transitively) a subclass of shape `b`'s. */
  const isSub = (a: string, b: string, seen = new Set<string>()): boolean => {
    if (a === b) return true;
    if (seen.has(a)) return false;
    seen.add(a);
    return (byIri.get(a)?.superClasses ?? []).some((c) => {
      const ss = byClass.get(c);
      return ss !== undefined && isSub(ss.iri, b, seen);
    });
  };
  /**
   * Both constraints apply, so the value type is the narrower of the two when
   * one class is a subclass of the other; otherwise `preferred` wins (a class's
   * own statement over an inherited one, the first superclass over later ones).
   */
  const narrower = (preferred: ValueType, other: ValueType): ValueType => {
    if (preferred.node && other.node && preferred.node !== THING && other.node !== THING && isSub(other.node, preferred.node)) return other;
    if (preferred.node === THING && other.node) return other;
    if (!preferred.node && !preferred.datatype) return other;
    return preferred;
  };
  /** Both constraints apply: the larger minimum, the smaller maximum, the narrower type. */
  const merge = (preferred: Raw, other: Raw): Raw => {
    const max = Math.min(preferred.maxCount ?? Infinity, other.maxCount ?? Infinity);
    const t = narrower({ node: preferred.node, datatype: preferred.datatype }, { node: other.node, datatype: other.datatype });
    return {
      path: preferred.path,
      ...(t.node ? { node: t.node } : {}),
      ...(t.datatype ? { datatype: t.datatype } : {}),
      minCount: Math.max(preferred.minCount ?? 0, other.minCount ?? 0) || undefined,
      maxCount: max === Infinity ? undefined : max,
    };
  };

  // Effective properties: constraints from every superclass and the class's own all apply together.
  const effectiveRaw = new Map<string, Map<string, Raw>>();
  const effectiveOf = (iri: string, stack: Set<string>): Map<string, Raw> => {
    const done = effectiveRaw.get(iri);
    if (done) return done;
    const s = byIri.get(iri)!;
    const out = new Map<string, Raw>();
    const next = new Set(stack).add(iri);
    for (const sup of s.superClasses) {
      const ss = byClass.get(sup);
      if (!ss || next.has(ss.iri)) continue;
      for (const [path, p] of effectiveOf(ss.iri, next)) {
        const prev = out.get(path);
        out.set(path, prev ? merge(prev, p) : { ...p });
      }
    }
    for (const ps of s.properties) {
      if (!safeIri(ps.path)) continue;
      const prev = out.get(ps.path);
      // A shape that only restricts cardinality keeps the inherited value type; the global range is only a fallback.
      const type = statedType(ps) ?? (prev ? {} : rangeType(ps.path));
      const own: Raw = { path: ps.path, ...type, minCount: ps.minCount, maxCount: ps.maxCount };
      out.set(ps.path, prev ? merge(own, prev) : own);
    }
    // Only cache results computed without a cycle cut short.
    if (stack.size === 0) effectiveRaw.set(iri, out);
    return out;
  };

  const classes: CodeClass[] = [];
  const byShape = new Map<string, CodeClass>();
  const visiting = new Set<string>();
  const build = (iri: string): CodeClass | undefined => {
    const existing = byShape.get(iri);
    if (existing) return existing;
    if (visiting.has(iri)) return undefined; // a superclass cycle
    visiting.add(iri);
    const s = byIri.get(iri)!;
    const eff = effectiveOf(iri, new Set());
    // Candidate base: the first named superclass that isn't part of a cycle through this class.
    const supers = s.superClasses.map((c) => byClass.get(c)).filter((x) => x !== undefined).map((ss) => build(ss.iri));
    let base = supers.find((b) => b && !chainIncludes(b, iri));
    // Keep the base only if every inherited accessor keeps its type.
    if (base) for (const [path, bp] of base.effective) if (eff.has(path) && typeKey(eff.get(path)!) !== typeKey(bp)) base = undefined;
    if (base && [...base.effective.keys()].some((p) => !eff.has(p))) base = undefined;

    const memberTaken = new Set<string>(base ? [...base.effective.values()].map((p) => p.name) : []);
    const effective = new Map<string, CodeProperty>();
    const declared: CodeProperty[] = [];
    for (const [path, p] of [...eff].sort(([a], [b]) => a.localeCompare(b))) {
      const inherited = base?.effective.get(path);
      if (inherited) {
        effective.set(path, inherited);
        continue;
      }
      // Reuse the name a superclass gives this path, when it's free.
      const fromSuper = s.superClasses.map((c) => byClass.get(c)).map((ss) => ss && byShape.get(ss.iri)?.effective.get(path)?.name).find(Boolean);
      const name = fromSuper && !memberTaken.has(fromSuper) && !RESERVED_MEMBERS.has(fromSuper)
        ? (memberTaken.add(fromSuper), fromSuper)
        : allocate(identifierFrom(localName(path), 'camel'), memberTaken, RESERVED_MEMBERS);
      const cp = { ...p, name };
      effective.set(path, cp);
      declared.push(cp);
    }
    const c: CodeClass = { shapeIRI: iri, targetClass: s.targetClass, name: names.get(iri)!, base: base?.shapeIRI, declared, effective };
    visiting.delete(iri);
    byShape.set(iri, c);
    classes.push(c);
    return c;
  };
  const chainIncludes = (c: CodeClass, iri: string): boolean => {
    for (let x: CodeClass | undefined = c; x; x = x.base ? byShape.get(x.base) : undefined) if (x.shapeIRI === iri) return true;
    return false;
  };
  for (const s of shapes) build(s.iri);

  const needThing = classes.some((c) => [...c.effective.values()].some((p) => p.node === THING));
  const thingName = needThing ? allocate('Thing', taken, RESERVED_CLASSES) : undefined;
  return { classes, byShape, thingName, taken };
}

/** owl:Thing, for documentation of the Thing wrapper. */
export const OWL_THING = NS.owl + 'Thing';
