/**
 * The outer LIMIT of a SPARQL query, read from its tokens the way a parser
 * would: comments, strings and IRIs are skipped, and only a LIMIT at the top
 * level (outside every { }) counts, so a subquery's LIMIT or the word inside
 * a string or comment never does.
 */

interface Token {
  text: string;
  start: number;
  end: number;
}

/** Tokens outside comments, strings and IRIs, with their positions. Braces are their own tokens. */
function tokens(q: string): Token[] {
  const out: Token[] = [];
  const re = /<[^<>\s]*>|"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|#[^\n]*|([{}])|([^\s{}#"'<]+)/g;
  for (const m of q.matchAll(re)) {
    const text = m[1] ?? m[2];
    if (text) out.push({ text, start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

/** The top-level LIMIT keyword and its number, if the query has one. */
function outerLimit(q: string): { keyword: Token; value: Token } | undefined {
  const ts = tokens(q);
  let depth = 0;
  let found: { keyword: Token; value: Token } | undefined;
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    if (t.text === '{') depth++;
    else if (t.text === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && /^limit$/i.test(t.text) && /^\d+$/.test(ts[i + 1]?.text ?? '')) found = { keyword: t, value: ts[i + 1] };
  }
  return found;
}

export function limitOf(q: string): number | undefined {
  const l = outerLimit(q);
  return l ? Number(l.value.text) : undefined;
}

/** The query without its outer LIMIT (any OFFSET stays). */
export function withoutLimit(q: string): string {
  const l = outerLimit(q);
  if (!l) return q;
  return `${q.slice(0, l.keyword.start)}${q.slice(l.value.end).replace(/^[ \t]+/, '')}`.replace(/[ \t]+\n/g, '\n').trimEnd() + '\n';
}
