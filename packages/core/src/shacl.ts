/**
 * Derives SHACL node shapes from the ontology: one sh:NodeShape per named class
 * (sh:targetClass), with property shapes from domain/range, restrictions and
 * functional characteristics. Qualified constraints are used where OWL semantics
 * require them (`p some F` does not mean every value is an F).
 */
import { DataFactory, Store } from 'n3';
import type { Quad, Term } from 'n3';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import type { Restriction } from './types.js';
import { NS, RDF_TYPE, localName } from './ns.js';
import { blankNode, canonical, literal, nn, objects, readList, typedLit, writeList } from './rdf.js';
import { isDatatype } from './changes.js';
import type { OntologyGraph } from './graph.js';
import { writeTurtle } from './turtle.js';
import { codeModel, derivesFrom, type PropertyInfo } from './codemodel.js';
import { boundDatatype, datatypeDefinitions, family, intersect, WHOLE_NUMBER_PATTERN } from './valuespace.js';
import { derivedTypes } from './xsdTypes.js';
export { identifierFrom } from './codemodel.js';

const SH = NS.sh;

export interface PropShape {
  path: string;
  cls?: string;
  datatype?: string;
  minCount?: number;
  maxCount?: number;
  hasValue?: Term;
  /** The value type is only the property's global range (from its domain), not a restriction on this class. */
  fromRange?: boolean;
  /**
   * Further value types the values must also have, none narrower than another
   * (from several `only` restrictions or a range). Each is checked by a
   * property shape of its own.
   */
  alsoTypes?: { cls?: string; datatype?: string }[];
  /**
   * Values checked by value rather than by datatype IRI, when several
   * datatypes apply at once (see valuespace.ts): any of `datatypes`, within
   * the bounds and lengths, matching every pattern.
   */
  values?: {
    datatypes: string[];
    min?: { value: string; inclusive: boolean };
    max?: { value: string; inclusive: boolean };
    minLength?: number;
    maxLength?: number;
    /** SHACL (XPath) patterns, already anchored. */
    patterns: string[];
  };
  /** The value type for generated code, when the shape checks values without one sh:datatype or sh:class. */
  codeType?: { cls?: string; datatype?: string };
  qualified: { shape: { cls?: string; datatype?: string }; min?: number; max?: number }[];
}

/** One derived node shape: the shape for a named class in the ontology's namespace. */
export interface DerivedNodeShape {
  iri: string;
  targetClass: string;
  label?: string;
  /** Named superclasses in the ontology's namespace (shapes exist for them too). */
  superClasses: string[];
  properties: PropShape[];
}

export interface DerivedShapes {
  /** Object or datatype property, and its declared range, for every property in the ontology. */
  propertyInfo: Map<string, PropertyInfo>;
  /** Datatypes the ontology defines, and the datatypes each is based on. */
  datatypeBases: Map<string, string[]>;
  /** Constraints the shapes can't express. */
  notes: string[];
  /** IRI of the shapes graph (`<ontology>/shapes`), when the ontology has an IRI. */
  shapesIRI?: string;
  shapesNs: string;
  prefixes: Record<string, string>;
  title?: string;
  source?: string;
  shapes: DerivedNodeShape[];
}

/**
 * The SHACL shapes implied by the ontology, as a model. `toShacl`, `toShaclc`
 * and the generated JavaScript classes are all rendered from it, so they agree.
 */
