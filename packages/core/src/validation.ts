/**
 * Validating instance data against an ontology.
 *
 * Two checks run on the same parsed data:
 *  - SHACL: the data graph against the shapes derived from the ontology
 *    (toShacl), with the sparq engine (WebAssembly, the same engine the Query
 *    tab uses in the browser). The ontology's class hierarchy is added to the
 *    data graph so sh:class and sh:targetClass see subclasses.
 *  - Terms: properties and classes in the ontology's namespace that it doesn't
 *    define, deprecated terms, and data that contradicts the ontology.
 *
 * Parsing never touches the network: JSON-LD remote contexts are refused.
 */
import { DataFactory, Parser, Store } from 'n3';
import type { Quad, Term } from 'n3';
import type { OntologyGraph } from './graph.js';
import { NS, RDF_TYPE, compactIRI } from './ns.js';
import { copyBlankSubtree, literalToNT, nn } from './rdf.js';
import { structuralReasoner } from './reasoner.js';
import { writeNTriples, writeTurtle } from './turtle.js';

const SH = NS.sh;

/* ------------------------------------------------------------------------ */
/* Input formats                                                             */
/* ------------------------------------------------------------------------ */

import { DATA_FORMATS, type DataFormat } from './dataFormats.js';

export { DATA_FORMATS, DATA_MEDIA_TYPES, dataFormatForFile, dataFormatForMediaType, sniffDataFormat } from './dataFormats.js';
export type { DataFormat } from './dataFormats.js';

/** Data that can't be validated: unparseable (400), too large (413), too slow to check (422) or the validator is busy (503). */
export class DataError extends Error {
  constructor(
    readonly status: 400 | 413 | 422 | 503,
    message: string,
  ) {
    super(message);
    this.name = 'DataError';
  }
}

export interface ParseDataOptions {
  /** Base IRI for relative IRIs. Without one, relative IRIs are an error. */
  baseIRI?: string;
  /** Refuse data with more triples than this. */
  maxTriples?: number;
}

const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i;
const BAD_IRI = /[\u0000-\u0020<>"{}|^`\\]/;

/**
 * Parses instance data into triples in the default graph (named graphs are
 * merged into it, as SHACL validates one data graph). Parsers stream: past
 * maxTriples, nothing more is kept, so a small document that expands to many
 * triples can't fill memory before it is refused. RDF/XML with a DTD is
 * refused, because entity declarations can expand without limit.
 */
export async function parseData(text: string, format: DataFormat, opts: ParseDataOptions = {}): Promise<Quad[]> {
  const max = opts.maxTriples ?? Infinity;
  const out = new Store();
  let seen = 0;
  const keep = (q: Quad) => {
    seen++;
    if (seen > max) return;
    for (const t of [q.subject, q.predicate, q.object]) {
      if (t.termType !== 'NamedNode') continue;
      if (!ABSOLUTE.test(t.value)) throw new DataError(400, `The data uses a relative IRI <${t.value}>. Add @base (or xml:base), or pass a base IRI.`);
      if (BAD_IRI.test(t.value)) throw new DataError(400, `The data uses an IRI with characters IRIs can't contain: <${t.value}>.`);
    }
    out.addQuad(q.subject, q.predicate, q.object);
  };
  try {
    await streamQuads(text, format, opts.baseIRI, keep);
  } catch (err) {
    if (err instanceof DataError) throw err;
    throw new DataError(400, `Could not parse the data as ${DATA_FORMATS[format].label}: ${(err as Error).message}`);
  }
  if (seen > max) throw new DataError(413, `The data has more than ${max.toLocaleString('en')} triples, the limit.`);
  return out.getQuads(null, null, null, null);
}

/** Parses N-Triples-family text, handing each quad to `emit` as it is read. */
function streamN3(text: string, format: 'Turtle' | 'TriG' | 'N-Triples' | 'N-Quads', baseIRI: string | undefined, emit: (q: Quad) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let failed = false;
    new Parser({ format, baseIRI }).parse(text, (err, quad) => {
      if (failed) return;
      if (err) {
        failed = true;
        return reject(err);
      }
      if (!quad) return resolve();
      try {
        emit(quad);
      } catch (e) {
        failed = true;
        reject(e);
      }
    });
  });
}

