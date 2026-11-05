// JavaScript syntax highlighting for the walkthrough: the code cards in claude-web.html, and the
// generated module the tour opens in the browser. Classes: tk-k keyword, tk-s string, tk-c comment,
// tk-n number, tk-t class name, tk-f function call, tk-p property.
(() => {
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const KEYWORDS = new Set('import from export default const let var function return for of in if else new await async class extends this typeof instanceof null undefined true false throw try catch while do break continue'.split(' '));
/**
 * JavaScript, highlighted line by line. The whole text is tokenised at once, so a template
 * literal or comment that spans lines keeps its colour on every line it covers.
 */
function highlightLines(lines) {
  const text = lines.join('\n');
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:\\[\s\S]|[^`\\])*`?|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)|\b(\d+(?:\.\d+)?)\b|([A-Za-z_$][\w$]*)/g;
  const tokens = [];
  let last = 0;
  for (let m; (m = re.exec(text)); ) {
    if (m.index > last) tokens.push(['', text.slice(last, m.index)]);
    let [t, comment, string, number, word] = m;
    if (string?.[0] === '`') {
      // Template literals can nest (`${x ? `<b>` : ""}`), so find the backtick that really ends this one.
      const end = templateEnd(text, m.index);
      t = string = text.slice(m.index, end);
      re.lastIndex = end;
    }
    let p = m.index - 1;
    while (p >= 0 && /\s/.test(text[p])) p--;
    CALL.lastIndex = re.lastIndex;
    const cls = comment ? 'tk-c' : string ? 'tk-s' : number ? 'tk-n'
      : KEYWORDS.has(word) ? 'tk-k'
      : /^[A-Z]/.test(word) ? 'tk-t'
      : CALL.test(text) ? 'tk-f'
      : text[p] === '.' ? 'tk-p' : '';
    tokens.push([cls, t]);
    last = re.lastIndex;
  }
  if (last < text.length) tokens.push(['', text.slice(last)]);
  const out = [''];
  for (const [cls, t] of tokens)
    t.split('\n').forEach((part, i) => {
      if (i) out.push('');
      if (part) out[out.length - 1] += cls ? `<span class="${cls}">${esc(part)}</span>` : esc(part);
    });
  return out;
}
const CALL = /\s*\(/y;
/** The index just after the template literal that starts at `start`, allowing for `${…}` holes that contain strings or templates. */
function templateEnd(text, start) {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') i += 2;
    else if (ch === '`') return i + 1;
    else if (ch === '$' && text[i + 1] === '{') {
      let depth = 1;
      i += 2;
      while (i < text.length && depth) {
        const c = text[i];
        if (c === '`') { i = templateEnd(text, i); continue; }
        if (c === '"' || c === "'") { const close = text.indexOf(c, i + 1); i = close < 0 ? text.length : close + 1; continue; }
        if (c === '{') depth++;
        else if (c === '}') depth--;
        i++;
      }
    } else i++;
  }
  return text.length;
}

/** The colours, for a page that has none of its own. */
const CSS = '.tk-k{color:#a626a4}.tk-s{color:#50a14f}.tk-c{color:#8e8f96;font-style:italic}.tk-n{color:#986801}.tk-t{color:#b76b01}.tk-f{color:#4078f2}.tk-p{color:#0184bc}';

Object.defineProperty(window, '__wtCode', { value: { highlightLines, CSS }, configurable: true });
})();
