/**
 * Turns sparq's SHACL validation results into sentences a person can act on,
 * written with the prefixes from their own data, and finds where in their
 * Turtle each problem is (see turtleDoc.ts), so the editor can underline it.
 */
import { RDF, RDF_TYPE, XSD, parseTurtle, termKey, type Placed, type RdfTerm, type Span, type TurtleDoc } from './turtleDoc';

const SH = 'http://www.w3.org/ns/shacl#';

/** One result as sparq reports it: terms in N-Triples syntax. */
export interface RawFinding {
  focusNode?: string | null;
  path?: string | null;
  value?: string | null;
  severity?: string | null;
  sourceConstraintComponent?: string | null;
  message?: string | null;
}

/** A piece of a sentence: plain words, a term shown as code, or a number shown in bold. */
export type Part = string | { code: string } | { strong: string };

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  severity: Severity;
  /** The focus node and path, as code, for the line above the sentence. */
  focus?: string;
  path?: string;
  /** The sentence, in parts (for display) and as plain text (for the editor's hover popup). */
  parts: Part[];
  text: string;
  /** An example of a fix, when there's an obvious one. */
  hint?: Part[];
  /** Where it is in the data: the main place (for jumping), and every place to underline. */
  at?: Span & { line: number };
  ranges: Span[];
  /** Why there's no place to point to, when there isn't one. */
  unlocated?: string;
}

const COMMON_PREFIXES: Record<string, string> = {
  rdf: RDF,
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  xsd: XSD,
  owl: 'http://www.w3.org/2002/07/owl#',
  skos: 'http://www.w3.org/2004/02/skos/core#',
  sh: SH,
};

/**
 * The prefixes to write terms with: the data's own first (that's how the
 * person wrote them), then the ontology's, then the usual vocabularies.
 */
export function displayPrefixes(doc: Pick<TurtleDoc, 'prefixes'>, ontology: Record<string, string> = {}): [string, string][] {
  const out: [string, string][] = [];
  const seenPrefix = new Set<string>();
  const add = (p: string, ns: string) => {
    if (seenPrefix.has(p) || !ns) return;
    seenPrefix.add(p);
    out.push([p, ns]);
  };
  for (const [p, ns] of doc.prefixes) add(p, ns);
  for (const [p, ns] of Object.entries(ontology)) add(p, ns);
  for (const [p, ns] of Object.entries(COMMON_PREFIXES)) add(p, ns);
  return out;
}

const LOCAL_RE = /^(?:[\p{L}\p{N}_]|[\p{L}\p{N}_][\p{L}\p{N}_.-]*[\p{L}\p{N}_-])?$/u;

/** An IRI as a prefixed name when one fits (longest namespace wins), else in <…>. */
export function shortIri(iri: string, prefixes: [string, string][]): string {
  let best: string | undefined;
  let bestLen = -1;
  for (const [p, ns] of prefixes) {
    if (ns.length > bestLen && iri.startsWith(ns) && LOCAL_RE.test(iri.slice(ns.length))) {
      best = `${p}:${iri.slice(ns.length)}`;
      bestLen = ns.length;
    }
  }
  return best ?? `<${iri}>`;
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}

/** A term the way it would be written in Turtle, with the given prefixes. */
export function formatTerm(t: RdfTerm, prefixes: [string, string][]): string {
  if (t.kind === 'iri') return shortIri(t.value, prefixes);
  if (t.kind === 'blank') return '[ ]';
  if (t.lang) return `${quote(t.value)}@${t.lang}`;
  if (!t.datatype || t.datatype === `${XSD}string`) return quote(t.value);
  // Turtle's own shorthand, which means exactly the same: 3, 2.5, true.
  if (t.datatype === `${XSD}integer` && /^[+-]?\d+$/.test(t.value)) return t.value;
  if (t.datatype === `${XSD}decimal` && /^[+-]?\d*\.\d+$/.test(t.value)) return t.value;
  if (t.datatype === `${XSD}boolean` && /^(true|false)$/.test(t.value)) return t.value;
  return `${quote(t.value)}^^${shortIri(t.datatype, prefixes)}`;
}

