/**
 * A small Turtle reader that remembers where everything is. sparq parses and
 * validates the data, but its report only names terms; this finds those terms
 * in the text the person typed, so a problem can be underlined in the editor
 * and jumped to. It also lists the document's prefixes (so problems read with
 * the person's own prefixes) and tidies the layout without losing comments.
 *
 * It follows the Turtle grammar closely enough to find triples, and stops at
 * the first thing it doesn't understand. sparq stays the judge of what's
 * valid: this never decides that data is fine, only where things are.
 *
 * Everything here runs in time linear in the document (sticky regexes, no
 * re-slicing), because it runs as the person types.
 */

export interface Span {
  from: number;
  to: number;
}

export interface RdfTerm {
  kind: 'iri' | 'blank' | 'literal';
  /** The IRI, the blank node's label, or the literal's lexical form. */
  value: string;
  datatype?: string;
  lang?: string;
}

export interface Placed extends Span {
  term: RdfTerm;
}

export interface PlacedTriple {
  s: Placed;
  p: Placed;
  o: Placed;
}

/** Where an IRI was written: vocabulary positions are where typos in term names matter. */
export type IriRole = 'subject' | 'predicate' | 'type' | 'object' | 'datatype' | 'directive';

export interface PlacedIri extends Placed {
  role: IriRole;
}

export interface TurtleDoc {
  /** Prefixes the document declares, in the order it declares them. */
  prefixes: Map<string, string>;
  triples: PlacedTriple[];
  /** Every IRI written in the document (full or prefixed), where and in what role. */
  iris: PlacedIri[];
  /** The first thing that couldn't be read; triples before it are still listed. */
  error?: Span & { message: string };
}

export const XSD = 'http://www.w3.org/2001/XMLSchema#';
export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const RDF_TYPE = `${RDF}type`;

type TokType = 'iri' | 'pname' | 'blank' | 'string' | 'lang' | 'hats' | 'number' | 'bool' | 'a' | 'prefix' | 'base' | 'punct' | 'comment' | 'error';

export interface Token extends Span {
  type: TokType;
  text: string;
  /** Strings: the unescaped lexical form. IRIs: the unescaped IRI. Numbers: the datatype. Errors: the message. */
  value?: string;
  /** PREFIX / BASE (SPARQL style, no closing '.'). */
  sparqlStyle?: boolean;
}

