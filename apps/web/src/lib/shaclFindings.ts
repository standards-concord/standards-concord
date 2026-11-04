/**
 * Turns sparq's SHACL validation results into sentences a person can act on,
 * written with the prefixes from their own data, and finds where in their
 * Turtle each problem is (see turtleDoc.ts), so the editor can underline it.
 */
import { RDF, RDF_TYPE, XSD, termKey, type Placed, type RdfTerm, type Span, type TurtleDoc } from './turtleDoc';

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

/** A piece of a sentence: plain words, or a term shown as code. */
export type Part = string | { code: string };

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

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

const countWord = (n: number) => (n === 1 ? 'one' : String(n));

/** What kind of value a literal is, in words, for "is of type …". */
function literalType(t: RdfTerm): string | undefined {
  if (t.kind !== 'literal') return undefined;
  if (t.lang) return `${RDF}langString`;
  return t.datatype ?? `${XSD}string`;
}

const INTEGER_TYPES = new Set(['integer', 'nonNegativeInteger', 'positiveInteger', 'nonPositiveInteger', 'negativeInteger', 'int', 'long', 'short', 'byte', 'unsignedInt', 'unsignedLong', 'unsignedShort', 'unsignedByte']);

/** Whether a lexical form is plausibly right for a datatype, so suggesting it with that datatype is a real fix. */
function fitsDatatype(lexical: string, datatype: string): boolean {
  if (!datatype.startsWith(XSD)) return false;
  const local = datatype.slice(XSD.length);
  if (INTEGER_TYPES.has(local)) {
    if (!/^[+-]?\d+$/.test(lexical)) return false;
    const n = Number(lexical);
    if (local === 'nonNegativeInteger' || local.startsWith('unsigned')) return n >= 0;
    if (local === 'positiveInteger') return n > 0;
    if (local === 'nonPositiveInteger') return n <= 0;
    if (local === 'negativeInteger') return n < 0;
    return true;
  }
  if (local === 'decimal') return /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(lexical);
  if (local === 'double' || local === 'float') return /^[+-]?((\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?|INF|NaN)$/.test(lexical) || lexical === '-INF';
  if (local === 'boolean') return /^(true|false|1|0)$/.test(lexical);
  if (local === 'date') return /^-?\d{4,}-\d{2}-\d{2}(Z|[+-]\d{2}:\d{2})?$/.test(lexical);
  if (local === 'dateTime') return /^-?\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(lexical);
  if (local === 'string') return true;
  return false;
}

/** Number words people write for small numbers, so "sixteen" can be suggested as 16. */
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

export interface DescribeContext {
  doc: TurtleDoc;
  text: string;
  prefixes: [string, string][];
}

/** Indexes the document's triples for the lookups below. */
function indexDoc(doc: TurtleDoc) {
  const bySubject = new Map<string, typeof doc.triples>();
  for (const t of doc.triples) {
    const k = termKey(t.s.term);
    const list = bySubject.get(k);
    if (list) list.push(t);
    else bySubject.set(k, [t]);
  }
  return bySubject;
}

/**
 * Finds a node from the report in the document. Named nodes match by IRI.
 * Blank nodes have labels only sparq knows, so they match when exactly one
 * blank node in the document has the reported path and value.
 */
function findSubject(term: RdfTerm, path: RdfTerm | undefined, value: RdfTerm | undefined, doc: TurtleDoc, bySubject: Map<string, TurtleDoc['triples']>): string | undefined {
  if (term.kind !== 'blank') return bySubject.has(termKey(term)) ? termKey(term) : undefined;
  if (!path || path.kind !== 'iri') return undefined;
  const candidates = new Set<string>();
  for (const t of doc.triples) {
    if (t.s.term.kind !== 'blank' || t.p.term.value !== path.value) continue;
    if (value && termKey(t.o.term) !== termKey(value)) continue;
    candidates.add(termKey(t.s.term));
  }
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

export function describeFinding(raw: RawFinding, ctx: DescribeContext, bySubject = indexDoc(ctx.doc)): Finding {
  const { prefixes, doc, text } = ctx;
  const focus = parseNtTerm(raw.focusNode);
  const path = parseNtTerm(raw.path);
  const value = parseNtTerm(raw.value);
  const component = (raw.sourceConstraintComponent ?? '').replace(SH, '').replace(/ConstraintComponent$/, '');
  const message = raw.message ?? '';
  const fmt = (t: RdfTerm) => ({ code: formatTerm(t, prefixes) });
  const iri = (s: string) => ({ code: shortIri(s, prefixes) });
  const focusCode = focus ? formatTerm(focus, prefixes) : undefined;
  const pathCode = path ? formatTerm(path, prefixes) : raw.path ? shortenMessage(raw.path, prefixes) : undefined;
  const pathPart = pathCode ? { code: pathCode } : 'a value';
  const focusPart: Part = focus ? fmt(focus) : 'A record';

  // Where it is.
  const subjectKey = focus ? findSubject(focus, path, value, doc, bySubject) : undefined;
  const own = subjectKey ? (bySubject.get(subjectKey) ?? []) : [];
  const withPath = path?.kind === 'iri' ? own.filter((t) => t.p.term.value === path.value) : [];
  const withValue = value ? withPath.filter((t) => termKey(t.o.term) === termKey(value)) : [];
  const subjectSpan: Placed | undefined = own[0]?.s;
  let ranges: Span[] = [];
  if (withValue.length) ranges = withValue.map((t) => ({ from: t.o.from, to: t.o.to }));
  else if (value && withPath.length === 0 && subjectSpan) ranges = [subjectSpan];
  else if (component === 'MaxCount' && withPath.length) ranges = withPath.map((t) => ({ from: t.p.from, to: t.o.to }));
  else if (subjectSpan) ranges = [{ from: subjectSpan.from, to: subjectSpan.to }];
  // A [ … ] subject can be long: underline just its opening bracket.
  ranges = ranges.map((r) => (focus?.kind === 'blank' && subjectSpan && r.from === subjectSpan.from && r.to === subjectSpan.to ? { from: r.from, to: r.from + 1 } : r));

  let parts: Part[];
  let hint: Part[] | undefined;
  const found = subjectKey ? withPath.length : undefined;
  const foundText = found === undefined ? '' : `, ${found} found`;
  const expected = /<([^<>\s]+)>/.exec(message)?.[1];

  switch (component) {
    case 'MinCount': {
      const n = Number(/(\d+)/.exec(message)?.[1] ?? 1);
      parts = [focusPart, ` requires at least ${countWord(n)} `, pathPart, foundText];
      break;
    }
    case 'MaxCount': {
      const n = Number(/(\d+)/.exec(message)?.[1] ?? 1);
      parts = [focusPart, ` allows at most ${countWord(n)} `, pathPart, foundText];
      break;
    }
    case 'Datatype': {
      if (!value || !expected) {
        parts = [shortenMessage(message, prefixes)];
        break;
      }
      const actual = literalType(value);
      if (!actual) {
        parts = ['Value ', fmt(value), ' is a resource, but must be a value of type ', iri(expected)];
        break;
      }
      const shownValue = { code: value.lang ? `${quote(value.value)}@${value.lang}` : quote(value.value) };
      if (actual === expected) parts = ['Value ', shownValue, ' isn’t a valid ', iri(expected)];
      else parts = ['Value ', shownValue, ' is of type ', iri(actual), ' but must be of type ', iri(expected)];
      const word = NUMBER_WORDS.indexOf(value.value.trim().toLowerCase());
      const lexical = word >= 0 ? String(word) : value.value;
      if (fitsDatatype(lexical, expected)) {
        const fixed = expected === `${XSD}string` ? quote(lexical) : `${quote(lexical)}^^${shortIri(expected, prefixes)}`;
        hint = ['Write it as ', { code: fixed }];
      }
      break;
    }
    case 'Class': {
      if (!value || !expected) {
        parts = [shortenMessage(message, prefixes)];
        break;
      }
      if (value.kind === 'literal') {
        parts = ['Value ', fmt(value), ' is a literal, but must be a ', iri(expected)];
        break;
      }
      const valueKey = findSubject(value, undefined, undefined, doc, bySubject);
      const types = valueKey ? (bySubject.get(valueKey) ?? []).filter((t) => t.p.term.value === RDF_TYPE).map((t) => t.o.term) : [];
      if (!types.length) parts = ['Value ', fmt(value), ' has no type, but must be of type ', iri(expected)];
      else {
        parts = ['Value ', fmt(value), ' is of type '];
        types.forEach((t, k) => {
          if (k) parts.push(k === types.length - 1 ? ' and ' : ', ');
          parts.push(fmt(t));
        });
        parts.push(' but must be of type ', iri(expected));
      }
      if (types.length === 0 && value.kind === 'iri') hint = ['Add ', { code: `${formatTerm(value, prefixes)} a ${shortIri(expected, prefixes)} .` }, ' if that’s what it is'];
      break;
    }
    case 'In':
      parts = value ? ['Value ', fmt(value), ' isn’t one of the allowed values for ', pathPart] : [shortenMessage(message, prefixes)];
      break;
    case 'HasValue':
      parts = [focusPart, ' must have ', pathPart, ' ', { code: shortenMessage(/<[^>]+>|"[^"]*"\S*/.exec(message)?.[0] ?? '', prefixes) || 'the required value' }];
      break;
    case 'Closed':
      parts = [focusPart, ' uses ', pathPart, ', which its shape doesn’t allow'];
      break;
    default: {
      const said = shortenMessage(message, prefixes) || 'Doesn’t meet a rule from the ontology';
      parts = value ? ['Value ', fmt(value), `: ${said.replace(/^Value /, '').replace(/^./, (c) => c.toLowerCase())}`] : [said];
    }
  }
  const textOf = (ps: Part[]) => ps.map((p) => (typeof p === 'string' ? p : p.code)).join('');
  const sentence = textOf(parts);
  const at = ranges[0] ? { ...ranges[0], line: lineOf(text, ranges[0].from) } : undefined;
  return {
    severity: severityOf(raw.severity),
    focus: focusCode,
    path: pathCode,
    parts,
    text: hint ? `${sentence}. ${textOf(hint)}.` : sentence,
    hint,
    at,
    ranges,
  };
}

/** Describes every result, in document order (unlocated ones last, in report order). */
export function describeFindings(raws: RawFinding[], ctx: DescribeContext): Finding[] {
  const bySubject = indexDoc(ctx.doc);
  const out = raws.map((r) => describeFinding(r, ctx, bySubject));
  return out
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (a.f.at?.from ?? Infinity) - (b.f.at?.from ?? Infinity) || a.i - b.i)
    .map(({ f }) => f);
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length];
}

export interface TermWarning extends Span {
  message: string;
}

/**
 * Terms written in the ontology's namespace that the ontology doesn't define,
 * which are almost always typos ("vol:titel"). Suggests the closest term.
 */
export function unknownTerms(doc: TurtleDoc, namespace: string, known: Iterable<string>, prefixes: [string, string][]): TermWarning[] {
  if (!namespace) return [];
  const knownSet = new Set(known);
  const locals = [...knownSet].filter((k) => k.startsWith(namespace)).map((k) => k.slice(namespace.length));
  const out: TermWarning[] = [];
  for (const p of doc.iris) {
    const v = p.term.value;
    if (!v.startsWith(namespace) || v === namespace || knownSet.has(v)) continue;
    const local = v.slice(namespace.length);
    let best: string | undefined;
    let bestD = Infinity;
    for (const k of locals) {
      const dist = editDistance(local, k);
      if (dist < bestD) {
        bestD = dist;
        best = k;
      }
    }
    const shown = shortIri(v, prefixes);
    const suggestion = best !== undefined && bestD <= Math.max(2, Math.floor(local.length / 4)) ? ` Did you mean ${shortIri(namespace + best, prefixes)}?` : '';
    out.push({ from: p.from, to: p.to, message: `${shown} isn’t defined in this ontology.${suggestion}` });
  }
  return out;
}

/** sparq reports syntax errors at a UTF-8 byte offset; the editor counts UTF-16 characters. */
export function byteToCharOffset(text: string, byte: number): number {
  const enc = new TextEncoder();
  let bytes = 0;
  let i = 0;
  while (i < text.length && bytes < byte) {
    const cp = text.codePointAt(i)!;
    bytes += enc.encode(String.fromCodePoint(cp)).length;
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