export function deriveShapes(graph: OntologyGraph): DerivedShapes {
  const v = graph.view();
  const ont = graph.ontologyIRI || graph.namespace.replace(/[#/]$/, '');
  const shapesNs = `${ont}/shapes#`;
  const pref = v.metadata.preferredPrefix ?? 'ont';
  const props = new Map([...v.objectProperties, ...v.datatypeProperties].map((p) => [p.iri, p]));
  const own = v.classes.filter((k) => !k.deprecated && k.iri.startsWith(graph.namespace));
  const ownIris = new Set(own.map((k) => k.iri));
  const shapes: DerivedNodeShape[] = [];
  const notes: string[] = [];
  // Whether type `a` is narrower than or equal to `b`: a subclass, or a derived datatype.
  const bases = datatypeBases(graph);
  const defs = datatypeDefinitions(graph.store);
  const supers = new Map(v.classes.map((k) => [k.iri, k.superClasses]));
  const isSubClass = (a: string, b: string) => {
    const seen = new Set([a]);
    for (const todo = [a]; todo.length; ) {
      const x = todo.pop()!;
      if (x === b) return true;
      for (const y of supers.get(x) ?? []) if (!seen.has(y)) seen.add(y), todo.push(y);
    }
    return false;
  };
  const narrowerOrEqual = (a: ValueType, b: ValueType) =>
    a.datatype && b.datatype ? derivesFrom(a.datatype, b.datatype, bases) : a.cls && b.cls ? isSubClass(a.cls, b.cls) : false;
  for (const k of own) {
    const byPath = new Map<string, PropShape>();
    const get = (p: string) => {
      if (!byPath.has(p)) byPath.set(p, { path: p, qualified: [] });
      return byPath.get(p)!;
    };
    // Properties whose (named) domain is this class: value type from the range.
    for (const p of props.values()) {
      if (p.deprecated || !domainMembers(graph, p.iri).includes(k.iri)) continue;
      const ps = get(p.iri);
      const r = p.range[0];
      if (r && p.range.length === 1) {
        if (isDatatype(graph, r)) ps.datatype = r;
        else ps.cls = r;
        ps.fromRange = true;
      }
      if (p.characteristics.includes('functional')) ps.maxCount = 1;
    }
    for (const r of k.restrictions) applyRestriction(graph, get(r.property), r, props.get(r.property)?.range ?? [], narrowerOrEqual);
    for (const ps of byPath.values()) combineDatatypes(k.iri, ps, defs, notes);
    shapes.push({
      iri: `${shapesNs}${localName(k.iri)}Shape`,
      targetClass: k.iri,
      label: k.label,
      superClasses: k.superClasses.filter((s) => ownIris.has(s) && s !== k.iri),
      properties: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)),
    });
  }
  return {
    propertyInfo: new Map<string, PropertyInfo>([
      ...v.objectProperties.map((p): [string, PropertyInfo] => [p.iri, { objectProperty: true, range: p.range }]),
      ...v.datatypeProperties.map((p): [string, PropertyInfo] => [p.iri, { objectProperty: false, range: p.range }]),
    ]),
    datatypeBases: bases,
    notes,
    shapesIRI: graph.ontologyIRI ? `${ont}/shapes` : undefined,
    shapesNs,
    prefixes: { ...graph.prefixes, sh: SH, [`${pref}sh`]: shapesNs },
    title: v.metadata.title ?? ont,
    source: v.metadata.versionIRI ?? ont,
    shapes,
  };
}

/**
 * The shapes as RDF. Each node shape and its main property shapes carry
 * sh:codeIdentifier (SHACL 1.2), the class and accessor names used for the
 * generated JavaScript classes, unless `codeIdentifiers` is false.
 */
