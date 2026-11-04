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
  /** Constraints the classes can't express exactly. */
  notes: string[];
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

/** XML Schema's built-in datatype derivations: each datatype and the one it is derived from. */
const XSD_BASE: Record<string, string> = {
  integer: 'decimal', nonPositiveInteger: 'integer', negativeInteger: 'nonPositiveInteger', long: 'integer', int: 'long', short: 'int', byte: 'short',
  nonNegativeInteger: 'integer', unsignedLong: 'nonNegativeInteger', unsignedInt: 'unsignedLong', unsignedShort: 'unsignedInt', unsignedByte: 'unsignedShort',
  positiveInteger: 'nonNegativeInteger', normalizedString: 'string', token: 'normalizedString', language: 'token', Name: 'token', NCName: 'Name',
  NMTOKEN: 'token', ID: 'NCName', IDREF: 'NCName', ENTITY: 'NCName', dateTimeStamp: 'dateTime', yearMonthDuration: 'duration', dayTimeDuration: 'duration',
};

/** Whether datatype `a` is `b` or derived from it, through the ontology's own datatypes (`bases`) and XML Schema's. */
export function derivesFrom(a: string, b: string, bases: Map<string, string[]> = new Map()): boolean {
  const seen = new Set<string>([a]);
  const todo = [a];
  while (todo.length) {
    const x = todo.pop()!;
    if (x === b) return true;
    const xsd = x.startsWith(NS.xsd) ? XSD_BASE[x.slice(NS.xsd.length)] : undefined;
    for (const y of [...(bases.get(x) ?? []), ...(xsd ? [NS.xsd + xsd] : [])]) if (!seen.has(y)) seen.add(y), todo.push(y);
  }
  return false;
}

/** The primitive datatypes `dt` derives from (those with no base of their own). */
function datatypeRoots(dt: string, bases: Map<string, string[]>): Set<string> {
  const roots = new Set<string>();
  const seen = new Set([dt]);
  for (const todo = [dt]; todo.length; ) {
    const x = todo.pop()!;
    const xsd = x.startsWith(NS.xsd) ? XSD_BASE[x.slice(NS.xsd.length)] : undefined;
    const up = [...(bases.get(x) ?? []), ...(xsd ? [NS.xsd + xsd] : [])];
    if (!up.length) roots.add(x);
    for (const y of up) if (!seen.has(y)) seen.add(y), todo.push(y);
  }
  return roots;
}

/**
 * Whether no value can have both datatypes: they derive from different XML
 * Schema primitive datatypes (xsd:string and xsd:decimal, say), whose value
 * spaces are disjoint. Anything else may overlap.
 */
