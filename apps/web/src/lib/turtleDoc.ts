/**
 * A small Turtle reader that remembers where everything is. sparq parses and
 * validates the data, but its report only names terms; this finds those terms
 * in the text the person typed, so a problem can be underlined in the editor
 * and jumped to. It also lists the document's prefixes (so problems read with
 * the person's own prefixes) and tidies the layout without losing comments.
 *
 * It reads the Turtle grammar closely enough to find triples, and stops at the
 * first thing it doesn't understand. sparq stays the judge of what's valid.
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

export interface TurtleDoc {
  /** Prefixes the document declares, in the order it declares them. */
  prefixes: Map<string, string>;
  triples: PlacedTriple[];
  /** Every IRI written in the document (full or prefixed), where it is written. */
  iris: Placed[];
  /** The first thing that couldn't be read; triples before it are still listed. */
  error?: Span & { message: string };
}

export const XSD = 'http://www.w3.org/2001/XMLSchema#';
export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const RDF_TYPE = `${RDF}type`;

type TokType = 'iri' | 'pname' | 'blank' | 'string' | 'lang' | 'hats' | 'number' | 'bool' | 'a' | 'prefix' | 'base' | 'punct' | 'comment' | 'error';

interface Token extends Span {
  type: TokType;
  text: string;
  /** Strings: the unescaped lexical form. Numbers: the datatype. Directives: whether SPARQL style. */
  value?: string;
  sparqlStyle?: boolean;
}