export function shaclStore(derived: DerivedShapes, opts: { codeIdentifiers?: boolean } = {}): Store {
  const out = new Store();
  const int = (n: number) => typedLit(String(n), NS.xsd + 'integer');
  const add = (s: Term, p: string, o: Term) => out.addQuad(s as any, nn(p), o as any);
  const model = opts.codeIdentifiers === false ? undefined : codeModel(derived, derived.propertyInfo);

  if (derived.shapesIRI) {
    const sh = nn(derived.shapesIRI);
    add(sh, RDF_TYPE, nn(NS.owl + 'Ontology'));
    add(sh, NS.rdfs + 'label', literal(`SHACL shapes derived from ${derived.title}`, 'en'));
    if (derived.source) add(sh, NS.dcterms + 'source', nn(derived.source));
  }

  for (const s of derived.shapes) {
    const shape = nn(s.iri);
    add(shape, RDF_TYPE, nn(SH + 'NodeShape'));
    add(shape, SH + 'targetClass', nn(s.targetClass));
    if (s.label) add(shape, SH + 'name', literal(s.label, 'en'));
    const cls = model?.byShape.get(s.iri);
    if (cls) add(shape, SH + 'codeIdentifier', literal(cls.name));

    for (const ps of s.properties) {
      const b = blankNode();
      add(shape, SH + 'property', b);
      add(b, SH + 'path', nn(ps.path));
      const accessor = cls?.effective.get(ps.path)?.name;
      if (accessor) add(b, SH + 'codeIdentifier', literal(accessor));
      if (ps.datatype) add(b, SH + 'datatype', nn(ps.datatype));
      if (ps.cls) add(b, SH + 'class', nn(ps.cls));
      if (ps.values) {
        const vc = ps.values;
        if (vc.datatypes.length === 1) add(b, SH + 'datatype', nn(vc.datatypes[0]));
        else if (vc.datatypes.length)
          add(b, SH + 'or', writeList(out, vc.datatypes.map((d) => {
            const alt = blankNode();
            add(alt, SH + 'datatype', nn(d));
            return alt;
          })));
        const bound = (x: { value: string }) => typedLit(x.value, boundDatatype(x.value));
        if (vc.min) add(b, SH + (vc.min.inclusive ? 'minInclusive' : 'minExclusive'), bound(vc.min));
        if (vc.max) add(b, SH + (vc.max.inclusive ? 'maxInclusive' : 'maxExclusive'), bound(vc.max));
        if (vc.minLength !== undefined) add(b, SH + 'minLength', int(vc.minLength));
        if (vc.maxLength !== undefined) add(b, SH + 'maxLength', int(vc.maxLength));
        // sh:pattern takes one pattern per property shape here, so SHACLC can write it.
        vc.patterns.forEach((pattern, i) => {
          const pb = i === 0 ? b : blankNode();
          if (i > 0) add(shape, SH + 'property', pb), add(pb, SH + 'path', nn(ps.path));
          add(pb, SH + 'pattern', literal(pattern));
        });
      }
      // Each further type gets a property shape of its own (SHACLC allows one datatype or class per property shape).
      for (const t of ps.alsoTypes ?? []) {
        const tb = blankNode();
        add(shape, SH + 'property', tb);
        add(tb, SH + 'path', nn(ps.path));
        add(tb, SH + (t.datatype ? 'datatype' : 'class'), nn((t.datatype ?? t.cls)!));
      }
      if (ps.minCount !== undefined) add(b, SH + 'minCount', int(ps.minCount));
      if (ps.maxCount !== undefined) add(b, SH + 'maxCount', int(ps.maxCount));
      if (ps.hasValue) add(b, SH + 'hasValue', ps.hasValue);
      for (const q of ps.qualified) {
        // Each qualified constraint needs its own property shape in SHACL.
        const qb = q === ps.qualified[0] ? b : blankNode();
        if (qb !== b) {
          add(shape, SH + 'property', qb);
          add(qb, SH + 'path', nn(ps.path));
        }
        const vs = blankNode();
        add(qb, SH + 'qualifiedValueShape', vs);
        if (q.shape.cls) add(vs, SH + 'class', nn(q.shape.cls));
        if (q.shape.datatype) add(vs, SH + 'datatype', nn(q.shape.datatype));
        if (q.min !== undefined) add(qb, SH + 'qualifiedMinCount', int(q.min));
        if (q.max !== undefined) add(qb, SH + 'qualifiedMaxCount', int(q.max));
      }
    }
  }
  return out;
}

/**
 * Datatypes defined in the ontology and every datatype each restricts or
 * equals: `e:Code owl:equivalentClass [ owl:onDatatype xsd:string ; ... ]`
 * gives e:Code → xsd:string. All definitions count, in any order.
 */
function datatypeBases(graph: OntologyGraph): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const d of graph.store.getSubjects(nn(RDF_TYPE), nn(NS.rdfs + 'Datatype'), null)) {
    if (d.termType !== 'NamedNode') continue;
    const bases = new Set<string>();
    for (const eq of objects(graph.store, d, NS.owl + 'equivalentClass')) {
      const base = eq.termType === 'NamedNode' ? eq : objects(graph.store, eq, NS.owl + 'onDatatype')[0];
      if (base?.termType === 'NamedNode' && base.value !== d.value) bases.add(base.value);
    }
    if (bases.size) out.set(d.value, [...bases].sort());
  }
  return out;
}

export async function toShacl(graph: OntologyGraph): Promise<string> {
  const derived = deriveShapes(graph);
  return noteLines(derived.notes) + (await writeTurtle(shaclStore(derived), derived.prefixes, { ontologyIRI: derived.shapesIRI }));
}

/** Notes as comment lines, for the top of the Turtle or SHACLC shapes. */
const noteLines = (notes: string[]) => notes.map((n) => `# Note: ${commentLine(n)}\n`).join('');

export interface ShaclcOptions {
  /**
   * Use shaclc-write's extended syntax to keep what standard SHACLC can't say
   * (shape names, the shapes graph's label). Off by default: the standard
   * output parses with any SHACLC parser.
   */
  extended?: boolean;
}

