import { LanguageSupport, StreamLanguage, type StreamParser, type StringStream } from '@codemirror/language';
import { tags as t, type Tag } from '@lezer/highlight';
import { json } from '@codemirror/lang-json';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';

/**
 * Syntax highlighting for every format Concord shows. Turtle, N-Triples,
 * SPARQL and Manchester syntax share one tokenizer for RDF terms (IRIs,
 * prefixed names, literals, blank nodes), so the same term looks the same in
 * every view. XML, JSON-LD and LinkML (YAML) use CodeMirror's Lezer grammars.
 */

export type CodeLanguage = 'turtle' | 'ntriples' | 'sparql' | 'manchester' | 'xml' | 'json' | 'yaml' | 'text';

/** Token names the tokenizers return, mapped to highlight tags (and so to colours). */
const tokenTable: Record<string, Tag | readonly Tag[]> = {
  iri: t.url,
  prefix: t.namespace,
  local: t.typeName,
  keyword: t.keyword,
  directive: t.processingInstruction,
  variable: t.variableName,
  string: t.string,
  langTag: t.annotation,
  datatype: t.annotation,
  number: t.number,
  bool: t.bool,
  blank: t.special(t.variableName),
  comment: t.lineComment,
  punct: t.punctuation,
  operator: t.operator,
  func: t.function(t.variableName),
  frame: t.heading,
};

const PN_CHARS_BASE =
  'A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD';
const PN_CHARS = `${PN_CHARS_BASE}_\\-0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040`;
/** prefix: (possibly empty) followed by a colon. */
const PNAME_NS = new RegExp(`^(?:[${PN_CHARS_BASE}](?:[${PN_CHARS}.]*[${PN_CHARS}])?)?:`);
/** Local part of a prefixed name, including %-escapes and backslash escapes. */
const PN_LOCAL = new RegExp(`^(?:[${PN_CHARS}:]|%[0-9A-Fa-f]{2}|\\\\[_~.\\-!$&'()*+,;=/?#@%])(?:[${PN_CHARS}.:]|%[0-9A-Fa-f]{2}|\\\\[_~.\\-!$&'()*+,;=/?#@%])*`);
const NUMBER = /^[+-]?(?:\d+\.\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|\d+(?:[eE][+-]?\d+)?)/;
const WORD = new RegExp(`^[${PN_CHARS_BASE}_][${PN_CHARS}]*`);

const SPARQL_KEYWORDS = new Set(
  (
    'base prefix select distinct reduced construct describe ask from named where order by asc desc limit offset ' +
    'filter optional graph as having undef values group minus in not service silent using insert delete union ' +
    'with data copy to move add create drop clear load into default all exists'
  ).split(' '),
);
const SPARQL_FUNCTIONS = new Set(
  (
    'str lang langmatches datatype bound sameterm isiri isuri iri uri bnode count sum min max avg sample ' +
    'group_concat rand abs ceil floor round concat substr strlen replace ucase lcase encode_for_uri contains ' +
    'strstarts strends strbefore strafter year month day hours minutes seconds timezone tz now uuid struuid md5 ' +
    'sha1 sha256 sha384 sha512 coalesce if strlang strdt isnumeric regex isblank isliteral bind separator'
  ).split(' '),
);
const MANCHESTER_KEYWORDS = new Set(
  'some only value min max exactly and or not that inverse self Self'.split(' '),
);

interface RdfState {
  /** Inside a multi-line string: the closing delimiter. */
  longString: string | null;
  /** The previous significant token, to tell a datatype IRI after ^^ apart. */
  afterCaret: boolean;
}

type Mode = 'turtle' | 'ntriples' | 'sparql' | 'manchester';

function readString(stream: StringStream, quote: string): boolean {
  // Returns true when the closing quote was found on this line.
  let escaped = false;
  while (!stream.eol()) {
    const ch = stream.next();
    if (escaped) escaped = false;
    else if (ch === '\\') escaped = true;
    else if (ch === quote) return true;
  }
  return false;
}

function readLongString(stream: StringStream, delim: string): boolean {
  while (!stream.eol()) {
    if (stream.match(delim)) return true;
    if (stream.next() === '\\') stream.next();
  }
  return false;
}

