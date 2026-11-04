import { tagHighlighter, tags as t, highlightTree } from '@lezer/highlight';
import { languageSupport, type CodeLanguage } from './languages';

/**
 * One tag → class mapping for both the live editor and static snippets. The
 * colours live in index.css (.tok-*), driven by the --syn-* theme tokens, so
 * light and dark mode swap in one place.
 */
export const highlighter = tagHighlighter([
  { tag: [t.keyword, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], class: 'tok-keyword' },
  { tag: [t.processingInstruction, t.meta, t.heading], class: 'tok-meta' },
  { tag: t.url, class: 'tok-iri' },
  { tag: t.namespace, class: 'tok-prefix' },
  { tag: [t.typeName, t.className], class: 'tok-name' },
  { tag: [t.string, t.special(t.string), t.docString, t.attributeValue], class: 'tok-string' },
  { tag: t.content, class: 'tok-content' },
  { tag: [t.number, t.bool, t.null, t.atom], class: 'tok-number' },
  { tag: [t.variableName, t.special(t.variableName)], class: 'tok-variable' },
  { tag: t.function(t.variableName), class: 'tok-func' },
  { tag: [t.comment, t.lineComment, t.blockComment], class: 'tok-comment' },
  { tag: t.annotation, class: 'tok-annotation' },
  { tag: [t.tagName, t.angleBracket], class: 'tok-tag' },
  { tag: [t.attributeName, t.propertyName, t.definition(t.propertyName)], class: 'tok-attr' },
  { tag: [t.punctuation, t.separator, t.bracket, t.brace, t.squareBracket, t.paren, t.operator], class: 'tok-punct' },
]);

export interface Segment {
  text: string;
  cls?: string;
}

/** Split code into highlighted segments without creating an editor (for small snippets). */
export function highlightSegments(code: string, lang: CodeLanguage): Segment[] {
  const support = languageSupport(lang);
  if (!support) return [{ text: code }];
  const tree = support.language.parser.parse(code);
  const out: Segment[] = [];
  let pos = 0;
  highlightTree(tree, highlighter, (from, to, cls) => {
    if (from > pos) out.push({ text: code.slice(pos, from) });
    out.push({ text: code.slice(from, to), cls });
    pos = to;
  });
  if (pos < code.length) out.push({ text: code.slice(pos) });
  return out;
}
