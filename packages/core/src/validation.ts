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
  /** Refuse data with more (distinct) triples than this. */
  maxTriples?: number;
  /** Refuse JSON-LD larger than this many bytes (default MAX_JSONLD_BYTES): it is expanded whole before any triple can be counted. */
  maxJsonLdBytes?: number;
}

const tooMany = (max: number) => `The data has more than ${max.toLocaleString('en')} triples, the limit.`;

/**
 * The largest JSON-LD accepted, in bytes. JSON-LD has to be expanded (every
 * context applied, nodes merged) before it yields triples, so it can't be cut
 * off at the triple limit the way the other formats are: its size, and the
 * validator's time limit, bound that work instead.
 */
export const MAX_JSONLD_BYTES = 2 * 1024 * 1024;

const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i;
const BAD_IRI = /[\u0000-\u0020<>"{}|^`\\]/;

/**
 * Parses instance data into triples in the default graph (named graphs are
 * merged into it, as SHACL validates one data graph). The limit is on
 * distinct triples. Turtle, TriG, N-Triples, N-Quads and RDF/XML parsers are
 * fed the text a chunk at a time and stop at the first triple past the
 * limit, so a small document that expands to many triples can't fill memory
 * or keep the parser busy. JSON-LD has to be converted whole, so it has its
 * own byte limit (MAX_JSONLD_BYTES) and relies on the caller's time limit.
 * RDF/XML with a DTD is refused, because entity declarations can expand
 * without limit.
 */
export async function parseData(text: string, format: DataFormat, opts: ParseDataOptions = {}): Promise<Quad[]> {
  const max = opts.maxTriples ?? Infinity;
  const out = new Store();
  let distinct = 0;
  const keep = (q: Quad) => {
    for (const t of [q.subject, q.predicate, q.object]) {
      if (t.termType !== 'NamedNode') continue;
      if (!ABSOLUTE.test(t.value)) throw new DataError(400, `The data uses a relative IRI <${t.value}>. Add @base (or xml:base), or pass a base IRI.`);
      if (BAD_IRI.test(t.value)) throw new DataError(400, `The data uses an IRI with characters IRIs can't contain: <${t.value}>.`);
    }
    // The limit is on distinct triples (as RDF terms: "a" and "a"^^xsd:string are one), so repeats are free.
    // Throwing stops the parser where it is (see the stream* functions).
    if (out.addQuad(q.subject, q.predicate, q.object) && ++distinct > max) throw new DataError(413, tooMany(max));
  };
  try {
    // JSON-LD may have at most 4 values per allowed triple before it is converted (see checkJsonLdBudget).
    await streamQuads(text, format, opts.baseIRI, keep, opts.maxJsonLdBytes ?? MAX_JSONLD_BYTES, Number.isFinite(max) ? max * 4 : Infinity);
  } catch (err) {
    if (err instanceof DataError) throw err;
    throw new DataError(400, `Could not parse the data as ${DATA_FORMATS[format].label}: ${(err as Error).message}`);
  }
  return out.getQuads(null, null, null, null);
}

/** How much text each parser is given at a time. */
const CHUNK = 16 * 1024;

/** The text in chunks, never splitting a surrogate pair. */
function* chunks(text: string): Generator<string> {
  for (let i = 0; i < text.length; ) {
    let end = Math.min(i + CHUNK, text.length);
    const c = text.charCodeAt(end - 1);
    if (end < text.length && c >= 0xd800 && c <= 0xdbff) end++;
    yield text.slice(i, end);
    i = end;
  }
}

/**
 * Parses Turtle-family text with n3, handing each quad to `emit`. The text is
 * fed as a stream of chunks, which n3 parses synchronously as each arrives, so
 * an exception from `emit` (such as the triple cap) comes straight back out
 * of the loop and nothing after it is read.
 */
function streamN3(text: string, format: 'Turtle' | 'TriG' | 'N-Triples' | 'N-Quads', baseIRI: string | undefined, emit: (q: Quad) => void): Promise<void> {
  // The smallest stream n3 accepts: it listens for data, end and error.
  const listeners: Record<string, ((x?: string) => void)[]> = {};
  const input = {
    on: (event: string, fn: (x?: string) => void) => void (listeners[event] ??= []).push(fn),
    emit: (event: string, x?: string) => listeners[event]?.forEach((fn) => fn(x)),
  };
  let error: unknown;
  let finished = false;
  new Parser({ format, baseIRI }).parse(input as never, (err, quad) => {
    if (finished) return;
    if (err) {
      finished = true;
      error = err;
    } else if (quad) emit(quad);
    else finished = true;
  });
  try {
    for (const chunk of chunks(text)) {
      if (finished) break;
      input.emit('data', chunk);
    }
    if (!finished) input.emit('end');
  } catch (e) {
    error = e;
  }
  return error === undefined ? Promise.resolve() : Promise.reject(error);
}

/**
 * Feeds a streaming parser (RDF/XML, JSON-LD) a chunk at a time, yielding
 * between chunks so its output is handled, and stops feeding it as soon as a
 * quad is refused or the parser fails.
 */
async function feed(
  parser: { write(chunk: string): unknown; end(): unknown; destroy(): unknown; on(event: string, fn: (x: never) => void): unknown },
  text: string,
  emit: (q: Quad) => void,
): Promise<void> {
  let error: unknown;
  let ended = false;
  const done = new Promise<void>((resolve) => {
    parser.on('data', (q: Quad) => {
      if (error !== undefined) return;
      try {
        emit(q);
      } catch (e) {
        error = e;
        parser.destroy();
        resolve();
      }
    });
    parser.on('error', (e: unknown) => {
      if (error === undefined) error = e;
      resolve();
    });
    parser.on('end', () => {
      ended = true;
      resolve();
    });
  });
  for (const chunk of chunks(text)) {
    if (error !== undefined) break;
    parser.write(chunk);
    await new Promise((r) => setImmediate(r));
  }
  if (error === undefined) parser.end();
  await done;
  if (error !== undefined) throw error;
  if (!ended) throw new Error('the parser stopped before the end of the data');
}

/** JSON nested deeper than this is refused: real data is far shallower, and expansion recurses. */
export const MAX_JSON_DEPTH = 64;

/** How deeply JSON is nested, without recursion (so it can't overflow the stack), stopping once past `limit`. */
function jsonDepth(doc: unknown, limit: number): number {
  let deepest = 0;
  const stack: [unknown, number][] = [[doc, 1]];
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    if (!node || typeof node !== 'object') continue;
    deepest = Math.max(deepest, depth);
    if (deepest > limit) return deepest;
    for (const child of Array.isArray(node) ? node : Object.values(node)) if (child && typeof child === 'object') stack.push([child, depth + 1]);
  }
  return deepest;
}