async function streamQuads(text: string, format: DataFormat, baseIRI: string | undefined, emit: (q: Quad) => void): Promise<void> {
  switch (format) {
    case 'turtle':
      return streamN3(text, 'Turtle', baseIRI, emit);
    case 'trig':
      return streamN3(text, 'TriG', baseIRI, emit);
    case 'ntriples':
      return streamN3(text, 'N-Triples', undefined, emit);
    case 'nquads':
      return streamN3(text, 'N-Quads', undefined, emit);
    case 'rdfxml': {
      // A DTD can declare entities that expand a few bytes into gigabytes ("billion laughs").
      if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new DataError(400, 'RDF/XML with a DOCTYPE or entity declarations is not accepted. Expand the entities and remove the DOCTYPE.');
      const { RdfXmlParser } = await import('rdfxml-streaming-parser');
      return new Promise((resolve, reject) => {
        let failed = false;
        const parser = new RdfXmlParser({ baseIRI: baseIRI ?? '' });
        const fail = (e: unknown) => {
          if (failed) return;
          failed = true;
          reject(e);
        };
        parser.on('data', (q: Quad) => {
          if (failed) return;
          try {
            emit(q);
          } catch (e) {
            fail(e);
          }
        });
        parser.on('error', fail);
        parser.on('end', () => !failed && resolve());
        parser.write(text);
        parser.end();
      });
    }
    case 'jsonld': {
      const jsonld = (await import('jsonld')).default;
      let doc: unknown;
      try {
        doc = JSON.parse(text);
      } catch (err) {
        throw new DataError(400, `The data is not valid JSON: ${(err as Error).message}`);
      }
      let remote: string | undefined;
      let nquads: string;
      try {
        nquads = (await jsonld.toRDF(doc as object, {
          format: 'application/n-quads',
          base: baseIRI,
          // Never fetch: a remote @context would let anyone make this server request any URL.
          documentLoader: async (url: string) => {
            remote = url;
            throw new Error('remote documents are not loaded');
          },
        } as never)) as unknown as string;
      } catch (err) {
        if (remote) throw new DataError(400, `Remote JSON-LD contexts are not fetched (${remote}). Put the context inline in the document.`);
        throw err;
      }
      return streamN3(nquads, 'N-Quads', undefined, emit);
    }
    default:
      throw new DataError(400, `Unsupported data format: ${format as string}`);
  }
}

/* ------------------------------------------------------------------------ */
/* SHACL                                                                     */
/* ------------------------------------------------------------------------ */

export type Severity = 'Violation' | 'Warning' | 'Info';

export interface ShaclResult {
  /** The node that failed: an IRI, or a blank node as "_:label". */
  focusNode: string;
  /** The property path: an IRI, or a SHACL path in Turtle (e.g. "[ sh:inversePath <…> ]"). */
  path?: string;
  /** The offending value in N-Triples form: <iri>, _:label or a literal such as "3"^^<…#integer>. */
  value?: string;
  severity: Severity;
  /** The constraint component's IRI, e.g. http://www.w3.org/ns/shacl#MinCountConstraintComponent. */
  constraint: string;
  /** The named node shape the constraint belongs to, when there is one. */
  shape?: string;
  message?: string;
}

export interface ShaclReport {
  conforms: boolean;
  results: ShaclResult[];
}

/** A report as the validator made it: `sources` holds each result's exact source shape, for the Turtle report. */
export interface ValidatedReport extends ShaclReport {
  sources: string[];
}

const SKOLEM = 'urn:x-concord-shape:';

type SparqReport = { conforms: boolean; results: { focusNode: string; path: string | null; value: string | null; sourceShape: string; sourceConstraintComponent: string; severity: string; message: string | null }[] };