const PN_CHARS_BASE = 'A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD';
const PN_CHARS = `${PN_CHARS_BASE}_\\-0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040`;
const PNAME_RE = new RegExp(`^(?:[${PN_CHARS_BASE}](?:[${PN_CHARS}.]*[${PN_CHARS}])?)?:(?:(?:[${PN_CHARS}:]|%[0-9A-Fa-f]{2}|\\\\[_~.\\-!$&'()*+,;=/?#@%])(?:[${PN_CHARS}.:]|%[0-9A-Fa-f]{2}|\\\\[_~.\\-!$&'()*+,;=/?#@%])*)?`);
const BLANK_RE = new RegExp(`^_:[${PN_CHARS}](?:[${PN_CHARS}.]*[${PN_CHARS}])?`);
const NUMBER_RE = /^[+-]?(?:\d+\.?\d*[eE][+-]?\d+|\.\d+[eE][+-]?\d+|\d*\.\d+|\d+)/;
/** A token ends at whitespace, punctuation, a comment or the start of a literal or IRI. */
const ENDS_WORD = /^(?:$|[\s.;,[\]()#<"'])/;

function unescapeString(s: string): string {
  return s.replace(/\\(?:u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|(.))/gs, (_m, u4: string, u8: string, c: string) => {
    if (u4 || u8) return String.fromCodePoint(parseInt(u4 ?? u8, 16));
    return ({ t: '\t', b: '\b', n: '\n', r: '\r', f: '\f' } as Record<string, string>)[c] ?? c;
  });
}

function unescapeIri(s: string): string {
  return s.replace(/\\u([0-9A-Fa-f]{4})|\\U([0-9A-Fa-f]{8})/g, (_m, a: string, b: string) => String.fromCodePoint(parseInt(a ?? b, 16)));
}

/** Splits Turtle into tokens, comments included (the formatter keeps them). */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const push = (type: TokType, len: number, extra: Partial<Token> = {}) => {
    out.push({ type, text: text.slice(i, i + len), from: i, to: i + len, ...extra });
    i += len;
  };
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const rest = text.slice(i);
    if (c === '#') {
      const end = rest.search(/[\r\n]/);
      push('comment', end < 0 ? rest.length : end);
      continue;
    }
    if (c === '<') {
      const m = /^<([^<>"{}|^`\\\s]|\\u[0-9A-Fa-f]{4}|\\U[0-9A-Fa-f]{8})*>/.exec(rest);
      if (m) push('iri', m[0].length, { value: unescapeIri(m[0].slice(1, -1)) });
      else push('error', 1, { value: 'This IRI isn’t closed with “>”, or contains a space' });
      continue;
    }
    if (c === '"' || c === "'") {
      const long = rest.startsWith(c.repeat(3));
      const q = long ? c.repeat(3) : c;
      let j = q.length;
      let closed = false;
      while (j < rest.length) {
        if (rest[j] === '\\') {
          j += 2;
          continue;
        }
        if (!long && (rest[j] === '\n' || rest[j] === '\r')) break;
        if (rest.startsWith(q, j)) {
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) {
        push('error', Math.min(j, rest.length), { value: 'This text isn’t closed with a matching quote' });
        continue;
      }
      push('string', j + q.length, { value: unescapeString(rest.slice(q.length, j)) });
      continue;
    }
    if (c === '@') {
      const m = /^@[A-Za-z]+(?:-[A-Za-z0-9]+)*/.exec(rest);
      if (!m) {
        push('error', 1, { value: 'Unexpected “@”' });
        continue;
      }
      const prev = out[out.length - 1];
      if (prev?.type === 'string') push('lang', m[0].length);
      else if (m[0] === '@prefix') push('prefix', m[0].length);
      else if (m[0] === '@base') push('base', m[0].length);
      else push('error', m[0].length, { value: `“${m[0]}” isn’t a Turtle directive` });
      continue;
    }
    if (rest.startsWith('^^')) {
      push('hats', 2);
      continue;
    }
    if ('.;,[]()'.includes(c)) {
      // A '.' followed by a digit is a decimal (".5"), not the end of a statement.
      if (c === '.' && /^\.\d/.test(rest)) {
        const m = NUMBER_RE.exec(rest)!;
        push('number', m[0].length, { value: /[eE]/.test(m[0]) ? `${XSD}double` : `${XSD}decimal` });
        continue;
      }
      push('punct', 1);
      continue;
    }
    if (/^(?:PREFIX|BASE)\s/i.test(rest)) {
      const word = rest.slice(0, rest.search(/\s/));
      push(word.toLowerCase() === 'prefix' ? 'prefix' : 'base', word.length, { sparqlStyle: true });
      continue;
    }
    const num = NUMBER_RE.exec(rest);
    if (num && ENDS_WORD.test(rest.slice(num[0].length))) {
      const dt = /[eE]/.test(num[0]) ? 'double' : num[0].includes('.') ? 'decimal' : 'integer';
      push('number', num[0].length, { value: `${XSD}${dt}` });
      continue;
    }
    const kw = /^(?:a|true|false)/.exec(rest);
    if (kw && ENDS_WORD.test(rest.slice(kw[0].length))) {
      push(kw[0] === 'a' ? 'a' : 'bool', kw[0].length);
      continue;
    }
    const blank = BLANK_RE.exec(rest);
    if (blank) {
      push('blank', blank[0].length);
      continue;
    }
    const pname = PNAME_RE.exec(rest);
    if (pname) {
      push('pname', pname[0].length);
      continue;
    }
    const word = /^[^\s.;,[\]()#<"']+/.exec(rest);
    push('error', word ? word[0].length : 1, { value: `“${word ? word[0] : c}” isn’t something Turtle understands here` });
  }
  return out;
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
  const tokens = tokenize(text).filter((t) => t.type !== 'comment');
  const declared = new Map<string, string>();
  const scope = new Map<string, string>(Object.entries(options.prefixes ?? {}));
  let base = options.base;
  const triples: PlacedTriple[] = [];
  const iris: Placed[] = [];
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

  const resolve = (iri: string) => {
    if (!base || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(iri)) return iri;
    try {
      return new URL(iri, base).href;
    } catch {
      return iri;
    }
  };

  const iriOf = (t: Token): string => {
    if (t.type === 'iri') return resolve(t.value!);
    const colon = t.text.indexOf(':');
    const prefix = t.text.slice(0, colon);
    const ns = scope.get(prefix);
    if (ns === undefined) fail(t, `The prefix “${prefix}:” hasn’t been declared`);
    return ns + t.text.slice(colon + 1).replace(/\\(.)/g, '$1');
  };

  const readIri = (t: Token): Placed => {
    const placed: Placed = { term: { kind: 'iri', value: iriOf(t) }, from: t.from, to: t.to };
    iris.push(placed);
    return placed;
  };

  const directive = () => {
    const t = tokens[pos++];
    if (t.type === 'prefix') {
      const name = peek();
      if (name?.type !== 'pname' || !name.text.endsWith(':') || name.text.indexOf(':') !== name.text.length - 1) fail(name, 'Expected a prefix name such as “ex:”');
      pos++;
      const iri = peek();
      if (iri?.type !== 'iri') fail(iri, 'Expected the namespace IRI in <…>');
      pos++;
      const prefix = name.text.slice(0, -1);
      const ns = resolve(iri.value!);
      declared.set(prefix, ns);
      scope.set(prefix, ns);
    } else {
      const iri = peek();
      if (iri?.type !== 'iri') fail(iri, 'Expected the base IRI in <…>');
      pos++;
      base = resolve(iri.value!);
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
      const placed = readIri(dt);
      return { term: { kind: 'literal', value: t.value!, datatype: placed.term.value }, from: t.from, to: dt.to };
    }
    return { term: { kind: 'literal', value: t.value!, datatype: `${XSD}string` }, from: t.from, to: t.to };
  };

  const object = (): Placed => {
    const t = peek();
    if (!t) fail(t, 'Expected a value');
    if (t.type === 'iri' || t.type === 'pname') {
      pos++;
      return readIri(t);
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
      items.push(object());
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
    predicateObjectList(placeholder);
    const close = expectPunct(']', 'Expected “]” to close this blank node');
    const placed = { term: node, from: open.from, to: close.to };
    // The subject of the triples inside is the whole [ … ].
    for (const tr of triples) if (tr.s === placeholder) tr.s = placed;
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
      return readIri(t);
    }
    return fail(t, 'Expected a property (or “a”)');
  };

  const predicateObjectList = (s: Placed) => {
    for (;;) {
      const p = verb();
      for (;;) {
        triples.push({ s, p, o: object() });
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
      s = blankNodePropertyList();
      if (isPunct(peek(), '.')) {
        pos++;
        return;
      }
    } else if (t.type === 'iri' || t.type === 'pname') {
      pos++;
      s = readIri(t);
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

/**
 * Lays the Turtle out the way the examples are written: one statement per
 * block, each property on its own indented line, blank nodes opened onto
 * their own lines, and directives grouped at the top of their run. Comments
 * stay where they were. Returns undefined when the document can't be read,
 * since moving tokens around in a broken document could make it worse.
 * `prefixes` are the ones in scope from the ontology, as for parseTurtle.
 */
export function formatTurtle(text: string, prefixes?: Record<string, string>): string | undefined {
  if (parseTurtle(text, { prefixes }).error) return undefined;
  const tokens = tokenize(text);
  if (tokens.some((t) => t.type === 'error')) return undefined;
  let out = '';
  const atLineStart = () => out === '' || /\n[ ]*$/.test(out);
  const newline = (indent: number) => {
    out = out.replace(/[ ]+$/, '');
    out += `\n${' '.repeat(indent)}`;
  };
  const put = (s: string, glue = false) => {
    if (!glue && !atLineStart()) out += ' ';
    out += s;
  };
  // Indent for property lines at each [ depth; the base depends on whether the statement starts with "[".
  let indents: number[] = [];
  let inStatement = false;
  let inDirective: Token | undefined;
  const indent = () => indents[indents.length - 1] ?? 0;
  const nextCode = (k: number) => tokens.slice(k + 1).find((t) => t.type !== 'comment');
  const ownLine = (t: Token) => /(^|\n)[ \t]*$/.test(text.slice(0, t.from));
  // A comment after the token on the same line stays there, and breaks the line itself.
  const trailingComment = (k: number) => tokens[k + 1]?.type === 'comment' && !ownLine(tokens[k + 1]);

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === 'comment') {
      if (ownLine(t)) {
        if (!atLineStart()) newline(inStatement ? indent() : 0);
        else if (!inStatement && !inDirective) out = out.replace(/[ ]+$/, '');
        out += t.text;
      } else put(t.text);
      newline(inStatement ? indent() : 0);
      continue;
    }

    if (!inStatement && !inDirective && (t.type === 'prefix' || t.type === 'base')) {
      if (!atLineStart()) newline(0);
      inDirective = t;
      out += t.text;
      if (t.sparqlStyle) {
        // PREFIX ex: <…> has no closing '.', so it ends with its IRI.
        const parts = t.type === 'prefix' ? 2 : 1;
        for (let n = 0; n < parts && k + 1 < tokens.length; n++) put(tokens[++k].text);
        inDirective = undefined;
        finishDirective(k);
      }
      continue;
    }
    if (inDirective) {
      if (t.type === 'punct' && t.text === '.') {
        put('.');
        inDirective = undefined;
        finishDirective(k);
      } else put(t.text);
      continue;
    }

    if (!inStatement) {
      if (!atLineStart()) newline(0);
      inStatement = true;
      indents = [t.type === 'punct' && t.text === '[' ? 0 : 2];
    }
    const glueToPrevious = t.type === 'lang' || t.type === 'hats' || tokens[k - 1]?.type === 'hats';
    if (t.type === 'punct') {
      switch (t.text) {
        case '.':
          put('.');
          inStatement = false;
          out += '\n\n';
          break;
        case ';': {
          const next = nextCode(k);
          // A trailing ';' adds nothing; drop it so the layout stays tidy.
          if (!next || (next.type === 'punct' && (next.text === '.' || next.text === ']' || next.text === ';'))) break;
          put(';');
          if (!trailingComment(k)) newline(indent());
          break;
        }
        case ',':
          put(',', true);
          break;
        case '[': {
          const next = nextCode(k);
          if (next?.type === 'punct' && next.text === ']') {
            put('[]');
            k = tokens.indexOf(next);
            break;
          }
          put('[');
          indents.push(indent() + 2);
          if (!trailingComment(k)) newline(indent());
          break;
        }
        case ']':
          indents.pop();
          newline(indent());
          out += ']';
          break;
        case '(':
          put('(');
          break;
        case ')':
          put(')');
          break;
      }
      continue;
    }
    put(t.text, glueToPrevious);
  }

  function finishDirective(k: number) {
    const next = nextCode(k);
    const nextIsDirective = next && (next.type === 'prefix' || next.type === 'base');
    out += nextIsDirective ? '\n' : '\n\n';
  }

  return `${out.replace(/\s+$/, '')}\n`;
}
