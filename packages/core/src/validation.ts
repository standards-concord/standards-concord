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
import type { Literal, Quad, Term } from 'n3';
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
  /** Refuse data whose distinct triples add up to more than this many characters of IRIs and literals (default MAX_DATA_CHARS). */
  maxChars?: number;
}

const tooMany = (max: number) => `The data has more than ${max.toLocaleString('en')} triples, the limit.`;
const tooLong = (max: number) =>
  `The data's triples hold more than ${(max / 1024 / 1024).toLocaleString('en')} million characters of IRIs and literals, the limit. Send less, or use shorter IRIs.`;

/**
 * The largest JSON-LD accepted, in bytes. JSON-LD has to be expanded (every
 * context applied, nodes merged) before it yields triples, so it can't be cut
 * off at the triple limit the way the other formats are: its size, and the
 * validator's time limit, bound that work instead.
 */
export const MAX_JSONLD_BYTES = 2 * 1024 * 1024;

/**
 * The most text the parsed triples may hold, in characters, counting every
 * IRI and literal of every distinct triple. Each triple is written out in
 * full for the SHACL engine and its terms can appear in the report, so this
 * bounds those however much a document's prefixes, @vocab or @base multiply
 * its size. Plain N-Triples within the byte limit stays well inside it.
 */
export const MAX_DATA_CHARS = 8 * 1024 * 1024;
/** The longest IRI data may use. IRIs are repeated in the report for each result about them. */
export const MAX_IRI_LENGTH = 4096;