function unescapeNt(s: string): string {
  return s.replace(/\\(?:u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|(.))/g, (_m, a: string, b: string, c: string) => {
    if (a || b) return String.fromCodePoint(parseInt(a ?? b, 16));
    return ({ t: '\t', b: '\b', n: '\n', r: '\r', f: '\f' } as Record<string, string>)[c] ?? c;
  });
}

/** Reads a term from sparq's report (N-Triples syntax). */
export function parseNtTerm(s: string | null | undefined): RdfTerm | undefined {
  if (!s) return undefined;
  if (s.startsWith('<') && s.endsWith('>')) return { kind: 'iri', value: s.slice(1, -1) };
  if (s.startsWith('_:')) return { kind: 'blank', value: s.slice(2) };
  const m = /^"((?:[^"\\]|\\.)*)"(?:@([A-Za-z0-9-]+)|\^\^<([^>]*)>)?$/s.exec(s);
  if (m) return { kind: 'literal', value: unescapeNt(m[1]), lang: m[2]?.toLowerCase(), datatype: m[2] ? `${RDF}langString` : (m[3] ?? `${XSD}string`) };
  // Some engines report bare IRIs.
  if (/^[a-z][a-z0-9+.-]*:\S+$/i.test(s)) return { kind: 'iri', value: s };
  return undefined;
}

/** IRIs in <…> inside a message, written with prefixes. */
function shortenMessage(message: string, prefixes: [string, string][]): string {
  return message.replace(/<([^<>\s]+)>/g, (_m, iri: string) => shortIri(iri, prefixes));
}

function severityOf(s: string | null | undefined): Severity {
  if (s === `${SH}Warning`) return 'warning';
  if (s === `${SH}Info`) return 'info';
  return 'error';
}

/** Line numbers by binary search over line starts, so locating many findings stays fast. */
export function lineFinder(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** What type a literal has, for "is of type …". */
function literalType(t: RdfTerm): string | undefined {
  if (t.kind !== 'literal') return undefined;
  if (t.lang) return `${RDF}langString`;
  return t.datatype ?? `${XSD}string`;
}

/** Inclusive bounds of XSD's bounded integer types. */
const INTEGER_BOUNDS: Record<string, [bigint | null, bigint | null]> = {
  integer: [null, null],
  nonNegativeInteger: [0n, null],
  positiveInteger: [1n, null],
  nonPositiveInteger: [null, 0n],
  negativeInteger: [null, -1n],
  long: [-(2n ** 63n), 2n ** 63n - 1n],
  int: [-(2n ** 31n), 2n ** 31n - 1n],
  short: [-32768n, 32767n],
  byte: [-128n, 127n],
  unsignedLong: [0n, 2n ** 64n - 1n],
  unsignedInt: [0n, 2n ** 32n - 1n],
  unsignedShort: [0n, 65535n],
  unsignedByte: [0n, 255n],
};

const NUMERIC_TYPES = new Set([...Object.keys(INTEGER_BOUNDS), 'decimal', 'double', 'float']);

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return d <= days;
}

/**
 * Whether a lexical form is valid for an XSD datatype, so suggesting it with
 * that datatype is a real fix. Types it doesn't know get no suggestion.
 */