export function disjointDatatypes(a: string, b: string, bases: Map<string, string[]> = new Map()): boolean {
  const ra = datatypeRoots(a, bases);
  const rb = datatypeRoots(b, bases);
  const known = [...ra, ...rb].every((r) => r.startsWith(NS.xsd) && !(r.slice(NS.xsd.length) in XSD_BASE));
  return known && ![...ra].some((r) => rb.has(r));
}

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
  const isSub = (a: string, b: string): boolean => {
    const seen = new Set([a]);
    for (const todo = [a]; todo.length; ) {
      const x = todo.pop()!;
      if (x === b) return true;
      for (const c of byIri.get(x)?.superClasses ?? []) {
        const y = byClass.get(c)?.iri;
        if (y && !seen.has(y)) seen.add(y), todo.push(y);
      }
    }
    return false;
  };
  /**
   * Both constraints apply, so the value type is the narrower of the two when
   * one class is a subclass of the other, or one datatype is derived from the
   * other (xsd:positiveInteger from xsd:integer); otherwise `preferred` wins (a class's
   * own statement over an inherited one, the first superclass over later ones).
   */
  const narrower = (preferred: ValueType, other: ValueType): ValueType => {
    if (preferred.node && other.node && preferred.node !== THING && other.node !== THING && isSub(other.node, preferred.node)) return other;
    if (preferred.node === THING && other.node) return other;
    if (preferred.datatype && other.datatype && derivesFrom(other.datatype, preferred.datatype, derived.datatypeBases)) return other;
    if (!preferred.node && !preferred.datatype) return other;
    return preferred;
  };
  const notes = new Set<string>();
  const typeName = (t: ValueType) => (t.datatype ? `<${t.datatype}>` : t.node === THING ? 'any resource' : `<${byIri.get(t.node!)?.targetClass}>`);
  /**
   * Both constraints apply: the larger minimum, the smaller maximum, the
   * narrower type. Two types neither of which is narrower can't both be
   * expressed by one accessor: `preferred` is used, and a note says so.
   */
  const merge = (preferred: Raw, other: Raw, where: string): Raw => {
    const max = Math.min(preferred.maxCount ?? Infinity, other.maxCount ?? Infinity);
    const a = { node: preferred.node, datatype: preferred.datatype };
    const b = { node: other.node, datatype: other.datatype };
    const t = narrower(a, b);
    const typed = (x: ValueType) => Boolean(x.datatype || (x.node && x.node !== THING));
    if (typed(a) && typed(b) && t === a && narrower(b, a) === b && typeName(a) !== typeName(b))
      notes.add(`${where} <${preferred.path}>: values must be both ${typeName(a)} and ${typeName(b)}, which one accessor can't express; it uses ${typeName(a)}.`);
    return {
      path: preferred.path,
      ...(t.node ? { node: t.node } : {}),
      ...(t.datatype ? { datatype: t.datatype } : {}),
      minCount: Math.max(preferred.minCount ?? 0, other.minCount ?? 0) || undefined,
      maxCount: max === Infinity ? undefined : max,
    };
  };

  // Superclass edges between the generated classes.
  const supersOf = (iri: string) =>
    byIri.get(iri)!.superClasses.map((c) => byClass.get(c)?.iri).filter((x): x is string => x !== undefined && x !== iri);

  // Superclass cycles (strongly connected components), each after all its ancestors: Tarjan's
  // algorithm, iteratively, so a deep hierarchy can't overflow the stack. A component is
  // listed in the order its members leave the stack.
  const components: string[][] = [];
  {
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    let counter = 0;
    for (const root of shapes.map((x) => x.iri)) {
      if (index.has(root)) continue;
      const work: { v: string; edges: string[]; i: number }[] = [];
      const visit = (v: string) => {
        index.set(v, counter);
        low.set(v, counter++);
        stack.push(v);
        onStack.add(v);
        work.push({ v, edges: supersOf(v), i: 0 });
      };
      visit(root);
      while (work.length) {
        const top = work[work.length - 1];
        if (top.i < top.edges.length) {
          const w = top.edges[top.i++];
          if (!index.has(w)) visit(w);
          else if (onStack.has(w)) low.set(top.v, Math.min(low.get(top.v)!, index.get(w)!));
          continue;
        }
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1].v;
          low.set(parent, Math.min(low.get(parent)!, low.get(top.v)!));
        }
        if (low.get(top.v) === index.get(top.v)) {
          const comp: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            comp.push(w);
          } while (w !== top.v);
          components.push(comp);
        }
      }
    }
  }

  // Effective properties: constraints from every superclass and the class's own all apply together.
  // Each component is worked out once, from its ancestors' results; the classes in a cycle are
  // equivalent, so they share theirs.
  const effectiveRaw = new Map<string, Map<string, Raw>>();
  for (const comp of components) {
    const members = new Set(comp);
    const out = new Map<string, Raw>();
    for (const iri of comp)
      for (const sup of supersOf(iri)) {
        if (members.has(sup)) continue;
        for (const [path, p] of effectiveRaw.get(sup)!) {
          const prev = out.get(path);
          out.set(path, prev ? merge(prev, p, names.get(iri)!) : { ...p });
        }
      }
    for (const iri of comp) {
      const where = names.get(iri)!;
      for (const ps of byIri.get(iri)!.properties) {
        if (!safeIri(ps.path)) continue;
        const prev = out.get(ps.path);
        const type = statedType(ps) ?? (prev ? {} : rangeType(ps.path));
        const own: Raw = { path: ps.path, ...type, minCount: ps.minCount, maxCount: ps.maxCount };
        // A type that only comes from the global range never widens an inherited one: the inherited type is
        // preferred unless the range is narrower. A restriction on this class is preferred over what it inherits.
        out.set(ps.path, !prev ? own : ps.fromRange || !statedType(ps) ? merge(prev, own, where) : merge(own, prev, where));
        if (ps.alsoTypes?.length || ps.unchecked?.length) {
          const all = [ps.datatype ?? ps.cls, ...(ps.alsoTypes ?? []).map((t) => t.datatype ?? t.cls), ...(ps.unchecked ?? [])].map((x) => `<${x}>`);
          notes.add(`${where} <${ps.path}>: values must be all of ${all.join(', ')}, which one accessor can't express; it uses ${all[0]}.`);
        }
      }
    }
    for (const iri of comp) effectiveRaw.set(iri, out);
  }

  // Classes, each after the classes it can extend.
  const classes: CodeClass[] = [];
  const byShape = new Map<string, CodeClass>();
  for (const iri of components.flat()) {
    const s = byIri.get(iri)!;
    const eff = effectiveRaw.get(iri)!;
    // Candidate base: the first superclass already built (in a cycle, an earlier member).
    let base = supersOf(iri).map((x) => byShape.get(x)).find((x) => x !== undefined);
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
      const fromSuper = supersOf(iri).map((x) => byShape.get(x)?.effective.get(path)?.name).find(Boolean);
      const name = fromSuper && !memberTaken.has(fromSuper) && !RESERVED_MEMBERS.has(fromSuper)
        ? (memberTaken.add(fromSuper), fromSuper)
        : allocate(identifierFrom(localName(path), 'camel'), memberTaken, RESERVED_MEMBERS);
      const cp = { ...p, name };
      effective.set(path, cp);
      declared.push(cp);
    }
    const c: CodeClass = { shapeIRI: iri, targetClass: s.targetClass, name: names.get(iri)!, base: base?.shapeIRI, declared, effective };
    byShape.set(iri, c);
    classes.push(c);
  }

  const needThing = classes.some((c) => [...c.effective.values()].some((p) => p.node === THING));
  const thingName = needThing ? allocate('Thing', taken, RESERVED_CLASSES) : undefined;
  return { classes, byShape, thingName, taken, notes: [...notes] };
}

/** owl:Thing, for documentation of the Thing wrapper. */
export const OWL_THING = NS.owl + 'Thing';