/**
 * A shapes graph ready to validate against. Property shapes that are blank
 * nodes get internal IRIs while validating, so each result can name the node
 * shape it came from and the Turtle report can describe its source shape.
 */
export class ShapesValidator {
  private constructor(
    private readonly shapes: Store,
    private readonly shapesNT: string,
    /** Internal IRI of a property shape → its blank node in `shapes`, and the named shape that owns it. */
    private readonly skolems: Map<string, { node: Term; owner?: string }>,
  ) {}

  static fromTurtle(turtle: string): ShapesValidator {
    const shapes = new Store(new Parser({ format: 'Turtle' }).parse(turtle));
    const skolems = new Map<string, { node: Term; owner?: string }>();
    const renamed = new Map<string, Term>();
    const ownerOf = (t: Term, seen = new Set<string>()): string | undefined => {
      if (t.termType === 'NamedNode') return t.value;
      if (seen.has(t.value)) return undefined;
      seen.add(t.value);
      for (const q of shapes.getQuads(null, SH + 'property', t, null)) {
        const o = ownerOf(q.subject as Term, seen);
        if (o) return o;
      }
      return undefined;
    };
    for (const q of shapes.getQuads(null, SH + 'property', null, null)) {
      const ps = q.object as Term;
      if (ps.termType !== 'BlankNode' || renamed.has(ps.value)) continue;
      const iri = nn(`${SKOLEM}${renamed.size + 1}`);
      renamed.set(ps.value, iri);
      skolems.set(iri.value, { node: ps, owner: ownerOf(q.subject as Term) });
    }
    const swap = (t: Term) => (t.termType === 'BlankNode' && renamed.get(t.value)) || t;
    const working = new Store();
    for (const q of shapes.getQuads(null, null, null, null)) working.addQuad(swap(q.subject as Term) as never, q.predicate, swap(q.object as Term) as never);
    return new ShapesValidator(shapes, writeNTriples(working), skolems);
  }

  /** Validates triples against the shapes. `context` (e.g. the class hierarchy) joins the data graph but isn't counted. */
  async validate(data: Quad[], context: Quad[] = []): Promise<ValidatedReport> {
    const { SparqStore } = await import('@sparq-org/sparq');
    const dataNT = toNTriples([...context, ...data]);
    const store = await SparqStore.fromString('', 'ntriples');
    let raw: SparqReport;
    try {
      raw = store.validate(dataNT, this.shapesNT, 'ntriples') as SparqReport;
    } finally {
      store.free();
    }
    const rows = raw.results.map((r) => {
      const source = unwrapIri(r.sourceShape);
      const skolem = source && this.skolems.get(source);
      const result: ShaclResult = {
        focusNode: ntToString(r.focusNode),
        ...(r.path ? { path: unwrapIri(r.path) ?? r.path } : {}),
        ...(r.value ? { value: r.value } : {}),
        severity: (r.severity.startsWith(SH) ? r.severity.slice(SH.length) : r.severity) as Severity,
        constraint: unwrapIri(r.sourceConstraintComponent) ?? r.sourceConstraintComponent,
        ...(skolem ? (skolem.owner ? { shape: skolem.owner } : {}) : source && !source.startsWith(SKOLEM) ? { shape: source } : {}),
        ...(r.message ? { message: r.message } : {}),
      };
      return { result, source: r.sourceShape };
    });
    rows.sort((x, y) => {
      const a = x.result;
      const b = y.result;
      return severityRank(a.severity) - severityRank(b.severity) || a.focusNode.localeCompare(b.focusNode) || (a.path ?? '').localeCompare(b.path ?? '');
    });
    return { conforms: raw.conforms, results: rows.map((r) => r.result), sources: rows.map((r) => r.source) };
  }