const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i;
const BAD_IRI = /[\u0000-\u0020<>"{}|^`\\]/;
/** BCP 47 in outline, as Turtle and N-Triples accept it. */
const LANGUAGE = /^[a-z]{1,8}(-[a-z0-9]{1,8})*$/i;

/** Refuses an IRI the validator can't use: too long (413), relative or malformed (400). */
function checkIri(iri: string, what = '') {
  if (iri.length > MAX_IRI_LENGTH) throw new DataError(413, `The data uses a ${what}IRI longer than ${MAX_IRI_LENGTH.toLocaleString('en')} characters, the limit: <${iri.slice(0, 80)}…>.`);
  if (!ABSOLUTE.test(iri)) throw new DataError(400, `The data uses a relative ${what}IRI <${iri.slice(0, 200)}>. Add @base (or xml:base), or pass a base IRI.`);
  if (BAD_IRI.test(iri)) throw new DataError(400, `The data uses a ${what}IRI with characters IRIs can't contain: <${iri.slice(0, 200)}>.`);
}

/**
 * Parses instance data into triples in the default graph (named graphs are
 * merged into it, as SHACL validates one data graph). The limits are on
 * distinct triples: how many (maxTriples), how much text they hold
 * (MAX_DATA_CHARS) and how long an IRI is (MAX_IRI_LENGTH). Turtle, TriG,
 * N-Triples, N-Quads and RDF/XML parsers are fed the text a chunk at a time
 * and stop at the first triple past a limit, so a small document that
 * expands to many or huge triples can't fill memory or keep the parser busy.
 * JSON-LD has to be converted whole, so it has its own byte and value limits
 * and relies on the caller to run it with a time and memory limit (the
 * server's worker pool); its triples are then taken against the same limits.
 * RDF/XML with a DTD is refused, because entity declarations can expand
 * without limit.
 */
export async function parseData(text: string, format: DataFormat, opts: ParseDataOptions = {}): Promise<Quad[]> {
  const max = opts.maxTriples ?? Infinity;
  const maxChars = opts.maxChars ?? MAX_DATA_CHARS;
  const out = new Store();
  let distinct = 0;
  let chars = 0;
  const keep = (q: Quad) => {
    let size = 0;
    for (const t of [q.subject, q.predicate, q.object]) {
      size += t.value.length;
      // (Blank node labels need no check: they are renamed where N-Triples can't write them, see toNTriples.)
      if (t.termType === 'NamedNode') checkIri(t.value);
      else if (t.termType === 'Literal') {
        const { language, datatype } = t as Literal;
        size += language.length + datatype.value.length;
        // A datatype is an IRI like any other, and a language tag has a fixed form.
        checkIri(datatype.value, 'datatype ');
        if (language && !LANGUAGE.test(language)) throw new DataError(400, `The data uses a language tag that isn't one: "${language.slice(0, 80)}".`);
      }
    }
    // The limits are on distinct triples (as RDF terms: "a" and "a"^^xsd:string are one), so repeats are free.
    // Throwing stops the parser where it is (see the stream* functions).
    if (!out.addQuad(q.subject, q.predicate, q.object)) return;
    if (++distinct > max) throw new DataError(413, tooMany(max));
    if ((chars += size) > maxChars) throw new DataError(413, tooLong(maxChars));
  };
  try {
    // JSON-LD may have at most 8 JSON values per allowed triple, and any small document is fine (see jsonShape).
    await streamQuads(text, format, opts.baseIRI, keep, opts.maxJsonLdBytes ?? MAX_JSONLD_BYTES, Number.isFinite(max) ? Math.max(1024, max * 8) : Infinity);
  } catch (err) {
    if (err instanceof DataError) throw err;
    // Converting JSON-LD recurses through its contexts: a long enough chain of them runs out of stack.
    if (err instanceof RangeError) throw new DataError(413, `The data is too large or complex to convert to triples (${err.message}). Send it as Turtle or N-Triples instead.`);
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

/**
 * How deeply JSON is nested and how many values it has, without recursion
 * (so it can't overflow the stack), stopping once past either limit. Every
 * value counts: objects, arrays, and the strings, numbers and booleans in
 * them. These are the only checks on JSON-LD before it is converted: what
 * conversion builds is bounded by the worker it runs in (time and memory),
 * and the triples it yields by parseData's limits as each one is taken.
 */
function jsonShape(doc: unknown, maxDepth: number, maxValues: number): { depth: number; values: number } {
  let depth = 0;
  let values = 0;
  const stack: [unknown, number][] = [[doc, 1]];
  while (stack.length) {
    const [node, level] = stack.pop()!;
    if (++values > maxValues) break;
    if (!node || typeof node !== 'object') continue;
    depth = Math.max(depth, level);
    if (depth > maxDepth) break;
    for (const child of Array.isArray(node) ? node : Object.values(node)) stack.push([child, level + 1]);
  }
  return { depth, values };
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
      const shape = jsonShape(doc, MAX_JSON_DEPTH, maxValues);
      if (shape.depth > MAX_JSON_DEPTH) throw new DataError(400, `The JSON is nested more than ${MAX_JSON_DEPTH} levels deep, the limit.`);
      if (shape.values > maxValues) throw new DataError(413, `This JSON-LD has more than ${maxValues.toLocaleString('en')} values, too many to convert. Send it as Turtle or N-Triples instead.`);
      const jsonld = (await import('jsonld')).default;
      let remote: string | undefined;
      let dataset: JsonLdQuad[];
      try {
        // One pass to RDF, as quad objects that share the term strings expansion made
        // (not one N-Quads string that copies every IRI into every line). It can't be
        // stopped part-way: the byte and value limits above and the worker's time and
        // memory limits bound it. Its triples are then taken one at a time, and refused
        // as soon as they pass parseData's limits.
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
  /** Every result by severity, including any past the limit that aren't in `results`. */
  counts: Record<Severity, number>;
}

export interface ValidateOptions {
  /** Keep at most this many results (the counts still count them all). */
  limit?: number;
  /** About how much data text (in characters) each run of the SHACL engine is given. */
  batchChars?: number;
  /** false: one run over all the data, as for shapes that can't be batched. */
  batched?: boolean;
}

/**
 * The structure the derived shapes (toShacl) have, which is what batching
 * relies on: node shapes with class targets and property shapes; property
 * shapes with a plain property path whose checks read only the focus node's
 * own values for that property and those values' types; and qualified value
 * shapes that only check a value's class or datatype. The SHACL predicates
 * each kind of shape may use; anything else, anywhere, means one run.
 */
const SHAPE_ANNOTATIONS = ['name', 'description', 'order', 'group', 'severity', 'message', 'deactivated'];
const ALLOWED: Record<'node' | 'property' | 'value', Set<string>> = {
  node: new Set(['targetClass', 'property', ...SHAPE_ANNOTATIONS].map((k) => SH + k)),
  property: new Set(['path', 'datatype', 'class', 'minCount', 'maxCount', 'hasValue', 'qualifiedValueShape', 'qualifiedMinCount', 'qualifiedMaxCount', ...SHAPE_ANNOTATIONS].map((k) => SH + k)),
  value: new Set(['class', 'datatype'].map((k) => SH + k)),
};

/** Whether shapes have exactly the derived shapes' structure (see ALLOWED). */
function derivedStructure(shapes: Store): boolean {
  const kinds = new Map<string, Set<keyof typeof ALLOWED>>();
  const mark = (t: Term, kind: keyof typeof ALLOWED) => {
    const k = `${t.termType}:${t.value}`;
    if (!kinds.has(k)) kinds.set(k, new Set());
    kinds.get(k)!.add(kind);
  };
  for (const q of shapes.getQuads(null, SH + 'targetClass', null, null)) {
    if (q.subject.termType !== 'NamedNode' || q.object.termType !== 'NamedNode') return false;
    mark(q.subject as Term, 'node');
  }
  for (const q of shapes.getQuads(null, RDF_TYPE, null, null)) {
    if (q.object.value === SH + 'NodeShape') mark(q.subject as Term, 'node');
    else if (q.object.value === SH + 'PropertyShape') mark(q.subject as Term, 'property');
    else if (q.object.value === NS.rdfs + 'Class' || q.object.value.startsWith(SH)) return false; // implicit class targets, other shape types
  }
  for (const q of shapes.getQuads(null, SH + 'property', null, null)) mark(q.object as Term, 'property');
  for (const q of shapes.getQuads(null, SH + 'qualifiedValueShape', null, null)) mark(q.object as Term, 'value');
  for (const q of shapes.getQuads(null, SH + 'path', null, null)) if (q.object.termType !== 'NamedNode') return false;
  for (const q of shapes.getQuads(null, null, null, null)) {
    if (!q.predicate.value.startsWith(SH)) continue;
    const roles = kinds.get(`${q.subject.termType}:${q.subject.value}`);
    // Each shape is one kind (a property shape that also has property shapes would nest checks), and uses only that kind's predicates.
    if (!roles || roles.size !== 1) return false;
    const [role] = roles;
    if (!ALLOWED[role].has(q.predicate.value)) return false;
    // sh:property only from node shapes: a property shape's values are never checked for their own properties.
    if (q.predicate.value === SH + 'property' && role !== 'node') return false;
  }
  return true;
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
    /**
     * For validating in batches: the shapes without their targets, and each target class's
     * shapes. Undefined when the shapes use more than the derived shapes do, so that which
     * data a focus node's checks need can't be known without running them.
     */
    private readonly batching?: { untargetedNT: string; targets: Map<string, string[]> },
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
    const untargeted = new Store();
    const targets = new Map<string, string[]>();
    for (const q of shapes.getQuads(null, null, null, null)) {
      const s = swap(q.subject as Term);
      const o = swap(q.object as Term);
      working.addQuad(s as never, q.predicate, o as never);
      if (q.predicate.value === SH + 'targetClass') targets.set(o.value, [...(targets.get(o.value) ?? []), s.value]);
      else untargeted.addQuad(s as never, q.predicate, o as never);
    }
    const shapesNT = writeNTriples(working);
    return new ShapesValidator(shapes, shapesNT, skolems, derivedStructure(shapes) ? { untargetedNT: writeNTriples(untargeted), targets } : undefined);
  }

  /**
   * Validates triples against the shapes. `context` (e.g. the class hierarchy)
   * joins the data graph but isn't counted.
   *
   * The SHACL engine builds its whole report in one go, so data that breaks
   * many constraints could make a huge one. For the derived shapes the data is
   * therefore checked in batches of focus nodes, each with only the triples
   * its checks read (the focus nodes' own triples, the types of their values,
   * and every rdfs:subClassOf triple), and only the first `limit` results are
   * kept: the rest are counted and dropped batch by batch.
   */
  async validate(data: Quad[], context: Quad[] = [], opts: ValidateOptions = {}): Promise<ValidatedReport> {
    const limit = opts.limit ?? Infinity;
    const { SparqStore } = await import('@sparq-org/sparq');
    const store = await SparqStore.fromString('', 'ntriples');
    const counts: Record<Severity, number> = { Violation: 0, Warning: 0, Info: 0 };
    const rows: { result: ShaclResult; source: string }[] = [];
    let conforms = true;
    const batched = !!this.batching && opts.batched !== false;
    // Blank nodes become IRIs under a prefix made for this run, which no IRI in the data or shapes uses.
    const blankPrefix = batched ? this.blankPrefix(data, context) : undefined;
    const run = (dataNT: string, shapesNT: string) => {
      const raw = store.validate(dataNT, shapesNT, 'ntriples') as SparqReport;
      if (!raw.conforms) conforms = false;
      for (const r of raw.results) {
        const result = this.toResult(r, blankPrefix);
        counts[result.severity] = (counts[result.severity] ?? 0) + 1;
        if (rows.length < limit) rows.push({ result, source: r.sourceShape });
      }
    };
    try {
      if (!blankPrefix) run(toNTriples([...context, ...data]), this.shapesNT);
      else for (const batch of this.batches(data, context, blankPrefix, opts.batchChars ?? 64 * 1024)) run(batch.data, batch.shapes);
    } finally {
      store.free();
    }
    rows.sort((x, y) => {
      const a = x.result;
      const b = y.result;
      return severityRank(a.severity) - severityRank(b.severity) || a.focusNode.localeCompare(b.focusNode) || (a.path ?? '').localeCompare(b.path ?? '');
    });
    return { conforms, counts, results: rows.map((r) => r.result), sources: rows.map((r) => r.source) };
  }

  /** An IRI prefix, for writing blank nodes as IRIs, that no IRI in the data, context or shapes starts with. */
  private blankPrefix(data: Quad[], context: Quad[]): string {
    for (;;) {
      const prefix = `urn:x-concord-blank-${globalThis.crypto.randomUUID()}:`;
      const clash = (t: Term) => (t.termType === 'NamedNode' && t.value.startsWith(prefix)) || (t.termType === 'Literal' && (t as Literal).datatype.value.startsWith(prefix));
      if (this.shapesNT.includes(prefix)) continue;
      if (![...context, ...data].some((q) => clash(q.subject as Term) || clash(q.predicate as Term) || clash(q.object as Term))) return prefix;
    }
  }

  /**
   * A result as the engine reported it, in this module's terms. A focus node
   * or value that is exactly one of this run's blank node IRIs is a blank node
   * again (_:label); nothing else is rewritten, except those IRIs in messages.
   */
  private toResult(r: SparqReport['results'][number], blankPrefix?: string): ShaclResult {
    const source = unwrapIri(r.sourceShape);
    const skolem = source && this.skolems.get(source);
    const blank = (nt: string) => {
      const iri = blankPrefix && unwrapIri(nt);
      return iri && iri.startsWith(blankPrefix) ? `_:${iri.slice(blankPrefix.length)}` : nt;
    };
    // The prefix is new for each run, so it can only appear in a message where the engine wrote a blank node's IRI.
    const message = r.message && blankPrefix ? r.message.split(`<${blankPrefix}`).map((part, i) => (i === 0 ? part : `_:${part.replace('>', '')}`)).join('') : r.message;
    return {
      focusNode: ntToString(blank(r.focusNode)),
      ...(r.path ? { path: unwrapIri(r.path) ?? r.path } : {}),
      ...(r.value ? { value: blank(r.value) } : {}),
      severity: (r.severity.startsWith(SH) ? r.severity.slice(SH.length) : r.severity) as Severity,
      constraint: unwrapIri(r.sourceConstraintComponent) ?? r.sourceConstraintComponent,
      ...(skolem ? (skolem.owner ? { shape: skolem.owner } : {}) : source && !source.startsWith(SKOLEM) ? { shape: source } : {}),
      ...(message ? { message } : {}),
    };
  }

  /**
   * The data in batches of focus nodes, for the derived shapes: N-Triples for
   * each batch (blank nodes written as IRIs, so the shapes can name them as
   * sh:targetNode) and the shapes with those targets.
   */
  private *batches(data: Quad[], context: Quad[], blankPrefix: string, batchChars: number): Generator<{ data: string; shapes: string }> {
    const { untargetedNT, targets } = this.batching!;
    const SUB = NS.rdfs + 'subClassOf';
    const all = [...context, ...data];
    const nt = ntWriter(blankPrefix);
    // Every subClassOf triple joins every batch: sh:targetClass and sh:class follow them.
    const hierarchy = all.filter((q) => q.predicate.value === SUB);
    const hierarchyNT = hierarchy.map(nt).join('\n');
    // Classes by term (a class can be a blank node), and each class's superclasses.
    const key = (t: Term) => `${t.termType}:${t.value}`;
    const supers = new Map<string, string[]>();
    for (const q of hierarchy) supers.set(key(q.subject as Term), [...(supers.get(key(q.subject as Term)) ?? []), key(q.object as Term)]);
    const closures = new Map<string, Set<string>>();
    const above = (cls: string) => {
      let seen = closures.get(cls);
      if (seen) return seen;
      seen = new Set([cls]);
      const todo = [cls];
      while (todo.length) for (const c of supers.get(todo.pop()!) ?? []) if (!seen.has(c)) (seen.add(c), todo.push(c));
      closures.set(cls, seen);
      return seen;
    };
    const bySubject = new Map<string, Quad[]>();
    for (const q of all) {
      const k = key(q.subject as Term);
      const list = bySubject.get(k);
      if (list) list.push(q);
      else bySubject.set(k, [q]);
    }
    // Each focus node, in order, with the shapes that target it: instances of a target class
    // through any chain of subclasses, named or blank.
    const focus = new Map<string, { node: Term; shapes: Set<string> }>();
    for (const q of all) {
      if (q.predicate.value !== RDF_TYPE || q.object.termType === 'Literal') continue;
      for (const cls of above(key(q.object as Term))) {
        if (!cls.startsWith('NamedNode:')) continue;
        for (const shape of targets.get(cls.slice('NamedNode:'.length)) ?? []) {
          const k = key(q.subject as Term);
          if (!focus.has(k)) focus.set(k, { node: q.subject as Term, shapes: new Set() });
          focus.get(k)!.shapes.add(shape);
        }
      }
    }
    const typesOf = (t: Term) => (bySubject.get(key(t)) ?? []).filter((q) => q.predicate.value === RDF_TYPE);
    let lines = new Set<string>();
    let targetsNT: string[] = [];
    let size = 0;
    const flush = () => {
      const batch = { data: `${hierarchyNT}\n${[...lines].join('\n')}`, shapes: `${untargetedNT}\n${targetsNT.join('\n')}` };
      lines = new Set();
      targetsNT = [];
      size = 0;
      return batch;
    };
    for (const { node, shapes } of focus.values()) {
      const term = nt.term(node);
      for (const shape of shapes) targetsNT.push(`<${shape}> <${SH}targetNode> ${term} .`);
      for (const q of bySubject.get(key(node)) ?? []) {
        for (const x of [q, ...(q.object.termType === 'Literal' ? [] : typesOf(q.object as Term))]) {
          const line = nt(x);
          if (!lines.has(line)) (lines.add(line), (size += line.length));
        }
      }
      if (size >= batchChars) yield flush();
    }
    if (targetsNT.length) yield flush();
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
 * Writes quads as N-Triples lines for validation. Unlike writeNTriples it
 * keeps the data's own blank node labels where it can (_:alice stays
 * _:alice), so results name them, renaming those N-Triples can't write. With
 * `blankPrefix`, blank nodes are written as IRIs with that prefix instead, so
 * that shapes can name them.
 */
function ntWriter(blankPrefix?: string) {
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
  const term = (x: Term) =>
    x.termType === 'BlankNode' ? (blankPrefix ? `<${blankPrefix}${label(x.value)}>` : `_:${label(x.value)}`) : x.termType === 'NamedNode' ? `<${x.value}>` : literalToNT(x as never);
  return Object.assign((q: Quad) => `${term(q.subject as Term)} ${term(q.predicate as Term)} ${term(q.object as Term)} .`, { term });
}

/** N-Triples for validation, in linear time (see ntWriter). */
function toNTriples(quads: Quad[]): string {
  return quads.map(ntWriter()).join('\n');
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
