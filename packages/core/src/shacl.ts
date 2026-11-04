/**
 * Derives SHACL node shapes from the ontology: one sh:NodeShape per named class
 * (sh:targetClass), with property shapes from domain/range, restrictions and
 * functional characteristics. Qualified constraints are used where OWL semantics
 * require them (`p some F` does not mean every value is an F).
 */
import { Store } from 'n3';
import type { Term } from 'n3';
import type { Restriction } from './types.js';
import { NS, RDF_TYPE, localName } from './ns.js';
import { blankNode, canonical, literal, nn, objects, readList, typedLit } from './rdf.js';
import { isDatatype } from './changes.js';
import type { OntologyGraph } from './graph.js';
import { writeTurtle } from './turtle.js';
import { codeModel, type PropertyInfo } from './codemodel.js';
export { identifierFrom } from './codemodel.js';

const SH = NS.sh;

export interface PropShape {
  path: string;
  cls?: string;
  datatype?: string;
  minCount?: number;
  maxCount?: number;
  hasValue?: Term;
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
      }
      if (p.characteristics.includes('functional')) ps.maxCount = 1;
    }
    for (const r of k.restrictions) applyRestriction(graph, get(r.property), r, props.get(r.property)?.range ?? []);
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

export async function toShacl(graph: OntologyGraph): Promise<string> {
  const derived = deriveShapes(graph);
  return writeTurtle(shaclStore(derived), derived.prefixes, { ontologyIRI: derived.shapesIRI });
}

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
  const { parse } = await import('shaclc-parse');
  const iris = namedIris(store);
  // A prefix is only used when every IRI it would abbreviate is safe to abbreviate (ex:p* would read as a path).
  const prefixes = Object.fromEntries(
    Object.entries(derived.prefixes).filter(([p, ns]) => p && iris.every((iri) => !iri.startsWith(ns) || SAFE_LOCAL.test(iri.slice(ns.length)))),
  );
  const { text } = await write(store.getQuads(null, null, null, null) as any, {
    prefixes,
    extendedSyntax: Boolean(opts.extended),
    // Without an ontology IRI there is no BASE to write.
    requireBase: Boolean(derived.shapesIRI),
  });
  const header = opts.extended
    ? `# SHACL shapes for ${commentLine(derived.title ?? '')}, in SHACL compact syntax with shaclc-write's extended syntax.\n`
    : `# SHACL shapes for ${commentLine(derived.title ?? '')}, in SHACL compact syntax.\n# Shape names and the shapes graph's label are in the Turtle shapes (.shacl.ttl); SHACLC has no place for them.\n`;
  const out = header + explicitDatatypes(text, store, prefixes) + (text.endsWith('\n') ? '' : '\n');

  // Check: the SHACLC must parse back to exactly the shapes it was written from.
  const back = new Store(parse(out, { extendedSyntax: Boolean(opts.extended) }) as any);
  const diff = graphDifference(store, back);
  if (diff) throw new Error(`SHACLC output would change the shapes (${diff}); use the Turtle shapes instead`);
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
 * any other IRI there is read as a class. This is shaclc-parse's list.
 */
const SHORT_FORM_DATATYPES = new Set([
  ...['integer', 'decimal', 'float', 'double', 'string', 'boolean', 'dateTime', 'nonPositiveInteger', 'negativeInteger', 'long', 'int', 'short',
    'byte', 'nonNegativeInteger', 'unsignedLong', 'unsignedInt', 'unsignedShort', 'unsignedByte', 'positiveInteger'].map((l) => NS.xsd + l),
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

/** Prefixes `datatype=` to whole tokens in `tokens`, skipping string literals and the first token (the path). */
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
    if (/\s/.test(c)) {
      out += c;
      i++;
      continue;
    }
    let j = i;
    while (j < line.length && !/[\s"']/.test(line[j])) j++;
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

function applyRestriction(graph: OntologyGraph, ps: PropShape, r: Restriction, range: string[]): void {
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
      if (filler) Object.assign(ps, typed);
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