  /**
   * The report as a SHACL validation report in Turtle (sh:ValidationReport).
   * Each result names its exact source shape. Property shapes that are blank
   * nodes in the shapes graph are copied into the report, so sh:sourceShape
   * always points at a description. A blank node in the data is one node
   * throughout the report, as focus node and as value.
   */
  reportTurtle(report: ValidatedReport, prefixes: Record<string, string> = {}): string {
    const out = new Store();
    const r = DataFactory.blankNode();
    const add = (s: Term, p: string, o: Term) => out.addQuad(s as never, nn(p), o as never);
    add(r, RDF_TYPE, nn(SH + 'ValidationReport'));
    add(r, SH + 'conforms', DataFactory.literal(String(report.conforms), nn(NS.xsd + 'boolean')));
    const blanks = new Map<string, Term>();
    const blank = (key: string) => {
      let b = blanks.get(key);
      if (!b) blanks.set(key, (b = DataFactory.blankNode()));
      return b;
    };
    const term = (nt: string): Term => (nt.startsWith('_:') ? blank(`data ${nt}`) : parseTerm(nt));
    const copied = new Map<string, Term>();
    const shapeTerm = (raw: string | undefined, result: ShaclResult): Term => {
      const iri = raw && unwrapIri(raw);
      const skolem = iri && this.skolems.get(iri);
      if (iri && skolem) {
        let copy = copied.get(iri);
        if (!copy) {
          copy = copyBlankSubtree(this.shapes, out, skolem.node);
          copied.set(iri, copy);
          if (skolem.owner) out.addQuad(nn(skolem.owner), nn(SH + 'property'), copy as never);
        }
        return copy;
      }
      if (iri) return nn(iri);
      if (raw?.startsWith('_:')) return blank(`shape ${raw}`);
      return result.shape ? nn(result.shape) : DataFactory.blankNode();
    };
    report.results.forEach((result, i) => {
      const b = DataFactory.blankNode();
      add(r, SH + 'result', b);
      add(b, RDF_TYPE, nn(SH + 'ValidationResult'));
      add(b, SH + 'resultSeverity', nn(SH + result.severity));
      add(b, SH + 'focusNode', term(result.focusNode.startsWith('_:') ? result.focusNode : `<${result.focusNode}>`));
      if (result.path) add(b, SH + 'resultPath', parsePath(result.path, out));
      if (result.value) add(b, SH + 'value', term(result.value));
      add(b, SH + 'sourceConstraintComponent', nn(result.constraint));
      add(b, SH + 'sourceShape', shapeTerm(report.sources[i], result));
      if (result.message) add(b, SH + 'resultMessage', DataFactory.literal(result.message));
    });
    return writeTurtle(out, { sh: SH, xsd: NS.xsd, rdf: NS.rdf, rdfs: NS.rdfs, ...prefixes }, { sectionComments: false });
  }
}

/**
 * N-Triples for validation. Unlike writeNTriples it keeps the data's own blank
 * node labels where it can (_:alice stays _:alice), so results name them, and
 * it runs in linear time.
 */
function toNTriples(quads: Quad[]): string {
  const labels = new Map<string, string>();
  const used = new Set<string>();
  const label = (id: string) => {
    let l = labels.get(id);
    if (l) return l;
    const own = id.replace(/^b\d+_/, '');
    l = /^[A-Za-z0-9_]+$/.test(own) && !used.has(own) ? own : `b${labels.size}`;
    while (used.has(l)) l = `${l}_`;
    labels.set(id, l);
    used.add(l);
    return l;
  };
  const t = (x: Term) => (x.termType === 'BlankNode' ? `_:${label(x.value)}` : x.termType === 'NamedNode' ? `<${x.value}>` : literalToNT(x as never));
  return quads.map((q) => `${t(q.subject as Term)} ${t(q.predicate as Term)} ${t(q.object as Term)} .`).join('\n');
}

const severityRank = (s: string) => (s === 'Violation' ? 0 : s === 'Warning' ? 1 : 2);

function unwrapIri(nt: string): string | undefined {
  const m = /^<([^>]*)>$/.exec(nt.trim());
  return m ? m[1] : undefined;
}

function ntToString(nt: string): string {
  return unwrapIri(nt) ?? nt;
}