// Character classes from the Turtle grammar (PN_CHARS_BASE etc.), including the supplementary planes.
const PN_CHARS_BASE = String.raw`A-Za-zÀ-ÖØ-öø-˿Ͱ-ͽͿ-῿‌-‍⁰-↏Ⰰ-⿯、-퟿豈-﷏ﷰ-�\u{10000}-\u{EFFFF}`;
const PN_CHARS_U = `${PN_CHARS_BASE}_`;
const PN_CHARS = String.raw`${PN_CHARS_U}\-0-9·̀-ͯ‿-⁀`;
const PLX = String.raw`%[0-9A-Fa-f]{2}|\\[_~.\-!$&'()*+,;=/?#@%]`;
const PN_PREFIX = `[${PN_CHARS_BASE}](?:[${PN_CHARS}.]*[${PN_CHARS}])?`;
// The local part may contain dots but not end with one; trailing dots are given back after matching.
const PNAME_RE = new RegExp(`(?:${PN_PREFIX})?:(?:(?:[${PN_CHARS_U}:0-9]|${PLX})(?:[${PN_CHARS}.:]|${PLX})*)?`, 'uy');
const BLANK_RE = new RegExp(`_:[${PN_CHARS_U}0-9](?:[${PN_CHARS}.]*[${PN_CHARS}])?`, 'uy');
const NUMBER_RE = /[+-]?(?:\d+\.?\d*[eE][+-]?\d+|\.\d+[eE][+-]?\d+|\d*\.\d+|\d+)/y;
const LANG_RE = /@[A-Za-z]+(?:-[A-Za-z0-9]+)*/y;
const IRI_RE = /<((?:[^\u0000- <>"{}|^`\\]|\\u[0-9A-Fa-f]{4}|\\U[0-9A-Fa-f]{8})*)>/y;
const WORD_RE = /[^\s.;,[\]()#<"']+/y;
const KEYWORD_RE = /(?:a|true|false)(?=$|[\s.;,[\]()#<"'])/y;
const DIRECTIVE_RE = /(?:PREFIX|BASE)(?=\s)/iy;
/** A token ends at whitespace, punctuation, a comment or the start of a literal or IRI. */
const ENDS_WORD = /$|[\s.;,[\]()#<"']/y;

function sticky(re: RegExp, text: string, at: number): RegExpExecArray | null {
  re.lastIndex = at;
  return re.exec(text);
}

/** A code point an escape may stand for: in range, and not half of a surrogate pair. */
function validCodePoint(n: number): boolean {
  return n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff);
}

const STRING_ESCAPES: Record<string, string> = { t: '\t', b: '\b', n: '\n', r: '\r', f: '\f', '"': '"', "'": "'", '\\': '\\' };

/** Unescapes a string's content, or says which escape is invalid (offset within `s`). */
function unescapeString(s: string): { value: string } | { error: string; at: number } {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const e = s[i + 1];
    if (e === 'u' || e === 'U') {
      const len = e === 'u' ? 4 : 8;
      const hex = s.slice(i + 2, i + 2 + len);
      const n = /^[0-9A-Fa-f]+$/.test(hex) && hex.length === len ? parseInt(hex, 16) : NaN;
      if (!validCodePoint(n)) return { error: `“\\${e}${hex}” isn’t a valid character escape`, at: i };
      out += String.fromCodePoint(n);
      i += 1 + len;
      continue;
    }
    const plain = e === undefined ? undefined : STRING_ESCAPES[e];
    if (plain === undefined) return { error: `“\\${e ?? ''}” isn’t a valid escape in a string (use \\\\ for a backslash)`, at: i };
    out += plain;
    i++;
  }
  return { value: out };
}

function unescapeIri(s: string): { value: string } | { error: string } {
  let bad: string | undefined;
  const value = s.replace(/\\u([0-9A-Fa-f]{4})|\\U([0-9A-Fa-f]{8})/g, (m, a: string, b: string) => {
    const n = parseInt(a ?? b, 16);
    if (!validCodePoint(n)) {
      bad ??= m;
      return m;
    }
    return String.fromCodePoint(n);
  });
  return bad ? { error: `“${bad}” isn’t a valid character escape` } : { value };
}

/** Splits Turtle into tokens, comments included (the formatter keeps them). */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const push = (type: TokType, len: number, extra: Partial<Token> = {}) => {
    out.push({ type, text: text.slice(i, i + len), from: i, to: i + len, ...extra });
    i += len;
  };
  const error = (len: number, message: string) => push('error', Math.max(1, len), { value: message });
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '#') {
      let end = i;
      while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end++;
      push('comment', end - i);
      continue;
    }
    if (c === '<') {
      const m = sticky(IRI_RE, text, i);
      if (!m) {
        error(1, 'This IRI isn’t closed with “>”, or contains a space or a character IRIs can’t hold');
        continue;
      }
      const iri = unescapeIri(m[1]);
      if ('error' in iri) error(m[0].length, iri.error);
      else push('iri', m[0].length, { value: iri.value });
      continue;
    }
    if (c === '"' || c === "'") {
      const long = text.startsWith(c.repeat(3), i);
      const q = long ? c.repeat(3) : c;
      let j = i + q.length;
      let closed = false;
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (!long && (text[j] === '\n' || text[j] === '\r')) break;
        if (text.startsWith(q, j)) {
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) {
        error(Math.min(j, text.length) - i, 'This text isn’t closed with a matching quote');
        continue;
      }
      const content = unescapeString(text.slice(i + q.length, j));
      if ('error' in content) {
        const at = i + q.length + content.at;
        // Point at the bad escape itself.
        out.push({ type: 'error', text: text.slice(at, at + 2), from: at, to: Math.min(text.length, at + 2), value: content.error });
        i = j + q.length;
        continue;
      }
      push('string', j + q.length - i, { value: content.value });
      continue;
    }
    if (c === '@') {
      const m = sticky(LANG_RE, text, i);
      if (!m) {
        error(1, 'Unexpected “@”');
        continue;
      }
      const prev = out[out.length - 1];
      if (prev?.type === 'string') push('lang', m[0].length);
      else if (m[0] === '@prefix') push('prefix', m[0].length);
      else if (m[0] === '@base') push('base', m[0].length);
      else error(m[0].length, `“${m[0]}” isn’t a Turtle directive`);
      continue;
    }
    if (c === '^' && text[i + 1] === '^') {
      push('hats', 2);
      continue;
    }
    if (c === '.' && /\d/.test(text[i + 1] ?? '')) {
      // ".5" is a decimal, not the end of a statement.
      const m = sticky(NUMBER_RE, text, i)!;
      push('number', m[0].length, { value: /[eE]/.test(m[0]) ? `${XSD}double` : `${XSD}decimal` });
      continue;
    }
    if ('.;,[]()'.includes(c)) {
      push('punct', 1);
      continue;
    }
    const dir = sticky(DIRECTIVE_RE, text, i);
    if (dir) {
      push(dir[0].toLowerCase() === 'prefix' ? 'prefix' : 'base', dir[0].length, { sparqlStyle: true });
      continue;
    }
    const num = sticky(NUMBER_RE, text, i);
    if (num && sticky(ENDS_WORD, text, i + num[0].length)) {
      const dt = /[eE]/.test(num[0]) ? 'double' : num[0].includes('.') ? 'decimal' : 'integer';
      push('number', num[0].length, { value: `${XSD}${dt}` });
      continue;
    }
    // "5." is the integer 5 and a full stop.
    if (num && /^[+-]?\d+\.$/.test(num[0]) && sticky(ENDS_WORD, text, i + num[0].length - 1)) {
      push('number', num[0].length - 1, { value: `${XSD}integer` });
      continue;
    }
    const kw = sticky(KEYWORD_RE, text, i);
    if (kw) {
      push(kw[0] === 'a' ? 'a' : 'bool', kw[0].length);
      continue;
    }
    const blank = sticky(BLANK_RE, text, i);
    if (blank) {
      push('blank', blank[0].length);
      continue;
    }
    const pname = sticky(PNAME_RE, text, i);
    if (pname) {
      // Give back trailing dots (the statement's full stop), unless escaped.
      let len = pname[0].length;
      while (len > 0 && text[i + len - 1] === '.' && text[i + len - 2] !== '\\') len--;
      push('pname', len);
      continue;
    }
    const word = sticky(WORD_RE, text, i);
    error(word ? word[0].length : 1, `“${word ? word[0] : c}” isn’t something Turtle understands here`);
  }
  return out;
}

/**
 * Resolves a relative IRI reference against a base (RFC 3986 §5.2), without
 * percent-encoding or normalising anything, as RDF parsers (and sparq) do:
 * `<café>` against `<http://e/>` is `http://e/café`.
 */
export function resolveIri(ref: string, base: string | undefined): string {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(ref) || !base) return ref;
  const b = /^([A-Za-z][A-Za-z0-9+.-]*:)(\/\/[^/?#]*)?([^?#]*)(\?[^#]*)?/.exec(base);
  if (!b) return ref;
  const [, scheme, authority = '', basePath, baseQuery = ''] = b;
  if (ref.startsWith('//')) {
    const m = /^(\/\/[^/?#]*)([^?#]*)(.*)$/.exec(ref)!;
    return scheme + m[1] + removeDotSegments(m[2]) + m[3];
  }
  if (ref === '') return scheme + authority + basePath + baseQuery;
  if (ref.startsWith('#')) return scheme + authority + basePath + baseQuery + ref;
  if (ref.startsWith('?')) return scheme + authority + basePath + ref;
  const m = /^([^?#]*)(.*)$/.exec(ref)!;
  let path: string;
  if (m[1].startsWith('/')) path = m[1];
  else if (authority && basePath === '') path = `/${m[1]}`;
  else path = basePath.slice(0, basePath.lastIndexOf('/') + 1) + m[1];
  return scheme + authority + removeDotSegments(path) + m[2];
}

function removeDotSegments(path: string): string {
  const input = path.split('/');
  const out: string[] = [];
  for (let k = 0; k < input.length; k++) {
    const seg = input[k];
    const last = k === input.length - 1;
    if (seg === '.') {
      if (last) out.push('');
    } else if (seg === '..') {
      if (out.length > 1 || (out.length === 1 && out[0] !== '')) out.pop();
      if (last) out.push('');
    } else out.push(seg);
  }
  return out.join('/');
}

class Stop extends Error {
  constructor(
    readonly span: Span,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Reads the document. `prefixes` are ones already in scope (sparq reads the
 * data after the ontology, so the ontology's prefixes work without being
 * declared again); declarations in the document override them.
 */
export function parseTurtle(text: string, options: { prefixes?: Record<string, string>; base?: string } = {}): TurtleDoc {
  return parseTokens(tokenize(text).filter((t) => t.type !== 'comment'), options);
}

function parseTokens(tokens: Token[], options: { prefixes?: Record<string, string>; base?: string }): TurtleDoc {
  const declared = new Map<string, string>();
  const scope = new Map<string, string>(Object.entries(options.prefixes ?? {}));
  let base = options.base;
  const triples: PlacedTriple[] = [];
  const iris: PlacedIri[] = [];
  let pos = 0;
  let blankCount = 0;
  const newBlank = (): RdfTerm => ({ kind: 'blank', value: `_anon${++blankCount}` });

  const peek = () => tokens[pos];
  const end = (): Span => {
    const last = tokens[tokens.length - 1];
    return last ? { from: last.to, to: last.to } : { from: 0, to: 0 };
  };
  const fail = (t: Token | undefined, message: string): never => {
    if (t?.type === 'error') throw new Stop(t, t.value ?? message);
    throw new Stop(t ?? end(), message);
  };
  const isPunct = (t: Token | undefined, p: string) => t?.type === 'punct' && t.text === p;
  const expectPunct = (p: string, message: string) => {
    const t = peek();
    if (!isPunct(t, p)) fail(t, message);
    pos++;
    return t;
  };

  const iriOf = (t: Token): string => {
    if (t.type === 'iri') return resolveIri(t.value!, base);
    const colon = t.text.indexOf(':');
    const prefix = t.text.slice(0, colon);
    const ns = scope.get(prefix);
    if (ns === undefined) fail(t, `The prefix “${prefix}:” hasn’t been declared`);
    return ns + t.text.slice(colon + 1).replace(/\\(.)/g, '$1');
  };

  const readIri = (t: Token, role: IriRole): PlacedIri => {
    const placed: PlacedIri = { term: { kind: 'iri', value: iriOf(t) }, from: t.from, to: t.to, role };
    iris.push(placed);
    return placed;
  };

  const directive = () => {
    const t = tokens[pos++];
    if (t.type === 'prefix') {
      const name = peek();
      if (name?.type !== 'pname' || name.text.indexOf(':') !== name.text.length - 1) fail(name, 'Expected a prefix name such as “ex:”');
      pos++;
      const iri = peek();
      if (iri?.type !== 'iri') fail(iri, 'Expected the namespace IRI in <…>');
      pos++;
      const prefix = name.text.slice(0, -1);
      const ns = resolveIri(iri.value!, base);
      declared.set(prefix, ns);
      scope.set(prefix, ns);
    } else {
      const iri = peek();
      if (iri?.type !== 'iri') fail(iri, 'Expected the base IRI in <…>');
      pos++;
      base = resolveIri(iri.value!, base);
    }
    if (!t.sparqlStyle) expectPunct('.', 'A directive ends with “.”');
  };

  const literal = (t: Token): Placed => {
    pos++;
    if (t.type === 'number') return { term: { kind: 'literal', value: t.text, datatype: t.value }, from: t.from, to: t.to };
    if (t.type === 'bool') return { term: { kind: 'literal', value: t.text, datatype: `${XSD}boolean` }, from: t.from, to: t.to };
    const next = peek();
    if (next?.type === 'lang') {
      pos++;
      return { term: { kind: 'literal', value: t.value!, lang: next.text.slice(1).toLowerCase() }, from: t.from, to: next.to };
    }
    if (next?.type === 'hats') {
      pos++;
      const dt = peek();
      if (dt?.type !== 'iri' && dt?.type !== 'pname') fail(dt, 'Expected a datatype after “^^”');
      pos++;
      const placed = readIri(dt, 'datatype');
      return { term: { kind: 'literal', value: t.value!, datatype: placed.term.value }, from: t.from, to: dt.to };
    }
    return { term: { kind: 'literal', value: t.value!, datatype: `${XSD}string` }, from: t.from, to: t.to };
  };

  const object = (role: IriRole): Placed => {
    const t = peek();
    if (!t) fail(t, 'Expected a value');
    if (t.type === 'iri' || t.type === 'pname') {
      pos++;
      return readIri(t, role);
    }
    if (t.type === 'blank') {
      pos++;
      return { term: { kind: 'blank', value: t.text.slice(2) }, from: t.from, to: t.to };
    }
    if (t.type === 'string' || t.type === 'number' || t.type === 'bool') return literal(t);
    if (isPunct(t, '[')) return blankNodePropertyList();
    if (isPunct(t, '(')) return collection();
    return fail(t, 'Expected a value: an IRI, a prefixed name, a blank node or a literal');
  };

  const collection = (): Placed => {
    const open = tokens[pos++];
    const items: Placed[] = [];
    while (!isPunct(peek(), ')')) {
      if (!peek()) fail(peek(), 'This list isn’t closed with “)”');
      items.push(object('object'));
    }
    const close = tokens[pos++];
    const span = { from: open.from, to: close.to };
    if (!items.length) return { term: { kind: 'iri', value: `${RDF}nil` }, ...span };
    const nodes = items.map(() => newBlank());
    items.forEach((item, k) => {
      const s = { term: nodes[k], from: item.from, to: item.to };
      triples.push({ s, p: { term: { kind: 'iri', value: `${RDF}first` }, ...span }, o: item });
      const rest: RdfTerm = k + 1 < nodes.length ? nodes[k + 1] : { kind: 'iri', value: `${RDF}nil` };
      triples.push({ s, p: { term: { kind: 'iri', value: `${RDF}rest` }, ...span }, o: { term: rest, ...span } });
    });
    return { term: nodes[0], ...span };
  };

  const blankNodePropertyList = (): Placed => {
    const open = tokens[pos++];
    const node = newBlank();
    if (isPunct(peek(), ']')) {
      const close = tokens[pos++];
      return { term: node, from: open.from, to: close.to };
    }
    const placeholder: Placed = { term: node, from: open.from, to: open.to };
    const first = triples.length;
    predicateObjectList(placeholder);
    const close = expectPunct(']', 'Expected “]” to close this blank node');
    const placed = { term: node, from: open.from, to: close.to };
    // The subject of the triples inside is the whole [ … ].
    for (let k = first; k < triples.length; k++) if (triples[k].s === placeholder) triples[k].s = placed;
    return placed;
  };

  const verb = (): Placed => {
    const t = peek();
    if (t?.type === 'a') {
      pos++;
      return { term: { kind: 'iri', value: RDF_TYPE }, from: t.from, to: t.to };
    }
    if (t?.type === 'iri' || t?.type === 'pname') {
      pos++;
      return readIri(t, 'predicate');
    }
    return fail(t, 'Expected a property (or “a”)');
  };

  const predicateObjectList = (s: Placed) => {
    for (;;) {
      const p = verb();
      const role: IriRole = p.term.value === RDF_TYPE ? 'type' : 'object';
      for (;;) {
        triples.push({ s, p, o: object(role) });
        if (!isPunct(peek(), ',')) break;
        pos++;
      }
      if (!isPunct(peek(), ';')) return;
      // One or more ';', possibly trailing.
      while (isPunct(peek(), ';')) pos++;
      const next = peek();
      if (!next || isPunct(next, '.') || isPunct(next, ']')) return;
    }
  };

  const statement = () => {
    const t = peek();
    if (t.type === 'prefix' || t.type === 'base') return directive();
    let s: Placed;
    if (isPunct(t, '[')) {
      const empty = isPunct(tokens[pos + 1], ']');
      s = blankNodePropertyList();
      // "[ ex:p ex:o ] ." is a whole statement; "[] ." isn't.
      if (!empty && isPunct(peek(), '.')) {
        pos++;
        return;
      }
    } else if (t.type === 'iri' || t.type === 'pname') {
      pos++;
      s = readIri(t, 'subject');
    } else if (t.type === 'blank') {
      pos++;
      s = { term: { kind: 'blank', value: t.text.slice(2) }, from: t.from, to: t.to };
    } else if (isPunct(t, '(')) {
      s = collection();
    } else return fail(t, 'Expected a subject: an IRI, a prefixed name or a blank node');
    predicateObjectList(s);
    expectPunct('.', 'Expected “.” at the end of this statement (or “;” / “,” to add more)');
  };

  let error: TurtleDoc['error'];
  try {
    while (pos < tokens.length) statement();
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    error = { ...e.span, message: e.message };
  }
  return { prefixes: declared, triples, iris, error };
}

/** A key that's equal for equal terms (blank nodes by label). */
export function termKey(t: RdfTerm): string {
  if (t.kind === 'iri') return `<${t.value}>`;
  if (t.kind === 'blank') return `_:${t.value}`;
  if (t.lang) return JSON.stringify([t.value, '@', t.lang.toLowerCase()]);
  return JSON.stringify([t.value, t.datatype ?? `${XSD}string`]);
}

function tripleKeys(doc: TurtleDoc): string[] {
  return doc.triples.map((t) => `${termKey(t.s.term)} ${termKey(t.p.term)} ${termKey(t.o.term)}`).sort();
}

/**
 * Lays the Turtle out the way the examples are written: one statement per
 * block, each property on its own indented line, blank nodes opened onto
 * their own lines, and directives grouped at the top. Comments stay with the
 * code they were next to.
 *
 * Returns undefined rather than risk the data: when the document can't be
 * read, or when the result doesn't read back as exactly the same triples,
 * prefixes and comments. The caller should also have sparq check the result.
 * `prefixes` are the ones in scope from the ontology, as for parseTurtle.
 */
export function formatTurtle(text: string, prefixes?: Record<string, string>): string | undefined {
  const tokens = tokenize(text);
  if (tokens.some((t) => t.type === 'error')) return undefined;
  const code = tokens.filter((t) => t.type !== 'comment');
  const before = parseTokens(code, { prefixes });
  if (before.error) return undefined;

  // Whether each token starts its line in the source (only spaces before it).
  const startsLine = tokens.map((t) => {
    let j = t.from - 1;
    while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) j--;
    return j < 0 || text[j] === '\n' || text[j] === '\r';
  });
  // Index of the next non-comment token after each position.
  const nextCode: (Token | undefined)[] = new Array(tokens.length);
  let upcoming: Token | undefined;
  for (let k = tokens.length - 1; k >= 0; k--) {
    nextCode[k] = upcoming;
    if (tokens[k].type !== 'comment') upcoming = tokens[k];
  }

  const lines: string[] = [];
  let cur = '';
  const atLineStart = () => cur.trim() === '';
  const newline = (indent: number) => {
    lines.push(cur.trimEnd());
    cur = ' '.repeat(indent);
  };
  const blankLine = () => {
    if (!atLineStart()) newline(0);
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    cur = '';
  };
  const put = (s: string, glue = false) => {
    if (!glue && !atLineStart()) cur += ' ';
    cur += s;
  };

  // Indent for property lines at each [ depth; the base depends on whether the statement starts with "[".
  let indents: number[] = [];
  let inStatement = false;
  /** In a directive: how many more code tokens it has (SPARQL style), or -1 until its '.'. */
  let directiveLeft = 0;
  /** A '.' had a comment after it on its line: the blank line goes after that comment. */
  let pendingBlank = false;
  const indent = () => (inStatement ? (indents[indents.length - 1] ?? 0) : 0);
  const trailingComment = (k: number) => tokens[k + 1]?.type === 'comment' && !startsLine[k + 1];
  const endDirective = (k: number) => {
    directiveLeft = 0;
    const next = nextCode[k];
    if (next && (next.type === 'prefix' || next.type === 'base')) {
      if (!trailingComment(k)) newline(0);
    } else if (!trailingComment(k)) blankLine();
    else pendingBlank = true;
  };

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === 'comment') {
      if (startsLine[k]) {
        if (!atLineStart()) newline(indent());
        cur = ' '.repeat(indent()) + t.text;
      } else put(t.text);
      // A comment always ends its line; a statement's blank line comes after its trailing comment.
      newline(indent());
      if (pendingBlank) {
        blankLine();
        pendingBlank = false;
      }
      continue;
    }

    if (directiveLeft !== 0) {
      put(t.text);
      if (directiveLeft > 0) {
        directiveLeft--;
        if (directiveLeft === 0) endDirective(k);
      } else if (t.type === 'punct' && t.text === '.') endDirective(k);
      continue;
    }
    if (!inStatement && (t.type === 'prefix' || t.type === 'base')) {
      if (!atLineStart()) newline(0);
      put(t.text);
      directiveLeft = t.sparqlStyle ? (t.type === 'prefix' ? 2 : 1) : -1;
      continue;
    }

    if (!inStatement) {
      if (!atLineStart()) newline(0);
      inStatement = true;
      indents = [t.type === 'punct' && t.text === '[' ? 0 : 2];
    }
    const glueToPrevious = t.type === 'lang' || t.type === 'hats' || (k > 0 && tokens[k - 1].type === 'hats');
    if (t.type === 'punct') {
      switch (t.text) {
        case '.':
          put('.');
          inStatement = false;
          if (!trailingComment(k)) blankLine();
          else pendingBlank = true;
          break;
        case ';': {
          const next = nextCode[k];
          // A trailing ';' adds nothing; drop it so the layout stays tidy.
          if (!next || (next.type === 'punct' && (next.text === '.' || next.text === ']' || next.text === ';'))) break;
          put(';');
          if (!trailingComment(k)) newline(indent());
          break;
        }
        case ',':
          put(',', true);
          break;
        case '[':
          // Only an empty [] with nothing (not even a comment) inside stays on one line.
          if (tokens[k + 1]?.type === 'punct' && tokens[k + 1].text === ']') {
            put('[]');
            k++;
            break;
          }
          put('[');
          indents.push(indent() + 2);
          if (!trailingComment(k)) newline(indent());
          break;
        case ']':
          indents.pop();
          if (!atLineStart()) newline(indent());
          else cur = ' '.repeat(indent());
          cur += ']';
          break;
        default:
          put(t.text);
      }
      continue;
    }
    put(t.text, glueToPrevious);
  }
  if (!atLineStart()) newline(0);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const out = `${lines.join('\n')}\n`;

  // Refuse unless it reads back as the same document.
  const outTokens = tokenize(out);
  if (outTokens.some((t) => t.type === 'error')) return undefined;
  const after = parseTokens(
    outTokens.filter((t) => t.type !== 'comment'),
    { prefixes },
  );
  if (after.error) return undefined;
  const comments = (ts: Token[]) => ts.filter((t) => t.type === 'comment').map((t) => t.text.trimEnd());
  if (comments(tokens).join('\n') !== comments(outTokens).join('\n')) return undefined;
  if ([...before.prefixes].join('\n') !== [...after.prefixes].join('\n')) return undefined;
  const a = tripleKeys(before);
  const b = tripleKeys(after);
  if (a.length !== b.length || a.some((x, i) => x !== b[i])) return undefined;
  return out;
}