function rdfParser(mode: Mode): StreamParser<RdfState> {
  return {
    name: mode,
    startState: () => ({ longString: null, afterCaret: false }),
    copyState: (s) => ({ ...s }),
    languageData: { commentTokens: mode === 'manchester' ? undefined : { line: '#' } },
    tokenTable,
    token(stream, state) {
      if (state.longString) {
        if (readLongString(stream, state.longString)) state.longString = null;
        return 'string';
      }
      const after = state.afterCaret;
      // The local part straight after a prefix (vol:|Opportunity).
      if (mode !== 'ntriples' && stream.pos > 0 && stream.string.charAt(stream.pos - 1) === ':' && stream.match(PN_LOCAL)) {
        state.afterCaret = false;
        return after ? 'datatype' : 'local';
      }
      if (stream.eatSpace()) return null;
      state.afterCaret = false;

      if (stream.peek() === '#') {
        stream.skipToEnd();
        return 'comment';
      }
      // Strings, including Turtle/SPARQL long strings.
      if (stream.match('"""') || stream.match("'''")) {
        const delim = stream.current();
        if (!readLongString(stream, delim)) state.longString = delim;
        return 'string';
      }
      const ch = stream.peek();
      if (ch === '"' || (ch === "'" && mode !== 'ntriples')) {
        stream.next();
        readString(stream, ch);
        return 'string';
      }
      if (stream.match(/^@[a-zA-Z]+(?:-[a-zA-Z0-9]+)*/)) {
        const word = stream.current().slice(1).toLowerCase();
        if (word === 'prefix' || word === 'base') return 'directive';
        return 'langTag';
      }
      if (stream.match('^^')) {
        state.afterCaret = true;
        return 'operator';
      }
      // IRIs. In SPARQL, < can also be a comparison operator.
      if (ch === '<') {
        if (stream.match(/^<[^<>"{}|^`\\\s]*>/)) return after ? 'datatype' : 'iri';
        stream.next();
        if (stream.eat('=')) return 'operator';
        return mode === 'sparql' ? 'operator' : 'punct';
      }
      if (stream.match(/^_:[A-Za-z0-9_\-.]*[A-Za-z0-9_\-]/) || stream.match(/^_:[A-Za-z0-9_]/)) return 'blank';
      if (mode === 'sparql' && (ch === '?' || ch === '$')) {
        if (stream.match(/^[?$][A-Za-z0-9_À-�][A-Za-z0-9_·À-�]*/)) return 'variable';
        stream.next();
        return 'operator';
      }
      if (mode === 'manchester' && stream.match(/^[A-Z][A-Za-z]*:(?=\s|$)/)) return 'frame';
      if (stream.match(NUMBER)) return 'number';
      // Prefixed names: the prefix here, the local part on the next call.
      if (mode !== 'ntriples' && stream.match(PNAME_NS)) {
        if (after) state.afterCaret = true;
        return after ? 'datatype' : 'prefix';
      }
      if (stream.match(WORD)) {
        const word = stream.current();
        const lower = word.toLowerCase();
        if (lower === 'true' || lower === 'false') return 'bool';
        if (mode === 'turtle' || mode === 'ntriples') {
          if (word === 'a') return 'keyword';
          if (lower === 'prefix' || lower === 'base') return 'directive';
          return null;
        }
        if (mode === 'sparql') {
          if (word === 'a') return 'keyword';
          if (SPARQL_KEYWORDS.has(lower)) return 'keyword';
          if (SPARQL_FUNCTIONS.has(lower)) return 'func';
          return null;
        }
        if (MANCHESTER_KEYWORDS.has(word)) return 'keyword';
        return 'local';
      }
      const c = stream.next() as string;
      if ('.;,[](){}'.includes(c)) return 'punct';
      if ('=!>&|*+/-^'.includes(c)) {
        stream.eat('=');
        return 'operator';
      }
      return null;
    },
  };
}

const streamLanguages = {
  turtle: StreamLanguage.define(rdfParser('turtle')),
  ntriples: StreamLanguage.define(rdfParser('ntriples')),
  sparql: StreamLanguage.define(rdfParser('sparql')),
  manchester: StreamLanguage.define(rdfParser('manchester')),
};

export function languageSupport(lang: CodeLanguage): LanguageSupport | null {
  switch (lang) {
    case 'turtle':
    case 'ntriples':
    case 'sparql':
    case 'manchester':
      return new LanguageSupport(streamLanguages[lang]);
    case 'xml':
      return xml();
    case 'json':
      return json();
    case 'yaml':
      return yaml();
    default:
      return null;
  }
}

/** The language for each serialisation the Formats tab offers. */
export const FORMAT_LANGUAGE: Record<string, CodeLanguage> = {
  turtle: 'turtle',
  shacl: 'turtle',
  ntriples: 'ntriples',
  rdfxml: 'xml',
  jsonld: 'json',
  linkml: 'yaml',
  manchester: 'manchester',
};