/**
 * SHACL compact syntax (SHACLC) for the same shapes, which is far easier to
 * read than Turtle. Written with shaclc-write, then parsed back with
 * shaclc-parse and compared with the shapes it came from, so what is served
 * always means the same as the Turtle shapes (less what the header says is
 * left out). sh:codeIdentifier is left out, as it is only there for code
 * generation.
 */
export async function toShaclc(graph: OntologyGraph, opts: ShaclcOptions = {}): Promise<string> {
  const derived = deriveShapes(graph);
  const store = shaclStore(derived, { codeIdentifiers: false });
  nameQualifiedShapes(store, derived.shapesNs);
  // Standard SHACLC has no place for shape names or the shapes graph's label and source.
  const dropped = opts.extended ? [] : [SH + 'name', NS.rdfs + 'label', NS.dcterms + 'source'];
  for (const p of dropped) for (const q of store.getQuads(null, nn(p), null, null)) store.removeQuad(q);

  const { write } = await import('shaclc-write');
  // shaclc-write abbreviates any IRI whose namespace has a prefix, including its
  // built-in rdf:, rdfs:, sh:, xsd: and owl:, and `ex:p*` would read back as a
  // path. So IRIs that aren't safe to abbreviate are swapped for placeholders it
  // writes in full, and put back afterwards.
  const { quads, restore } = shieldUnsafeIris(store);
  const prefixes = Object.fromEntries(Object.entries(derived.prefixes).filter(([p]) => p));
  const { text } = await write(quads as any, {
    prefixes,
    extendedSyntax: Boolean(opts.extended),
    // Without an ontology IRI there is no BASE to write.
    requireBase: Boolean(derived.shapesIRI),
  });
  const header = opts.extended
    ? `# SHACL shapes for ${commentLine(derived.title ?? '')}, in SHACL compact syntax with shaclc-write's extended syntax.\n`
    : `# SHACL shapes for ${commentLine(derived.title ?? '')}, in SHACL compact syntax.\n# Shape names and the shapes graph's label are in the Turtle shapes (.shacl.ttl); SHACLC has no place for them.\n`;
  const notes = noteLines(derived.notes);
  const body = restore(explicitDatatypes(rawUnicodeEscapes(text), new Store(quads), prefixes));
  const out = header + notes + body + (body.endsWith('\n') ? '' : '\n');

  // Check: the SHACLC must parse back to exactly the shapes it was written from.
  const back = new Store(await parseShaclc(out, Boolean(opts.extended)));
  const diff = graphDifference(store, back);
  if (diff) throw new Error(`SHACLC output would change the shapes (${diff}); use the Turtle shapes instead`);
  return out;
}