export function fitsDatatype(lexical: string, datatype: string): boolean {
  if (!datatype.startsWith(XSD)) return false;
  const local = datatype.slice(XSD.length);
  const bounds = INTEGER_BOUNDS[local];
  if (bounds) {
    if (!/^[+-]?\d+$/.test(lexical)) return false;
    const n = BigInt(lexical);
    return (bounds[0] === null || n >= bounds[0]) && (bounds[1] === null || n <= bounds[1]);
  }
  if (local === 'decimal') return /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(lexical);
  if (local === 'double' || local === 'float') return /^([+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?|[+-]?INF|NaN)$/.test(lexical);
  if (local === 'boolean') return /^(true|false|1|0)$/.test(lexical);
  const date = /^(-?\d{4,})-(\d{2})-(\d{2})/.exec(lexical);
  const zone = '(Z|[+-](0\\d|1[0-3]):[0-5]\\d|[+-]14:00)?';
  if (local === 'date') return !!date && new RegExp(`^-?\\d{4,}-\\d{2}-\\d{2}${zone}$`).test(lexical) && validDate(+date[1], +date[2], +date[3]);
  if (local === 'dateTime')
    return !!date && new RegExp(`^-?\\d{4,}-\\d{2}-\\d{2}T([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(\\.\\d+)?${zone}$`).test(lexical) && validDate(+date[1], +date[2], +date[3]);
  if (local === 'string') return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(lexical);
  return false;
}

/** Number words people write for small numbers, so "sixteen" can be suggested as 16 for a number type. */
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

/* ------------------------------------------------------------- Shapes */

/** One shape in the shapes graph: its parameters, read from the shapes Turtle. */
interface ShapeInfo {
  key: string;
  path?: string;
  params: Map<string, RdfTerm[]>;
}

/**
 * The shapes, read so findings can quote the real constraint (sh:minCount 2,
 * sh:datatype xsd:date, the members of an sh:or) instead of mining numbers or
 * IRIs out of a message, which may be the shape author's own wording.
 * sparq reports a source shape by a blank-node label only it knows, so a
 * finding is matched to property shapes by path and constraint; when those
 * disagree, the parameter counts as unknown.
 */
export class ShapesIndex {
  private readonly shapes = new Map<string, ShapeInfo>();
  private readonly byPath = new Map<string, ShapeInfo[]>();
  private readonly lists = new Map<string, RdfTerm[]>();
  /** Every sh:message text in the shapes. */
  readonly messages = new Set<string>();

  constructor(shapesTurtle: string | undefined) {
    if (!shapesTurtle) return;
    const doc = parseTurtle(shapesTurtle);
    const first = new Map<string, RdfTerm>();
    const rest = new Map<string, string>();
    for (const t of doc.triples) {
      const key = termKey(t.s.term);
      const p = t.p.term.value;
      if (p === `${SH}message` && t.o.term.kind === 'literal') this.messages.add(t.o.term.value.trim());
      if (p === `${RDF}first`) first.set(key, t.o.term);
      else if (p === `${RDF}rest`) rest.set(key, termKey(t.o.term));
      let shape = this.shapes.get(key);
      if (!shape) {
        shape = { key, params: new Map() };
        this.shapes.set(key, shape);
      }
      const list = shape.params.get(p);
      if (list) list.push(t.o.term);
      else shape.params.set(p, [t.o.term]);
      if (p === `${SH}path` && t.o.term.kind === 'iri') {
        shape.path = t.o.term.value;
        const byPath = this.byPath.get(shape.path);
        if (byPath) byPath.push(shape);
        else this.byPath.set(shape.path, [shape]);
      }
    }
    for (const head of first.keys()) {
      const items: RdfTerm[] = [];
      let at: string | undefined = head;
      for (let guard = 0; at && first.has(at) && guard < 1000; guard++) {
        items.push(first.get(at)!);
        at = rest.get(at);
      }
      this.lists.set(head, items);
    }
  }

  shape(t: RdfTerm): ShapeInfo | undefined {
    return this.shapes.get(termKey(t));
  }

  list(t: RdfTerm): RdfTerm[] {
    return this.lists.get(termKey(t)) ?? [];
  }

  /** The property shapes on `path` that use `param`. */
  candidates(path: string | undefined, param: string): ShapeInfo[] {
    if (!path) return [];
    return (this.byPath.get(path) ?? []).filter((s) => s.params.has(param));
  }

  /** The one value every matching shape agrees on for `param`, if they agree. */
  agreed(path: string | undefined, param: string): RdfTerm | undefined {
    const values = new Set<string>();
    let found: RdfTerm | undefined;
    for (const s of this.candidates(path, param)) {
      for (const v of s.params.get(param)!) {
        values.add(termKey(v));
        found = v;
      }
    }
    return values.size === 1 ? found : undefined;
  }
}

/**
 * sparq's own message for each constraint, in full. A message that doesn't
 * match its component's template exactly, or that a shape declares as its
 * sh:message, is the shape author's: it's shown as written and never mined
 * for numbers or IRIs.
 */
const ENGINE_TEMPLATES: Record<string, RegExp> = {
  MinCount: /^Fewer than \d+ values$/,
  MaxCount: /^More than \d+ values$/,
  Datatype: /^Value does not have datatype <[^<>\s]+>$/,
  Class: /^Value does not have class <[^<>\s]+>$/,
  In: /^Value is not in the enumeration$/,
  Or: /^Value does not conform to any member shape$/,
  And: /^Value does not conform to every member shape$/,
  Node: /^Value does not conform to the node shape$/,
  Not: /^Value conforms to the negated shape$/,
};

/* ------------------------------------------------------------- Findings */

export interface DescribeContext {
  doc: TurtleDoc;
  text: string;
  prefixes: [string, string][];
  shapes?: ShapesIndex;
  /**
   * Subjects (term keys) the ontology describes too. sparq checks the
   * ontology and the data together, so for these the data alone doesn't say
   * how many values there are, or which one was meant.
   */
  external?: Set<string>;
}

/** Indexes the document's triples by subject. */
function indexDoc(doc: TurtleDoc) {
  const bySubject = new Map<string, TurtleDoc['triples']>();
  for (const t of doc.triples) {
    const k = termKey(t.s.term);
    const list = bySubject.get(k);
    if (list) list.push(t);
    else bySubject.set(k, [t]);
  }
  return bySubject;
}

const textOf = (ps: Part[]) => ps.map((p) => (typeof p === 'string' ? p : 'code' in p ? p.code : p.strong)).join('');

/** Shape properties that say nothing about the value, so an alternative can still be described fully without them. */
const DESCRIPTIVE = new Set([`${RDF}type`, `${SH}name`, `${SH}description`, `${SH}message`, `${SH}severity`, `${SH}order`, `${SH}group`, `${SH}codeIdentifier`, 'http://www.w3.org/2000/01/rdf-schema#label', 'http://www.w3.org/2000/01/rdf-schema#comment']);

/**
 * One alternative of sh:or / sh:xone / sh:and in words, with every constraint
 * it has ("a xsd:integer value of at least 10"). Returns undefined if the
 * shape has anything it can't put into words, so a sentence never leaves a
 * requirement out.
 */
function describeAlternative(t: RdfTerm, shapes: ShapesIndex, prefixes: [string, string][]): Part[] | undefined {
  const shape = shapes.shape(t);
  if (!shape) return undefined;
  const one = (p: string) => {
    const v = shape.params.get(`${SH}${p}`);
    return v && v.length === 1 ? v[0] : undefined;
  };
  for (const [p, vs] of shape.params) {
    if (DESCRIPTIVE.has(p)) continue;
    const known = ['class', 'datatype', 'nodeKind', 'minInclusive', 'maxInclusive', 'minExclusive', 'maxExclusive', 'minLength', 'maxLength', 'pattern', 'hasValue'].map((k) => `${SH}${k}`);
    if (!known.includes(p) || vs.length !== 1) return undefined;
  }
  if (shape.params.has(`${SH}flags`)) return undefined;
  const lit = (v: RdfTerm | undefined) => (v?.kind === 'literal' ? v.value : undefined);
  const out: Part[] = [];
  const cls = one('class');
  const dt = one('datatype');
  const kind = one('nodeKind');
  if (cls?.kind === 'iri') out.push('a ', { code: shortIri(cls.value, prefixes) });
  else if (dt?.kind === 'iri') out.push('a ', { code: shortIri(dt.value, prefixes) }, ' value');
  else if (kind?.kind === 'iri') {
    const words: Record<string, string> = { IRI: 'an IRI', Literal: 'a literal', BlankNode: 'a blank node', BlankNodeOrIRI: 'an IRI or blank node', BlankNodeOrLiteral: 'a blank node or literal', IRIOrLiteral: 'an IRI or literal' };
    const w = words[kind.value.replace(SH, '')];
    if (!w) return undefined;
    out.push(w);
  } else out.push('a value');
  if (cls && kind) return undefined;
  const quals: Part[][] = [];
  const bound = (p: string, words: string) => {
    const v = one(p);
    if (v) quals.push([`${words} `, { code: formatTerm(v, prefixes) }]);
  };
  bound('minInclusive', 'of at least');
  bound('minExclusive', 'above');
  bound('maxInclusive', 'of at most');
  bound('maxExclusive', 'below');
  if (lit(one('minLength'))) quals.push([`at least ${lit(one('minLength'))} characters long`]);
  if (lit(one('maxLength'))) quals.push([`at most ${lit(one('maxLength'))} characters long`]);
  if (lit(one('pattern'))) quals.push(['matching the pattern ', { code: `/${lit(one('pattern'))}/` }]);
  const hv = one('hasValue');
  if (hv) quals.push(['equal to ', { code: formatTerm(hv, prefixes) }]);
  quals.forEach((q, k) => out.push(k ? ' and ' : ' ', ...q));
  return out;
}

function joinAlternatives(alts: Part[][], word: string): Part[] {
  const out: Part[] = [];
  alts.forEach((a, k) => {
    if (k) out.push(k === alts.length - 1 ? ` ${word} ` : ', ');
    out.push(...a);
  });
  return out;
}

export function describeFinding(raw: RawFinding, ctx: DescribeContext, bySubject = indexDoc(ctx.doc), lineOf = lineFinder(ctx.text)): Finding {
  const { prefixes } = ctx;
  const shapes = ctx.shapes ?? new ShapesIndex(undefined);
  const focus = parseNtTerm(raw.focusNode);
  const path = parseNtTerm(raw.path);
  const value = parseNtTerm(raw.value);
  const pathIri = path?.kind === 'iri' ? path.value : undefined;
  const component = (raw.sourceConstraintComponent ?? '').replace(SH, '').replace(/ConstraintComponent$/, '');
  const message = (raw.message ?? '').trim();
  const template = ENGINE_TEMPLATES[component];
  const custom = message && (shapes.messages.has(message) || (template && !template.test(message))) ? message : undefined;
  const fmt = (t: RdfTerm) => ({ code: formatTerm(t, prefixes) });
  const iri = (s: string) => ({ code: shortIri(s, prefixes) });
  const focusCode = focus ? formatTerm(focus, prefixes) : undefined;
  const pathCode = path ? formatTerm(path, prefixes) : raw.path ? shortenMessage(raw.path, prefixes) : undefined;
  const pathPart: Part = pathCode ? { code: pathCode } : 'a value';
  const focusPart: Part = focus?.kind === 'blank' ? 'A blank node' : focus ? fmt(focus) : 'A record';
  const valuePart: Part = value?.kind === 'blank' ? 'a blank node' : value ? fmt(value) : 'the value';

  // Where it is. sparq labels anonymous nodes ([ … ], ( … )) itself, so those are never guessed at.
  // A _:label someone wrote is kept by sparq, so it can be matched.
  const findable = (t: RdfTerm | undefined) => !!t && (t.kind !== 'blank' || !/^__ttl_anon_/.test(t.value));
  const focusKey = focus ? termKey(focus) : undefined;
  const shared = !!focusKey && !!ctx.external?.has(focusKey);
  const located = findable(focus) && !shared && bySubject.has(focusKey!);
  const own = located ? bySubject.get(focusKey!)! : [];
  const withPath = pathIri ? own.filter((t) => t.p.term.value === pathIri) : [];
  const distinctObjects = new Map(withPath.map((t) => [termKey(t.o.term), t]));
  let withValue = value && findable(value) ? withPath.filter((t) => termKey(t.o.term) === termKey(value)) : [];
  // An anonymous value can still be placed when it's the record's only value for that property.
  if (value?.kind === 'blank' && !withValue.length && distinctObjects.size === 1) {
    const only = [...distinctObjects.values()][0];
    if (only.o.term.kind === 'blank') withValue = withPath.filter((t) => t.o.term === only.o.term || termKey(t.o.term) === termKey(only.o.term));
  }
  const subjectSpan: Placed | undefined = own[0]?.s;
  let ranges: Span[] = [];
  if (withValue.length) ranges = withValue.map((t) => ({ from: t.o.from, to: t.o.to }));
  else if (component === 'MaxCount' && withPath.length) ranges = withPath.map((t) => ({ from: t.p.from, to: t.o.to }));
  else if (subjectSpan && !value) ranges = [{ from: subjectSpan.from, to: subjectSpan.to }];
  // A [ … ] subject can be long: underline just its opening bracket.
  ranges = ranges.map((r) => (subjectSpan && focus?.kind === 'blank' && r.from === subjectSpan.from && r.to === subjectSpan.to && r.to - r.from > 1 && /^\[/.test(ctx.text.slice(r.from, r.from + 1)) ? { from: r.from, to: r.from + 1 } : r));
  let unlocated: string | undefined;
  if (!ranges.length) {
    if (focus?.kind === 'blank' && !findable(focus)) unlocated = 'This is about an anonymous record (written with [ … ]), which can’t be matched to one place in the text. Giving it a name (like _:b1 or ex:something) lets Concord point to it.';
    else if (value?.kind === 'blank' && !findable(value)) unlocated = 'The value is an anonymous record (written with [ … ]), and this record has more than one, so Concord can’t tell which.';
    else if (shared) unlocated = 'This record is described in the ontology as well as here, so Concord can’t point to one place.';
    else unlocated = 'Concord couldn’t find this in the text.';
  }
  // SHACL counts distinct values, so repeating a triple doesn't count twice.
  const found = located && pathIri ? distinctObjects.size : undefined;
  const foundParts: Part[] = found === undefined ? [] : [', ', { strong: String(found) }, ' found'];

  let parts: Part[];
  let hint: Part[] | undefined;
  const fromShapes = (param: string) => shapes.agreed(pathIri, `${SH}${param}`);
  const engineIri = custom ? undefined : /<([^<>\s]+)>/.exec(message)?.[1];
  const engineNumber = custom ? undefined : /^(?:Fewer|More) than (\d+) values$/.exec(message)?.[1];
  const fallback = (): Part[] => (custom ? [custom] : value ? ['Value ', valuePart, `: ${shortenMessage(message, prefixes).replace(/^Value /, '')}`] : [shortenMessage(message, prefixes) || 'Doesn’t meet a rule from the ontology']);

  switch (component) {
    case 'MinCount':
    case 'MaxCount': {
      const param = fromShapes(component === 'MinCount' ? 'minCount' : 'maxCount');
      const n = param?.kind === 'literal' ? param.value : engineNumber;
      if (n === undefined) parts = [focusPart, ' has ', ...(found === undefined ? ['the wrong number of '] : [{ strong: String(found) }, ' ']), pathPart];
      else parts = [focusPart, component === 'MinCount' ? ' requires at least ' : ' allows at most ', { strong: n }, ' ', pathPart, ...foundParts];
      break;
    }
    case 'Datatype': {
      const param = fromShapes('datatype');
      const expected = param?.kind === 'iri' ? param.value : engineIri;
      if (!value || !expected) {
        parts = fallback();
        break;
      }
      const actual = literalType(value);
      if (!actual) {
        parts = ['Value ', valuePart, ' is a resource, but must be a value of type ', iri(expected)];
        break;
      }
      const shownValue = { code: value.lang ? `${quote(value.value)}@${value.lang}` : quote(value.value) };
      if (actual === expected) parts = ['Value ', shownValue, ' isn’t a valid ', iri(expected)];
      else parts = ['Value ', shownValue, ' is of type ', iri(actual), ' but must be of type ', iri(expected)];
      // "sixteen" → 16, but only for a number type and plain text (never change "one"@en into 1).
      const word = NUMBER_WORDS.indexOf(value.value.trim().toLowerCase());
      const numeric = expected.startsWith(XSD) && NUMERIC_TYPES.has(expected.slice(XSD.length));
      const lexical = numeric && !value.lang && word >= 0 ? String(word) : value.value;
      if (fitsDatatype(lexical, expected) && !(actual === expected && lexical === value.value)) {
        const fixed = expected === `${XSD}string` ? quote(lexical) : `${quote(lexical)}^^${shortIri(expected, prefixes)}`;
        hint = ['Write it as ', { code: fixed }];
      }
      break;
    }
    case 'Class': {
      const param = fromShapes('class');
      const expected = param?.kind === 'iri' ? param.value : engineIri;
      if (!value || !expected) {
        parts = fallback();
        break;
      }
      if (value.kind === 'literal') {
        parts = ['Value ', valuePart, ' is a literal, but must be a ', iri(expected)];
        break;
      }
      if (value.kind === 'blank') {
        parts = ['The value (a blank node) must be of type ', iri(expected)];
        break;
      }
      const types = (bySubject.get(termKey(value)) ?? []).filter((t) => t.p.term.value === RDF_TYPE).map((t) => t.o.term);
      const distinct = [...new Map(types.map((t) => [termKey(t), t])).values()];
      if (!distinct.length) {
        parts = ['Value ', valuePart, ' has no type here, but must be of type ', iri(expected)];
        hint = ['Add ', { code: `${formatTerm(value, prefixes)} a ${shortIri(expected, prefixes)} .` }, ' if that’s what it is'];
      } else {
        parts = ['Value ', valuePart, ' is of type ', ...joinAlternatives(distinct.map((t) => [fmt(t)]), 'and'), ' but must be of type ', iri(expected)];
      }
      break;
    }
    case 'In':
      parts = value ? ['Value ', valuePart, ' isn’t one of the allowed values for ', pathPart] : fallback();
      break;
    case 'Closed':
      parts = [focusPart, ' uses ', pathPart, ', which its shape doesn’t allow'];
      break;
    case 'Or':
    case 'Xone':
    case 'And': {
      const param = `${SH}${component.toLowerCase()}`;
      const shape = shapes.candidates(pathIri, param);
      const members = shape.length === 1 ? shapes.list(shape[0].params.get(param)![0]) : [];
      const alts = members.map((m) => describeAlternative(m, shapes, prefixes));
      if (alts.length && alts.every((a) => a)) {
        const lead = component === 'Or' ? ' must be ' : component === 'Xone' ? ' must be exactly one of: ' : ' must be all of: ';
        parts = ['Value ', valuePart, lead, ...joinAlternatives(alts as Part[][], component === 'And' ? 'and' : 'or')];
      } else parts = ['Value ', valuePart, component === 'Or' ? ' doesn’t match any of the allowed kinds of value' : component === 'Xone' ? ' must match exactly one of the allowed kinds of value' : ' doesn’t meet every rule for this property'];
      break;
    }
    case 'Node': {
      // A shape's target says which records it checks, not what a value must be, so it's never named as a requirement.
      const shape = shapes.candidates(pathIri, `${SH}node`);
      const node = shape.length === 1 && shape[0].params.get(`${SH}node`)!.length === 1 ? shape[0].params.get(`${SH}node`)![0] : undefined;
      const alt = node ? describeAlternative(node, shapes, prefixes) : undefined;
      if (alt) parts = ['Value ', valuePart, ' must be ', ...alt];
      else if (node?.kind === 'iri') parts = ['Value ', valuePart, ' doesn’t meet the rules in the shape ', iri(node.value)];
      else parts = ['Value ', valuePart, ' doesn’t meet the rules for this property'];
      break;
    }
    case 'Not':
      parts = ['Value ', valuePart, ' matches something this property must not be'];
      break;
    default:
      parts = fallback();
  }
  // The author's own wording always shows, as written.
  const note: Part[] | undefined = custom && !(parts.length === 1 && parts[0] === custom) ? [`“${custom}”`] : undefined;
  if (note) hint = hint ? [...note, ' · ', ...hint] : note;
  const sentence = textOf(parts);
  const at = ranges[0] ? { ...ranges[0], line: lineOf(ranges[0].from) } : undefined;
  return {
    severity: severityOf(raw.severity),
    focus: focusCode && focus?.kind !== 'blank' ? focusCode : undefined,
    path: pathCode,
    parts,
    text: hint ? `${sentence}. ${textOf(hint)}` : sentence,
    hint,
    at,
    ranges,
    unlocated,
  };
}

/** Describes every result, in document order (unlocated ones last, in report order). */
export function describeFindings(raws: RawFinding[], ctx: DescribeContext): Finding[] {
  const bySubject = indexDoc(ctx.doc);
  const lineOf = lineFinder(ctx.text);
  const out = raws.map((r) => describeFinding(r, ctx, bySubject, lineOf));
  return out
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (a.f.at?.from ?? Infinity) - (b.f.at?.from ?? Infinity) || a.i - b.i)
    .map(({ f }) => f);
}

function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    let rowMin = d[0];
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1));
      prev = tmp;
      rowMin = Math.min(rowMin, d[j]);
    }
    if (rowMin > limit) return limit + 1;
  }
  return d[b.length];
}

