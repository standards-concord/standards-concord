// JavaScript syntax highlighting for the walkthrough: the code cards in claude-web.html, and the
// generated module the tour opens in the browser. Classes: tk-k keyword, tk-s string or template,
// tk-r regular expression, tk-c comment, tk-n number, tk-t class name, tk-f function call,
// tk-p property.
//
// A small single-pass scanner, enough for the sample app and the generated classes: comments,
// strings (escapes and backslash-newline continuations), template literals whose ${…} holes are
// scanned as code (so they can hold strings, comments, regexes and further templates), and regex
// literals, told apart from division by the token before them.
//
// Accepted limits. It does not parse JavaScript, and it only ever shows the walkthrough's own code,
// which has none of these:
// - a regex right after `)` or `}` (as in `if (x) /re/.test(y)`) is read as division;
// - a `/` after a variable named like a keyword (`of / 2 / n`) can be read as starting a regex;
// - JSX, Flow and TypeScript type syntax are not understood;
// - HTML inside strings and templates is coloured as string text.
(() => {
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const KEYWORDS = new Set('import from export default const let var function return for of in if else new await async class extends this typeof instanceof null undefined true false throw try catch finally while do break continue switch case delete void yield static get set super'.split(' '));
/** After these words an expression starts, so a `/` begins a regex rather than dividing. */
const BEFORE_EXPRESSION = new Set('return typeof instanceof in of new delete void throw case do else yield await default extends'.split(' '));
const isIdStart = (c) => /[A-Za-z_$]/.test(c);
const isId = (c) => /[\w$]/.test(c);

/** Splits JavaScript into [class, text] tokens; the texts joined give back the input exactly. */
function tokenize(text) {
  const n = text.length;
  const tokens = [];
  let i = 0;
  // What came last, ignoring space and comments: 'value' (a `/` after it divides), 'operator'
  // (a `/` after it starts a regex), or '.' (the next word is a property).
  let last = 'operator';
  const push = (cls, s) => { if (s) tokens.push([cls, s]); };

  /** The end of a quoted string. An escape skips the next character, newline included. */
  function quoted(start) {
    const q = text[start];
    let j = start + 1;
    while (j < n) {
      const c = text[j];
      if (c === '\\') j += text[j + 1] === '\r' && text[j + 2] === '\n' ? 3 : 2; // CRLF continuations too
      else if (c === q) return j + 1;
      else if (c === '\n') return j; // unterminated: stop at the line's end
      else j++;
    }
    return n;
  }

  /** The end of a regex literal starting at `start`, or 0 if there isn't one on this line. */
  function regex(start) {
    let j = start + 1;
    let inClass = false;
    while (j < n) {
      const c = text[j];
      if (c === '\n') return 0;
      if (c === '\\') { j += 2; continue; }
      if (inClass) { if (c === ']') inClass = false; }
      else if (c === '[') inClass = true;
      else if (c === '/') {
        j++;
        while (j < n && /[a-z]/i.test(text[j])) j++;
        return j;
      }
      j++;
    }
    return 0;
  }

  /** A template literal from i, its ${…} holes scanned as code. */
  function template() {
    let start = i;
    i++;
    while (i < n) {
      const c = text[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { i++; break; }
      if (c === '$' && text[i + 1] === '{') {
        push('tk-s', text.slice(start, i + 2));
        i += 2;
        last = 'operator';
        code(true);
        start = i; // the closing brace (if any) starts the next string piece
        if (i < n) i++;
        continue;
      }
      i++;
    }
    push('tk-s', text.slice(start, Math.min(i, n)));
    last = 'value';
  }

  /** Code until the end, or (in a ${…} hole) until its closing brace, which is left unread. */
  function code(inHole) {
    let depth = 0;
    while (i < n) {
      const c = text[i];
      const d = text[i + 1];
      if (c === '/' && d === '/') {
        const e = text.indexOf('\n', i);
        const end = e < 0 ? n : e;
        push('tk-c', text.slice(i, end));
        i = end;
      } else if (c === '/' && d === '*') {
        const e = text.indexOf('*/', i + 2);
        const end = e < 0 ? n : e + 2;
        push('tk-c', text.slice(i, end));
        i = end;
      } else if (c === '"' || c === "'") {
        const end = quoted(i);
        push('tk-s', text.slice(i, end));
        i = end;
        last = 'value';
      } else if (c === '`') {
        template();
      } else if (c === '/' && last === 'operator' && regex(i)) {
        const end = regex(i);
        push('tk-r', text.slice(i, end));
        i = end;
        last = 'value';
      } else if (/\d/.test(c) || (c === '.' && /\d/.test(d ?? ''))) {
        const m = /^(?:0[xob][\da-f_]+|\d[\d_]*(?:\.\d*)?(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)n?/i.exec(text.slice(i, i + 64));
        const s = m ? m[0] : c;
        push('tk-n', s);
        i += s.length;
        last = 'value';
      } else if (isIdStart(c)) {
        let j = i + 1;
        while (j < n && isId(text[j])) j++;
        const word = text.slice(i, j);
        let k = j;
        while (k < n && /\s/.test(text[k])) k++; // a call's ( may be on the next line
        const cls = last === '.' ? (text[k] === '(' ? 'tk-f' : 'tk-p')
          : KEYWORDS.has(word) ? 'tk-k'
          : /^[A-Z]/.test(word) ? 'tk-t'
          : text[k] === '(' ? 'tk-f' : '';
        push(cls, word);
        i = j;
        last = last !== '.' && BEFORE_EXPRESSION.has(word) ? 'operator' : 'value';
      } else if (/\s/.test(c)) {
        let j = i + 1;
        while (j < n && /\s/.test(text[j])) j++;
        push('', text.slice(i, j));
        i = j;
      } else if ((c === '+' || c === '-') && d === c && last === 'value' && !/\n/.test(tokens[tokens.length - 1]?.[1] ?? '')) {
        // Postfix ++ or --: what follows comes after a value, so a / there divides. (After a line
        // break it is the next statement's prefix operator instead.)
        push('', c + d);
        i += 2;
      } else {
        if (inHole) {
          if (c === '{') depth++;
          else if (c === '}') { if (!depth) return; depth--; }
        }
        push('', c);
        i++;
        last = c === '.' ? '.' : c === ')' || c === ']' || c === '}' ? 'value' : 'operator';
      }
    }
  }

  code(false);
  return tokens;
}

/** JavaScript as HTML, one string per input line; a token that spans lines is coloured on each. */
function highlightLines(lines) {
  const out = [''];
  for (const [cls, t] of tokenize(lines.join('\n')))
    t.split('\n').forEach((part, k) => {
      if (k) out.push('');
      if (part) out[out.length - 1] += cls ? `<span class="${cls}">${esc(part)}</span>` : esc(part);
    });
  return out;
}

/** The colours, for a page that has none of its own. */
const CSS = '.tk-k{color:#a626a4}.tk-s{color:#50a14f}.tk-r{color:#c2185b}.tk-c{color:#8e8f96;font-style:italic}.tk-n{color:#986801}.tk-t{color:#b76b01}.tk-f{color:#4078f2}.tk-p{color:#0184bc}';

Object.defineProperty(window, '__wtCode', { value: { tokenize, highlightLines, CSS }, configurable: true });
})();