/** shaclc-write's split of an IRI into namespace and local name. */
const writerNamespace = (iri: string) => /^[^]*[#/]/.exec(iri)?.[0] ?? '';

/**
 * Swaps every IRI whose local name isn't safe to abbreviate for a placeholder
 * IRI with no namespace, which shaclc-write can only write in full. `restore`
 * puts the real IRIs back into the written text.
 */
function shieldUnsafeIris(store: Store): { quads: Quad[]; restore: (text: string) => string } {
  const nonce = randomBytes(8).toString('hex');
  const swap = new Map<string, string>();
  const shield = <T extends Term>(t: T): T => {
    if (t.termType !== 'NamedNode' || SAFE_LOCAL.test(t.value.slice(writerNamespace(t.value).length))) return t;
    if (!swap.has(t.value)) swap.set(t.value, `urn:x-concord-iri:${nonce}:${swap.size}`);
    return nn(swap.get(t.value)!) as unknown as T;
  };
  const quads = store.getQuads(null, null, null, null).map((q) => DataFactory.quad(shield(q.subject), shield(q.predicate), shield(q.object), q.graph));
  const back = new Map([...swap].map(([iri, ph]) => [`<${ph}>`, `<${iri}>`]));
  const restore = (text: string) => (back.size ? text.replace(new RegExp(`<urn:x-concord-iri:${nonce}:\\d+>`, 'g'), (m) => back.get(m) ?? m) : text);
  return { quads, restore };
}

/** Escapes N3's string literal parser understands. */
const STRING_ESCAPES = { '\\': '\\', "'": "'", '"': '"', n: '\n', r: '\r', t: '\t', f: '\f', b: '\b' };

/**
 * shaclc-parse 2.0.0 unescapes literals with a private N3 lexer method that, in
 * n3 2.x, needs a table of escapes, which shaclc-parse doesn't pass; so any
 * literal with a backslash escape (a newline, a quote) fails to parse. Its IRI
 * rule also leaves out '=', which IRIs may contain. Both are put right for the
 * duration of the (synchronous) parse.
 */
export async function parseShaclc(text: string, extended: boolean): Promise<Quad[]> {
  const { parse } = await import('shaclc-parse');
  const req = createRequire(createRequire(import.meta.url).resolve('shaclc-parse'));
  const lexer = (req('n3') as typeof import('n3')).Lexer.prototype as unknown as {
    _unescape: (item: string, replacements?: Record<string, string>) => string | null;
  };
  const rules = (req('./ShaclcParser.js') as { lexer: { rules: RegExp[] } }).lexer.rules;
  // The IRIREF rule, which excludes '=' (the SHACLC grammar allows it, as in `?key=value`).
  const iriRule = rules.findIndex((r) => r.source.startsWith('^(?:(<([^=<>'));
  const originalRule = rules[iriRule];
  const original = lexer._unescape;
  lexer._unescape = function (item, replacements) {
    return original.call(this, item, replacements ?? STRING_ESCAPES);
  };
  if (iriRule >= 0) rules[iriRule] = new RegExp(originalRule.source.replace('^(?:(<([^=<>', '^(?:(<([^<>'), originalRule.flags);
  try {
    return parse(text, { extendedSyntax: extended }) as unknown as Quad[];
  } finally {
    lexer._unescape = original;
    if (iriRule >= 0) rules[iriRule] = originalRule;
  }
}

/**
 * Splits SHACLC text into string literals, IRI references and everything else
 * (comments included), so a rewrite never touches the inside of a string, an
 * IRI or a comment.
 */
function scanText(text: string, on: { string: (s: string) => void; iri: (s: string) => void; other: (s: string) => void }): void {
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const end = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      let j = i + end.length;
      while (j < text.length && !text.startsWith(end, j)) j += text[j] === '\\' ? 2 : 1;
      j = Math.min(text.length, j + end.length);
      on.string(text.slice(i, j));
      i = j;
    } else if (c === '#') {
      // A comment (shaclc-write writes no '#' outside IRIs, strings and comments) runs to the end of the line.
      const nl = text.indexOf('\n', i);
      const j = nl < 0 ? text.length : nl;
      on.other(text.slice(i, j));
      i = j;
    } else if (c === '<') {
      const close = text.indexOf('>', i);
      const j = close < 0 ? text.length : close + 1;
      on.iri(text.slice(i, j));
      i = j;
    } else {
      let j = i;
      while (j < text.length && !'"\'<#'.includes(text[j])) j++;
      on.other(text.slice(i, j));
      i = j;
    }
  }
}

/** What a character becomes inside a SHACLC string: a short escape where it needs one. */
const SHORT_ESCAPES: Record<string, string> = { '"': '\\"', "'": "\\'", '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };

/**
 * SHACLC strings only allow the short escapes (\n, \", ...), but shaclc-write
 * writes characters outside ASCII as \uXXXX or \UXXXXXXXX. Those are written
 * as the characters themselves.
 */
function rawUnicodeEscapes(text: string): string {
  if (!/\\[uU]/.test(text)) return text;
  let out = '';
  scanText(text, {
    other: (s) => (out += s),
    iri: (s) => (out += s),
    string: (s) =>
      (out += s.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/gs, (m, e: string) => {
        if (e.length === 1) return m;
        const ch = String.fromCodePoint(parseInt(e.slice(1), 16));
        return SHORT_ESCAPES[ch] ?? ch;
      })),
  });
  return out;
}


const commentLine = (s: string) => s.replace(/[\r\n\u2028\u2029]+/g, ' ');

/** A local name that is safe to write after a prefix in SHACLC (no path operators, escapes or trailing dots). */
const SAFE_LOCAL = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function namedIris(store: Store): string[] {
  const out = new Set<string>();
  for (const q of store.getQuads(null, null, null, null)) for (const t of [q.subject, q.predicate, q.object]) if (t.termType === 'NamedNode') out.add(t.value);
  return [...out];
}