export interface TermWarning extends Span {
  message: string;
}

/**
 * Terms used as a property, a type (after "a") or a datatype in the
 * ontology's namespace that the ontology doesn't define: almost always typos
 * ("vol:titel"). Names of records (subjects, ordinary values) are the data's
 * own and are never flagged. Each distinct IRI is looked at once.
 */
export function unknownTerms(doc: TurtleDoc, namespace: string, known: Set<string>, prefixes: [string, string][]): TermWarning[] {
  if (!namespace) return [];
  let locals: string[] | undefined;
  const verdicts = new Map<string, string | null>();
  const out: TermWarning[] = [];
  for (const p of doc.iris) {
    if (p.role !== 'predicate' && p.role !== 'type' && p.role !== 'datatype') continue;
    const v = p.term.value;
    if (!v.startsWith(namespace) || v === namespace || known.has(v)) continue;
    let message = verdicts.get(v);
    if (message === undefined) {
      locals ??= [...known].filter((k) => k.startsWith(namespace)).map((k) => k.slice(namespace.length));
      const local = v.slice(namespace.length);
      const limit = Math.max(2, Math.floor(local.length / 4));
      let best: string | undefined;
      let bestD = limit + 1;
      for (const k of locals) {
        const dist = editDistance(local, k, limit);
        if (dist < bestD) {
          bestD = dist;
          best = k;
        }
      }
      const suggestion = best !== undefined ? ` Did you mean ${shortIri(namespace + best, prefixes)}?` : '';
      message = `${shortIri(v, prefixes)} isn’t defined in this ontology.${suggestion}`;
      verdicts.set(v, message);
    }
    if (message) out.push({ from: p.from, to: p.to, message });
  }
  return out;
}

/** sparq reports syntax errors at a UTF-8 byte offset; the editor counts UTF-16 characters. */
export function byteToCharOffset(text: string, byte: number): number {
  let bytes = 0;
  let i = 0;
  while (i < text.length && bytes < byte) {
    const cp = text.codePointAt(i)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    i += cp > 0xffff ? 2 : 1;
  }
  return i;
}

/** "Turtle: expected '.' at byte 54" → the message and offset, relative to the start of `text`. */
export function parseSyntaxError(message: string, text: string, headerBytes = 0): { message: string; from: number } | undefined {
  const m = /^(?:Turtle:\s*)?(.*?)\s+at byte (\d+)/s.exec(message);
  if (!m) return undefined;
  const byte = Number(m[2]) - headerBytes;
  if (byte < 0) return undefined;
  return { message: m[1].replace(/^./, (c) => c.toUpperCase()), from: byteToCharOffset(text, byte) };
}