function parseTerm(nt: string): Term {
  const [q] = new Parser({ format: 'N-Triples' }).parse(`<urn:s> <urn:p> ${nt} .`);
  return q.object as Term;
}

/** Parses a SHACL path (an IRI or a Turtle path expression) into `out`, returning its root. */
function parsePath(path: string, out: Store): Term {
  if (ABSOLUTE.test(path) && !/[\s<>[\]()]/.test(path)) return nn(path);
  const tmp = new Store(new Parser({ format: 'Turtle' }).parse(`<urn:s> <urn:p> ${path} .`));
  const root = tmp.getQuads(nn('urn:s'), nn('urn:p'), null, null)[0].object as Term;
  return copyBlankSubtree(tmp, out, root);
}

/** The ontology's named class hierarchy, for the data graph: sh:class and sh:targetClass follow rdfs:subClassOf there. */
export function classHierarchy(graph: OntologyGraph): Quad[] {
  return graph.store
    .getQuads(null, nn(NS.rdfs + 'subClassOf'), null, null)
    .filter((q) => q.subject.termType === 'NamedNode' && q.object.termType === 'NamedNode')
    .map((q) => DataFactory.quad(q.subject, q.predicate, q.object));
}

/* ------------------------------------------------------------------------ */
/* Terms                                                                     */
/* ------------------------------------------------------------------------ */

export interface TermIssue {
  severity: 'error' | 'warning';
  message: string;
  /** The term the issue is about, when there is one. */
  term?: string;
}

const WELL_KNOWN = [NS.rdf, NS.rdfs, NS.owl, NS.xsd, NS.skos, NS.dcterms, NS.schema, NS.foaf, NS.prov];

/**
 * Checks the terms data uses against the ontology: properties and classes in
 * its namespace that it doesn't define (with suggestions), deprecated terms,
 * and contradictions between the data and the ontology (structural reasoner).
 */
export function checkTerms(graph: OntologyGraph, data: Quad[], prefixes: Record<string, string> = {}): TermIssue[] {
  const known = new Set<string>();
  for (const q of graph.store.getQuads(null, null, null, null)) known.add(q.subject.value);
  const issues: TermIssue[] = [];
  const c = (iri: string) => compactIRI(iri, { ...graph.prefixes, ...prefixes });
  const check = (iri: string, what: string) => {
    if (known.has(iri) || WELL_KNOWN.some((ns) => iri.startsWith(ns))) return;
    if (graph.namespace && iri.startsWith(graph.namespace)) {
      const t = graph.search(iri.slice(graph.namespace.length), 10).filter((x) => x.iri.startsWith(graph.namespace)).slice(0, 3);
      issues.push({ severity: 'error', term: iri, message: `${c(iri)} is used as a ${what} but is not defined in the ontology.${t.length ? ` Did you mean ${t.map((x) => c(x.iri)).join(' or ')}?` : ''}` });
    }
  };
  const deprecated = (iri: string) => {
    const term = graph.term(iri);
    if (term?.deprecated) issues.push({ severity: 'warning', term: iri, message: `${c(iri)} is deprecated${term.replacedBy ? `; use ${c(term.replacedBy)} instead` : ''}.` });
  };
  // Each distinct term once: data can repeat the same few terms thousands of times.
  const predicates = new Set<string>();
  const types = new Set<string>();
  for (const q of data) {
    predicates.add(q.predicate.value);
    if (q.predicate.value === RDF_TYPE && q.object.termType === 'NamedNode') types.add(q.object.value);
  }
  for (const p of predicates) {
    check(p, 'property');
    deprecated(p);
  }
  for (const t of types) {
    check(t, 'class');
    deprecated(t);
  }
  const merged = graph.clone();
  merged.store.addQuads(data);
  const r = structuralReasoner(merged);
  if (!r.consistent) issues.push({ severity: 'error', message: `The data contradicts the ontology: ${r.explanation ?? 'inconsistent'}` });
  return [...new Map(issues.map((x) => [x.message, x])).values()];
}