/** Blank-node-insensitive comparison of two graphs: undefined when equal, else a short description. */
function graphDifference(a: Store, b: Store): string | undefined {
  const key = (s: Store) =>
    new Set(
      s
        .getQuads(null, null, null, null)
        .filter((q) => q.subject.termType !== 'BlankNode')
        .map((q) => `${canonical(s, q.subject as Term)} <${q.predicate.value}> ${canonical(s, q.object as Term)}`),
    );
  const ka = key(a);
  const kb = key(b);
  const missing = [...ka].filter((k) => !kb.has(k));
  const extra = [...kb].filter((k) => !ka.has(k));
  if (!missing.length && !extra.length && a.size === b.size) return undefined;
  return [missing.length ? `missing ${missing[0]}` : '', extra.length ? `extra ${extra[0]}` : '', a.size !== b.size ? `${a.size} vs ${b.size} triples` : '']
    .filter(Boolean)
    .join('; ');
}

/**
 * Datatypes SHACLC parsers recognise in the short form (`ex:p xsd:string`);
 * any other IRI there is read as a class. This is shaclc-parse's list, which
 * leaves out xsd:unsignedInt (the specification's list has it), so that one is
 * written explicitly too.
 */
const SHORT_FORM_DATATYPES = new Set([
  ...['integer', 'decimal', 'float', 'double', 'string', 'boolean', 'dateTime', 'nonPositiveInteger', 'negativeInteger', 'long', 'int', 'short',
    'byte', 'nonNegativeInteger', 'unsignedLong', 'unsignedShort', 'unsignedByte', 'positiveInteger'].map((l) => NS.xsd + l),
  NS.rdf + 'langString',
]);

/**
 * Writes other datatypes (xsd:anyURI, xsd:date, custom datatypes) as
 * `datatype=…`, so they read back as datatypes, not classes. Only whole
 * tokens outside string literals, in property lines, are touched; the
 * round-trip check in toShaclc catches anything else.
 */
function explicitDatatypes(text: string, store: Store, prefixes: Record<string, string>): string {
  const tokens = new Set<string>();
  for (const dt of new Set(store.getObjects(null, nn(SH + 'datatype'), null).map((o) => o.value))) {
    if (SHORT_FORM_DATATYPES.has(dt)) continue;
    tokens.add(`<${dt}>`);
    for (const [p, ns] of Object.entries({ ...prefixes, xsd: NS.xsd, rdf: NS.rdf })) if (dt.startsWith(ns)) tokens.add(`${p}:${dt.slice(ns.length)}`);
  }
  if (!tokens.size) return text;
  return text
    .split('\n')
    .map((line) => (/^\t/.test(line) ? rewriteTokens(line, tokens) : line))
    .join('\n');
}