/** The longest term, IRI or context string JSON-LD may use. */
export const MAX_JSONLD_STRING = 4096;
/** How much IRI text expanding JSON-LD may make, in characters: uses of terms times the longest a term can expand to. */
export const MAX_JSONLD_EXPANSION = 32 * 1024 * 1024;

/**
 * Bounds what converting JSON-LD can build, from the parsed JSON alone,
 * before anything is converted. Expansion turns each use of a term (a key,
 * an @type, a value coerced to an IRI) into a full IRI, which can be far
 * longer than the term: a short document can name a huge IRI and use it
 * thousands of times. So:
 *  - keys, @id/@type/@vocab/@base values and every string in a context are
 *    limited to MAX_JSONLD_STRING characters;
 *  - the longest IRI any term can expand to is worked out from the contexts
 *    (following prefixes through other terms), and that times the number of
 *    uses must stay within MAX_JSONLD_EXPANSION;
 *  - there may be at most `maxValues` property values and types (each makes
 *    at most a triple or two), which bounds the triples built before they
 *    are counted.
 * Walks without recursion. Throws DataError 413.
 */
export function checkJsonLdBudget(doc: unknown, maxValues: number): void {
  const fail = (why: string) => {
    throw new DataError(413, `This JSON-LD is too large or complex to convert: ${why}. Send it as Turtle or N-Triples instead.`);
  };
  const long = (x: string, what: string) => x.length > MAX_JSONLD_STRING && fail(`${what} is longer than ${MAX_JSONLD_STRING.toLocaleString('en')} characters`);
  // Term name → the IRIs (or compact IRIs) it is defined as, across every context.
  const terms = new Map<string, string[]>();
  let vocab = 0;
  let base = 0;
  let uses = 0;
  let values = 0;
  // Terms whose values are JSON literals (@type: @json): one literal each, never looked inside.
  const jsonTerms = new Set<string>();
  const define = (name: string, iri: string) => {
    if (!terms.has(name)) terms.set(name, []);
    terms.get(name)!.push(iri);
  };
  // First the contexts, wherever they are, so the terms are known before the data is counted.
  const contexts: unknown[] = [];
  const data: unknown[] = [doc];
  const all: unknown[] = [doc];
  while (all.length) {
    const node = all.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const x of node) all.push(x);
      continue;
    }
    for (const [key, value] of Object.entries(node)) {
      long(key, 'a key');
      if (key === '@context') contexts.push(value);
      else if (key !== '@value') all.push(value);
    }
  }
  while (contexts.length) {
    const node = contexts.pop();
    if (typeof node === 'string') {
      long(node, 'a context string');
      continue;
    }
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const x of node) contexts.push(x);
      continue;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === '@vocab' && typeof value === 'string') vocab = Math.max(vocab, value.length);
      else if (key === '@base' && typeof value === 'string') base = Math.max(base, value.length);
      else if (!key.startsWith('@')) {
        if (typeof value === 'string') define(key, value);
        else if (value && typeof value === 'object' && !Array.isArray(value)) {
          const def = value as Record<string, unknown>;
          for (const k of ['@id', '@reverse']) if (typeof def[k] === 'string') define(key, def[k] as string);
          if (def['@id'] === undefined && def['@reverse'] === undefined) define(key, key);
          if (def['@type'] === '@json') jsonTerms.add(key);
        }
      }
      // Nested definitions and scoped contexts are contexts too.
      contexts.push(value);
    }
  }
  // Then the data: uses of terms (keys, and strings that may be IRIs) and values.
  while (data.length) {
    const node = data.pop();
    if (typeof node === 'string') {
      uses++;
      continue;
    }
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      // Every item of an array (of values, of a list, of types, of a graph) can make a triple or two.
      values += node.length;
      if (values > maxValues) fail(`it has more than ${maxValues.toLocaleString('en')} values`);
      for (const x of node) data.push(x);
      continue;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === '@context' || key === '@value') continue;
      if (key === '@id' || key === '@type' || key === '@vocab' || key === '@base') {
        for (const v of Array.isArray(value) ? value : [value]) if (typeof v === 'string') long(v, `an ${key} value`);
      }
      const term = !key.startsWith('@');
      if (term) uses++;
      if ((term || key === '@type') && !Array.isArray(value)) values++;
      if (values > maxValues) fail(`it has more than ${maxValues.toLocaleString('en')} values`);
      if (term && jsonTerms.has(key)) continue;
      data.push(value);
    }
  }
  // The longest IRI each term can expand to: its definition, plus whatever its prefix (a term itself) expands to.
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const expandsTo = (name: string): number => {
    const known = memo.get(name);
    if (known !== undefined) return known;
    if (visiting.has(name)) return 0; // A cycle: JSON-LD refuses it anyway.
    visiting.add(name);
    let longest = 0;
    for (const iri of terms.get(name) ?? []) {
      const colon = iri.indexOf(':');
      const prefix = colon > 0 ? iri.slice(0, colon) : undefined;
      const extra = prefix !== undefined && prefix !== name && terms.has(prefix) ? expandsTo(prefix) : colon < 0 ? Math.max(vocab, base) : 0;
      longest = Math.max(longest, iri.length + extra);
    }
    visiting.delete(name);
    memo.set(name, longest);
    return longest;
  };
  let longest = Math.max(vocab, base);
  for (const name of terms.keys()) longest = Math.max(longest, expandsTo(name));
  if (longest > MAX_JSONLD_STRING) fail(`a term in its context expands to an IRI longer than ${MAX_JSONLD_STRING.toLocaleString('en')} characters`);
  // Terms are expanded while their contexts are processed too, so count each definition as a use.
  if ((uses + terms.size) * Math.max(longest, 1) > MAX_JSONLD_EXPANSION) fail('its contexts would expand it to too much text');
}

