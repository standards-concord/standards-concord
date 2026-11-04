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
import { blankNode, literal, nn, objects, readList, typedLit } from './rdf.js';
import { isDatatype } from './changes.js';
import type { OntologyGraph } from './graph.js';
import { writeTurtle } from './turtle.js';

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
  const ids = opts.codeIdentifiers === false ? undefined : codeIdentifiers(derived);

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
    if (ids) add(shape, SH + 'codeIdentifier', literal(ids.classes.get(s.iri)!));

    for (const ps of s.properties) {
      const b = blankNode();
      add(shape, SH + 'property', b);
      add(b, SH + 'path', nn(ps.path));
      if (ids) add(b, SH + 'codeIdentifier', literal(ids.properties.get(s.iri)!.get(ps.path)!));
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

/**
 * SHACL compact syntax (SHACLC) for the same shapes, which is far easier to
 * read than Turtle. Written with shaclc-write; statements the compact grammar
 * can't express (shape names, qualified value shapes, the shapes graph's
 * label) use its extended syntax, so nothing is lost. sh:codeIdentifier is
 * left out, as it is only there for code generation.
 */
export async function toShaclc(graph: OntologyGraph): Promise<string> {
  const derived = deriveShapes(graph);
  const store = shaclStore(derived, { codeIdentifiers: false });
  nameQualifiedShapes(store, derived.shapesNs);
  const prefixes = Object.fromEntries(Object.entries(derived.prefixes).filter(([p]) => p));
  const { write } = await import('shaclc-write');
  const { text } = await write(store.getQuads(null, null, null, null) as any, {
    prefixes,
    extendedSyntax: true,
    // Without an ontology IRI there is no BASE to write.
    requireBase: Boolean(derived.shapesIRI),
  });
  const out = explicitDatatypes(text, store, prefixes);
  return out.endsWith('\n') ? out : `${out}\n`;
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

/** Writes other datatypes (xsd:anyURI, xsd:date, custom datatypes) as `datatype=…`, so they read back as datatypes, not classes. */
function explicitDatatypes(text: string, store: Store, prefixes: Record<string, string>): string {
  const dts = new Set(store.getObjects(null, nn(SH + 'datatype'), null).map((o) => o.value));
  let out = text;
  for (const dt of dts) {
    if (SHORT_FORM_DATATYPES.has(dt)) continue;
    const all = { ...prefixes, xsd: NS.xsd, rdf: NS.rdf };
    const [p, ns] = Object.entries(all).filter(([, ns]) => dt.startsWith(ns)).sort((a, b) => b[1].length - a[1].length)[0] ?? [];
    const tokens = [`<${dt}>`, ...(p !== undefined && ns ? [`${p}:${dt.slice(ns.length)}`] : [])];
    for (const t of tokens) out = out.replace(new RegExp(`(?<=^\\t+\\S+(?: [^\\n]*)? )${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?= |$)`, 'gm'), `datatype=${t}`);
  }
  return out;
}

/**
 * SHACLC can only refer to a qualified value shape by IRI, so each anonymous
 * one becomes a named node shape (e.g. volsh:Employee-worksFor-Charity),
 * written as its own `shape` block. The constraint is unchanged.
 */
function nameQualifiedShapes(store: Store, shapesNs: string): void {
  const taken = new Set<string>();
  for (const q of store.getQuads(null, nn(SH + 'qualifiedValueShape'), null, null)) {
    if (q.object.termType !== 'BlankNode') continue;
    const owner = store.getSubjects(nn(SH + 'property'), q.subject, null)[0];
    const path = store.getObjects(q.subject, nn(SH + 'path'), null)[0];
    const filler = [...store.getObjects(q.object, nn(SH + 'class'), null), ...store.getObjects(q.object, nn(SH + 'datatype'), null)][0];
    const parts = [owner ? localName(owner.value).replace(/Shape$/, '') : 'Shape', path ? localName(path.value) : 'value', filler ? localName(filler.value) : 'value'];
    let iri = `${shapesNs}${parts.join('-')}`;
    for (let n = 2; taken.has(iri); n++) iri = `${shapesNs}${parts.join('-')}-${n}`;
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

/* ------------------------------------------------------------------------ */
/* Code identifiers                                                          */
/* ------------------------------------------------------------------------ */

/**
 * Members of @rdfjs/wrapper's TermWrapper (a wrapped node is also an RDF/JS
 * term), plus names the ODI shacl-converter reserves. An accessor can't use them.
 */
const RESERVED_MEMBERS = new Set([
  'constructor', 'dataset', 'factory', 'original', 'termType', 'value', 'equals', 'language', 'direction',
  'datatype', 'subject', 'predicate', 'object', 'graph', 'type', 'toString', 'prototype',
]);
/** Names a generated class can't take (the base classes, and words JavaScript reserves). */
const RESERVED_CLASSES = new Set(['TermWrapper', 'DatasetWrapper', 'Object', 'Set', 'Map', 'Date', 'String', 'Number', 'Boolean', 'Symbol', 'Array', 'Function', 'Promise', 'Error']);
const JS_KEYWORDS = new Set(('break case catch class const continue debugger default delete do else enum export extends false finally for function if ' +
  'implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield await').split(' '));

/** A valid identifier from an IRI local name: letters, digits and underscores, not starting with a digit. */
export function identifierFrom(name: string, style: 'pascal' | 'camel'): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  let id = words.map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1))).join('') || 'unnamed';
  id = style === 'pascal' ? id[0].toUpperCase() + id.slice(1) : id[0].toLowerCase() + id.slice(1);
  if (/^[0-9]/.test(id)) id = `_${id}`;
  return id;
}

export interface CodeIdentifiers {
  /** Shape IRI → class name. */
  classes: Map<string, string>;
  /** Shape IRI → property path → accessor name. */
  properties: Map<string, Map<string, string>>;
}

/** Stable, unique class and accessor names for every derived shape. */
export function codeIdentifiers(derived: DerivedShapes): CodeIdentifiers {
  const classes = new Map<string, string>();
  const used = new Set<string>();
  for (const s of derived.shapes) {
    let id = identifierFrom(localName(s.targetClass), 'pascal');
    if (RESERVED_CLASSES.has(id) || JS_KEYWORDS.has(id)) id = `${id}_`;
    let n = 2;
    const base = id;
    while (used.has(id)) id = `${base}${n++}`;
    used.add(id);
    classes.set(s.iri, id);
  }
  const properties = new Map<string, Map<string, string>>();
  for (const s of derived.shapes) {
    const names = new Map<string, string>();
    const taken = new Set<string>();
    for (const ps of s.properties) {
      let id = identifierFrom(localName(ps.path), 'camel');
      if (RESERVED_MEMBERS.has(id) || JS_KEYWORDS.has(id)) id = `${id}_`;
      let n = 2;
      const base = id;
      while (taken.has(id)) id = `${base}${n++}`;
      taken.add(id);
      names.set(ps.path, id);
    }
    properties.set(s.iri, names);
  }
  return { classes, properties };
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