/** Prefixes `datatype=` to whole tokens in `tokens`, skipping string literals, the insides of IRIs and the first token (the path). */
function rewriteTokens(line: string, tokens: Set<string>): string {
  let out = '';
  let i = 0;
  let first = true;
  while (i < line.length) {
    const c = line[i];
    if (c === '"' || c === "'") {
      const long = line.startsWith(c.repeat(3), i);
      const end = long ? c.repeat(3) : c;
      let j = i + end.length;
      while (j < line.length && !line.startsWith(end, j)) j += line[j] === '\\' ? 2 : 1;
      j = Math.min(line.length, j + end.length);
      out += line.slice(i, j);
      i = j;
      first = false;
      continue;
    }
    // '|' separates the alternatives of an sh:or (it can't occur in an IRI reference).
    if (/[\s|]/.test(c)) {
      out += c;
      i++;
      continue;
    }
    let j = i;
    // An IRI reference runs to its closing '>' (it may contain quotes); otherwise a token ends at whitespace, '|' or a quote.
    if (c === '<') j = line.indexOf('>', i) < 0 ? line.length : line.indexOf('>', i) + 1;
    else while (j < line.length && !/[\s"'|]/.test(line[j])) j++;
    const tok = line.slice(i, j);
    out += !first && tokens.has(tok) ? `datatype=${tok}` : tok;
    first = false;
    i = j;
  }
  return out;
}

/**
 * SHACLC can only refer to a qualified value shape by IRI, so each anonymous
 * one becomes a named node shape (e.g. volsh:Employee-worksFor-Charity),
 * written as its own `shape` block. The constraint is unchanged. Names never
 * reuse an IRI already in the graph.
 */
function nameQualifiedShapes(store: Store, shapesNs: string): void {
  const taken = new Set(namedIris(store));
  for (const q of store.getQuads(null, nn(SH + 'qualifiedValueShape'), null, null)) {
    if (q.object.termType !== 'BlankNode') continue;
    const owner = store.getSubjects(nn(SH + 'property'), q.subject, null)[0];
    const path = store.getObjects(q.subject, nn(SH + 'path'), null)[0];
    const filler = [...store.getObjects(q.object, nn(SH + 'class'), null), ...store.getObjects(q.object, nn(SH + 'datatype'), null)][0];
    const parts = [owner ? localName(owner.value).replace(/Shape$/, '') : 'Shape', path ? localName(path.value) : 'value', filler ? localName(filler.value) : 'value'];
    const stem = `${shapesNs}${parts.map((x) => x.replace(/[^A-Za-z0-9_]/g, '_') || 'x').join('-')}`;
    let iri = stem;
    for (let n = 2; taken.has(iri); n++) iri = `${stem}${n}`;
    taken.add(iri);
    const named = nn(iri);
    for (const inner of store.getQuads(q.object, null, null, null)) {
      store.removeQuad(inner);
      store.addQuad(named, inner.predicate, inner.object);
    }
    store.removeQuad(q);
    store.addQuad(q.subject, q.predicate, named);
    store.addQuad(named, nn(RDF_TYPE), nn(SH + 'NodeShape'));
  }
}

type ValueType = { cls?: string; datatype?: string };

/** xsd:string or a built-in datatype derived from it. */
const isStringType = (dt: string) => dt === NS.xsd + 'string' || derivedTypes(NS.xsd + 'string').includes(dt);

/**
 * Several datatypes apply to one property (from several `only` restrictions,
 * or one and the range), none of them narrower than another. No literal has
 * two datatype IRIs, so one sh:datatype each would reject every value,
 * including those OWL allows in the overlap of their value spaces (0 for
 * xsd:nonNegativeInteger and xsd:nonPositiveInteger). The overlap is checked
 * by value instead; if there is none, the property can have no values. What
 * can't be expressed is left unchecked, never rejected, and a note says so.
 *
 * One datatype isn't always one sh:datatype either (#27): a built-in one
 * also takes the built-ins derived from it (`only xsd:integer` takes
 * "1"^^xsd:byte), and one the ontology defines (an alias of xsd:string, or one
 * with facets), which is never a literal's own datatype, is checked by value.
 */
function combineDatatypes(cls: string, ps: PropShape, defs: ReturnType<typeof datatypeDefinitions>, notes: string[]): void {
  const types = [...(ps.datatype ? [{ datatype: ps.datatype }] : ps.cls ? [{ cls: ps.cls }] : []), ...(ps.alsoTypes ?? [])];
  const datatypes = types.flatMap((t) => (t.datatype ? [t.datatype] : []));
  const classes = types.filter((t) => t.cls);
  if (!datatypes.length) return;
  const single = datatypes.length === 1 && !classes.length;
  if (single && !defs.has(datatypes[0])) {
    // One built-in (or unknown) datatype: its own values and those of the built-ins derived from it, so `only
    // xsd:integer` takes "1"^^xsd:byte. Nothing more is needed when nothing derives from it. Strings are the
    // exception: literals written as xsd:token, xsd:NCName and the like are rare, and listing ten datatypes on
    // every text property would make the shapes hard to read, so xsd:string stays one exact check.
    const derived = isStringType(datatypes[0]) ? [] : derivedTypes(datatypes[0]);
    if (derived.length) {
      delete ps.datatype;
      ps.codeType = { datatype: datatypes[0] };
      ps.values = { datatypes: [datatypes[0], ...derived], patterns: [] };
    }
    return;
  }
  const where = `<${cls}> <${ps.path}>`;
  const all = types.map((t) => `<${t.datatype ?? t.cls}>`).join(', ');
  delete ps.datatype;
  delete ps.cls;
  delete ps.alsoTypes;
  ps.codeType = types[0];
  // A literal is never an instance of a class, so a datatype and a class together allow nothing.
  const v = classes.length ? undefined : intersect(datatypes, defs);
  if (!v || v.empty) {
    ps.maxCount = 0;
    notes.push(single ? `${where}: values must be in ${all}, which has no values, so it can have none.` : `${where}: values must be all of ${all}, which have no values in common, so it can have none.`);
    return;
  }
  const decimal = v.root === NS.xsd + 'decimal';
  ps.values = {
    // One datatype the ontology defines on a string is checked as an xsd:string, as a built-in one is (see above).
    datatypes: v.root ? (single && v.root === NS.xsd + 'string' ? [v.root] : family(v.root)) : [],
    min: v.min,
    max: v.max,
    minLength: v.minLength,
    maxLength: v.maxLength,
    patterns: [...(v.whole ? [WHOLE_NUMBER_PATTERN] : []), ...v.patterns],
  };
  if (v.root) ps.codeType = { datatype: decimal ? NS.xsd + (v.whole ? 'integer' : 'decimal') : v.root };
  const unchecked = [...v.partial, ...(v.root ? [] : ['their datatype'])];
  if (unchecked.length)
    notes.push(`${where}: values must be ${single ? `in ${all}` : `all of ${all}`}. The shapes check what they can by value, but not ${unchecked.join(' or ')}, so they accept some values the ontology doesn't.`);
}

/**
 * Adds an `only` type to a property shape. Every such type applies, as does
 * the range: the narrowest is kept, and types none of which is narrower are
 * all kept (the first restriction's as the main one, and a restriction's over
 * the range's).
 */
function addOnlyType(ps: PropShape, t: ValueType, narrowerOrEqual: (a: ValueType, b: ValueType) => boolean): void {
  const cur: ValueType | undefined = ps.datatype ? { datatype: ps.datatype } : ps.cls ? { cls: ps.cls } : undefined;
  const range = ps.fromRange ? cur : undefined;
  delete ps.fromRange;
  // The types so far are already the narrowest, in order of preference. One as narrow as the new type
  // makes it redundant; otherwise it replaces those it is narrower than. A restriction goes before the range's.
  let types = [...(cur ? [cur] : []), ...(ps.alsoTypes ?? [])];
  if (!types.some((x) => narrowerOrEqual(x, t))) {
    types = types.filter((x) => !narrowerOrEqual(t, x));
    if (range && types[0] === range) types.unshift(t);
    else types.push(t);
  }
  delete ps.cls;
  delete ps.datatype;
  Object.assign(ps, types[0]);
  if (types.length > 1) ps.alsoTypes = types.slice(1);
  else delete ps.alsoTypes;
}

function applyRestriction(graph: OntologyGraph, ps: PropShape, r: Restriction, range: string[], narrowerOrEqual: (a: ValueType, b: ValueType) => boolean): void {
  const filler = r.filler && r.filler !== NS.owl + 'Thing' && r.filler !== NS.rdfs + 'Literal' ? r.filler : undefined;
  // A filler equal to the property's range adds no type constraint beyond the range.
  const sameAsRange = !filler || (range.length === 1 && range[0] === filler);
  const typed = filler ? (isDatatype(graph, filler) ? { datatype: filler } : { cls: filler }) : {};
  const n = r.cardinality ?? 0;
  switch (r.kind) {
    case 'some':
      if (sameAsRange) ps.minCount = Math.max(ps.minCount ?? 0, 1);
      else ps.qualified.push({ shape: typed, min: 1 });
      break;
    case 'only':
      if (filler) addOnlyType(ps, typed, narrowerOrEqual);
      break;
    case 'value':
      ps.hasValue = r.literal !== undefined ? literal(r.literal) : nn(r.filler!);
      break;
    case 'min':
      if (sameAsRange) ps.minCount = Math.max(ps.minCount ?? 0, n);
      else ps.qualified.push({ shape: typed, min: n });
      break;
    case 'max':
      if (sameAsRange) ps.maxCount = Math.min(ps.maxCount ?? Infinity, n);
      else ps.qualified.push({ shape: typed, max: n });
      break;
    case 'exactly':
      if (sameAsRange) {
        ps.minCount = Math.max(ps.minCount ?? 0, n);
        ps.maxCount = Math.min(ps.maxCount ?? Infinity, n);
      } else ps.qualified.push({ shape: typed, min: n, max: n });
      break;
  }
}

/** Named domain classes of a property, including members of a union domain. */
function domainMembers(graph: OntologyGraph, p: string): string[] {
  const out: string[] = [];
  for (const d of objects(graph.store, p, NS.rdfs + 'domain')) {
    if (d.termType === 'NamedNode') out.push(d.value);
    else for (const head of objects(graph.store, d, NS.owl + 'unionOf')) for (const m of readList(graph.store, head) ?? []) out.push(m.value);
  }
  return out;
}