/** A quad as jsonld.toRDF returns it (plain objects, not RDF/JS terms). */
interface JsonLdTerm {
  termType: 'NamedNode' | 'BlankNode' | 'Literal' | 'DefaultGraph';
  value: string;
  datatype?: { value: string };
  language?: string;
}
interface JsonLdQuad {
  subject: JsonLdTerm;
  predicate: JsonLdTerm;
  object: JsonLdTerm;
}

const { namedNode, blankNode, literal, quad: makeQuad } = DataFactory;
const fromTerm = (t: JsonLdTerm) =>
  t.termType === 'BlankNode'
    ? blankNode(t.value.replace(/^_:/, ''))
    : t.termType === 'Literal'
      ? literal(t.value, t.language || (t.datatype ? namedNode(t.datatype.value) : undefined))
      : namedNode(t.value);
/** Named graphs are merged into the default graph, as for the other formats. */
const fromJsonLd = (q: JsonLdQuad) => makeQuad(fromTerm(q.subject) as never, fromTerm(q.predicate) as never, fromTerm(q.object) as never) as unknown as Quad;

async function streamQuads(text: string, format: DataFormat, baseIRI: string | undefined, emit: (q: Quad) => void, maxJsonLdBytes: number, maxValues: number): Promise<void> {
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
      return feed(new RdfXmlParser({ baseIRI: baseIRI ?? '' }) as never, text, emit);
    }
    case 'jsonld': {
      const bytes = text.length > maxJsonLdBytes ? Infinity : new TextEncoder().encode(text).length;
      if (bytes > maxJsonLdBytes) throw new DataError(413, `JSON-LD data is limited to ${(maxJsonLdBytes / 1024 / 1024).toLocaleString('en')} MB. Send larger data as Turtle or N-Triples.`);
      let doc: unknown;
      try {
        doc = JSON.parse(text);
      } catch (err) {
        throw new DataError(400, `The data is not valid JSON: ${(err as Error).message}`);
      }
      if (jsonDepth(doc, MAX_JSON_DEPTH) > MAX_JSON_DEPTH) throw new DataError(400, `The JSON is nested more than ${MAX_JSON_DEPTH} levels deep, the limit.`);
      checkJsonLdBudget(doc, maxValues);
      const jsonld = (await import('jsonld')).default;
      let remote: string | undefined;
      let dataset: JsonLdQuad[];
      try {
        // One pass to RDF, as quad objects that share the term strings expansion made
        // (not one N-Quads string that copies every IRI into every line). It can't be
        // stopped part-way, so the limits above, the byte limit and the validator's time
        // limit bound it; the triples are then counted (distinct, as RDF) and refused
        // past the limit.
        dataset = (await jsonld.toRDF(doc as object, {
          base: baseIRI,
          // Never fetch: a remote @context would let anyone make this server request any URL.
          documentLoader: async (url: string) => {
            remote = url;
            throw new Error('remote documents are not loaded');
          },
        } as never)) as unknown as JsonLdQuad[];
      } catch (err) {
        if (remote) throw new DataError(400, `Remote JSON-LD contexts are not fetched (${remote}). Put the context inline in the document.`);
        throw err;
      }
      doc = undefined;
      for (const q of dataset) emit(fromJsonLd(q));
      return;
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
